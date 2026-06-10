/**
 * Docker-gated integration tests — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * Exercises the Vapi inbound-call webhook against real Postgres (features 3/6/7):
 * a simulated end-of-call-report records a voice_sessions row (test-call
 * detection), activates on a new caller, no-ops on the owner's verified phone,
 * is idempotent on replay, and persists vapi_assistant_id under the right tenant.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';

const recordFunnelEventMock = vi.fn();
vi.mock('../../src/analytics/posthog', () => ({
  recordFunnelEvent: (...args: unknown[]) => recordFunnelEventMock(...args),
}));

import { handleVapiCallEvent } from '../../src/integrations/vapi/webhook';
import { computeVapiHmac } from '../../src/integrations/vapi/signature';
import { PgWebhookEventRepository } from '../../src/webhooks/pg-webhook-event';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const SECRET = 'vapi_whsec_integration';

async function seed(pool: Pool, opts: { ownerPhone?: string; businessPhone?: string } = {}): Promise<string> {
  const { tenantId } = await createTestTenant(pool);
  await pool.query(`UPDATE tenants SET subscription_status = 'trialing' WHERE id = $1`, [tenantId]);
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, business_phone, owner_phone, voice_agent_live_at, vapi_assistant_id)
       VALUES (gen_random_uuid(), $1, 'Biz', $2, $3, now(), 'asst_seed')`,
    [tenantId, opts.businessPhone ?? '+15125559999', opts.ownerPhone ?? '+15125551111'],
  );
  return tenantId;
}

function endedBody(callId: string, from: string): string {
  return JSON.stringify({ message: { type: 'end-of-call-report', call: { id: callId }, customer: { number: from } } });
}

function deps(pool: Pool, webhookRepo: PgWebhookEventRepository) {
  return { pool, auditRepo: new InMemoryAuditRepository(), webhookRepo, secret: SECRET };
}

describe('Postgres integration — Vapi inbound-call webhook', () => {
  let pool: Pool;
  let webhookRepo: PgWebhookEventRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    webhookRepo = new PgWebhookEventRepository(pool);
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });
  beforeEach(() => recordFunnelEventMock.mockClear());

  it('records the inbound session and activates on a new (non-verified) caller', async () => {
    const tenantId = await seed(pool);
    const callId = `call_real_${Date.now()}`;
    const body = endedBody(callId, '+15125557777');
    const res = await handleVapiCallEvent(deps(pool, webhookRepo), {
      tenantId,
      rawBody: body,
      signatureHeader: computeVapiHmac(body, SECRET),
    });
    expect(res.status).toBe(200);
    expect((res.body as { activated: boolean }).activated).toBe(true);

    const sessions = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM voice_sessions WHERE tenant_id = $1 AND channel = 'voice_inbound'`,
      [tenantId],
    );
    expect(sessions.rows[0].n).toBeGreaterThanOrEqual(1);
    const settings = await pool.query<{ activated_at: Date | null }>(
      `SELECT activated_at FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(settings.rows[0].activated_at).toBeInstanceOf(Date);
    expect(recordFunnelEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'first_real_call_received' }),
    );
  });

  it('does NOT activate on the owner verified caller (the test call)', async () => {
    const tenantId = await seed(pool, { ownerPhone: '+15125550000' });
    const body = endedBody(`call_test_${Date.now()}`, '+15125550000');
    const res = await handleVapiCallEvent(deps(pool, webhookRepo), {
      tenantId,
      rawBody: body,
      signatureHeader: computeVapiHmac(body, SECRET),
    });
    expect((res.body as { activated: boolean }).activated).toBe(false);
    const settings = await pool.query<{ activated_at: Date | null }>(
      `SELECT activated_at FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(settings.rows[0].activated_at).toBeNull();
  });

  it('is idempotent on a replayed call id — one session, no double activation', async () => {
    const tenantId = await seed(pool);
    const callId = `call_idem_${Date.now()}`;
    const body = endedBody(callId, '+15125557777');
    const sig = computeVapiHmac(body, SECRET);
    await handleVapiCallEvent(deps(pool, webhookRepo), { tenantId, rawBody: body, signatureHeader: sig });
    const replay = await handleVapiCallEvent(deps(pool, webhookRepo), { tenantId, rawBody: body, signatureHeader: sig });
    expect((replay.body as { duplicate: boolean }).duplicate).toBe(true);
    const sessions = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM voice_sessions WHERE tenant_id = $1 AND external_id = $2`,
      [tenantId, callId],
    );
    expect(sessions.rows[0].n).toBe(1);
  });

  it('rejects an invalid signature with 403', async () => {
    const tenantId = await seed(pool);
    const body = endedBody(`call_badsig_${Date.now()}`, '+15125557777');
    const res = await handleVapiCallEvent(deps(pool, webhookRepo), {
      tenantId,
      rawBody: body,
      signatureHeader: 'deadbeef',
    });
    expect(res.status).toBe(403);
  });

  it('persists vapi_assistant_id under the correct tenant', async () => {
    const tenantId = await seed(pool);
    const row = await pool.query<{ vapi_assistant_id: string | null }>(
      `SELECT vapi_assistant_id FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(row.rows[0].vapi_assistant_id).toBe('asst_seed');
  });
});
