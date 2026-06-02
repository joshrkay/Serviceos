import { describe, it, expect, beforeEach } from 'vitest';
import {
  splitMilestones,
  validateMilestones,
  buildInvoiceSchedule,
  InvoiceMilestone,
  InMemoryInvoiceScheduleRepository,
} from '../../src/invoices/invoice-schedule';

const deposit5050: InvoiceMilestone[] = [
  { label: 'Deposit', type: 'percent', value: 5000, trigger: 'on_accept' },
  { label: 'Balance', type: 'remainder', value: 0, trigger: 'on_completion' },
];

describe('splitMilestones — conserves cents', () => {
  it('splits 50/50 with the remainder taking the balance', () => {
    const alloc = splitMilestones(20000, deposit5050);
    expect(alloc.map((a) => a.amountCents)).toEqual([10000, 10000]);
    expect(alloc[0].label).toBe('Deposit');
    expect(alloc[1].trigger).toBe('on_completion');
  });

  it('the remainder absorbs rounding so the sum equals the total exactly', () => {
    // 33.33% of 10000¢ rounds to 3333; remainder must take 6667 (Σ = 10000).
    const alloc = splitMilestones(10000, [
      { label: 'First', type: 'percent', value: 3333, trigger: 'on_accept' },
      { label: 'Rest', type: 'remainder', value: 0, trigger: 'on_completion' },
    ]);
    expect(alloc[0].amountCents).toBe(3333);
    expect(alloc[1].amountCents).toBe(6667);
    expect(alloc.reduce((s, a) => s + a.amountCents, 0)).toBe(10000);
  });

  it('mixes percent + flat + remainder and still conserves the total', () => {
    const alloc = splitMilestones(100000, [
      { label: 'Permit fee', type: 'flat', value: 15000, trigger: 'on_accept' },
      { label: 'Progress', type: 'percent', value: 3000, trigger: 'manual' }, // 30% = 30000
      { label: 'Final', type: 'remainder', value: 0, trigger: 'on_completion' },
    ]);
    expect(alloc.map((a) => a.amountCents)).toEqual([15000, 30000, 55000]);
    expect(alloc.reduce((s, a) => s + a.amountCents, 0)).toBe(100000);
  });

  it('conserves cents for many odd percentage splits (property-style)', () => {
    for (const total of [1, 7, 99, 100, 333, 99999, 1234567]) {
      const alloc = splitMilestones(total, [
        { label: 'A', type: 'percent', value: 1234, trigger: 'on_accept' },
        { label: 'B', type: 'percent', value: 6789, trigger: 'manual' },
        { label: 'C', type: 'remainder', value: 0, trigger: 'on_completion' },
      ]);
      expect(alloc.reduce((s, a) => s + a.amountCents, 0)).toBe(total);
      expect(alloc.every((a) => a.amountCents >= 0)).toBe(true);
    }
  });

  it('throws when fixed amounts exceed the total', () => {
    expect(() =>
      splitMilestones(10000, [
        { label: 'Too big', type: 'flat', value: 15000, trigger: 'on_accept' },
        { label: 'Rest', type: 'remainder', value: 0, trigger: 'on_completion' },
      ]),
    ).toThrow(/exceed/i);
  });

  it('throws on a negative or non-integer total', () => {
    expect(() => splitMilestones(-1, deposit5050)).toThrow(/non-negative integer/i);
    expect(() => splitMilestones(10.5, deposit5050)).toThrow(/non-negative integer/i);
  });
});

describe('validateMilestones', () => {
  it('accepts a valid list', () => {
    expect(validateMilestones(deposit5050)).toEqual([]);
  });

  it('requires exactly one remainder', () => {
    expect(validateMilestones([{ label: 'Only', type: 'percent', value: 5000, trigger: 'manual' }]))
      .toContainEqual(expect.stringMatching(/exactly one 'remainder'/i));
    expect(
      validateMilestones([
        { label: 'R1', type: 'remainder', value: 0, trigger: 'on_accept' },
        { label: 'R2', type: 'remainder', value: 0, trigger: 'on_completion' },
      ]),
    ).toContainEqual(expect.stringMatching(/exactly one 'remainder'/i));
  });

  it('rejects out-of-range percent bps and negative flats', () => {
    expect(
      validateMilestones([
        { label: 'Bad pct', type: 'percent', value: 10001, trigger: 'manual' },
        { label: 'R', type: 'remainder', value: 0, trigger: 'on_completion' },
      ]),
    ).toContainEqual(expect.stringMatching(/0–10000 bps/));
    expect(
      validateMilestones([
        { label: 'Bad flat', type: 'flat', value: -5, trigger: 'manual' },
        { label: 'R', type: 'remainder', value: 0, trigger: 'on_completion' },
      ]),
    ).toContainEqual(expect.stringMatching(/non-negative integer cents/));
  });

  it('flags an empty list', () => {
    expect(validateMilestones([])).toContainEqual(expect.stringMatching(/at least one/i));
  });
});

describe('buildInvoiceSchedule + InMemoryInvoiceScheduleRepository', () => {
  let repo: InMemoryInvoiceScheduleRepository;
  beforeEach(() => {
    repo = new InMemoryInvoiceScheduleRepository();
  });

  it('builds and persists a schedule, isolated by tenant', async () => {
    const schedule = buildInvoiceSchedule({
      tenantId: 't1',
      jobId: 'job-1',
      estimateId: 'est-1',
      totalAmountCents: 50000,
      milestones: deposit5050,
      createdBy: 'u1',
    });
    await repo.create(schedule);

    expect(await repo.findById('t1', schedule.id)).not.toBeNull();
    // Tenant isolation: another tenant cannot read it.
    expect(await repo.findById('t2', schedule.id)).toBeNull();
    expect(await repo.findByJob('t1', 'job-1')).toHaveLength(1);
    expect(await repo.findByJob('t2', 'job-1')).toHaveLength(0);
  });

  it('refuses to build a schedule with invalid milestones', () => {
    expect(() =>
      buildInvoiceSchedule({
        tenantId: 't1',
        jobId: 'job-1',
        totalAmountCents: 50000,
        milestones: [{ label: 'No remainder', type: 'percent', value: 5000, trigger: 'manual' }],
        createdBy: 'u1',
      }),
    ).toThrow(/invalid milestones/i);
  });
});
