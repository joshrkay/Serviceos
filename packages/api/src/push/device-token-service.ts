import { v4 as uuidv4 } from 'uuid';

/**
 * Device push-token storage. The mobile app registers its Expo push token after
 * sign-in so the owner can be notified when a proposal executes. Tokens are
 * tenant-scoped (RLS) and keyed by (tenant_id, expo_push_token) so re-registers
 * upsert rather than duplicate. Persistence is behind a repository interface —
 * Pg in production (app.ts), in-memory in tests.
 */
export type DevicePlatform = 'ios' | 'android';

export interface DeviceToken {
  id: string;
  tenantId: string;
  userId: string;
  expoPushToken: string;
  platform: DevicePlatform;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegisterDeviceTokenInput {
  tenantId: string;
  userId: string;
  expoPushToken: string;
  platform: string;
}

export interface DeviceTokenRepository {
  /** Upsert by (tenantId, expoPushToken); updates user/platform/updatedAt on conflict. */
  register(input: RegisterDeviceTokenInput): Promise<DeviceToken>;
  /** All device tokens for the tenant (used by the notify path). */
  listByTenant(tenantId: string): Promise<DeviceToken[]>;
  /** Remove a token (on sign-out / token rotation). True when a row was deleted. */
  remove(tenantId: string, expoPushToken: string): Promise<boolean>;
  /**
   * Remove every token registered by a user (account deletion). The client
   * can't do its own sign-out cleanup at that point — its credentials are
   * already dead — so the server must purge, or the deleted user's device
   * keeps receiving pushes. `userId` is the Clerk subject, matching what
   * the devices route stores. Returns the number of rows deleted.
   */
  removeAllForUser(tenantId: string, userId: string): Promise<number>;
}

// Expo issues tokens shaped `ExponentPushToken[...]` (legacy) or
// `ExpoPushToken[...]`. Validating the shape keeps junk out of the send path.
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]+\]$/;
const PLATFORMS: ReadonlyArray<DevicePlatform> = ['ios', 'android'];

export function isExpoPushToken(token: string): boolean {
  return EXPO_TOKEN_RE.test(token);
}

/** Returns a list of validation errors (empty = valid). */
export function validateRegisterInput(input: RegisterDeviceTokenInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.userId) errors.push('userId is required');
  if (!input.expoPushToken || !isExpoPushToken(input.expoPushToken)) {
    errors.push('expoPushToken must be a valid Expo push token');
  }
  if (!PLATFORMS.includes(input.platform as DevicePlatform)) {
    errors.push(`platform must be one of ${PLATFORMS.join(', ')}`);
  }
  return errors;
}

export class InMemoryDeviceTokenRepository implements DeviceTokenRepository {
  private tokens = new Map<string, DeviceToken>();

  private key(tenantId: string, token: string): string {
    return `${tenantId}::${token}`;
  }

  async register(input: RegisterDeviceTokenInput): Promise<DeviceToken> {
    const key = this.key(input.tenantId, input.expoPushToken);
    const existing = this.tokens.get(key);
    const now = new Date();
    const record: DeviceToken = existing
      ? { ...existing, userId: input.userId, platform: input.platform as DevicePlatform, updatedAt: now }
      : {
          id: uuidv4(),
          tenantId: input.tenantId,
          userId: input.userId,
          expoPushToken: input.expoPushToken,
          platform: input.platform as DevicePlatform,
          createdAt: now,
          updatedAt: now,
        };
    this.tokens.set(key, record);
    // Token-exclusive ownership (mirrors PgDeviceTokenRepository): the same
    // physical token may belong to only one tenant at a time, so drop it from
    // any other tenant on (re-)register.
    for (const [k, t] of this.tokens) {
      if (t.expoPushToken === input.expoPushToken && t.tenantId !== input.tenantId) {
        this.tokens.delete(k);
      }
    }
    return { ...record };
  }

  async listByTenant(tenantId: string): Promise<DeviceToken[]> {
    return Array.from(this.tokens.values())
      .filter((t) => t.tenantId === tenantId)
      .map((t) => ({ ...t }));
  }

  async remove(tenantId: string, expoPushToken: string): Promise<boolean> {
    return this.tokens.delete(this.key(tenantId, expoPushToken));
  }

  async removeAllForUser(tenantId: string, userId: string): Promise<number> {
    let removed = 0;
    for (const [k, t] of this.tokens) {
      if (t.tenantId === tenantId && t.userId === userId) {
        this.tokens.delete(k);
        removed += 1;
      }
    }
    return removed;
  }
}
