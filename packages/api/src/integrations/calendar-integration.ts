import { v4 as uuidv4 } from 'uuid';
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { ValidationError } from '../shared/errors';
import { encrypt, decrypt } from './crypto';

/**
 * Tier 4 (Calendar sync — PR 1). Per-user Google Calendar OAuth
 * connection. Each technician/dispatcher connects their own personal
 * calendar; tokens are stored encrypted at rest using the existing
 * AES-256-GCM helper.
 *
 * Token refresh lives on this service (not the OAuth route) so any
 * call site that needs a fresh access token — appointment push,
 * future free/busy lookup — can `getAccessToken(userId)` and have
 * the refresh + persist happen transparently.
 */

export type CalendarProvider = 'google';
export type CalendarStatus = 'active' | 'expired' | 'revoked';

export interface CalendarIntegration {
  id: string;
  tenantId: string;
  /** Clerk subject. Stored as text because the webhook race makes
   *  users.id occasionally unavailable when first connecting. */
  userId: string;
  provider: CalendarProvider;
  /** Encrypted at rest. Use `decryptedAccessToken()` to read. */
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  accessTokenExpiresAt: Date;
  externalAccountEmail: string;
  calendarId: string;
  status: CalendarStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertCalendarIntegrationInput {
  tenantId: string;
  userId: string;
  provider: CalendarProvider;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  externalAccountEmail: string;
  calendarId?: string;
}

export interface CalendarIntegrationRepository {
  /** Upsert keyed on (tenant_id, user_id, provider). Reconnect-safe. */
  upsert(input: UpsertCalendarIntegrationInput): Promise<CalendarIntegration>;
  findByUser(
    tenantId: string,
    userId: string,
    provider?: CalendarProvider,
  ): Promise<CalendarIntegration | null>;
  /** Used by the appointment-push hook to enumerate connected techs. */
  findActiveByTenant(tenantId: string): Promise<CalendarIntegration[]>;
  /** Refresh path — bumps the access token + expiry without changing
   *  the refresh token. tenantId is required so the Pg implementation
   *  can route through `withTenant` and satisfy RLS (PR 320 review P1). */
  updateAccessToken(
    tenantId: string,
    id: string,
    accessTokenEncrypted: string,
    accessTokenExpiresAt: Date,
  ): Promise<CalendarIntegration | null>;
  setStatus(
    tenantId: string,
    id: string,
    status: CalendarStatus,
  ): Promise<CalendarIntegration | null>;
  /** Soft delete. Disconnects on the UI side; keeps the row around for
   *  audit. Future reconnect on the same (tenant, user, provider)
   *  upserts and flips status back to 'active'. */
  revoke(tenantId: string, userId: string, provider: CalendarProvider): Promise<boolean>;
}

export interface OAuthStateRepository {
  create(input: {
    tenantId: string;
    userId: string;
    provider: CalendarProvider;
    redirectAfter?: string;
  }): Promise<{ id: string }>;
  /** Atomic consume: mark consumed_at AND return the row only if
   *  it was unconsumed + not expired. Prevents replay. */
  consume(id: string): Promise<{
    tenantId: string;
    userId: string;
    provider: CalendarProvider;
    redirectAfter?: string;
  } | null>;
}

const ENCRYPTION_KEY_VAR = 'TENANT_ENCRYPTION_KEY';

function getKey(): string {
  const key = process.env[ENCRYPTION_KEY_VAR];
  if (!key) {
    throw new ValidationError(
      `${ENCRYPTION_KEY_VAR} env var is required for calendar token storage`,
    );
  }
  return key;
}

export function decryptAccessToken(integration: CalendarIntegration): string {
  return decrypt(integration.accessTokenEncrypted, getKey());
}

export function decryptRefreshToken(integration: CalendarIntegration): string {
  return decrypt(integration.refreshTokenEncrypted, getKey());
}

export function encryptToken(token: string): string {
  return encrypt(token, getKey());
}

/* ───────────────────── In-memory implementations (tests) ───────────────────── */

export class InMemoryCalendarIntegrationRepository
  implements CalendarIntegrationRepository
{
  private rows: Map<string, CalendarIntegration> = new Map();

  async upsert(input: UpsertCalendarIntegrationInput): Promise<CalendarIntegration> {
    if (!input.tenantId || !input.userId || !input.provider) {
      throw new ValidationError('tenantId, userId, and provider are required');
    }
    const existing = await this.findByUser(input.tenantId, input.userId, input.provider);
    const now = new Date();
    const next: CalendarIntegration = {
      id: existing?.id ?? uuidv4(),
      tenantId: input.tenantId,
      userId: input.userId,
      provider: input.provider,
      accessTokenEncrypted: encryptToken(input.accessToken),
      refreshTokenEncrypted: encryptToken(input.refreshToken),
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      externalAccountEmail: input.externalAccountEmail,
      calendarId: input.calendarId ?? 'primary',
      status: 'active',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(next.id, next);
    return { ...next };
  }

  async findByUser(
    tenantId: string,
    userId: string,
    provider: CalendarProvider = 'google',
  ): Promise<CalendarIntegration | null> {
    for (const row of this.rows.values()) {
      if (
        row.tenantId === tenantId &&
        row.userId === userId &&
        row.provider === provider
      ) {
        return { ...row };
      }
    }
    return null;
  }

  async findActiveByTenant(tenantId: string): Promise<CalendarIntegration[]> {
    return Array.from(this.rows.values())
      .filter((r) => r.tenantId === tenantId && r.status === 'active')
      .map((r) => ({ ...r }));
  }

  async updateAccessToken(
    tenantId: string,
    id: string,
    accessTokenEncrypted: string,
    accessTokenExpiresAt: Date,
  ): Promise<CalendarIntegration | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    const next = { ...r, accessTokenEncrypted, accessTokenExpiresAt, updatedAt: new Date() };
    this.rows.set(id, next);
    return { ...next };
  }

  async setStatus(
    tenantId: string,
    id: string,
    status: CalendarStatus,
  ): Promise<CalendarIntegration | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    const next = { ...r, status, updatedAt: new Date() };
    this.rows.set(id, next);
    return { ...next };
  }

