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
  /** null with `noTenantRow` unset: a tenants row before checkout. */
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
  /** No tenants row at all (an id the registry does not know). */
  noTenantRow?: boolean;
  /** No tenant_settings row at all. */
  noSettingsRow?: boolean;
  /** Any statement that reads tenant_settings throws (a database error). */
  settingsReadFails?: boolean;
  /**
   * escalation_settings.after_hours_voice_mode as stored (any JSON value,
   * null included); undefined: the key is absent.
   */
  afterHoursVoiceMode?: unknown;
}

/**
 * Answers the gate's statements. The decision's row is the tenants registry
 * row joined to the tenant_settings row (`FROM tenants t LEFT JOIN
 * tenant_settings s`); a separate `FROM tenant_settings` read gets the same
 * settings columns, so a test that pins the statement shape fails on the
 * shape, not on a missing answer.
 */
function mockFake(opts: MockOpts): FakeTenantPool {
  const liveAt = opts.voiceAgentLiveAt === undefined ? new Date() : opts.voiceAgentLiveAt;
  const tenantCols = {
    subscription_status: opts.subscriptionStatus,
    plan_id: 'starter',
    current_period_start: opts.period ? new Date('2026-10-01T00:00:00Z') : null,
    current_period_end: opts.period ? new Date('2099-01-01T00:00:00Z') : null,
    owner_id: null,
    owner_email: null,
    past_due_grace_until: opts.pastDueGraceUntil ?? null,
  };
  const settingsCols = opts.noSettingsRow
    ? null
    : {
        voice_agent_live_at: liveAt,
        owner_phone: opts.ownerPhone ?? null,
        business_phone: opts.businessPhone ?? null,
        business_hours: opts.businessHours ?? {},
        timezone: opts.timezone === undefined ? 'America/Chicago' : opts.timezone,
        ai_overage_cap_cents: null,
        ai_overage_uncapped: false,
        has_after_hours_voice_mode: opts.afterHoursVoiceMode !== undefined,
        after_hours_voice_mode: opts.afterHoursVoiceMode === undefined ? null : opts.afterHoursVoiceMode,
      };
  return fakeTenantPool((sql) => {
    if (opts.settingsReadFails && sql.includes('tenant_settings')) throw new Error('connection reset');
    if (sql.includes('FROM tenants')) {
      if (opts.noTenantRow) return { rows: [] };
      return {
        rows: [
          {
            ...tenantCols,
            has_settings: settingsCols !== null,
            voice_agent_live_at: null,
            owner_phone: null,
            business_phone: null,
            business_hours: null,
            timezone: null,
            ai_overage_cap_cents: null,
            ai_overage_uncapped: null,
            has_after_hours_voice_mode: false,
            after_hours_voice_mode: null,
            ...(settingsCols ?? {}),
          },
        ],
      };
    }
    if (sql.includes('FROM tenant_settings')) return { rows: settingsCols ? [settingsCols] : [] };
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
 * Raw-pg audit 2026-10-23 §4 P1.3 — the gate runs on every inbound call, so
 * the whole decision is ONE tenant session: its first statement reads the
 * tenants registry row (billing state) joined to the tenant_settings row
 * (go-live, owner numbers, forward-to, the overage cap and business hours),
 * the usage reads follow on the same client, and the block audit is written
 * only after that session has released its connection.
 */
describe('createVoiceGate — one tenant session per decision', () => {
  const statementsOf = (fake: FakeTenantPool) => fake.statements.map((s) => s.sql.replace(/\s+/g, ' ').trim());
  const tablesRead = (fake: FakeTenantPool) => fake.work().map((s) => s.sql.match(/FROM (\w+)/)?.[1]);
  const GATE_ROW = /FROM tenants t LEFT JOIN tenant_settings s ON s\.tenant_id = \$1 WHERE t\.id = \$1$/;

  it('a live trial answer: ONE checkout — the billing+settings row, then open calls and minutes', async () => {
    const fake = mockFake({ subscriptionStatus: 'trialing' });
    const result = await createVoiceGate({ pool: fake.pool, auditRepo: mockAudit() })({ tenantId: T1, callSid: 'CA1' });

    expect(result.allowed).toBe(true);
    expect(fake.checkouts()).toBe(1);
    expect(fake.open()).toBe(0);
    expect(tablesRead(fake)).toEqual(['tenants', 'voice_sessions', 'call_usage_events']);
    const statements = statementsOf(fake);
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toContain("set_config('app.current_tenant_id'");
    expect(statements[2]).toMatch(GATE_ROW);
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).toHaveLength(6);
    for (const s of fake.work()) {
      expect(s.sql).toContain('tenant_id = $1');
      expect(s.values?.[0]).toBe(T1);
    }
  });

  it('a paid answer with a period reads the period minutes on the same session (no cap store round trip)', async () => {
    const fake = mockFake({ subscriptionStatus: 'active', period: true });
    const result = await createVoiceGate({ pool: fake.pool, auditRepo: mockAudit() })({ tenantId: T1, callSid: 'CA1' });

    expect(result.allowed).toBe(true);
    expect(fake.checkouts()).toBe(1);
    expect(tablesRead(fake)).toEqual(['tenants', 'call_usage_events']);
  });

  it('a paid answer without a mirrored period has nothing to measure: the row alone', async () => {
    const fake = mockFake({ subscriptionStatus: 'active' });
    const result = await createVoiceGate({ pool: fake.pool, auditRepo: mockAudit() })({ tenantId: T1, callSid: 'CA1' });

    expect(result.allowed).toBe(true);
    expect(tablesRead(fake)).toEqual(['tenants']);
  });

  it('no_billing is decided on the row alone; the audit follows the session', async () => {
    const fake = mockFake({ subscriptionStatus: null });
    const result = await createVoiceGate({ pool: fake.pool, auditRepo: mockAudit() })({ tenantId: T1, callSid: 'CA1' });

    expect(result).toEqual({ allowed: false, reason: 'no_billing' });
    expect(fake.checkouts()).toBe(1);
    expect(tablesRead(fake)).toEqual(['tenants']);
  });

  it('an id the tenants registry does not know is no_billing', async () => {
    const audit = mockAudit();
    const fake = mockFake({ subscriptionStatus: 'active', noTenantRow: true });
    const result = await createVoiceGate({ pool: fake.pool, auditRepo: audit })({ tenantId: T1, callSid: 'CA1' });

    expect(result).toEqual({ allowed: false, reason: 'no_billing' });
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'voice_blocked_no_billing', metadata: { reason: 'no_billing', subscriptionStatus: null } }),
    );
  });

  it('a trialing tenant with no tenant_settings row is not live (no hours, no owner numbers)', async () => {
    const fake = mockFake({ subscriptionStatus: 'trialing', noSettingsRow: true });
    const result = await createVoiceGate({ pool: fake.pool, auditRepo: mockAudit() })({
      tenantId: T1,
      callSid: 'CA1',
      from: '+14805550100',
      stirVerstat: 'TN-Validation-Passed-A',
    });

    expect(result).toEqual({ allowed: false, reason: 'not_live' });
    expect(tablesRead(fake)).toEqual(['tenants']);
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
      afterHoursVoiceMode: 'ai_answering',
    });
  });

  it('no usable schedule → businessHours null', async () => {
    const noSchedule = await createVoiceGate({ pool: mockPool({ subscriptionStatus: 'active' }), auditRepo: mockAudit() })({
      tenantId: T1,
      callSid: 'CA1',
    });
    expect(noSchedule).toEqual({ allowed: true, businessHours: null, afterHoursVoiceMode: 'ai_answering' });
  });

  describe('dunning grace answers with the business hours too, so /voice reads nothing itself', () => {
    const inGrace = (extra: Partial<MockOpts> = {}) =>
      mockFake({ subscriptionStatus: 'past_due', pastDueGraceUntil: new Date(Date.now() + 60_000), ...extra });

    it('the hours come from the same row as the billing state: one statement, one session (no go-live or usage reads)', async () => {
      const fake = inGrace({ businessHours: { mon: { open: '08:00', close: '17:00' } }, voiceAgentLiveAt: null });
      const audit = mockAudit();

      const result = await createVoiceGate({ pool: fake.pool, auditRepo: audit })({ tenantId: T1, callSid: 'CA1' });

      // Grace answers regardless of go-live (voice_agent_live_at is null here), as before.
      expect(result).toEqual({
        allowed: true,
        businessHours: { timezone: 'America/Chicago', schedule: [{ dayOfWeek: 1, openTime: '08:00', closeTime: '17:00' }] },
        afterHoursVoiceMode: 'ai_answering',
      });
      expect(audit.create).not.toHaveBeenCalled();
      expect(fake.checkouts()).toBe(1);
      expect(fake.open()).toBe(0);
      const statements = statementsOf(fake);
      expect(statements).toHaveLength(4);
      expect(statements[0]).toBe('BEGIN');
      expect(statements[1]).toContain("set_config('app.current_tenant_id'");
      expect(statements[2]).toMatch(GATE_ROW);
      expect(statements[3]).toBe('COMMIT');
    });

    it('no settings row → businessHours null (never after hours), still answered', async () => {
      const result = await createVoiceGate({ pool: inGrace({ noSettingsRow: true }).pool, auditRepo: mockAudit() })({
        tenantId: T1,
        callSid: 'CA1',
      });
      expect(result).toEqual({ allowed: true, businessHours: null, afterHoursVoiceMode: 'ai_answering' });
    });

    it('a failed read fails the gate closed (it throws; /voice sends voicemail), as a failed tenants read always did', async () => {
      const fake = inGrace({ settingsReadFails: true });
      const audit = mockAudit();

      await expect(createVoiceGate({ pool: fake.pool, auditRepo: audit })({ tenantId: T1, callSid: 'CA1' })).rejects.toThrow(
        'connection reset',
      );
      expect(statementsOf(fake).at(-1)).toBe('ROLLBACK');
      expect(fake.open()).toBe(0);
      expect(audit.create).not.toHaveBeenCalled();
    });
  });

  it('the #1605 owner bypass compares From with the same row: one statement, one session', async () => {
    const fake = mockFake({ subscriptionStatus: 'trialing', voiceAgentLiveAt: null, ownerPhone: '+14805550100' });
    const result = await createVoiceGate({ pool: fake.pool, auditRepo: mockAudit() })({
      tenantId: T1,
      callSid: 'CA1',
      from: '+14805550100',
      stirVerstat: 'TN-Validation-Passed-A',
    });

    expect(result.allowed).toBe(true);
    expect(fake.checkouts()).toBe(1);
    expect(statementsOf(fake)).toHaveLength(4);
    expect(tablesRead(fake)).toEqual(['tenants']);
  });

  it('not_live for any other caller: the session, then the audit', async () => {
    const fake = mockFake({ subscriptionStatus: 'trialing', voiceAgentLiveAt: null, ownerPhone: '+14805550100' });
    const audit = mockAudit();
    const result = await createVoiceGate({ pool: fake.pool, auditRepo: audit })({ tenantId: T1, callSid: 'CA1', from: '+19995550111' });

    expect(result).toEqual({ allowed: false, reason: 'not_live' });
    expect(fake.checkouts()).toBe(1);
    expect(tablesRead(fake)).toEqual(['tenants']);
    expect(audit.create).toHaveBeenCalledOnce();
  });
});

