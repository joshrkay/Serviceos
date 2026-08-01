/**
 * Blocker 11 — TCPA / DNC outbound consent gate.
 *
 * Mocks the pg client to simulate the four input cases the gate must
 * distinguish, plus the audit-emission contract. The real-DB integration
 * test belongs in the testcontainers suite (out of scope here).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import {
  checkOutboundConsent,
  recordCustomerConsent,
} from '../../src/voice/outbound-consent';

const TENANT = '11111111-1111-1111-1111-111111111111';
const PHONE = '+15555550100';
const PREMIUM = '+19005550100';
const NON_NANP = '+447911123456';
const MALFORMED = 'not a number';

interface MockResponses {
  dnc?: Array<{ phone: string }>;
  customer?: Array<{ id: string; consent_status: string }>;
  /** consent_events ledger rows, newest first (WS12 cross-channel check). */
  consentEvents?: Array<{ kind: string; state: string }>;
  updateRowCount?: number;
  customerBefore?: Array<{ consent_status: string }>;
}

function buildPool(responses: MockResponses = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const release = vi.fn();
  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string | { text: string }, params?: unknown[]) => {
      const text = typeof sql === 'string' ? sql : sql.text;
      calls.push({ sql: text, params: params ?? [] });
      if (text.includes('FROM tenant_dnc_list')) {
        const rows = responses.dnc ?? [];
        return { rows, rowCount: rows.length } as unknown as QueryResult;
      }
      if (text.includes('FROM consent_events')) {
        const rows = responses.consentEvents ?? [];
        return { rows, rowCount: rows.length } as unknown as QueryResult;
      }
      if (text.includes('FROM customers') && text.includes('phone_normalized')) {
        const rows = responses.customer ?? [];
        return { rows, rowCount: rows.length } as unknown as QueryResult;
      }
      if (text.includes('FROM customers') && text.includes('LIMIT 1')) {
        const rows = responses.customerBefore ?? [];
        return { rows, rowCount: rows.length } as unknown as QueryResult;
      }
      if (text.includes('UPDATE customers')) {
        return { rows: [], rowCount: responses.updateRowCount ?? 1 } as unknown as QueryResult;
      }
      // BEGIN / COMMIT / ROLLBACK / SET / RESET — return empty.
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    }) as unknown as PoolClient['query'],
    release: release as unknown as PoolClient['release'],
  };
  const pool: Partial<Pool> = {
    connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
  };
  return { pool: pool as Pool, calls, release };
}

function makeAuditRepo() {
  const events: Array<Record<string, unknown>> = [];
  return {
    repo: {
      async create(e: Record<string, unknown>) {
        events.push(e);
      },
    },
    events,
  };
}