  async revoke(
    tenantId: string,
    userId: string,
    provider: CalendarProvider,
  ): Promise<boolean> {
    const row = await this.findByUser(tenantId, userId, provider);
    if (!row) return false;
    await this.setStatus(tenantId, row.id, 'revoked');
    return true;
  }
}

export class InMemoryOAuthStateRepository implements OAuthStateRepository {
  private rows: Map<
    string,
    {
      tenantId: string;
      userId: string;
      provider: CalendarProvider;
      redirectAfter?: string;
      expiresAt: Date;
      consumedAt: Date | null;
    }
  > = new Map();

  async create(input: {
    tenantId: string;
    userId: string;
    provider: CalendarProvider;
    redirectAfter?: string;
  }): Promise<{ id: string }> {
    const id = uuidv4();
    this.rows.set(id, {
      ...input,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      consumedAt: null,
    });
    return { id };
  }

  async consume(id: string): Promise<{
    tenantId: string;
    userId: string;
    provider: CalendarProvider;
    redirectAfter?: string;
  } | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    if (row.consumedAt) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;
    row.consumedAt = new Date();
    this.rows.set(id, row);
    return {
      tenantId: row.tenantId,
      userId: row.userId,
      provider: row.provider,
      redirectAfter: row.redirectAfter,
    };
  }
}

/* ───────────────────── Pg implementations ───────────────────── */

/**
 * Pg implementation. Extends PgBaseRepository so every query routes
 * through `withTenant` — required for the RLS policy on
 * user_calendar_integrations (`tenant_id = current_setting(
 * 'app.current_tenant_id')`). The OAuth callback path runs BEFORE
 * the global tenant-transaction middleware, so without an explicit
 * SET LOCAL the queries would be RLS-rejected (PR 320 review P1).
 */
