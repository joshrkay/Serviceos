/**
 * Device push tokens — model + persistence seam.
 *
 * The mobile app registers its Expo push token after sign-in so the owner can
 * be reached on their phone (proposal executed, E1 life-safety call). Tokens
 * are tenant-scoped and keyed by the Clerk subject (matching the users table);
 * a user can have several devices, so registration is an upsert on
 * (tenant_id, clerk_user_id, expo_push_token).
 *
 * Layout mirrors the other repos (settings, audit): this module owns the types
 * + the in-memory implementation; `pg-device-token.ts` owns the Postgres one.
 * `routes/devices.ts` and the E1 alert fan-out both talk to the interface only.
 */

export type DevicePlatform = 'ios' | 'android';

/**
 * A token not re-registered in this many days is treated as dead. The app
 * re-registers on every sign-in, so 90 days without a refresh means the
 * device is gone (uninstalled, wiped, token rotated).
 */
export const DEVICE_TOKEN_STALE_AFTER_DAYS = 90;

export const VALID_DEVICE_PLATFORMS: ReadonlyArray<DevicePlatform> = ['ios', 'android'];

/** One registered device. */
export interface DeviceToken {
  clerkUserId: string;
  expoPushToken: string;
  platform: DevicePlatform;
}

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
  /**
   * Every device registered for the tenant. Used by the fan-out senders
   * (E1 tenant alert) — an owner-scoped alert goes to every device the
   * tenant's staff have registered, not just one user's.
   */
  listByTenant(tenantId: string): Promise<DeviceToken[]>;
  /**
   * Delete tokens not re-registered in `olderThanDays` days. Expo tokens go
   * stale silently (app uninstalled, token rotated), and pushing to a dead
   * token is a wasted round trip on every alert. Returns the delete count.
   *
   * Tenant-scoped by design: `device_push_tokens` has FORCE ROW LEVEL
   * SECURITY, so there is no cross-tenant sweep to write — the caller drives
   * this per tenant (see the sweep in app.ts).
   */
  pruneStale(tenantId: string, olderThanDays: number): Promise<number>;
}

/** Expo push tokens look like `ExponentPushToken[xxxx]` / `ExpoPushToken[xxxx]`. */
export function isExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && /^Expo(nent)?PushToken\[[^\]]+\]$/.test(value.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory implementation. Used by tests + the no-DB dev path. Production
// wires PgDeviceTokenRepository in app.ts.
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryDeviceTokenService implements DeviceTokenService {
  /** key: `${tenantId}\0${clerkUserId}\0${token}` */
  private readonly tokens = new Map<string, { platform: DevicePlatform; updatedAt: Date }>();

  private key(tenantId: string, userId: string, token: string): string {
    return `${tenantId}\0${userId}\0${token}`;
  }

  async upsert(
    tenantId: string,
    clerkUserId: string,
    expoPushToken: string,
    platform: DevicePlatform,
  ): Promise<void> {
    this.tokens.set(this.key(tenantId, clerkUserId, expoPushToken), {
      platform,
      updatedAt: new Date(),
    });
  }

  async remove(tenantId: string, clerkUserId: string, expoPushToken: string): Promise<void> {
    this.tokens.delete(this.key(tenantId, clerkUserId, expoPushToken));
  }

  async listByTenant(tenantId: string): Promise<DeviceToken[]> {
    const prefix = `${tenantId}\0`;
    const out: DeviceToken[] = [];
    for (const [key, value] of this.tokens) {
      if (!key.startsWith(prefix)) continue;
      const [, clerkUserId, expoPushToken] = key.split('\0');
      out.push({
        clerkUserId: clerkUserId as string,
        expoPushToken: expoPushToken as string,
        platform: value.platform,
      });
    }
    return out;
  }

  async pruneStale(tenantId: string, olderThanDays: number): Promise<number> {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60_000;
    const prefix = `${tenantId}\0`;
    let deleted = 0;
    for (const [key, value] of [...this.tokens]) {
      if (!key.startsWith(prefix)) continue;
      if (value.updatedAt.getTime() >= cutoff) continue;
      this.tokens.delete(key);
      deleted += 1;
    }
    return deleted;
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

  /** Test helper: backdate a token's `updated_at` so pruneStale can be exercised. */
  setUpdatedAt(tenantId: string, clerkUserId: string, token: string, updatedAt: Date): void {
    const row = this.tokens.get(this.key(tenantId, clerkUserId, token));
    if (row) row.updatedAt = updatedAt;
  }
}
