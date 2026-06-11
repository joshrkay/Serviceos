/**
 * P12-001 — `GET /api/me` and `POST /api/me/mode`.
 *
 * Returns the authenticated user's tenant + role + permissions + current
 * operator mode + the tenant-level supervisor / unsupervised-routing
 * settings. The frontend uses this as a single bootstrap call after
 * sign-in; the result drives the in-app mode toggle and the proposal
 * routing UI.
 *
 * Wiring contract (kept narrow on purpose):
 *  - Permissions are derived from `auth/rbac.ts` (frozen). We do NOT
 *    treat mode as a permission — owners stay owners regardless of mode.
 *  - `POST /api/me/mode` writes the new mode + audit row, then primes the
 *    in-process cache used by `requireTenant` so the next request on the
 *    same dyno sees the new mode immediately.
 *  - All DB I/O is delegated to a small `UserModeService` interface so
 *    the route module has no Pg dependency. app.ts wires the Pg impl;
 *    tests inject an in-memory impl.
 */
import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import {
  requireAuth,
  requireTenant,
  setCachedMode,
} from '../middleware/auth';
import { type Mode } from '@ai-service-os/shared';
import { getPermissions, isValidRole, Role } from '../auth/rbac';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { TenantIntegrationStatus } from '../integrations/status-machine';

const VALID_MODES: ReadonlyArray<Mode> = ['supervisor', 'tech', 'both'];

export interface MeUserRecord {
  user_id: string;
  tenant_id: string;
  role: string;
  can_field_serve: boolean;
  current_mode: Mode;
  mode_changed_at: Date | null;
}

export interface MeTenantSettings {
  backup_supervisor_user_id: string | null;
  unsupervised_proposal_routing:
    | 'queue_and_sms'
    | 'queue_only'
    | 'escalate_to_oncall';
  /**
   * IANA timezone identifier for the business (e.g. `America/New_York`).
   * Stored on `tenant_settings.timezone` (default `America/New_York`,
   * see migration 013). Surfaces here so the web client renders dates
   * in the tenant's local time rather than the viewer's browser-local
   * time. CLAUDE.md core pattern: "All times: stored UTC, rendered in
   * tenant timezone".
   */
  timezone: string;
}

/** Safe default when tenant_settings is missing a timezone row. */
export const DEFAULT_TENANT_TIMEZONE = 'America/New_York';

/**
 * Persistence seam for the /api/me endpoints. Implementations talk to
 * Postgres (`users` + `tenant_settings`) in production; tests use an
 * in-memory variant.
 */
export interface UserModeService {
  /** Fetch the user record needed to populate `GET /api/me`. */
  getUser(tenantId: string, userId: string): Promise<MeUserRecord | null>;
  /** Fetch the tenant-scoped settings consumed by `GET /api/me`. */
  getTenantSettings(tenantId: string): Promise<MeTenantSettings>;
  getTenantIntegrationStatuses(
    tenantId: string,
  ): Promise<Array<{ provider: string; status: TenantIntegrationStatus; updated_at: Date | null }>>;
  /**
   * Persist a mode switch. Implementations MUST update both
   * `users.current_mode` and `users.mode_changed_at`. Returns the new
   * mode_changed_at timestamp for the audit + response shape.
   */
  setMode(
    tenantId: string,
    userId: string,
    mode: Mode,
  ): Promise<{ modeChangedAt: Date }>;
}

