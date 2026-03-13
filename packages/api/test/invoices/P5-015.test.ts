import { computeInvoiceBenchmark, TimeToCashEvent } from '../../src/invoices/analytics';

describe('P5-015 — Invoice-acceleration beta benchmark', () => {
  const period = {
    start: new Date('2025-01-01T00:00:00Z'),
    end: new Date('2025-12-31T23:59:59Z'),
  };

  function makeEvent(
    jobId: string,
    milestone: TimeToCashEvent['milestone'],
    occurredAt: Date,
    invoiceId?: string
  ): TimeToCashEvent {
    return {
      id: `evt-${Math.random().toString(36).slice(2)}`,
      tenantId: 't1',
      jobId,
      invoiceId,
      milestone,
      occurredAt,
      createdAt: new Date(),
    };
  }

  it('manual vs AI time-to-cash computed correctly', () => {
    const events: TimeToCashEvent[] = [
      // Manual job: 10 days
      makeEvent('job-manual', 'job_completed', new Date('2025-03-01T00:00:00Z')),
      makeEvent('job-manual', 'fully_paid', new Date('2025-03-11T00:00:00Z')),
      // AI job: 3 days
      makeEvent('job-ai', 'job_completed', new Date('2025-04-01T00:00:00Z'), 'inv-ai'),
      makeEvent('job-ai', 'fully_paid', new Date('2025-04-04T00:00:00Z'), 'inv-ai'),
    ];
    const provenance = [{ invoiceId: 'inv-ai', sourceType: 'job' }];

    const result = computeInvoiceBenchmark(events, provenance, period);
    const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    expect(result.manualAverageTimeToCashMs).toBe(tenDaysMs);
    expect(result.aiAssistedAverageTimeToCashMs).toBe(threeDaysMs);
  });

  it('improvement percentage calculated', () => {
    const events: TimeToCashEvent[] = [
      makeEvent('job-m', 'job_completed', new Date('2025-02-01T00:00:00Z')),
      makeEvent('job-m', 'fully_paid', new Date('2025-02-11T00:00:00Z')),
      makeEvent('job-a', 'job_completed', new Date('2025-03-01T00:00:00Z'), 'inv-a'),
      makeEvent('job-a', 'fully_paid', new Date('2025-03-06T00:00:00Z'), 'inv-a'),
    ];
    const provenance = [{ invoiceId: 'inv-a', sourceType: 'estimate' }];

    const result = computeInvoiceBenchmark(events, provenance, period);
    // Manual: 10 days, AI: 5 days → 50% improvement
    expect(result.improvementPercent).toBe(50);
  });

  it('period filtering works', () => {
    const events: TimeToCashEvent[] = [
      // Inside period
      makeEvent('job-in', 'job_completed', new Date('2025-06-01T00:00:00Z')),
      makeEvent('job-in', 'fully_paid', new Date('2025-06-05T00:00:00Z')),
      // Outside period
      makeEvent('job-out', 'job_completed', new Date('2024-06-01T00:00:00Z')),
      makeEvent('job-out', 'fully_paid', new Date('2024-06-10T00:00:00Z')),
    ];

    const result = computeInvoiceBenchmark(events, [], period);
    expect(result.sampleSize).toBe(1);
  });

  it('empty data returns zeros', () => {
    const result = computeInvoiceBenchmark([], [], period);
    expect(result.manualAverageTimeToCashMs).toBe(0);
    expect(result.aiAssistedAverageTimeToCashMs).toBe(0);
    expect(result.improvementPercent).toBe(0);
    expect(result.sampleSize).toBe(0);
  });

  it('sample size correct', () => {
    const events: TimeToCashEvent[] = [
      makeEvent('j1', 'job_completed', new Date('2025-01-10T00:00:00Z')),
      makeEvent('j1', 'fully_paid', new Date('2025-01-15T00:00:00Z')),
      makeEvent('j2', 'job_completed', new Date('2025-02-10T00:00:00Z'), 'inv-2'),
      makeEvent('j2', 'fully_paid', new Date('2025-02-12T00:00:00Z'), 'inv-2'),
      makeEvent('j3', 'job_completed', new Date('2025-03-10T00:00:00Z')),
      makeEvent('j3', 'fully_paid', new Date('2025-03-20T00:00:00Z')),
    ];
    const provenance = [{ invoiceId: 'inv-2', sourceType: 'conversation' }];

    const result = computeInvoiceBenchmark(events, provenance, period);
    expect(result.sampleSize).toBe(3);
  });

  it('events outside period excluded', () => {
    const narrowPeriod = {
      start: new Date('2025-03-01T00:00:00Z'),
      end: new Date('2025-03-31T23:59:59Z'),
    };
    const events: TimeToCashEvent[] = [
      makeEvent('j-mar', 'job_completed', new Date('2025-03-01T00:00:00Z')),
      makeEvent('j-mar', 'fully_paid', new Date('2025-03-05T00:00:00Z')),
      makeEvent('j-jan', 'job_completed', new Date('2025-01-01T00:00:00Z')),
      makeEvent('j-jan', 'fully_paid', new Date('2025-01-10T00:00:00Z')),
    ];

    const result = computeInvoiceBenchmark(events, [], narrowPeriod);
    expect(result.sampleSize).toBe(1);
  });

  it('handles jobs without fully_paid milestone', () => {
    const events: TimeToCashEvent[] = [
      makeEvent('j1', 'job_completed', new Date('2025-05-01T00:00:00Z')),
      makeEvent('j1', 'invoice_drafted', new Date('2025-05-02T00:00:00Z')),
      // No fully_paid event
      makeEvent('j2', 'job_completed', new Date('2025-06-01T00:00:00Z')),
      makeEvent('j2', 'fully_paid', new Date('2025-06-05T00:00:00Z')),
    ];

    const result = computeInvoiceBenchmark(events, [], period);
    // Only j2 has both milestones
    expect(result.sampleSize).toBe(1);
  });
});
