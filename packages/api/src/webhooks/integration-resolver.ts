import type { Pool } from 'pg';
import type { WebhookRouterDeps } from './routes';

/**
 * The per-tenant inbound-webhook credential resolver, typed against the
 * canonical declaration in `WebhookRouterDeps` so the two can never drift.
 */
export type IntegrationResolver = NonNullable<WebhookRouterDeps['integrationResolver']>;

/**
 * Pg-backed implementation of the per-tenant inbound-webhook credential
 * resolver. Extracted from app.ts (composition-root decomposition).
 *
 * Resolves per-tenant integration credentials for inbound webhook signature
 * verification. Returns null when no row exists or the integration provider
 * doesn't match — recordTwilio / recordSendGrid then 403 with audit.
 *
 * `tenant_integrations` is FORCE RLS, and webhook handlers run OUTSIDE
 * `withTenantTransaction`, so this opens its own dedicated client/transaction
 * and sets the `app.current_tenant_id` GUC, then RESETs it on release to avoid
 * leaking the tenant context onto the next pool checkout.
 */
export function createIntegrationResolver(pool: Pool): IntegrationResolver {
  return async (tenantId, provider) => {
    const { decrypt } = await import('../integrations/crypto');
    const { setTenantContext } = await import('../db/schema');
    const encKey = process.env.TENANT_ENCRYPTION_KEY;

    const client = await pool.connect();
    let rows: Array<{
      subaccount_sid: string | null;
      auth_token_primary_enc: string | null;
      auth_token_secondary_enc: string | null;
      provider_data: Record<string, unknown>;
    }> = [];
    try {
      await client.query('BEGIN');
      await client.query(setTenantContext(tenantId));
      const result = await client.query<{
        subaccount_sid: string | null;
        auth_token_primary_enc: string | null;
        auth_token_secondary_enc: string | null;
        provider_data: Record<string, unknown>;
      }>(
        `SELECT subaccount_sid, auth_token_primary_enc, auth_token_secondary_enc, provider_data
         FROM tenant_integrations
         WHERE tenant_id = $1 AND provider = $2`,
        [tenantId, provider]
      );
      rows = result.rows;
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
      throw err;
    } finally {
      // GUC leak fix: plain `SET app.current_tenant_id` persists past
      // COMMIT/ROLLBACK on the underlying connection. Clear it before
      // release so the next pool checkout doesn't inherit this
      // tenant's context.
      try { await client.query('RESET app.current_tenant_id'); } catch { /* ignore */ }
      client.release();
    }
    const row = rows[0];
    if (!row) return null;
    // Decryption is only needed for Twilio auth tokens. SendGrid integrations
    // store a public verification key (not encrypted) in provider_data, so
    // the resolver shouldn't 403 valid SendGrid webhooks just because
    // TENANT_ENCRYPTION_KEY isn't configured.
    const canDecrypt = Boolean(encKey);
    if (provider === 'twilio' && !canDecrypt) return null;
    return {
      tenantId,
      provider,
      subaccountSid: row.subaccount_sid ?? undefined,
      authTokenPrimary: row.auth_token_primary_enc && canDecrypt
        ? decrypt(row.auth_token_primary_enc, encKey!)
        : undefined,
      authTokenSecondary: row.auth_token_secondary_enc && canDecrypt
        ? decrypt(row.auth_token_secondary_enc, encKey!)
        : undefined,
      sendgridPublicKeyPem: (row.provider_data?.sendgridPublicKeyPem as string | undefined),
    };
  };
}
