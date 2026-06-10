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

function makeDeps(state: PoolState = {}, inserted = true) {
  const s = {
    ownerPhone: state.ownerPhone ?? '+15125551111',
    businessPhone: state.businessPhone ?? '+15125559999',
    activatedAt: state.activatedAt ?? null,
    subscription: state.subscription ?? 'trialing',
    updateRowCount: state.updateRowCount ?? 1,
  };
  const txnClient = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })), release: vi.fn() };
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
  const webhookRepo = { recordReceipt: vi.fn(async () => ({ inserted })) };
  const auditRepo = { create: vi.fn(async () => undefined) } as never;
  return { deps: { pool: pool as never, auditRepo, webhookRepo, secret: SECRET }, pool, webhookRepo, txnClient };
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

  it('is idempotent — a duplicate call id no-ops with no activation', async () => {
    const { deps } = makeDeps({}, /* inserted */ false);
    const body = endedBody('call_dup', '+15125550000');
    const res = await handleVapiCallEvent(deps, { tenantId: TENANT, ...signed(body) });
    expect(res.body).toEqual({ duplicate: true });
    expect(recordFunnelEventMock).not.toHaveBeenCalled();
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

  it('fires first_real_call_received for a new caller (records session + activation)', async () => {
    const { deps, webhookRepo, txnClient } = makeDeps({ ownerPhone: '+15125551111' });
    const body = endedBody('call_real', '+15125557777');
    const res = await handleVapiCallEvent(deps, { tenantId: TENANT, ...signed(body) });
    expect(res.status).toBe(200);
    expect((res.body as { activated: boolean }).activated).toBe(true);
    expect(webhookRepo.recordReceipt).toHaveBeenCalledWith('vapi', 'call_real', 'call.ended', expect.any(Object));
    // inbound voice_session recorded (drives test-call detection)
    expect(txnClient.query).toHaveBeenCalled();
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
});
