/**
 * Device push-token registration — `POST /api/devices/push-token` and
 * `DELETE /api/devices/push-token`.
 *
 * The mobile app registers its Expo push token after sign-in so the owner can
 * be notified when a proposal executes ("push from day one"). Tokens are
 * tenant-scoped and keyed by the Clerk subject (matching the users table); a
 * user can have several devices, so registration is an upsert on
 * (tenant_id, clerk_user_id, expo_push_token).
 *
 * Following the /api/me pattern, all DB I/O is delegated to a small
 * DeviceTokenService interface: app.ts wires the Pg impl; tests inject the
 * in-memory impl. The route module has no Pg dependency.
 */
import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { AuditRepository, createAuditEvent } from '../audit/audit';

export type DevicePlatform = 'ios' | 'android';

const VALID_PLATFORMS: ReadonlyArray<DevicePlatform> = ['ios', 'android'];

/** Persistence seam for device push tokens (Pg in prod, in-memory in tests). */
export interface DeviceTokenService {
  /** Idempotent upsert of a device's Expo push token for the user. */
  upsert(
    tenantId: string,
    clerkUserId: string,
    expoPushToken: string,
    platform: DevicePlatform,
  ): Promise<void>;
  /** Remove a token (sign-out / token rotation). No-op if absent. */
  remove(tenantId: string, clerkUserId: string, expoPushToken: string): Promise<void>;
}

/** Expo push tokens look like `ExponentPushToken[xxxx]` / `ExpoPushToken[xxxx]`. */
export function isExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && /^Expo(nent)?PushToken\[[^\]]+\]$/.test(value.trim());
}

export function createDevicesRouter(
  service: DeviceTokenService,
  auditRepo: AuditRepository,
): Router {
  const router = Router();

  router.post(
    '/push-token',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const auth = req.auth!;
        const token = (req.body?.token ?? '') as string;
        const platform = (req.body?.platform ?? '') as string;

        if (!isExpoPushToken(token)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'token must be a valid Expo push token' });
          return;
        }
        if (!VALID_PLATFORMS.includes(platform as DevicePlatform)) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: `platform must be one of ${VALID_PLATFORMS.join(', ')}`,
          });
          return;
        }

        await service.upsert(auth.tenantId, auth.userId, token.trim(), platform as DevicePlatform);

        await auditRepo.create(
          createAuditEvent({
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorRole: auth.role,
            eventType: 'device_push_token_registered',
            entityType: 'device_push_token',
            entityId: auth.userId,
            metadata: { platform },
          }),
        );

        res.status(204).send();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to register push token';
        res.status(500).json({ error: 'INTERNAL_ERROR', message });
      }
    },
  );

  router.delete(
    '/push-token',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const auth = req.auth!;
        const token = (req.body?.token ?? '') as string;
        if (!isExpoPushToken(token)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'token must be a valid Expo push token' });
          return;
        }

        await service.remove(auth.tenantId, auth.userId, token.trim());

        await auditRepo.create(
          createAuditEvent({
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorRole: auth.role,
            eventType: 'device_push_token_removed',
            entityType: 'device_push_token',
            entityId: auth.userId,
            metadata: {},
          }),
        );

        res.status(204).send();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to remove push token';
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

export class InMemoryDeviceTokenService implements DeviceTokenService {
  /** key: `${tenantId}\0${clerkUserId}\0${token}` */
  private readonly tokens = new Map<string, { platform: DevicePlatform }>();

  private key(tenantId: string, userId: string, token: string): string {
    return `${tenantId}\0${userId}\0${token}`;
  }

  async upsert(
    tenantId: string,
    clerkUserId: string,
    expoPushToken: string,
    platform: DevicePlatform,
  ): Promise<void> {
    this.tokens.set(this.key(tenantId, clerkUserId, expoPushToken), { platform });
  }

  async remove(tenantId: string, clerkUserId: string, expoPushToken: string): Promise<void> {
    this.tokens.delete(this.key(tenantId, clerkUserId, expoPushToken));
  }

  /** Test helper: tokens currently registered for a user. */
  list(tenantId: string, clerkUserId: string): Array<{ token: string; platform: DevicePlatform }> {
    const prefix = `${tenantId}\0${clerkUserId}\0`;
    const out: Array<{ token: string; platform: DevicePlatform }> = [];
    for (const [key, value] of this.tokens) {
      if (key.startsWith(prefix)) out.push({ token: key.slice(prefix.length), platform: value.platform });
    }
    return out;
  }
}
