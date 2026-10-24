import { describe, it, expect, beforeEach, vi } from 'vitest';
// Usage caps (trial minutes/concurrency, paid overage cap) read the AI-minute
// ledger and are covered against real Postgres in
// test/integration/voice-gate-usage.test.ts; the tenant role and the cost per
// decision in test/integration/voice-path-tenant-context.test.ts.
import { createVoiceGate } from '../../src/voice/voice-gate';
import type { Pool } from 'pg';
import type { AuditRepository } from '../../src/audit/audit';
import { fakeTenantPool, type FakeTenantPool } from '../helpers/fake-tenant-pool';

/** The gate's reads run under applyTenantContext, which requires a uuid. */
const T1 = '00000000-0000-4000-8000-0000000ca7e1';

interface MockOpts {
  subscriptionStatus: string | null;
  voiceAgentLiveAt?: Date | null;
  pastDueGraceUntil?: Date | null;
  ownerPhone?: string | null;
  businessPhone?: string | null;
  businessHours?: object;
  timezone?: string | null;
  openCalls?: number;
  billableSeconds?: number;
  period?: boolean;
}

function mockFake(opts: MockOpts): FakeTenantPool {
  const liveAt = opts.voiceAgentLiveAt === undefined ? new Date() : opts.voiceAgentLiveAt;
  return fakeTenantPool((sql) => {
    if (sql.includes('FROM tenants')) {
      return {
        rows: [
          {
            subscription_status: opts.subscriptionStatus,
            plan_id: 'starter',
            current_period_start: opts.period ? new Date('2026-10-01T00:00:00Z') : null,
            current_period_end: opts.period ? new Date('2099-01-01T00:00:00Z') : null,
            past_due_grace_until: opts.pastDueGraceUntil ?? null,
          },
        ],
      };
    }
    if (sql.includes('FROM tenant_settings')) {
      return {
        rows: [
          {
            voice_agent_live_at: liveAt,
            owner_phone: opts.ownerPhone ?? null,
            business_phone: opts.businessPhone ?? null,
            business_hours: opts.businessHours ?? {},
            timezone: opts.timezone === undefined ? 'America/Chicago' : opts.timezone,
            ai_overage_cap_cents: null,
            ai_overage_uncapped: false,
          },
        ],
      };
    }
    if (sql.includes('FROM voice_sessions')) return { rows: [{ concurrent: opts.openCalls ?? 0 }] };
    if (sql.includes('FROM call_usage_events')) return { rows: [{ seconds: String(opts.billableSeconds ?? 0) }] };
    return undefined;
  });
}

function mockPool(opts: MockOpts): Pool {
  return mockFake(opts).pool;
}

function mockAudit(): AuditRepository {
  return {
    create: vi.fn(async () => undefined),
  } as unknown as AuditRepository;
}