/**
 * The /voice after-hours fork acts on tenant_settings.escalation_settings
 * .after_hours_voice_mode. Every answer carries it from the decision's own
 * row, so an answered after-hours call reads tenant_settings once (the fork
 * used to re-read the whole row through settingsRepo.findByTenant — a second
 * tenant session — for that one key). The mode is the one the fork's own read
 * resolved: resolveEscalationSettings over the repo's row, then
 * `!== 'ai_answering'` → voicemail.
 */
describe('createVoiceGate — an answer carries the after-hours mode from the same row', () => {
  const tablesRead = (fake: FakeTenantPool) => fake.work().map((s) => s.sql.match(/FROM (\w+)/)?.[1]);
  const answeredPaths: Array<{ path: string; opts: MockOpts; call?: { from: string; stirVerstat: string }; tables: string[] }> = [
    { path: 'a live trial', opts: { subscriptionStatus: 'trialing' }, tables: ['tenants', 'voice_sessions', 'call_usage_events'] },
    { path: 'a paid tenant', opts: { subscriptionStatus: 'active', period: true }, tables: ['tenants', 'call_usage_events'] },
    {
      path: 'dunning grace',
      opts: { subscriptionStatus: 'past_due', pastDueGraceUntil: new Date(Date.now() + 60_000) },
      tables: ['tenants'],
    },
    {
      path: 'the #1605 owner test call while not_live',
      opts: { subscriptionStatus: 'trialing', voiceAgentLiveAt: null, ownerPhone: '+14805550100' },
      call: { from: '+14805550100', stirVerstat: 'TN-Validation-Passed-A' },
      tables: ['tenants'],
    },
  ];
  // Stored value → the mode the fork acts on (the default when no key is stored).
  const modes: Array<{ stored: unknown; label: string; expected: 'ai_answering' | 'voicemail' }> = [
    { stored: undefined, label: 'no key stored (the #1595 default)', expected: 'ai_answering' },
    { stored: 'ai_answering', label: "'ai_answering'", expected: 'ai_answering' },
    { stored: 'voicemail', label: "'voicemail'", expected: 'voicemail' },
  ];

  for (const { path, opts, call, tables } of answeredPaths) {
    for (const { stored, label, expected } of modes) {
      it(`${path}, ${label} → ${expected}, on the decision's one statement (no extra read)`, async () => {
        const fake = mockFake({ ...opts, afterHoursVoiceMode: stored });
        const result = await createVoiceGate({ pool: fake.pool, auditRepo: mockAudit() })({ tenantId: T1, callSid: 'CA1', ...call });

        expect(result).toMatchObject({ allowed: true, afterHoursVoiceMode: expected });
        expect(fake.checkouts()).toBe(1);
        expect(tablesRead(fake)).toEqual(tables);
        expect(fake.work()[0]!.sql).toContain("s.escalation_settings->'after_hours_voice_mode'");
      });
    }
  }

  it('no tenant_settings row (dunning grace answers without one) → the default, as resolveEscalationSettings(null)', async () => {
    const result = await createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'past_due', pastDueGraceUntil: new Date(Date.now() + 60_000), noSettingsRow: true }),
      auditRepo: mockAudit(),
    })({ tenantId: T1, callSid: 'CA1' });
    expect(result).toEqual({ allowed: true, businessHours: null, afterHoursVoiceMode: 'ai_answering' });
  });

  // The fork sent every stored value but 'ai_answering' to voicemail; the
  // write paths only store the enum, but a hand-written row must route the same.
  it.each([
    ['a value outside the enum', 'forward'],
    ['a stored JSON null (a value, not an absent key)', null],
    ['a non-string value', 1],
  ])('%s → voicemail, as the fork routed it', async (_label, stored) => {
    const result = await createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'active', afterHoursVoiceMode: stored }),
      auditRepo: mockAudit(),
    })({ tenantId: T1, callSid: 'CA1' });
    expect(result).toMatchObject({ allowed: true, afterHoursVoiceMode: 'voicemail' });
  });

  it('a block carries no mode (the route answers it before the after-hours fork)', async () => {
    const fake = mockFake({ subscriptionStatus: 'trialing', openCalls: 2, afterHoursVoiceMode: 'voicemail' });
    const result = await createVoiceGate({ pool: fake.pool, auditRepo: mockAudit() })({ tenantId: T1, callSid: 'CA1' });
    expect(result).toMatchObject({ allowed: false, reason: 'trial_cap_concurrent' });
    expect(result).not.toHaveProperty('afterHoursVoiceMode');
  });
});
