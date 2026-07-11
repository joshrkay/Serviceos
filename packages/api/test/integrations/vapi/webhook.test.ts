import { describe, it, expect, beforeEach, vi } from 'vitest';

const recordFunnelEventMock = vi.fn();
vi.mock('../../../src/analytics/posthog', () => ({
  recordFunnelEvent: (...args: unknown[]) => recordFunnelEventMock(...args),
}));

import { handleVapiCallEvent } from '../../../src/integrations/vapi/webhook';
import { computeVapiHmac } from '../../../src/integrations/vapi/signature';

const SECRET = 'vapi_whsec_test';
const TENANT = '00000000-0000-0000-0000-0000000000aa';

function endedBody(callId: string, from: string): string {
  return JSON.stringify({ message: { type: 'end-of-call-report', call: { id: callId }, customer: { number: from } } });
}

interface PoolState {
  ownerPhone?: string | null;
  businessPhone?: string | null;
  activatedAt?: Date | null;
  subscription?: string;
  updateRowCount?: number;
}

interface RecordReceiptResult {
  inserted: boolean;
  record?: { processedAt?: Date | null };
}

/**
 * `txnClient.query` mock used by `recordInboundSession`: answers the
 * pre-insert existence check with "not found" by default (rowCount 0) so
 * the INSERT branch runs, unless `sessionExists` says otherwise. When
 * `failInsert` is armed, the INSERT itself throws once (simulating the
 * transient DB blip VOX-04 is about) and disarms itself.
 */