export function createMeRouter(
  service: UserModeService,
  auditRepo: AuditRepository,
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const auth = req.auth!;
        const user = await service.getUser(auth.tenantId, auth.userId);
        const settings = await service.getTenantSettings(auth.tenantId);
        const integrationStatuses = await service.getTenantIntegrationStatuses(auth.tenantId);

        // Derive permissions from rbac.ts. If the JWT carries an
        // unexpected role, fall back to an empty list rather than 500
        // — the request is already authenticated, so the right answer
        // is "no powers", not "server crash".
        const role = auth.role;
        const permissions = isValidRole(role) ? getPermissions(role as Role) : [];

        // If no user row exists yet (e.g. tenant freshly bootstrapped
        // and the row hasn't been created), return defaults so the UI
        // can still render. P12-002 will tighten this.
        const currentMode: Mode = user?.current_mode ?? 'supervisor';
        const canFieldServe =
          user?.can_field_serve ?? auth.role === 'owner';

        res.json({
          user_id: auth.userId,
          tenant_id: auth.tenantId,
          role,
          can_field_serve: canFieldServe,
          current_mode: currentMode,
          mode_changed_at: user?.mode_changed_at
            ? user.mode_changed_at.toISOString()
            : null,
          permissions,
          backup_supervisor_user_id: settings.backup_supervisor_user_id,
          unsupervised_proposal_routing:
            settings.unsupervised_proposal_routing,
          // Business timezone so the web client can render UTC instants
          // in the tenant's local time (appointments, invoice dates,
          // dashboard buckets, etc.).
          timezone: settings.timezone,
          integration_statuses: integrationStatuses.map((s) => ({
            provider: s.provider,
            status: s.status,
            updated_at: s.updated_at ? s.updated_at.toISOString() : null,
          })),
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to load /api/me';
        res.status(500).json({ error: 'INTERNAL_ERROR', message });
      }
    },
  );

  router.post(
    '/mode',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const auth = req.auth!;
        const target = (req.body?.mode ?? '') as string;
        if (!VALID_MODES.includes(target as Mode)) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: `mode must be one of ${VALID_MODES.join(', ')}`,
          });
          return;
        }

        const user = await service.getUser(auth.tenantId, auth.userId);
        const fromMode: Mode = user?.current_mode ?? 'supervisor';
        const targetMode = target as Mode;

        // Owners always have field-capability; everyone else needs
        // can_field_serve = true to enter 'tech' or 'both'. Mode is
        // intentionally NOT an rbac.ts permission — the gating logic
        // lives here so rbac.ts stays frozen.
        if (targetMode === 'tech' || targetMode === 'both') {
          const fieldCapable =
            auth.role === 'owner' || user?.can_field_serve === true;
          if (!fieldCapable) {
            res.status(403).json({
              error: 'FORBIDDEN',
              message:
                'User is not field-capable; cannot enter tech or both mode',
            });
            return;
          }
        }

        const { modeChangedAt } = await service.setMode(
          auth.tenantId,
          auth.userId,
          targetMode,
        );

        // Prime the in-process cache so the next requireTenant call on
        // this dyno reads the new mode without waiting for the 60s TTL.
        setCachedMode(auth.userId, auth.tenantId, targetMode);

        await auditRepo.create(
          createAuditEvent({
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorRole: auth.role,
            eventType: 'mode_switched',
            entityType: 'user',
            entityId: auth.userId,
            metadata: {
              from_mode: fromMode,
              to_mode: targetMode,
              mode_changed_at: modeChangedAt.toISOString(),
            },
          }),
        );

        res.status(204).send();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to switch mode';
        res.status(500).json({ error: 'INTERNAL_ERROR', message });
      }
    },
  );

  return router;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory implementation. Used by tests + the no-DB dev path. Production
// wires a Pg implementation in app.ts.
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryUserModeService implements UserModeService {
  private readonly users = new Map<string, MeUserRecord>();
  private readonly settings = new Map<string, MeTenantSettings>();

  upsertUser(record: MeUserRecord): void {
    this.users.set(this.userKey(record.tenant_id, record.user_id), { ...record });
  }

  setTenantSettings(tenantId: string, settings: MeTenantSettings): void {
    this.settings.set(tenantId, { ...settings });
  }

  async getUser(tenantId: string, userId: string): Promise<MeUserRecord | null> {
    const row = this.users.get(this.userKey(tenantId, userId));
    return row ? { ...row } : null;
  }

  async getTenantSettings(tenantId: string): Promise<MeTenantSettings> {
    return (
      this.settings.get(tenantId) ?? {
        backup_supervisor_user_id: null,
        unsupervised_proposal_routing: 'queue_and_sms',
        timezone: DEFAULT_TENANT_TIMEZONE,
      }
    );
  }

  async setMode(
    tenantId: string,
    userId: string,
    mode: Mode,
  ): Promise<{ modeChangedAt: Date }> {
    const key = this.userKey(tenantId, userId);
    const existing = this.users.get(key);
    const modeChangedAt = new Date();
    if (existing) {
      existing.current_mode = mode;
      existing.mode_changed_at = modeChangedAt;
    } else {
      // Synthesize a default row so subsequent GETs reflect the switch.
      this.users.set(key, {
        user_id: userId,
        tenant_id: tenantId,
        role: 'owner',
        can_field_serve: true,
        current_mode: mode,
        mode_changed_at: modeChangedAt,
      });
    }
    return { modeChangedAt };
  }

  async getTenantIntegrationStatuses(
    _tenantId: string,
  ): Promise<Array<{ provider: string; status: TenantIntegrationStatus; updated_at: Date | null }>> {
    return [];
  }

  private userKey(tenantId: string, userId: string): string {
    return `${tenantId}::${userId}`;
  }
}
