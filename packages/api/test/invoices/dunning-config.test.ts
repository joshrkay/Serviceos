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
    stepIndex: 0,
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
    expect(events[0].stepIndex).toBe(0);
  });

  it('rejects a duplicate (invoice, kind, step) with a 23505 code', async () => {
    await repo.create(makeEvent({ kind: 'reminder', stepIndex: 1 }));
    await expect(
      repo.create(makeEvent({ kind: 'reminder', stepIndex: 1 })),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('allows the same step index for a different kind', async () => {
    await repo.create(makeEvent({ kind: 'reminder', stepIndex: 0 }));
    await expect(
      repo.create(makeEvent({ kind: 'late_fee', stepIndex: 0, amountCents: 2500 })),
    ).resolves.toBeTruthy();
    expect(await repo.findByInvoice(TENANT, 'inv-1')).toHaveLength(2);
  });

  it('isolates events by tenant', async () => {
    await repo.create(makeEvent());
    expect(await repo.findByInvoice('other-tenant', 'inv-1')).toHaveLength(0);
  });
});

describe('defaultDunningConfig', () => {
  it('is a single 3-day SMS nudge with no late fee', () => {
    const cfg = defaultDunningConfig(TENANT);
    expect(cfg.enabled).toBe(true);
    expect(cfg.reminderSteps).toEqual([{ offsetDays: 3, channel: 'sms' }]);
    expect(cfg.lateFeeType).toBe('none');
  });
});

describe('selectDueReminderSteps', () => {
  const dueDate = new Date('2026-01-01T00:00:00Z');

  it('returns nothing before the first offset elapses', () => {
    const due = selectDueReminderSteps(makeConfig(), {
      dueDate,
      now: new Date('2026-01-02T00:00:00Z'), // 1 day past due
      sentStepIndexes: [],
    });
    expect(due).toHaveLength(0);
  });

  it('returns all elapsed, unsent steps ordered by index', () => {
    const due = selectDueReminderSteps(makeConfig(), {
      dueDate,
      now: new Date('2026-01-09T00:00:00Z'), // 8 days past due → steps 0 (3d) and 1 (7d)
      sentStepIndexes: [],
    });
    expect(due.map((d) => d.stepIndex)).toEqual([0, 1]);
    expect(due[0].step.channel).toBe('sms');
    expect(due[1].step.channel).toBe('email');
  });

  it('skips steps already sent', () => {
    const due = selectDueReminderSteps(makeConfig(), {
      dueDate,
      now: new Date('2026-01-09T00:00:00Z'),
      sentStepIndexes: [0],
    });
    expect(due.map((d) => d.stepIndex)).toEqual([1]);
  });

  it('returns nothing when dunning is disabled', () => {
    const due = selectDueReminderSteps(makeConfig({ enabled: false }), {
      dueDate,
      now: new Date('2026-02-01T00:00:00Z'),
      sentStepIndexes: [],
    });
    expect(due).toHaveLength(0);
  });
});