describe('createVoiceGate', () => {
  let auditRepo: AuditRepository;

  beforeEach(() => {
    auditRepo = mockAudit();
  });

  it('allows when subscription is active', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'active' }),
      auditRepo,
    });
    const result = await gate({ tenantId: T1, callSid: 'CA1' });
    expect(result.allowed).toBe(true);
    expect(auditRepo.create).not.toHaveBeenCalled();
  });

  it('blocks with no_billing when subscription is null', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: null }),
      auditRepo,
    });
    const result = await gate({ tenantId: T1, callSid: 'CA1' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no_billing');
    expect(auditRepo.create).toHaveBeenCalledOnce();
  });

  it('blocks with no_billing when subscription is canceled', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'canceled' }),
      auditRepo,
    });
    const result = await gate({ tenantId: T1, callSid: 'CA1' });
    expect(result.reason).toBe('no_billing');
  });

  it('blocks with not_live when trialing but voice_agent_live_at is null', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'trialing', voiceAgentLiveAt: null }),
      auditRepo,
    });
    const result = await gate({ tenantId: T1, callSid: 'CA1' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_live');
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'voice_blocked_not_live' }),
    );
  });

  // #1605 — the owner's own caller-ID must pass the not_live gate as a test
  // session; every other caller still goes to voicemail until go-live.
  const FULL_ATTESTATION = 'TN-Validation-Passed-A';

  it('#1605: lets the owner\'s own cell through while not_live (full attestation)', async () => {
    const gate = createVoiceGate({
      pool: mockPool({
        subscriptionStatus: 'trialing',
        voiceAgentLiveAt: null,
        ownerPhone: '+14805550100',
      }),
      auditRepo,
    });
    const result = await gate({
      tenantId: T1,
      callSid: 'CA1',
      from: '+14805550100',
      stirVerstat: FULL_ATTESTATION,
    });
    expect(result.allowed).toBe(true);
    expect(auditRepo.create).not.toHaveBeenCalled();
  });

  it('#1605: lets the tenant\'s own business number through while not_live (full attestation)', async () => {
    const gate = createVoiceGate({
      pool: mockPool({
        subscriptionStatus: 'trialing',
        voiceAgentLiveAt: null,
        businessPhone: '+15125550999',
      }),
      auditRepo,
    });
    const result = await gate({
      tenantId: T1,
      callSid: 'CA1',
      from: '+15125550999',
      stirVerstat: FULL_ATTESTATION,
    });
    expect(result.allowed).toBe(true);
  });

  // Code-review finding (#1605 follow-up) — caller-ID alone is spoofable
  // (#1223's own rationale for requiring full STIR/SHAKEN attestation before
  // granting owner-line authority elsewhere). Without it, business_phone
  // defaulting to the tenant's own DID at provisioning would let anyone who
  // spoofs From=To through this gate. Written RED against the pre-fix
  // behavior (which granted the bypass on caller-ID match alone).
  it('#1605: still blocks the owner\'s own number without full STIR/SHAKEN attestation', async () => {
    const gate = createVoiceGate({
      pool: mockPool({
        subscriptionStatus: 'trialing',
        voiceAgentLiveAt: null,
        ownerPhone: '+14805550100',
      }),
      auditRepo,
    });
    const result = await gate({ tenantId: T1, callSid: 'CA1', from: '+14805550100' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_live');
  });

  it('#1605: still blocks a stranger\'s number while not_live', async () => {
    const gate = createVoiceGate({
      pool: mockPool({
        subscriptionStatus: 'trialing',
        voiceAgentLiveAt: null,
        ownerPhone: '+14805550100',
      }),
      auditRepo,
    });
    const result = await gate({ tenantId: T1, callSid: 'CA1', from: '+19995550111' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_live');
  });

  it('#1605: still blocks when no caller-ID is given at all', async () => {
    const gate = createVoiceGate({
      pool: mockPool({
        subscriptionStatus: 'trialing',
        voiceAgentLiveAt: null,
        ownerPhone: '+14805550100',
      }),
      auditRepo,
    });
    const result = await gate({ tenantId: T1, callSid: 'CA1' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_live');
  });

  it('treats unknown subscription_status as no_billing', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'something_unexpected' }),
      auditRepo,
    });
    const result = await gate({ tenantId: T1, callSid: 'CA1' });
    expect(result.reason).toBe('no_billing');
  });

  it('answers past_due calls while the 7-day grace is active', async () => {
    const gate = createVoiceGate({
      pool: mockPool({
        subscriptionStatus: 'past_due',
        pastDueGraceUntil: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
      }),
      auditRepo,
    });
    const result = await gate({ tenantId: T1, callSid: 'CA1' });
    expect(result.allowed).toBe(true);
    expect(auditRepo.create).not.toHaveBeenCalled();
  });

  it('blocks past_due to voicemail once the grace has lapsed', async () => {
    const gate = createVoiceGate({
      pool: mockPool({
        subscriptionStatus: 'past_due',
        pastDueGraceUntil: new Date(Date.now() - 60 * 1000),
      }),
      auditRepo,
    });
    const result = await gate({ tenantId: T1, callSid: 'CA1' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no_billing');
  });

  it('blocks past_due to voicemail when no grace was ever stamped', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'past_due' }),
      auditRepo,
    });
    const result = await gate({ tenantId: T1, callSid: 'CA1' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no_billing');
  });

  it('audit failure does not block (gate still returns block result)', async () => {
    const failingAudit = {
      create: vi.fn(async () => {
        throw new Error('audit DB down');
      }),
    } as unknown as AuditRepository;
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: null }),
      auditRepo: failingAudit,
    });
    const result = await gate({ tenantId: T1, callSid: 'CA1' });
    expect(result.allowed).toBe(false);
  });
});

/**
 * Raw-pg audit 2026-10-23 §4 P1.3 — the gate runs on every inbound call. The
 * tenants registry read decides billing on its own; every tenant-table read
 * the rest of the decision needs shares ONE tenant transaction (one
 * tenant_settings row for go-live, owner numbers, forward-to, the overage cap
 * and business hours), and the block audit is written only after that
 * transaction has released its connection.
 */