const ACTOR = { actorId: 'voice-worker-1', actorRole: 'system' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkOutboundConsent — format gate (cheap, no DB hop)', () => {
  it('rejects a malformed number without touching the pool', async () => {
    const { pool } = buildPool();
    const { repo, events } = makeAuditRepo();

    const res = await checkOutboundConsent(
      { pool, auditRepo: repo },
      { tenantId: TENANT, phoneE164: MALFORMED, ...ACTOR },
    );

    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('malformed');
    expect((pool.connect as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('voice.outbound_blocked');
  });

  it('rejects a non-NANP number', async () => {
    const { pool } = buildPool();
    const res = await checkOutboundConsent(
      { pool },
      { tenantId: TENANT, phoneE164: NON_NANP, ...ACTOR },
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('non_nanp');
  });

  it('rejects a premium NPA (900)', async () => {
    const { pool } = buildPool();
    const res = await checkOutboundConsent(
      { pool },
      { tenantId: TENANT, phoneE164: PREMIUM, ...ACTOR },
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('premium_npa');
  });
});

describe('checkOutboundConsent — DNC list', () => {
  it('refuses a number on the tenant DNC list (overrides any granted consent)', async () => {
    const { pool, calls } = buildPool({
      dnc: [{ phone: PHONE }],
      customer: [{ id: 'cust-1', consent_status: 'granted' }],
    });
    const { repo, events } = makeAuditRepo();

    const res = await checkOutboundConsent(
      { pool, auditRepo: repo },
      { tenantId: TENANT, phoneE164: PHONE, ...ACTOR },
    );

    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('dnc_listed');
    // DNC query ran; customer query short-circuited (no need to check
    // consent when the number is on the list).
    expect(calls.some((c) => c.sql.includes('FROM tenant_dnc_list'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('FROM customers'))).toBe(false);
    // Single audit event.
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ reason: 'dnc_listed', phone: PHONE });
  });

  it('clears tenant context (RESET) before releasing the client', async () => {
    const { pool, calls, release } = buildPool({ dnc: [{ phone: PHONE }] });
    await checkOutboundConsent(
      { pool },
      { tenantId: TENANT, phoneE164: PHONE, ...ACTOR },
    );
    expect(calls.some((c) => c.sql.includes('RESET app.current_tenant_id'))).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('checkOutboundConsent — customer consent', () => {
  it('allows when consent_status = granted', async () => {
    const { pool } = buildPool({
      customer: [{ id: 'cust-1', consent_status: 'granted' }],
    });
    const { repo, events } = makeAuditRepo();

    const res = await checkOutboundConsent(
      { pool, auditRepo: repo },
      { tenantId: TENANT, phoneE164: PHONE, ...ACTOR },
    );

    expect(res.allowed).toBe(true);
    expect(res.reason).toBeUndefined();
    // Success path does NOT emit voice.outbound_blocked.
    expect(events).toHaveLength(0);
  });

  it.each([
    ['not_requested', 'consent_not_granted'],
    ['revoked', 'consent_revoked'],
    ['expired', 'consent_expired'],
  ])('refuses when consent_status = %s and reports reason %s', async (status, expectedReason) => {
    const { pool } = buildPool({
      customer: [{ id: 'cust-1', consent_status: status }],
    });
    const res = await checkOutboundConsent(
      { pool },
      { tenantId: TENANT, phoneE164: PHONE, ...ACTOR },
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe(expectedReason);
  });

  it('fails closed when no customer row matches the number', async () => {
    const { pool } = buildPool({ customer: [] });
    const res = await checkOutboundConsent(
      { pool },
      { tenantId: TENANT, phoneE164: PHONE, ...ACTOR },
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('customer_not_found');
  });
});

describe('checkOutboundConsent — WS12 cross-channel revocation (one consent model)', () => {
  it('an SMS STOP in the ledger blocks the CALL even when consent_status = granted', async () => {
    const { pool, calls } = buildPool({
      customer: [{ id: 'cust-1', consent_status: 'granted' }],
      consentEvents: [{ kind: 'sms', state: 'revoked' }],
    });
    const { repo, events } = makeAuditRepo();

    const res = await checkOutboundConsent(
      { pool, auditRepo: repo },
      { tenantId: TENANT, phoneE164: PHONE, ...ACTOR },
    );

    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('consent_revoked');
    // The ledger was consulted inside the same transaction.
    expect(calls.some((c) => c.sql.includes('FROM consent_events'))).toBe(true);
    // Same audit shape as any consent block.
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('voice.outbound_blocked');
    expect(events[0].metadata).toMatchObject({ reason: 'consent_revoked' });
  });

  it('a marketing revocation blocks the call too', async () => {
    const { pool } = buildPool({
      customer: [{ id: 'cust-1', consent_status: 'granted' }],
      consentEvents: [{ kind: 'marketing', state: 'revoked' }],
    });
    const res = await checkOutboundConsent(
      { pool },
      { tenantId: TENANT, phoneE164: PHONE, ...ACTOR },
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('consent_revoked');
  });

  it('a recording objection in the ledger does NOT cross-block a granted customer (kind-scoping)', async () => {
    // Recording is not a contact kind; voice blocking for an objector flows
    // through the consent_status rollup (covered by the consent-status
    // matrix above), never through the cross-channel ledger check.
    const { pool } = buildPool({
      customer: [{ id: 'cust-1', consent_status: 'granted' }],
      consentEvents: [{ kind: 'recording', state: 'revoked' }],
    });
    const res = await checkOutboundConsent(
      { pool },
      { tenantId: TENANT, phoneE164: PHONE, ...ACTOR },
    );
    expect(res.allowed).toBe(true);
  });

  it('an sms GRANT never manufactures voice consent (asymmetry)', async () => {
    const { pool } = buildPool({
      customer: [{ id: 'cust-1', consent_status: 'not_requested' }],
      consentEvents: [{ kind: 'sms', state: 'granted' }],
    });
    const res = await checkOutboundConsent(
      { pool },
      { tenantId: TENANT, phoneE164: PHONE, ...ACTOR },
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('consent_not_granted');
  });

  it('STOP → START re-opt-in clears the cross-channel block (per-channel consent still applies)', async () => {
    const { pool } = buildPool({
      customer: [{ id: 'cust-1', consent_status: 'granted' }],
      // newest first: the later START clears the sms-kind revocation.
      consentEvents: [
        { kind: 'sms', state: 'granted' },
        { kind: 'sms', state: 'revoked' },
      ],
    });
    const res = await checkOutboundConsent(
      { pool },
      { tenantId: TENANT, phoneE164: PHONE, ...ACTOR },
    );
    expect(res.allowed).toBe(true);
  });
});

describe('recordCustomerConsent', () => {
  it('writes the new status and emits customer.consent_changed', async () => {
    const { pool, calls } = buildPool({
      customerBefore: [{ consent_status: 'not_requested' }],
      updateRowCount: 1,
    });
    const { repo, events } = makeAuditRepo();

    await recordCustomerConsent(
      { pool, auditRepo: repo },
      {
        tenantId: TENANT,
        customerId: 'cust-1',
        status: 'granted',
        actorId: 'user-99',
        actorRole: 'owner',
        method: 'web_form',
      },
    );

    expect(calls.some((c) => c.sql.includes('UPDATE customers'))).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('customer.consent_changed');
    expect(events[0].metadata).toMatchObject({
      from: 'not_requested',
      to: 'granted',
      method: 'web_form',
    });
  });

  it('skips audit emission on a no-op (status unchanged)', async () => {
    const { pool } = buildPool({
      customerBefore: [{ consent_status: 'granted' }],
      updateRowCount: 1,
    });
    const { repo, events } = makeAuditRepo();

    await recordCustomerConsent(
      { pool, auditRepo: repo },
      { tenantId: TENANT, customerId: 'cust-1', status: 'granted', actorId: 'u', actorRole: 'owner' },
    );
    expect(events).toHaveLength(0);
  });

  it('throws on a missing customer', async () => {
    const { pool } = buildPool({ customerBefore: [] });

    await expect(
      recordCustomerConsent(
        { pool },
        { tenantId: TENANT, customerId: 'gone', status: 'granted', actorId: 'u' },
      ),
    ).rejects.toThrow(/Customer gone not found/);
  });
});
