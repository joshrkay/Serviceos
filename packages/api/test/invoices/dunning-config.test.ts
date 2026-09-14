import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  DunningConfig,
  DunningEvent,
  InMemoryDunningConfigRepository,
  InMemoryDunningEventRepository,
  defaultDunningConfig,
  applyLateFeePolicy,
  lateFeePolicyOf,
  lateFeePolicyUpdateSchema,
} from '../../src/invoices/dunning-config';
import { selectDueReminderSteps } from '../../src/invoices/dunning-schedule';
import { computeLateFeeCents } from '../../src/invoices/late-fee';

const TENANT = 'tenant-dunning';

function makeConfig(overrides: Partial<DunningConfig> = {}): DunningConfig {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: uuidv4(),
    tenantId: TENANT,
    enabled: true,
    reminderSteps: [
      { offsetDays: 3, channel: 'sms' },
      { offsetDays: 7, channel: 'email' },
      { offsetDays: 14, channel: 'sms' },
    ],
    lateFeeType: 'none',
    lateFeeValueCents: 0,
    lateFeeGraceDays: 0,
    lateFeeMaxCents: undefined,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<DunningEvent> = {}): DunningEvent {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    invoiceId: 'inv-1',
    kind: 'reminder',
    stepKey: '3:sms',
    channel: 'sms',
    sentAt: new Date('2026-01-04T00:00:00Z'),
    ...overrides,
  };
}

describe('InMemoryDunningConfigRepository', () => {
  let repo: InMemoryDunningConfigRepository;
  beforeEach(() => {
    repo = new InMemoryDunningConfigRepository();
  });

  it('returns null before any config is saved', async () => {
    expect(await repo.findByTenant(TENANT)).toBeNull();
  });

  it('upserts and reads back a config (deep-copied)', async () => {
    const cfg = makeConfig();
    await repo.upsert(cfg);
    const found = await repo.findByTenant(TENANT);
    expect(found).not.toBeNull();
    expect(found!.reminderSteps).toHaveLength(3);
    // mutating the returned copy must not corrupt stored state
    found!.reminderSteps.push({ offsetDays: 99, channel: 'sms' });
    const again = await repo.findByTenant(TENANT);
    expect(again!.reminderSteps).toHaveLength(3);
  });

  it('upsert replaces the single per-tenant row', async () => {
    await repo.upsert(makeConfig({ lateFeeType: 'flat', lateFeeValueCents: 2500 }));
    await repo.upsert(makeConfig({ lateFeeType: 'percent', lateFeeValueCents: 150 }));
    const found = await repo.findByTenant(TENANT);
    expect(found!.lateFeeType).toBe('percent');
    expect(found!.lateFeeValueCents).toBe(150);
  });
});

