import type { Pool } from 'pg';
import { isValidTenantId } from '../db/schema';
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
 * verification. Returns null when the tenant id is malformed, no row exists,
 * or the integration provider doesn't match.
 *
 * The webhook route handlers gate `tenantId` on `isValidTenantId` up front, so
 * the malformed-id check here is defense-in-depth (this is an exported,
 * independently-callable function): without it a non-UUID would acquire a pool
 * client and only then throw inside setTenantContext.
 *
 * `tenant_integrations` is FORCE RLS, and webhook handlers run OUTSIDE
 * `withTenantTransaction`, so this opens its own dedicated client/transaction
 * and sets the `app.current_tenant_id` GUC, then RESETs it on release to avoid
 * leaking the tenant context onto the next pool checkout.
 */
export function createIntegrationResolver(pool: Pool): IntegrationResolver {
  return async (tenantId, provider) => {
    // Reject malformed tenant ids before touching the pool so a bad URL param
    // can't reach setTenantContext's throw on a checked-out client.
    if (!isValidTenantId(tenantId)) return null;
    const { decrypt } = await import('../integrations/crypto');
    const { applyTenantContext } = await import('../db/rls-runtime-role');
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
      await applyTenantContext(client, tenantId, { transactional: true });
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

/**
 * Pg-backed resolver for a tenant's per-tenant Vapi webhook secret
 * (`tenant_settings.vapi_webhook_secret`). Mirrors createIntegrationResolver's
 * tenant-context discipline: reads under the tenant's own RLS context on a
 * dedicated client and RESETs the GUC on release. Returns null when the id is
 * malformed, the row is absent, or the secret hasn't been provisioned yet — the
 * /vapi handler then falls back to the global secret (transitional).
 */
export function createVapiSecretResolver(
  pool: Pool,
): (tenantId: string) => Promise<string | null> {
  return async (tenantId) => {
    if (!isValidTenantId(tenantId)) return null;
    const { applyTenantContext } = await import('../db/rls-runtime-role');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await applyTenantContext(client, tenantId, { transactional: true });
      const { rows } = await client.query<{ vapi_webhook_secret: string | null }>(
        `SELECT vapi_webhook_secret FROM tenant_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      await client.query('COMMIT');
      return rows[0]?.vapi_webhook_secret ?? null;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
      throw err;
    } finally {
      try { await client.query('RESET app.current_tenant_id'); } catch { /* ignore */ }
      client.release();
    }
  };
}
