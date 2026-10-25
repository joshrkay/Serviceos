/**
 * P12-001 — the Postgres `UserModeService` behind `GET /api/me`,
 * `POST /api/me/mode` and requireTenant's `req.auth.mode` loader, under the
 * RLS runtime role (raw-pg audit 2026-10-23 §4 P2.1).
 *
 * The three reads go through `withTenantClient`. requireTenant is a per-route
 * gate inside the routers, which app.ts mounts after the `/api`
 * `withTenantTransaction` middleware, so on an ordinary /api request the
 * request transaction is already open for `req.auth.tenantId` when the mode
 * loader runs: the read rides that client and costs no checkout. Where no
 * request transaction exists — the SSE and long-LLM routes the middleware
 * skips, the voice-memo worker's creator-mode lookup — each read is one
 * tenant session of its own.
 *
 * `setMode` deliberately does NOT join the request: it commits in a tenant
 * session of its own (`withTenantSession`), before the route writes its audit
 * row, exactly as the bare `pool.query` it replaces committed on its own
 * pooled connection. So the switch stands even if the request then fails and
 * rolls back (the route has already primed requireTenant's in-process cache
 * with the new mode). Whether the switch should become atomic with its audit
 * row is the owner's call (P2.1); this keeps today's behaviour, pinned by
 * test/integration/user-mode-tenant-context.test.ts.
 */
import type { Pool, PoolClient } from 'pg';
import { withTenantClient } from '../db/tenant-transaction';
import { withTenantSession } from '../db/rls-runtime-role';
import type { UserModeLoader } from '../middleware/auth';
import type { TenantIntegrationStatus } from '../integrations/status-machine';
import {
  DEFAULT_TENANT_TIMEZONE,
  type MeTenantSettings,
  type MeUserRecord,
  type UserModeService,
} from '../routes/me';

async function readUser(client: PoolClient, tenantId: string, userId: string): Promise<MeUserRecord | null> {
  // P12-001 review fix — `userId` here is the Clerk subject
  // (`req.auth.userId` = `payload.sub`), not the UUID PK on
  // `users.id`. Lookup goes through `clerk_user_id`. The
  // returned `user_id` continues to be the Clerk sub so
  // downstream callers (the API surface) stay aligned with
  // the auth-layer identity.
  const r = await client.query(
    `SELECT id, clerk_user_id, tenant_id, role,
            COALESCE(can_field_serve, false) AS can_field_serve,
            COALESCE(current_mode, 'supervisor') AS current_mode,
            mode_changed_at
     FROM users
     WHERE tenant_id = $1 AND clerk_user_id = $2
     LIMIT 1`,
    [tenantId, userId],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0] as Record<string, unknown>;
  return {
    user_id: String(row.clerk_user_id),
    // Sweep-2 S5 — internal users.id UUID; this is what
    // appointment_assignments.technician_id references, so the
    // web technician surfaces resolve THIS, not the Clerk sub.
    internal_user_id: String(row.id),
    tenant_id: String(row.tenant_id),
    role: String(row.role),
    can_field_serve: Boolean(row.can_field_serve),
    current_mode: row.current_mode as MeUserRecord['current_mode'],
    mode_changed_at: row.mode_changed_at ? new Date(row.mode_changed_at as string) : null,
  };
}

async function readTenantSettings(client: PoolClient, tenantId: string): Promise<MeTenantSettings> {
  const r = await client.query(
    `SELECT backup_supervisor_user_id,
            COALESCE(unsupervised_proposal_routing, 'queue_and_sms') AS unsupervised_proposal_routing,
            COALESCE(timezone, $2) AS timezone
     FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
    [tenantId, DEFAULT_TENANT_TIMEZONE],
  );
  if (r.rowCount === 0) {
    return {
      backup_supervisor_user_id: null,
      unsupervised_proposal_routing: 'queue_and_sms',
      timezone: DEFAULT_TENANT_TIMEZONE,
    };
  }
  const row = r.rows[0] as Record<string, unknown>;
  return {
    backup_supervisor_user_id: row.backup_supervisor_user_id ? String(row.backup_supervisor_user_id) : null,
    unsupervised_proposal_routing:
      row.unsupervised_proposal_routing as MeTenantSettings['unsupervised_proposal_routing'],
    timezone: String(row.timezone),
  };
}

async function readIntegrationStatuses(
  client: PoolClient,
  tenantId: string,
): Promise<Array<{ provider: string; status: TenantIntegrationStatus; updated_at: Date | null }>> {
  const r = await client.query(
    `SELECT provider, status, updated_at
     FROM tenant_integrations
     WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows.map((row) => ({
    provider: String(row.provider),
    status: String(row.status) as TenantIntegrationStatus,
    updated_at: row.updated_at ? new Date(String(row.updated_at)) : null,
  }));
}

export function createPgUserModeService(pool: Pool): UserModeService {
  return {
    getUser: (tenantId, userId) => withTenantClient(pool, tenantId, (client) => readUser(client, tenantId, userId)),
    getTenantSettings: (tenantId) => withTenantClient(pool, tenantId, (client) => readTenantSettings(client, tenantId)),
    getTenantIntegrationStatuses: (tenantId) =>
      withTenantClient(pool, tenantId, (client) => readIntegrationStatuses(client, tenantId)),
    async setMode(tenantId, userId, mode) {
      // P12-001 review fix — `userId` is the Clerk subject; match
      // on `clerk_user_id`, not the UUID PK. Without this the
      // UPDATE silently no-ops in production.
      const now = new Date();
      await withTenantSession(pool, tenantId, (client) =>
        client.query(
          `UPDATE users
           SET current_mode = $1, mode_changed_at = $2, updated_at = now()
           WHERE tenant_id = $3 AND clerk_user_id = $4`,
          [mode, now, tenantId, userId],
        ),
      );
      return { modeChangedAt: now };
    },
  };
}

/**
 * requireTenant's mode loader over `service.getUser`. Any failure reads as "no
 * row" (null), which requireTenant turns into its supervisor default: mode is
 * not a security boundary on the request path.
 */
export function createUserModeLoader(service: Pick<UserModeService, 'getUser'>): UserModeLoader {
  return async (userId, tenantId) => {
    try {
      const u = await service.getUser(tenantId, userId);
      return u ? u.current_mode : null;
    } catch {
      return null;
    }
  };
}
