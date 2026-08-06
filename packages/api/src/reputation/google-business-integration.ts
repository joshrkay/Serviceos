/**
 * Review-monitoring self-serve — Google Business credential storage on
 * `tenant_integrations` + shared token resolution / refresh helpers.
 *
 * ONE credential shape, one home. The connect flow (routes/
 * googlebusiness-integrations.ts) WRITES it; the poll worker
 * (workers/google-reviews.ts) and reply resolver
 * (reputation/pg-google-business-reply-resolver.ts) READ it through the
 * helpers below — previously each reader carried its own copy-pasted
 * decoder and nothing wrote the row at all (hand-inserted SQL only).
 *
 * Row: `tenant_integrations (tenant_id, provider='google_business')`
 * (UNIQUE per migration 070; provider CHECK widened + `credentials`
 * JSONB added by migration 155 — no new migration needed):
 *
 *   credentials = {
 *     accessTokenEnc:       AES-256-GCM via TENANT_ENCRYPTION_KEY,
 *     refreshTokenEnc:      AES-256-GCM via TENANT_ENCRYPTION_KEY,
 *     accessTokenExpiresAt: ISO timestamp,
 *     providerData: { accountId, locationId },
 *   }
 *
 * Legacy hand-seeded rows with plaintext `accessToken` / top-level
 * `accountId`/`locationId` keys stay readable (the worker always
 * accepted both shapes; keeping that keeps existing tenants alive).
 *
 * Cache invalidation: `createCredentialResolver` memoizes rows —
 * INCLUDING nulls for tenants with no row — and only invalidates on a
 * `tenant_integration_rotated` NOTIFY. Every Pg write below therefore
 * fires `pg_notify('tenant_integration_rotated', '<tenantId>:google_business')`;
 * without it a fresh connect would stay invisible to the poll worker
 * until process restart.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { ValidationError } from '../shared/errors';
import { encrypt, decrypt } from '../integrations/crypto';
import type { CredentialRow } from '../integrations/credentials';
import {
  GoogleBusinessAuthError,
  GoogleBusinessOAuthConfig,
  GoogleFetch,
  refreshAccessToken,
} from './google-business-client';

export const GOOGLE_BUSINESS_PROVIDER = 'google_business';

/**
 * Backoff applied (via the existing `review_poll_state` mechanism) when
 * a tenant's credentials are irreparably broken — refresh grant failed
 * or Google keeps 401ing a freshly-minted token. 1h = the poll-state
 * backoff cap; the status endpoint surfaces `backoffUntil` so the
 * degradation is visible, and each post-backoff sweep re-attempts (and
 * re-extends on continued failure) instead of hammering Google.
 */
export const GOOGLE_BUSINESS_AUTH_BACKOFF_SECONDS = 3600;

const ENCRYPTION_KEY_VAR = 'TENANT_ENCRYPTION_KEY';

function getKey(): string {
  const key = process.env[ENCRYPTION_KEY_VAR];
  if (!key) {
    throw new ValidationError(
      `${ENCRYPTION_KEY_VAR} env var is required for Google Business token storage`,
    );
  }
  return key;
}

/** The credentials JSONB shape (writer side + both legacy read fallbacks). */
interface StoredGoogleBusinessCredentials {
  accessTokenEnc?: string;
  refreshTokenEnc?: string;
  accessTokenExpiresAt?: string;
  providerData?: { accountId?: string; locationId?: string };
  /** dev/test + legacy hand-seeded plaintext fallbacks */
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  locationId?: string;
}

export interface GoogleBusinessTokens {
  accessToken: string;
  /** Null when the row predates the connect flow (hand-seeded, no refresh). */
  refreshToken: string | null;
  /** Null when the row doesn't record an expiry (hand-seeded). */
  expiresAt: Date | null;
}

/**
 * Decode the token set from a credential row. Plaintext keys win over
 * encrypted ones (dev/test shape); encrypted keys require `encKey`.
 * Returns null when no access token is recoverable — callers treat
 * that as "misconfigured tenant", not "throttle".
 */
