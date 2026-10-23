/**
 * Postgres integration — the Vapi end-of-call webhook records its
 * voice_sessions row under the RLS runtime role.
 *
 * `recordInboundSession` opened a transaction and set only the tenant GUC
 * (`set_config('app.current_tenant_id', $1, true)`), never the role, so its
 * dedup SELECT and its INSERT ran as the privileged connection principal and
 * the voice_sessions policy never applied. Its docstring called that
 * "tenant-scoped (RLS-safe)". This suite forces RLS_RUNTIME_ROLE on and asks
 * Postgres (statement-role-probe) which role and tenant each voice_sessions
 * statement ran under, and checks the writes stay inside the calling tenant.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { probeStatementRoles, type StatementRoleProbe } from './statement-role-probe';
import { handleVapiCallEvent, type VapiWebhookRepository } from '../../src/integrations/vapi/webhook';
import { computeVapiHmac } from '../../src/integrations/vapi/signature';
import { PgAuditRepository } from '../../src/audit/pg-audit';

const SECRET = 'vapi_whsec_tenant_context';
const OWNER_PHONE = '+15125550100';
const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;

let pool: Pool;
let probe: StatementRoleProbe;

/**
 * A receipt store that never reports a processed duplicate, so every delivery
 * reaches recordInboundSession — the reprocess path a retried delivery takes.
 */
const reprocessingReceipts: VapiWebhookRepository = {
  recordReceipt: async () => ({ inserted: true }),
  markProcessed: async () => undefined,
};

async function seedTenant(): Promise<string> {
  const { tenantId } = await createTestTenant(pool);
  await pool.query(`UPDATE tenants SET subscription_status = 'trialing' WHERE id = $1`, [tenantId]);
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, business_phone, owner_phone)
       VALUES (gen_random_uuid(), $1, 'Biz', '+15125559999', $2)`,
    [tenantId, OWNER_PHONE],
  );
  return tenantId;
}

/** An ended call from the owner's own phone (the test call: no activation side path). */
async function deliverEndedCall(tenantId: string, callId: string) {
  const rawBody = JSON.stringify({
    message: { type: 'end-of-call-report', call: { id: callId }, customer: { number: OWNER_PHONE } },
  });
  return handleVapiCallEvent(
    {
      pool: probe.pool,
      auditRepo: new PgAuditRepository(pool),
      webhookRepo: reprocessingReceipts,
      secret: SECRET,
    },
    { tenantId, rawBody, signatureHeader: computeVapiHmac(rawBody, SECRET) },
  );
}

async function sessionsFor(callId: string): Promise<Array<{ tenant_id: string }>> {
  const { rows } = await pool.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM voice_sessions WHERE channel = 'voice_inbound' AND external_id = $1`,
    [callId],
  );
  return rows;
}

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  probe = probeStatementRoles(pool, /voice_sessions/);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  await closeSharedTestDb();
});

describe('Vapi end-of-call webhook — voice_sessions write under the RLS runtime role (real Postgres)', () => {
  it('runs its dedup read and insert as rls_app_runtime, scoped to the calling tenant', async () => {
    const tenantId = await seedTenant();
    const callId = `call_ctx_${crypto.randomUUID()}`;

    const res = await deliverEndedCall(tenantId, callId);

    expect(res.status).toBe(200);
    expect(await sessionsFor(callId)).toEqual([{ tenant_id: tenantId }]);
    expect(probe.seen.map((s) => s.sql.trim().split(/\s+/)[0])).toEqual(['SELECT', 'INSERT']);
    for (const statement of probe.seen) {
      expect(statement).toMatchObject({ role: 'rls_app_runtime', tenantGuc: tenantId });
    }
  });

  it('a reprocessed delivery still finds its own row under RLS and does not insert a second one', async () => {
    const tenantId = await seedTenant();
    const callId = `call_replay_${crypto.randomUUID()}`;

    await deliverEndedCall(tenantId, callId);
    await deliverEndedCall(tenantId, callId);

    expect(await sessionsFor(callId)).toEqual([{ tenant_id: tenantId }]);
  });

  it("another tenant's row for the same call id is neither read as a duplicate nor touched", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const callId = `call_shared_${crypto.randomUUID()}`;

    await deliverEndedCall(tenantA, callId);
    const res = await deliverEndedCall(tenantB, callId);

    expect(res.status).toBe(200);
    const owners = (await sessionsFor(callId)).map((r) => r.tenant_id).sort();
    expect(owners).toEqual([tenantA, tenantB].sort());
  });
});
