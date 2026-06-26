import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  DunningConfig,
  DunningEvent,
  InMemoryDunningConfigRepository,
  InMemoryDunningEventRepository,
  defaultDunningConfig,
} from '../../src/invoices/dunning-config';
import { selectDueReminderSteps } from '../../src/invoices/dunning-schedule';

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
