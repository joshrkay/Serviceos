/**
 * PRIV-4 — the Vapi notice backfill reads its rows at REAL Postgres: the
 * cross-tenant `tenant_integrations` read under `app.system_lookup`, then
 * `vapi_assistant_id`, `business_name`, `voice_greeting`, `services_offered`
 * and `default_language` from `tenant_settings` under each tenant's own RLS
 * context (a mocked Pool is never the only proof a query works). The same
 * columns back `refreshVapiFirstMessage`, the language-change re-push.
 *
 * Run (Docker-gated):
 *   cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *     --config vitest.integration.config.mts \
 *     test/integration/backfill-vapi-assistant-notice.test.ts
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { listVapiAssistantsForBackfill } from '../../scripts/backfill-vapi-assistant-notice';
import { refreshVapiFirstMessage } from '../../src/voice/voice-config';
import { tenantQuery } from '../../src/workers/tenant-query';

describe('PRIV-4 — listVapiAssistantsForBackfill at real Postgres', () => {
  let pool: Pool;
  let vapiTenant: string;
  let plainTenant: string;

  async function seed(tenantId: string, assistantId: string | null, language: 'en' | 'es') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      await client.query(
        `INSERT INTO tenant_integrations (tenant_id, provider, status, provider_data)
         VALUES ($1, 'twilio', 'full_readiness', '{}'::jsonb)`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO tenant_settings
           (id, tenant_id, business_name, voice_greeting, services_offered, vapi_assistant_id, default_language)
         VALUES (gen_random_uuid(), $1, 'Plomería Sol', 'Gracias por llamar.', ARRAY['drains']::text[], $2, $3)`,
        [tenantId, assistantId, language],
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
    vapiTenant = (await createTestTenant(pool)).tenantId;
    plainTenant = (await createTestTenant(pool)).tenantId;
    await seed(vapiTenant, 'asst_priv4', 'es');
    await seed(plainTenant, null, 'en');
  });

  it("returns each Twilio tenant's assistant and the settings its first message is built from", async () => {
    const rows = await listVapiAssistantsForBackfill(pool);
    expect(rows.find((r) => r.tenantId === vapiTenant)).toEqual({
      tenantId: vapiTenant,
      assistantId: 'asst_priv4',
      businessName: 'Plomería Sol',
      greeting: 'Gracias por llamar.',
      services: ['drains'],
      defaultLanguage: 'es',
    });
    expect(rows.find((r) => r.tenantId === plainTenant)?.assistantId).toBeNull();
  });

  it('narrows to one tenant with --tenant-id', async () => {
    const rows = await listVapiAssistantsForBackfill(pool, vapiTenant);
    expect(rows.map((r) => r.tenantId)).toEqual([vapiTenant]);
  });

  it('refreshVapiFirstMessage reads the same columns under the tenant context and pushes the Spanish notice', async () => {
    const updateAssistant = vi.fn(async () => undefined);
    const scoped = (tenantId: string) => ({
      query: (sql: string, params: unknown[]) => tenantQuery(pool, tenantId, sql, params),
    });
    const outcome = await refreshVapiFirstMessage(
      { pool: scoped(vapiTenant) as never, vapiClient: { updateAssistant } },
      vapiTenant,
    );
    expect(outcome).toBe('updated');
    expect(updateAssistant).toHaveBeenCalledWith('asst_priv4', {
      firstMessage: 'Gracias por llamar. Para que lo sepa, soy un asistente virtual, no una persona real.',
    });

    const none = await refreshVapiFirstMessage(
      { pool: scoped(plainTenant) as never, vapiClient: { updateAssistant } },
      plainTenant,
    );
    expect(none).toBe('no_assistant');
    expect(updateAssistant).toHaveBeenCalledTimes(1);
  });
});
