/**
 * Twilio inbound-webhook credential resolution (#1072).
 *
 * The credential that verifies an inbound Twilio webhook MUST belong to the
 * tenant that owns the dialled number. Before this module, the signing
 * credential and the tenant were resolved from two independent body fields:
 * the auth token from `AccountSid`, the tenant from `To`. Nothing checked they
 * agreed, so `requireTwilioSignature` answered "is this signed by SOME tenant"
 * rather than "is this signed by THE tenant that owns the dialled number" — and
 * a tenant holding its own Twilio credential could drive inbound calls into any
 * other tenant simply by putting the victim's (public) DID in `To`.
 *
 * Resolution order — the first match wins:
 *
 *   1. `tenantId`, when the caller already knows it from trusted, non-payload
 *      state (the media-stream upgrade reads it off the in-process session
 *      created by the already-bound /voice webhook).
 *   2. `to` — the dialled number, looked up against
 *      `tenant_integrations.provider_data->>'phoneE164'`, the same mapping
 *      `PgPhoneNumberRepository.findByNumber` uses to pick the tenant the call
 *      will run as. Deliberately the SAME predicate (no status filter): if the
 *      credential lookup and the tenant lookup could disagree about which row
 *      owns a number, the binding this module exists to enforce would be back
 *      to guesswork.
 *   3. `accountSid` — the legacy subaccount-keyed lookup. Only reached when the
 *      payload names no number we own (recording/status callbacks that carry no
 *      dialled number, outbound-leg callbacks whose `To` is the customer). It
 *      cannot be used to reach a tenant by DID: any number a tenant owns is
 *      resolved at step 2 and never falls through to here.
 *   4. The deployment's own `TWILIO_AUTH_TOKEN` — numbers with no tenant
 *      integration row at all, and the single-account deployments that predate
 *      per-tenant subaccounts.
 *
 * At steps 1 and 2, when the payload also carries an `AccountSid` that is NOT
 * the owning tenant's subaccount, the request is REFUSED (403) rather than
 * verified — the mismatch is the attack signature, and refusing on it names the
 * failure instead of letting it read as a corrupt HMAC.
 *
 * The two lookups here are cross-tenant by construction (an inbound webhook
 * arrives with no tenant context — finding the tenant is the whole point), so
 * they run under the `app.system_lookup = 'true'` GUC that migration 074's
 * permissive read policy on `tenant_integrations` gates on, set LOCAL inside a
 * short transaction so it cannot leak onto the next pool checkout.
 */

import type { Pool, PoolClient } from 'pg';
import { createLogger } from '../logging/logger';
import { normalizeE164 } from '../integrations/twilio/phone-number-repository';
import type {
  TwilioAuthTokenGetter,
  TwilioCredentialDecision,
} from './twilio-signature';

const logger = createLogger({
  service: 'telephony.webhook-credential',
  environment: process.env.NODE_ENV || 'development',
});

interface IntegrationRow {
  tenant_id: string;
  subaccount_sid: string | null;
  auth_token_primary_enc: string | null;
}

export interface TwilioWebhookCredentialResolverDeps {
  /** Absent in dev/test boots with no DATABASE_URL — the deployment token is then the only credential. */
  pool?: Pool;
  /**
   * Env readers, evaluated per request so a rotated token / late-set env is
   * picked up exactly as the previous inline resolver's `process.env` reads
   * were. Overridable for tests.
   */
  env?: () => NodeJS.ProcessEnv;
}

/**
 * Run a cross-tenant read against `tenant_integrations` under the
 * `app.system_lookup` GUC. Rolls back before release so a failed lookup can't
 * return a connection to the pool with an open transaction (and the GUC still
 * set) — the same guard the resolvers this replaced carried.
 */
async function systemLookup<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.system_lookup', 'true', true)");
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function findByPhoneNumber(pool: Pool, to: string): Promise<IntegrationRow | null> {
  const normalized = normalizeE164(to);
  if (!normalized) return null;
  return systemLookup(pool, async (client) => {
    const { rows } = await client.query<IntegrationRow>(
      `SELECT tenant_id, subaccount_sid, auth_token_primary_enc
         FROM tenant_integrations
        WHERE provider = 'twilio'
          AND provider_data->>'phoneE164' = $1
        LIMIT 1`,
      [normalized],
    );
    return rows[0] ?? null;
  });
}

async function findByTenant(pool: Pool, tenantId: string): Promise<IntegrationRow | null> {
  return systemLookup(pool, async (client) => {
    const { rows } = await client.query<IntegrationRow>(
      `SELECT tenant_id, subaccount_sid, auth_token_primary_enc
         FROM tenant_integrations
        WHERE provider = 'twilio' AND tenant_id = $1
        LIMIT 1`,
      [tenantId],
    );
    return rows[0] ?? null;
  });
}

async function findBySubaccount(pool: Pool, accountSid: string): Promise<IntegrationRow | null> {
  return systemLookup(pool, async (client) => {
    const { rows } = await client.query<IntegrationRow>(
      `SELECT tenant_id, subaccount_sid, auth_token_primary_enc
         FROM tenant_integrations
        WHERE provider = 'twilio' AND subaccount_sid = $1
        LIMIT 1`,
      [accountSid],
    );
    return rows[0] ?? null;
  });
}

