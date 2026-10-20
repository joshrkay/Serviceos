/**
 * LCR-04 — the VoiceFallbackUrl backfill reads its rows from
 * `tenant_integrations` at REAL Postgres: `subaccount_sid`,
 * `auth_token_primary_enc`, `provider_data->>'phoneNumberSid'`,
 * `provider_data->>'phoneE164'` and `provider_data->>'stub'` are pinned here
 * (a mocked Pool is never the only proof a query works), including the
 * cross-tenant read under `app.system_lookup` that the RLS runtime role needs.
 *
 * Run (Docker-gated):
 *   cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *     --config vitest.integration.config.mts \
 *     test/integration/backfill-twilio-voice-fallback-url.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { decrypt, encrypt } from '../../src/integrations/crypto';
import { listTwilioNumbersForBackfill } from '../../scripts/backfill-twilio-voice-fallback-url';

const ENCRYPTION_KEY = 'c'.repeat(64);
const RUN = crypto.randomInt(100000, 999999);
const DID = `+1830${RUN}1`;
const SUBACCOUNT = `AClcr04bf${RUN}ccccccccccccccccccccc`;

describe('LCR-04 — listTwilioNumbersForBackfill at real Postgres', () => {
  let pool: Pool;
  let liveTenant: string;
  let stubTenant: string;

  async function insertIntegration(tenantId: string, providerData: Record<string, unknown>, creds: boolean) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      await client.query(
        `INSERT INTO tenant_integrations
           (tenant_id, provider, status, provider_data, subaccount_sid, auth_token_primary_enc)
         VALUES ($1, 'twilio', 'full_readiness', $2::jsonb, $3, $4)`,
        [
          tenantId,
          JSON.stringify(providerData),
          creds ? SUBACCOUNT : null,
          creds ? encrypt('backfill-token', ENCRYPTION_KEY) : null,
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    liveTenant = (await createTestTenant(pool)).tenantId;
    stubTenant = (await createTestTenant(pool)).tenantId;
    await insertIntegration(liveTenant, { phoneE164: DID, phoneNumberSid: `PN${RUN}`, messagingServiceSid: 'MG1' }, true);
    await insertIntegration(stubTenant, { phoneE164: '+15005550006', stub: true }, false);
  });

  it('returns every Twilio row with the columns the backfill decrypts and updates from', async () => {
    const rows = await listTwilioNumbersForBackfill(pool);
    const live = rows.find((r) => r.tenantId === liveTenant);
    expect(live).toEqual({
      tenantId: liveTenant,
      subaccountSid: SUBACCOUNT,
      authTokenEnc: expect.any(String),
      phoneNumberSid: `PN${RUN}`,
      phoneE164: DID,
      stub: false,
    });
    expect(decrypt(live!.authTokenEnc!, ENCRYPTION_KEY)).toBe('backfill-token');

    const stub = rows.find((r) => r.tenantId === stubTenant);
    expect(stub).toEqual({
      tenantId: stubTenant,
      subaccountSid: null,
      authTokenEnc: null,
      phoneNumberSid: null,
      phoneE164: '+15005550006',
      stub: true,
    });
  });

  it('--tenant-id narrows the read to one tenant', async () => {
    const rows = await listTwilioNumbersForBackfill(pool, liveTenant);
    expect(rows.map((r) => r.tenantId)).toEqual([liveTenant]);
  });
});