describe('createVoiceGate — one tenant session per decision', () => {
  const statementKinds = (fake: FakeTenantPool, checkout: number) =>
    fake.statements.filter((s) => s.checkout === checkout).map((s) => s.sql.replace(/\s+/g, ' ').trim());

  it('a live trial answer: the tenants read, then ONE checkout for settings, open calls and minutes', async () => {
    const fake = mockFake({ subscriptionStatus: 'trialing' });
    const result = await createVoiceGate({ pool: fake.pool, auditRepo: mockAudit() })({ tenantId: T1, callSid: 'CA1' });

    expect(result.allowed).toBe(true);
    expect(fake.checkouts()).toBe(2);
    expect(fake.open()).toBe(0);
    expect(fake.work().map((s) => s.checkout)).toEqual([0, 1, 1, 1]);
    expect(fake.work().filter((s) => s.sql.includes('FROM tenant_settings'))).toHaveLength(1);
    const session = statementKinds(fake, 1);
    expect(session[0]).toBe('BEGIN');
    expect(session[1]).toContain("set_config('app.current_tenant_id'");
    expect(session.at(-1)).toBe('COMMIT');
    for (const s of fake.work().filter((w) => w.checkout === 1)) {
      expect(s.sql).toContain('WHERE tenant_id = $1');
      expect(s.values?.[0]).toBe(T1);
    }
  });

  it('a paid answer with a period reads the period minutes on the same session (no cap store round trip)', async () => {
    const fake = mockFake({ subscriptionStatus: 'active', period: true });
    const result = await createVoiceGate({ pool: fake.pool, auditRepo: mockAudit() })({ tenantId: T1, callSid: 'CA1' });

    expect(result.allowed).toBe(true);
    expect(fake.checkouts()).toBe(2);
    expect(fake.work().map((s) => s.sql.match(/FROM (\w+)/)?.[1])).toEqual(['tenants', 'tenant_settings', 'call_usage_events']);
  });

  it('no_billing is decided on the tenants read alone: no tenant session', async () => {
    const fake = mockFake({ subscriptionStatus: null });
    const result = await createVoiceGate({ pool: fake.pool, auditRepo: mockAudit() })({ tenantId: T1, callSid: 'CA1' });

    expect(result.reason).toBe('no_billing');
    expect(fake.checkouts()).toBe(1);
  });

  it('the block audit is written after the tenant session has released its connection', async () => {
    const fake = mockFake({ subscriptionStatus: 'trialing', openCalls: 2 });
    let openAtAudit = -1;
    const auditRepo = {
      create: vi.fn(async () => {
        openAtAudit = fake.open();
      }),
    } as unknown as AuditRepository;

    const result = await createVoiceGate({ pool: fake.pool, auditRepo })({ tenantId: T1, callSid: 'CA1' });

    expect(result).toMatchObject({ allowed: false, reason: 'trial_cap_concurrent' });
    expect(auditRepo.create).toHaveBeenCalledOnce();
    expect(openAtAudit).toBe(0);
  });

  it("an answer carries the business hours from the decision's own settings row, so /voice reads it once", async () => {
    const result = await createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'trialing', businessHours: { mon: { open: '08:00', close: '17:00' } } }),
      auditRepo: mockAudit(),
    })({ tenantId: T1, callSid: 'CA1' });

    expect(result).toEqual({
      allowed: true,
      businessHours: { timezone: 'America/Chicago', schedule: [{ dayOfWeek: 1, openTime: '08:00', closeTime: '17:00' }] },
    });
  });

  it('no usable schedule → businessHours null; the dunning-grace answer never read settings → absent', async () => {
    const noSchedule = await createVoiceGate({ pool: mockPool({ subscriptionStatus: 'active' }), auditRepo: mockAudit() })({
      tenantId: T1,
      callSid: 'CA1',
    });
    expect(noSchedule).toEqual({ allowed: true, businessHours: null });

    const grace = await createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'past_due', pastDueGraceUntil: new Date(Date.now() + 60_000) }),
      auditRepo: mockAudit(),
    })({ tenantId: T1, callSid: 'CA1' });
    expect(grace).toEqual({ allowed: true });
  });

  it('the #1605 owner bypass compares From with the same settings row (no second read)', async () => {
    const fake = mockFake({ subscriptionStatus: 'trialing', voiceAgentLiveAt: null, ownerPhone: '+14805550100' });
    const result = await createVoiceGate({ pool: fake.pool, auditRepo: mockAudit() })({
      tenantId: T1,
      callSid: 'CA1',
      from: '+14805550100',
      stirVerstat: 'TN-Validation-Passed-A',
    });

    expect(result.allowed).toBe(true);
    expect(fake.work().filter((s) => s.sql.includes('FROM tenant_settings'))).toHaveLength(1);
  });
});