/**
 * Build the per-request credential resolver `requireTwilioSignature` (and the
 * media-stream upgrade) consult. See the file header for the resolution order.
 */
export function createTwilioWebhookCredentialResolver(
  deps: TwilioWebhookCredentialResolverDeps,
): TwilioAuthTokenGetter {
  const readEnv = deps.env ?? (() => process.env);

  return async ({ accountSid, to, tenantId }): Promise<TwilioCredentialDecision> => {
    const env = readEnv();
    const deploymentToken = env.TWILIO_AUTH_TOKEN;
    const deploymentAccountSid = env.TWILIO_ACCOUNT_SID;
    const encKey = env.TENANT_ENCRYPTION_KEY;

    const deploymentFallback = (owningTenantId?: string): TwilioCredentialDecision =>
      deploymentToken
        ? {
            outcome: 'verify',
            authToken: deploymentToken,
            path: 'deployment_fallback',
            ...(owningTenantId ? { tenantId: owningTenantId } : {}),
          }
        : { outcome: 'misconfigured', reason: 'no_twilio_auth_token_configured' };

    const pool = deps.pool;
    if (!pool) return deploymentFallback();

    let owner: IntegrationRow | null = null;
    try {
      if (tenantId) owner = await findByTenant(pool, tenantId);
      else if (to) owner = await findByPhoneNumber(pool, to);
    } catch (err) {
      // A lookup failure must never silently downgrade to "verify with whatever
      // token we have": that is exactly the unbound behaviour #1072 closes.
      // Fail closed and let the operator see it (500 → Twilio retries).
      logger.error('telephony.credential_lookup_failed', {
        error: err instanceof Error ? err.message : String(err),
        ...(tenantId ? { tenantId } : {}),
      });
      return { outcome: 'misconfigured', reason: 'credential_lookup_failed' };
    }

    if (owner) {
      if (accountSid && owner.subaccount_sid && accountSid !== owner.subaccount_sid) {
        logger.warn('telephony.account_sid_mismatch', {
          tenantId: owner.tenant_id,
          // The presented SID is the attacker-controlled field; the tenant's own
          // subaccount SID is never logged next to it.
          presentedAccountSid: accountSid,
        });
        return {
          outcome: 'refuse',
          reason: 'account_sid_not_owned_by_dialled_number_tenant',
          tenantId: owner.tenant_id,
        };
      }

      if (owner.auth_token_primary_enc) {
        if (!encKey) {
          logger.error('telephony.tenant_credential_undecryptable', {
            tenantId: owner.tenant_id,
            reason: 'TENANT_ENCRYPTION_KEY unset',
          });
          return { outcome: 'misconfigured', reason: 'tenant_encryption_key_missing' };
        }
        try {
          const { decrypt } = await import('../integrations/crypto');
          return {
            outcome: 'verify',
            authToken: decrypt(owner.auth_token_primary_enc, encKey),
            path: 'tenant_integration',
            tenantId: owner.tenant_id,
          };
        } catch (err) {
          logger.error('telephony.tenant_credential_undecryptable', {
            tenantId: owner.tenant_id,
            error: err instanceof Error ? err.message : String(err),
          });
          return { outcome: 'misconfigured', reason: 'tenant_credential_undecryptable' };
        }
      }

      // The owning row carries no credential of its own. That is the
      // single-account shape (the number lives on the deployment's own Twilio
      // account, whose token is in env) — legitimate only when the row claims
      // no foreign subaccount. A row naming a subaccount we hold no token for
      // is a provisioning gap, not a call we may accept on the master token.
      if (owner.subaccount_sid && owner.subaccount_sid !== deploymentAccountSid) {
        logger.error('telephony.tenant_credential_missing', {
          tenantId: owner.tenant_id,
        });
        return {
          outcome: 'misconfigured',
          reason: 'tenant_integration_has_no_credential',
          tenantId: owner.tenant_id,
        };
      }
      return deploymentFallback(owner.tenant_id);
    }

    // No tenant owns the number in this payload (or the payload names none).
    // Legacy subaccount-keyed resolution, then the deployment token.
    if (accountSid) {
      let row: IntegrationRow | null = null;
      try {
        row = await findBySubaccount(pool, accountSid);
      } catch (err) {
        logger.error('telephony.credential_lookup_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return { outcome: 'misconfigured', reason: 'credential_lookup_failed' };
      }
      if (row?.auth_token_primary_enc && encKey) {
        try {
          const { decrypt } = await import('../integrations/crypto');
          return {
            outcome: 'verify',
            authToken: decrypt(row.auth_token_primary_enc, encKey),
            path: 'subaccount_lookup',
            tenantId: row.tenant_id,
          };
        } catch (err) {
          logger.error('telephony.tenant_credential_undecryptable', {
            tenantId: row.tenant_id,
            error: err instanceof Error ? err.message : String(err),
          });
          return { outcome: 'misconfigured', reason: 'tenant_credential_undecryptable' };
        }
      }
    }

    return deploymentFallback();
  };
}