export class PgCalendarIntegrationRepository
  extends PgBaseRepository
  implements CalendarIntegrationRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  private map(row: Record<string, unknown>): CalendarIntegration {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      userId: row.user_id as string,
      provider: row.provider as CalendarProvider,
      accessTokenEncrypted: row.access_token_encrypted as string,
      refreshTokenEncrypted: row.refresh_token_encrypted as string,
      accessTokenExpiresAt: new Date(row.access_token_expires_at as string),
      externalAccountEmail: row.external_account_email as string,
      calendarId: row.calendar_id as string,
      status: row.status as CalendarStatus,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  async upsert(input: UpsertCalendarIntegrationInput): Promise<CalendarIntegration> {
    const accessTokenEncrypted = encryptToken(input.accessToken);
    const refreshTokenEncrypted = encryptToken(input.refreshToken);
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO user_calendar_integrations
           (tenant_id, user_id, provider, access_token_encrypted,
            refresh_token_encrypted, access_token_expires_at,
            external_account_email, calendar_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
         ON CONFLICT (tenant_id, user_id, provider) DO UPDATE SET
           access_token_encrypted = EXCLUDED.access_token_encrypted,
           refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
           access_token_expires_at = EXCLUDED.access_token_expires_at,
           external_account_email = EXCLUDED.external_account_email,
           calendar_id = EXCLUDED.calendar_id,
           status = 'active',
           updated_at = NOW()
         RETURNING *`,
        [
          input.tenantId,
          input.userId,
          input.provider,
          accessTokenEncrypted,
          refreshTokenEncrypted,
          input.accessTokenExpiresAt,
          input.externalAccountEmail,
          input.calendarId ?? 'primary',
        ],
      );
      return this.map(result.rows[0] as Record<string, unknown>);
    });
  }

  async findByUser(
    tenantId: string,
    userId: string,
    provider: CalendarProvider = 'google',
  ): Promise<CalendarIntegration | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM user_calendar_integrations
         WHERE tenant_id = $1 AND user_id = $2 AND provider = $3`,
        [tenantId, userId, provider],
      );
      return result.rows.length > 0
        ? this.map(result.rows[0] as Record<string, unknown>)
        : null;
    });
  }

  async findActiveByTenant(tenantId: string): Promise<CalendarIntegration[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM user_calendar_integrations
         WHERE tenant_id = $1 AND status = 'active'`,
        [tenantId],
      );
      return result.rows.map((r) => this.map(r as Record<string, unknown>));
    });
  }

  async updateAccessToken(
    tenantId: string,
    id: string,
    accessTokenEncrypted: string,
    accessTokenExpiresAt: Date,
  ): Promise<CalendarIntegration | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE user_calendar_integrations
         SET access_token_encrypted = $1,
             access_token_expires_at = $2,
             updated_at = NOW()
         WHERE id = $3 AND tenant_id = $4
         RETURNING *`,
        [accessTokenEncrypted, accessTokenExpiresAt, id, tenantId],
      );
      return result.rows.length > 0
        ? this.map(result.rows[0] as Record<string, unknown>)
        : null;
    });
  }

  async setStatus(
    tenantId: string,
    id: string,
    status: CalendarStatus,
  ): Promise<CalendarIntegration | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE user_calendar_integrations
         SET status = $1, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3
         RETURNING *`,
        [status, id, tenantId],
      );
      return result.rows.length > 0
        ? this.map(result.rows[0] as Record<string, unknown>)
        : null;
    });
  }

  async revoke(
    tenantId: string,
    userId: string,
    provider: CalendarProvider,
  ): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE user_calendar_integrations
         SET status = 'revoked', updated_at = NOW()
         WHERE tenant_id = $1 AND user_id = $2 AND provider = $3
           AND status != 'revoked'`,
        [tenantId, userId, provider],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}

export class PgOAuthStateRepository implements OAuthStateRepository {
  constructor(private pool: Pool) {}

  async create(input: {
    tenantId: string;
    userId: string;
    provider: CalendarProvider;
    redirectAfter?: string;
  }): Promise<{ id: string }> {
    const result = await this.pool.query(
      `INSERT INTO oauth_states (tenant_id, user_id, provider, redirect_after)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [input.tenantId, input.userId, input.provider, input.redirectAfter ?? null],
    );
    return { id: result.rows[0].id as string };
  }

  /** Atomic consume — single UPDATE protects against concurrent
   *  callbacks (e.g. user double-clicks the OAuth redirect). */
  async consume(id: string): Promise<{
    tenantId: string;
    userId: string;
    provider: CalendarProvider;
    redirectAfter?: string;
  } | null> {
    const result = await this.pool.query(
      `UPDATE oauth_states
       SET consumed_at = NOW()
       WHERE id = $1
         AND consumed_at IS NULL
         AND expires_at > NOW()
       RETURNING tenant_id, user_id, provider, redirect_after`,
      [id],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return {
      tenantId: row.tenant_id as string,
      userId: row.user_id as string,
      provider: row.provider as CalendarProvider,
      redirectAfter: (row.redirect_after as string) ?? undefined,
    };
  }
}