describe('InMemoryDunningEventRepository', () => {
  let repo: InMemoryDunningEventRepository;
  beforeEach(() => {
    repo = new InMemoryDunningEventRepository();
  });

  it('records an event and lists it by invoice', async () => {
    await repo.create(makeEvent());
    const events = await repo.findByInvoice(TENANT, 'inv-1');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('reminder');
    expect(events[0].stepKey).toBe('3:sms');
  });

  it('rejects a duplicate (invoice, kind, step) with a 23505 code', async () => {
    await repo.create(makeEvent({ kind: 'reminder', stepKey: '7:email' }));
    await expect(
      repo.create(makeEvent({ kind: 'reminder', stepKey: '7:email' })),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('allows the same step key for a different kind', async () => {
    await repo.create(makeEvent({ kind: 'reminder', stepKey: '3:sms' }));
    await expect(
      repo.create(
        makeEvent({ kind: 'late_fee', stepKey: '3:sms', amountCents: 2500, channel: undefined }),
      ),
    ).resolves.toBeTruthy();
    const events = await repo.findByInvoice(TENANT, 'inv-1');
    expect(events).toHaveLength(2);
    const lateFee = events.find((e) => e.kind === 'late_fee');
    expect(lateFee!.amountCents).toBe(2500);
    expect(lateFee!.channel).toBeUndefined();
  });

  it('isolates events by tenant', async () => {
    await repo.create(makeEvent());
    expect(await repo.findByInvoice('other-tenant', 'inv-1')).toHaveLength(0);
  });
});

describe('defaultDunningConfig', () => {
  it('is the 3/7/14-day SMS cadence with no late fee (PRD US-370)', () => {
    const cfg = defaultDunningConfig(TENANT);
    expect(cfg.enabled).toBe(true);
    expect(cfg.reminderSteps).toEqual([
      { offsetDays: 3, channel: 'sms' },
      { offsetDays: 7, channel: 'sms' },
      { offsetDays: 14, channel: 'sms' },
    ]);
    expect(cfg.lateFeeType).toBe('none');
    // id must be a real UUID so it can be persisted via PgDunningConfigRepository.upsert
    expect(cfg.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

describe('selectDueReminderSteps', () => {
  const dueDate = new Date('2026-01-01T00:00:00Z');

  it('returns nothing before the first offset elapses', () => {
    const due = selectDueReminderSteps(makeConfig(), {
      dueDate,
      now: new Date('2026-01-02T00:00:00Z'), // 1 day past due
      sentStepKeys: [],
    });
    expect(due).toHaveLength(0);
  });

  it('returns all elapsed, unsent steps ordered by offsetDays', () => {
    const due = selectDueReminderSteps(makeConfig(), {
      dueDate,
      now: new Date('2026-01-09T00:00:00Z'), // 8 days past due → 3d and 7d steps
      sentStepKeys: [],
    });
    expect(due.map((d) => d.stepKey)).toEqual(['3:sms', '7:email']);
    expect(due[0].step.channel).toBe('sms');
    expect(due[1].step.channel).toBe('email');
  });

  it('skips steps already sent', () => {
    const due = selectDueReminderSteps(makeConfig(), {
      dueDate,
      now: new Date('2026-01-09T00:00:00Z'),
      sentStepKeys: ['3:sms'],
    });
    expect(due.map((d) => d.stepKey)).toEqual(['7:email']);
  });

  it('returns nothing when dunning is disabled', () => {
    const due = selectDueReminderSteps(makeConfig({ enabled: false }), {
      dueDate,
      now: new Date('2026-02-01T00:00:00Z'),
      sentStepKeys: [],
    });
    expect(due).toHaveLength(0);
  });

  it('keys reminders by definition so editing the cadence does not resend (P20-002 fix)', () => {
    // The 3-day SMS was already sent (recorded under its stable key '3:sms').
    // A new 1-day SMS is then prepended, shifting the 3-day step to index 1.
    const reordered = makeConfig({
      reminderSteps: [
        { offsetDays: 1, channel: 'sms' },
        { offsetDays: 3, channel: 'sms' },
        { offsetDays: 7, channel: 'email' },
        { offsetDays: 14, channel: 'sms' },
      ],
    });
    const due = selectDueReminderSteps(reordered, {
      dueDate,
      now: new Date('2026-01-09T00:00:00Z'), // 8 days past due
      sentStepKeys: ['3:sms'],
    });
    // The already-sent 3-day SMS is NOT resent despite moving position; only
    // the new 1-day SMS and the 7-day email are due.
    expect(due.map((d) => d.stepKey)).toEqual(['1:sms', '7:email']);
  });

  it('collapses duplicate step definitions so a sweep cannot double-send', () => {
    const dupes = makeConfig({
      reminderSteps: [
        { offsetDays: 3, channel: 'sms' },
        { offsetDays: 3, channel: 'sms' }, // duplicate definition → same stepKey
      ],
    });
    const due = selectDueReminderSteps(dupes, {
      dueDate,
      now: new Date('2026-01-09T00:00:00Z'), // 8 days past due
      sentStepKeys: [],
    });
    expect(due.map((d) => d.stepKey)).toEqual(['3:sms']);
  });

  it('ignores negative or non-integer offsets (never fires before due)', () => {
    const bad = makeConfig({
      reminderSteps: [
        { offsetDays: -1, channel: 'sms' },
        { offsetDays: 2.5, channel: 'email' },
        { offsetDays: 3, channel: 'sms' },
      ],
    });
    const due = selectDueReminderSteps(bad, {
      dueDate,
      now: new Date('2026-01-09T00:00:00Z'),
      sentStepKeys: [],
    });
    expect(due.map((d) => d.stepKey)).toEqual(['3:sms']);
  });
});

// #1143 — the owner-editable late-fee slice of the config (PUT /api/settings/dunning).
describe('lateFeePolicyUpdateSchema', () => {
  it.each([
    [{ lateFeeType: 'none' }],
    [{ lateFeeType: 'flat', lateFeeValueCents: 1 }],
    [{ lateFeeType: 'flat', lateFeeValueCents: 5000, lateFeeGraceDays: 10, lateFeeMaxCents: 2000 }],
    [{ lateFeeType: 'percent', lateFeeValueCents: 10000, lateFeeMaxCents: null }],
  ])('accepts %j', (body) => {
    expect(lateFeePolicyUpdateSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    [{}],
    [{ lateFeeType: 'flat' }],
    [{ lateFeeType: 'flat', lateFeeValueCents: 0 }],
    [{ lateFeeType: 'percent', lateFeeValueCents: 0 }],
    [{ lateFeeType: 'percent', lateFeeValueCents: 10001 }],
    [{ lateFeeType: 'flat', lateFeeValueCents: 1.5 }],
    [{ lateFeeType: 'flat', lateFeeValueCents: 100, lateFeeGraceDays: 1.5 }],
    [{ lateFeeType: 'flat', lateFeeValueCents: 100, lateFeeGraceDays: -1 }],
    [{ lateFeeType: 'flat', lateFeeValueCents: 100, lateFeeMaxCents: -1 }],
    [{ lateFeeType: 'daily', lateFeeValueCents: 100 }],
    [{ lateFeeType: 'none', enabled: false }],
    [{ lateFeeType: 'none', tenantId: 'someone-else' }],
  ])('rejects %j', (body) => {
    expect(lateFeePolicyUpdateSchema.safeParse(body).success).toBe(false);
  });
});

describe('applyLateFeePolicy', () => {
  const now = new Date('2026-09-13T12:00:00Z');

  it('replaces only the late-fee fields, preserving id, tenant, enabled, cadence and createdAt', () => {
    const current = makeConfig({ enabled: false });
    const next = applyLateFeePolicy(
      current,
      { lateFeeType: 'flat', lateFeeValueCents: 5000, lateFeeGraceDays: 5, lateFeeMaxCents: 2000 },
      now,
    );
    expect(next).toEqual({
      ...current,
      lateFeeType: 'flat',
      lateFeeValueCents: 5000,
      lateFeeGraceDays: 5,
      lateFeeMaxCents: 2000,
      updatedAt: now,
    });
    // Pure: the input is untouched.
    expect(current.lateFeeType).toBe('none');
  });

  it('defaults an omitted grace to 0 and an omitted/null cap to uncapped', () => {
    const next = applyLateFeePolicy(makeConfig(), { lateFeeType: 'percent', lateFeeValueCents: 150, lateFeeMaxCents: null }, now);
    expect(next.lateFeeGraceDays).toBe(0);
    expect(next.lateFeeMaxCents).toBeUndefined();
  });

  it("'none' clears the amount, grace and cap", () => {
    const withFee = makeConfig({ lateFeeType: 'flat', lateFeeValueCents: 5000, lateFeeGraceDays: 5, lateFeeMaxCents: 2000 });
    expect(applyLateFeePolicy(withFee, { lateFeeType: 'none' }, now)).toMatchObject({
      lateFeeType: 'none',
      lateFeeValueCents: 0,
      lateFeeGraceDays: 0,
      lateFeeMaxCents: undefined,
    });
  });

  it('introduces no fee math: the policy it writes is clamped by the existing computeLateFeeCents cap', () => {
    const next = applyLateFeePolicy(
      makeConfig(),
      { lateFeeType: 'flat', lateFeeValueCents: 5000, lateFeeGraceDays: 5, lateFeeMaxCents: 2000 },
      now,
    );
    const dueDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    expect(computeLateFeeCents(next, { amountDueCents: 100000, dueDate, now })).toBe(2000);
    // Inside the grace window the same policy charges nothing.
    const recent = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    expect(computeLateFeeCents(next, { amountDueCents: 100000, dueDate: recent, now })).toBe(0);
  });
});

describe('lateFeePolicyOf', () => {
  it('projects the late-fee slice with an uncapped policy as null', () => {
    expect(lateFeePolicyOf(defaultDunningConfig(TENANT))).toEqual({
      lateFeeType: 'none',
      lateFeeValueCents: 0,
      lateFeeGraceDays: 0,
      lateFeeMaxCents: null,
    });
    expect(
      lateFeePolicyOf(makeConfig({ lateFeeType: 'flat', lateFeeValueCents: 900, lateFeeGraceDays: 2, lateFeeMaxCents: 1500 })),
    ).toEqual({ lateFeeType: 'flat', lateFeeValueCents: 900, lateFeeGraceDays: 2, lateFeeMaxCents: 1500 });
  });
});