export function resolveGoogleBusinessTokens(
  credRow: CredentialRow,
  encKey: string | undefined,
): GoogleBusinessTokens | null {
  const creds = (credRow.credentials ?? {}) as StoredGoogleBusinessCredentials;

  let accessToken: string | null = null;
  if (creds.accessToken) {
    accessToken = creds.accessToken;
  } else if (creds.accessTokenEnc && encKey) {
    try {
      accessToken = decrypt(creds.accessTokenEnc, encKey);
    } catch {
      accessToken = null;
    }
  }
  if (!accessToken) return null;

  let refreshToken: string | null = null;
  if (creds.refreshToken) {
    refreshToken = creds.refreshToken;
  } else if (creds.refreshTokenEnc && encKey) {
    try {
      refreshToken = decrypt(creds.refreshTokenEnc, encKey);
    } catch {
      refreshToken = null;
    }
  }

  let expiresAt: Date | null = null;
  if (creds.accessTokenExpiresAt) {
    const parsed = new Date(creds.accessTokenExpiresAt);
    if (Number.isFinite(parsed.getTime())) expiresAt = parsed;
  }

  return { accessToken, refreshToken, expiresAt };
}

/**
 * Extract `{accountId, locationId}` from a credential row, accepting
 * both nested (`credentials.providerData.*` — the connect-flow shape)
 * and hoisted top-level keys (legacy hand-seeded rows).
 */
export function resolveGoogleBusinessLocation(credRow: CredentialRow): {
  accountId?: string;
  locationId?: string;
} {
  const creds = (credRow.credentials ?? {}) as StoredGoogleBusinessCredentials;
  if (creds.providerData) {
    const { accountId, locationId } = creds.providerData;
    return {
      ...(accountId !== undefined ? { accountId } : {}),
      ...(locationId !== undefined ? { locationId } : {}),
    };
  }
  return {
    ...(creds.accountId !== undefined ? { accountId: creds.accountId } : {}),
    ...(creds.locationId !== undefined ? { locationId: creds.locationId } : {}),
  };
}

/** Minimal writer surface the refresh path needs (worker + resolver dep). */
export interface GoogleBusinessCredentialStore {
  persistRotatedAccessToken(
    tenantId: string,
    accessToken: string,
    expiresAt: Date,
  ): Promise<void>;
}

export interface GoogleBusinessAuthRetryOptions<T> {
  tenantId: string;
  tokens: GoogleBusinessTokens;
  config: GoogleBusinessOAuthConfig | null | undefined;
  store: GoogleBusinessCredentialStore | null | undefined;
  fetchFn?: GoogleFetch;
  /** Invoked after a successful rotation so pagination loops can keep
   *  using the fresh token for subsequent pages. */
  onRotated?: (accessToken: string) => void;
  call: (accessToken: string) => Promise<T>;
}

/**
 * Refresh-on-401, retry ONCE. The single shared implementation of the
 * expired-token dance:
 *
 *   1. Run `call` with the stored access token.
 *   2. On {@link GoogleBusinessAuthError} (401): refresh via the stored
 *      refresh token, persist the rotated access token, retry once.
 *   3. Anything still failing propagates: a failed refresh grant and a
 *      post-refresh 401 both surface as GoogleBusinessAuthError, which
 *      callers turn into a VISIBLE degradation (worker → poll-state
 *      backoff; reply resolver → null context → explicit sub-action
 *      failure). Missing refresh token / config short-circuits to the
 *      same propagation — there is nothing to retry with.
 *
 * Non-auth errors (429 quota, schema drift, 5xx) pass through untouched.
 */
export async function callWithGoogleBusinessAuthRetry<T>(
  opts: GoogleBusinessAuthRetryOptions<T>,
): Promise<T> {
  try {
    return await opts.call(opts.tokens.accessToken);
  } catch (err) {
    if (!(err instanceof GoogleBusinessAuthError)) throw err;
    if (!opts.tokens.refreshToken || !opts.config) throw err;

    // Throws GoogleBusinessAuthError itself when the grant is dead.
    const rotated = await refreshAccessToken(
      opts.config,
      opts.tokens.refreshToken,
      opts.fetchFn ?? fetch,
    );
    if (opts.store) {
      await opts.store.persistRotatedAccessToken(
        opts.tenantId,
        rotated.accessToken,
        rotated.expiresAt,
      );
    }
    opts.onRotated?.(rotated.accessToken);
    // Exactly one retry — a second 401 propagates to the caller.
    return await opts.call(rotated.accessToken);
  }
}

/* ───────────────────── Integration repository ───────────────────── */

export interface GoogleBusinessIntegrationSummary {
  /** tenant_integrations.id (audit entity id). */
  id: string;
  tenantId: string;
  status: string;
  accountId: string | null;
  locationId: string | null;
  updatedAt: Date;
}