function makeTxnClient(opts: { failInsert?: { armed: boolean }; sessionExists?: boolean } = {}) {
  return {
    query: vi.fn(async (sql: string) => {
      if (/INSERT INTO voice_sessions/i.test(sql) && opts.failInsert?.armed) {
        opts.failInsert.armed = false;
        throw new Error('transient db blip');
      }
      if (/SELECT 1 FROM voice_sessions/i.test(sql)) {
        return { rows: opts.sessionExists ? [{ '?column?': 1 }] : [], rowCount: opts.sessionExists ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
}

function makeDeps(
  state: PoolState = {},
  recordReceiptResult: RecordReceiptResult = { inserted: true },
  txnClient = makeTxnClient(),
) {
  const s = {
    ownerPhone: state.ownerPhone ?? '+15125551111',
    businessPhone: state.businessPhone ?? '+15125559999',
    activatedAt: state.activatedAt ?? null,
    subscription: state.subscription ?? 'trialing',
    updateRowCount: state.updateRowCount ?? 1,
  };
  const pool = {
    connect: vi.fn(async () => txnClient),
    query: vi.fn(async (sql: string) => {
      if (/UPDATE\s+tenant_settings/i.test(sql) && /activated_at\s*=\s*now\(\)/i.test(sql)) {
        return { rows: [], rowCount: s.updateRowCount };
      }
      if (/FROM\s+tenants/i.test(sql)) {
        return { rows: [{ owner_id: 'clerk_owner', owner_email: 'o@x.com', subscription_status: s.subscription }] };
      }
      if (/FROM\s+tenant_settings/i.test(sql)) {
        return { rows: [{ owner_phone: s.ownerPhone, business_phone: s.businessPhone, activated_at: s.activatedAt }] };
      }
      return { rows: [] };
    }),
  };
  const webhookRepo = {
    recordReceipt: vi.fn(async () => recordReceiptResult),
    markProcessed: vi.fn(async () => undefined),
  };
  const auditRepo = { create: vi.fn(async () => undefined) } as never;
  return { deps: { pool: pool as never, auditRepo, webhookRepo, secret: SECRET }, pool, webhookRepo, txnClient };
}

/**
 * A stateful `webhookRepo` fake that mirrors the real Pg/InMemory
 * webhook-event repos: `recordReceipt` inserts once and returns the same
 * mutable record on every later call for that eventId; `markProcessed`
 * stamps `processedAt` on that record in place. Used for the retry-after-
 * failure regression test, where the SAME deps object is reused across two
 * `handleVapiCallEvent` invocations.
 */
function makeStatefulWebhookRepo() {
  const events = new Map<string, { processedAt: Date | null }>();
  return {
    recordReceipt: vi.fn(async (_provider: string, eventId: string) => {
      const existing = events.get(eventId);
      if (existing) {
        return { inserted: false, record: existing };
      }
      const record = { processedAt: null as Date | null };
      events.set(eventId, record);
      return { inserted: true, record };
    }),
    markProcessed: vi.fn(async (_provider: string, eventId: string) => {
      const existing = events.get(eventId);
      if (existing) existing.processedAt = new Date();
    }),
  };
}

function signed(body: string) {
  return { rawBody: body, signatureHeader: computeVapiHmac(body, SECRET), sharedSecretHeader: null };
}

describe('handleVapiCallEvent', () => {
  beforeEach(() => recordFunnelEventMock.mockClear());

  it('rejects an invalid signature with 403 and no side effects', async () => {
    const { deps, webhookRepo } = makeDeps();
    const body = endedBody('call_1', '+15125550000');
    const res = await handleVapiCallEvent(deps, { tenantId: TENANT, rawBody: body, signatureHeader: 'deadbeef', sharedSecretHeader: null });
    expect(res.status).toBe(403);
    expect(webhookRepo.recordReceipt).not.toHaveBeenCalled();
    expect(recordFunnelEventMock).not.toHaveBeenCalled();
  });

  it('ignores non-terminal events with 200', async () => {
    const { deps } = makeDeps();
    const body = JSON.stringify({ message: { type: 'status-update', status: 'in-progress', call: { id: 'call_x' } } });
    const res = await handleVapiCallEvent(deps, { tenantId: TENANT, ...signed(body) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ignored: true });
  });

  it('a duplicate delivery AFTER the work already succeeded no-ops (true idempotency)', async () => {
    // record already exists AND is marked processed — a genuine replay of a
    // call whose session/activation work already ran.
    const { deps, txnClient, webhookRepo } = makeDeps({}, { inserted: false, record: { processedAt: new Date() } });
    const body = endedBody('call_dup', '+15125550000');
    const res = await handleVapiCallEvent(deps, { tenantId: TENANT, ...signed(body) });
    expect(res.body).toEqual({ duplicate: true });
    expect(recordFunnelEventMock).not.toHaveBeenCalled();
    expect(txnClient.query).not.toHaveBeenCalled();
    expect(webhookRepo.markProcessed).not.toHaveBeenCalled();
  });

  it('does NOT activate when the caller is a verified phone (the owner test call)', async () => {
    const { deps } = makeDeps({ ownerPhone: '+15125550000' });
    const body = endedBody('call_test', '+15125550000');
    const res = await handleVapiCallEvent(deps, { tenantId: TENANT, ...signed(body) });
    expect(res.status).toBe(200);
    expect((res.body as { activated: boolean }).activated).toBe(false);
    expect((res.body as { reason: string }).reason).toBe('verified_caller');
    expect(recordFunnelEventMock).not.toHaveBeenCalled();
  });

  it('fires first_real_call_received for a new caller (records session + activation, marks processed)', async () => {
    const { deps, webhookRepo, txnClient } = makeDeps({ ownerPhone: '+15125551111' });
    const body = endedBody('call_real', '+15125557777');
    const res = await handleVapiCallEvent(deps, { tenantId: TENANT, ...signed(body) });
    expect(res.status).toBe(200);
    expect((res.body as { activated: boolean }).activated).toBe(true);
    expect(webhookRepo.recordReceipt).toHaveBeenCalledWith('vapi', 'call_real', 'call.ended', expect.any(Object));
    // inbound voice_session recorded (drives test-call detection)
    expect(txnClient.query).toHaveBeenCalled();
    // Receipt is stamped processed only after the work above succeeded.
    expect(webhookRepo.markProcessed).toHaveBeenCalledTimes(1);
    expect(webhookRepo.markProcessed).toHaveBeenCalledWith('vapi', 'call_real');
    expect(recordFunnelEventMock).toHaveBeenCalledTimes(1);
    expect(recordFunnelEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'first_real_call_received', properties: expect.objectContaining({ detection: 'caller_identity', tenant_id: TENANT }) }),
    );
  });

  it('does not double-fire when activation already happened (check-and-set races to 0 rows)', async () => {
    const { deps } = makeDeps({ ownerPhone: '+15125551111', activatedAt: new Date() });
    const body = endedBody('call_real2', '+15125557777');
    const res = await handleVapiCallEvent(deps, { tenantId: TENANT, ...signed(body) });
    expect((res.body as { activated: boolean }).activated).toBe(false);
    expect(recordFunnelEventMock).not.toHaveBeenCalled();
  });

  // VOX-04 regression: the dedup receipt must not be committed-as-done
  // before the gated work succeeds. If recordInboundSession throws on the
  // first delivery, the receipt must be left unprocessed so a retry
  // reprocesses instead of short-circuiting to a silent 200 duplicate.
  it('VOX-04: a retry after recordInboundSession throws on first delivery successfully records the session', async () => {
    const webhookRepo = makeStatefulWebhookRepo();
    const failInsert = { armed: true };
    const txnClient = makeTxnClient({ failInsert });
    const s = { ownerPhone: '+15125551111', businessPhone: '+15125559999', activatedAt: null as Date | null, subscription: 'trialing' };
    const pool = {
      connect: vi.fn(async () => txnClient),
      query: vi.fn(async (sql: string) => {
        if (/UPDATE\s+tenant_settings/i.test(sql) && /activated_at\s*=\s*now\(\)/i.test(sql)) {
          return { rows: [], rowCount: 1 };
        }
        if (/FROM\s+tenants/i.test(sql)) {
          return { rows: [{ owner_id: 'clerk_owner', owner_email: 'o@x.com', subscription_status: s.subscription }] };
        }
        if (/FROM\s+tenant_settings/i.test(sql)) {
          return { rows: [{ owner_phone: s.ownerPhone, business_phone: s.businessPhone, activated_at: s.activatedAt }] };
        }
        return { rows: [] };
      }),
    };
    const auditRepo = { create: vi.fn(async () => undefined) } as never;
    const deps = { pool: pool as never, auditRepo, webhookRepo, secret: SECRET };
    const body = endedBody('call_retry', '+15125557777');

    // First delivery: recordReceipt inserts (fresh row, unprocessed), then
    // recordInboundSession's INSERT throws (transient DB blip). The
    // exception propagates — the caller (router) would 500, and Vapi
    // retries. Critically, recordReceipt already ran, so we must confirm
    // it did NOT get marked processed.
    await expect(handleVapiCallEvent(deps, { tenantId: TENANT, ...signed(body) })).rejects.toThrow('transient db blip');
    expect(webhookRepo.markProcessed).not.toHaveBeenCalled();

    // Retry (same call id): recordReceipt now returns inserted:false, but
    // the record is still unprocessed (processedAt null) — this must NOT
    // short-circuit to `duplicate:true`. It must fall through and actually
    // write the voice_sessions row + run activation this time.
    recordFunnelEventMock.mockClear();
    const retryRes = await handleVapiCallEvent(deps, { tenantId: TENANT, ...signed(body) });
    expect(retryRes.status).toBe(200);
    expect(retryRes.body).not.toEqual({ duplicate: true });
    expect((retryRes.body as { activated: boolean }).activated).toBe(true);
    expect(webhookRepo.markProcessed).toHaveBeenCalledTimes(1);
    expect(webhookRepo.markProcessed).toHaveBeenCalledWith('vapi', 'call_retry');
    expect(recordFunnelEventMock).toHaveBeenCalledTimes(1);

    // A THIRD delivery (true duplicate — work now actually done) must no-op.
    recordFunnelEventMock.mockClear();
    const thirdRes = await handleVapiCallEvent(deps, { tenantId: TENANT, ...signed(body) });
    expect(thirdRes.body).toEqual({ duplicate: true });
    expect(recordFunnelEventMock).not.toHaveBeenCalled();
  });
});