export interface UpsertGoogleBusinessIntegrationInput {
  tenantId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  accountId?: string;
  locationId?: string;
}

export interface GoogleBusinessIntegrationRepository
  extends GoogleBusinessCredentialStore {
  /** Upsert keyed on (tenant_id, 'google_business'). Reconnect-safe. */
  upsert(
    input: UpsertGoogleBusinessIntegrationInput,
  ): Promise<GoogleBusinessIntegrationSummary>;
  /** Metadata for the status endpoint — never returns token material. */
  get(tenantId: string): Promise<GoogleBusinessIntegrationSummary | null>;
  /**
   * Hard-delete the row. The poll worker treats "no row" as a silent
   * skip (many tenants legitimately have no GBP), so deletion — not a
   * status flip — is what stops per-sweep failure noise after
   * disconnect. The audit event is the durable record.
   */
  disconnect(tenantId: string): Promise<boolean>;
}

function buildCredentialsJson(
  input: UpsertGoogleBusinessIntegrationInput,
): Record<string, unknown> {
  const key = getKey();
  return {
    accessTokenEnc: encrypt(input.accessToken, key),
    refreshTokenEnc: encrypt(input.refreshToken, key),
    accessTokenExpiresAt: input.accessTokenExpiresAt.toISOString(),
    providerData: {
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.locationId !== undefined
        ? { locationId: input.locationId }
        : {}),
    },
  };
}

function summaryFromCredentials(
  id: string,
  tenantId: string,
  status: string,
  credentials: Record<string, unknown>,
  updatedAt: Date,
): GoogleBusinessIntegrationSummary {
  const { accountId, locationId } = resolveGoogleBusinessLocation({
    tenant_id: tenantId,
    provider: GOOGLE_BUSINESS_PROVIDER,
    credentials,
    credential_version: 0,
  });
  return {
    id,
    tenantId,
    status,
    accountId: accountId ?? null,
    locationId: locationId ?? null,
    updatedAt,
  };
}

/**
 * In-memory implementation (tests + pool-less dev boot). Stores the
 * SAME credentials JSON the Pg repo writes — including real encryption
 * via TENANT_ENCRYPTION_KEY — and doubles as a `CredentialResolver`
 * (`getCredential`/`close`) so tests can hand it straight to
 * `runGoogleReviewsSweep` and prove the worker reads what the connect
 * flow wrote.
 */
export class InMemoryGoogleBusinessIntegrationRepository
  implements GoogleBusinessIntegrationRepository
{
  private rows = new Map<
    string,
    { id: string; row: CredentialRow; status: string; updatedAt: Date }
  >();

  async upsert(
    input: UpsertGoogleBusinessIntegrationInput,
  ): Promise<GoogleBusinessIntegrationSummary> {
    if (!input.tenantId) {
      throw new ValidationError('tenantId is required');
    }
    const existing = this.rows.get(input.tenantId);
    const credentials = buildCredentialsJson(input);
    const entry = {
      id: existing?.id ?? uuidv4(),
      row: {
        tenant_id: input.tenantId,
        provider: GOOGLE_BUSINESS_PROVIDER,
        credentials,
        credential_version: (existing?.row.credential_version ?? 0) + 1,
      },
      status: 'full_readiness',
      updatedAt: new Date(),
    };
    this.rows.set(input.tenantId, entry);
    return summaryFromCredentials(
      entry.id,
      input.tenantId,
      entry.status,
      credentials,
      entry.updatedAt,
    );
  }

  async get(tenantId: string): Promise<GoogleBusinessIntegrationSummary | null> {
    const entry = this.rows.get(tenantId);
    if (!entry) return null;
    return summaryFromCredentials(
      entry.id,
      tenantId,
      entry.status,
      entry.row.credentials,
      entry.updatedAt,
    );
  }

  async disconnect(tenantId: string): Promise<boolean> {
    return this.rows.delete(tenantId);
  }

  async persistRotatedAccessToken(
    tenantId: string,
    accessToken: string,
    expiresAt: Date,
  ): Promise<void> {
    const entry = this.rows.get(tenantId);
    if (!entry) return;
    const next: Record<string, unknown> = {
      ...entry.row.credentials,
      accessTokenEnc: encrypt(accessToken, getKey()),
      accessTokenExpiresAt: expiresAt.toISOString(),
    };
    // Drop any stale plaintext token so the rotated one wins on read.
    delete next.accessToken;
    entry.row = {
      ...entry.row,
      credentials: next,
      credential_version: entry.row.credential_version + 1,
    };
    entry.updatedAt = new Date();
    this.rows.set(tenantId, entry);
  }

  /* CredentialResolver compatibility (worker read path in tests). */
  async getCredential(
    tenantId: string,
    provider: string,
  ): Promise<CredentialRow | null> {
    if (provider !== GOOGLE_BUSINESS_PROVIDER) return null;
    const entry = this.rows.get(tenantId);
    return entry ? { ...entry.row } : null;
  }

  async close(): Promise<void> {
    // no-op — interface parity with CredentialResolver
  }
}

/**
 * Postgres implementation. Extends PgBaseRepository so every query runs
 * under `withTenant` — tenant_integrations is FORCE RLS (migration 074)
 * and the OAuth callback path runs before any tenant middleware.
 */
export class PgGoogleBusinessIntegrationRepository
  extends PgBaseRepository
  implements GoogleBusinessIntegrationRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async upsert(
    input: UpsertGoogleBusinessIntegrationInput,
  ): Promise<GoogleBusinessIntegrationSummary> {
    const credentials = buildCredentialsJson(input);
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO tenant_integrations (tenant_id, provider, status, credentials)
         VALUES ($1, $2, 'full_readiness', $3::jsonb)
         ON CONFLICT (tenant_id, provider) DO UPDATE SET
           credentials = EXCLUDED.credentials,
           status = 'full_readiness',
           credential_version = tenant_integrations.credential_version + 1,
           updated_at = NOW()
         RETURNING id, status, credentials, updated_at`,
        [input.tenantId, GOOGLE_BUSINESS_PROVIDER, JSON.stringify(credentials)],
      );
      // Flush the CredentialResolver's in-process cache (it memoizes
      // nulls too — without this a fresh connect is invisible to the
      // poll worker until restart). Fires on COMMIT.
      await client.query(`SELECT pg_notify('tenant_integration_rotated', $1)`, [
        `${input.tenantId}:${GOOGLE_BUSINESS_PROVIDER}`,
      ]);
      const row = result.rows[0] as {
        id: string;
        status: string;
        credentials: Record<string, unknown>;
        updated_at: string;
      };
      return summaryFromCredentials(
        row.id,
        input.tenantId,
        row.status,
        row.credentials,
        new Date(row.updated_at),
      );
    });
  }

  async get(tenantId: string): Promise<GoogleBusinessIntegrationSummary | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, status, credentials, updated_at
           FROM tenant_integrations
          WHERE tenant_id = $1 AND provider = $2`,
        [tenantId, GOOGLE_BUSINESS_PROVIDER],
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0] as {
        id: string;
        status: string;
        credentials: Record<string, unknown>;
        updated_at: string;
      };
      return summaryFromCredentials(
        row.id,
        tenantId,
        row.status,
        row.credentials,
        new Date(row.updated_at),
      );
    });
  }

  async disconnect(tenantId: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM tenant_integrations
          WHERE tenant_id = $1 AND provider = $2`,
        [tenantId, GOOGLE_BUSINESS_PROVIDER],
      );
      await client.query(`SELECT pg_notify('tenant_integration_rotated', $1)`, [
        `${tenantId}:${GOOGLE_BUSINESS_PROVIDER}`,
      ]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async persistRotatedAccessToken(
    tenantId: string,
    accessToken: string,
    expiresAt: Date,
  ): Promise<void> {
    const key = getKey();
    const accessTokenEnc = encrypt(accessToken, key);
    await this.withTenant(tenantId, async (client) => {
      // Merge-update: rotate only the access token + expiry, keep the
      // refresh token and providerData. `- 'accessToken'` drops any
      // legacy plaintext token so the rotated encrypted one wins on
      // read (plaintext takes precedence in the resolver).
      await client.query(
        `UPDATE tenant_integrations
            SET credentials = (credentials - 'accessToken')
                  || jsonb_build_object(
                       'accessTokenEnc', $3::text,
                       'accessTokenExpiresAt', $4::text
                     ),
                credential_version = credential_version + 1,
                updated_at = NOW()
          WHERE tenant_id = $1 AND provider = $2`,
        [
          tenantId,
          GOOGLE_BUSINESS_PROVIDER,
          accessTokenEnc,
          expiresAt.toISOString(),
        ],
      );
      await client.query(`SELECT pg_notify('tenant_integration_rotated', $1)`, [
        `${tenantId}:${GOOGLE_BUSINESS_PROVIDER}`,
      ]);
    });
  }
}
