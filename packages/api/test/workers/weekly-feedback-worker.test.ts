import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWeeklyFeedbackSweep, type WeeklyFeedbackDeps } from '../../src/workers/weekly-feedback-worker';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { WeeklyFeedbackSnapshot } from '../../src/digest/weekly-feedback';

const NOW = new Date('2026-06-08T00:00:00.000Z'); // a Monday
const WEEK_KEY = '2026-06-01'; // prior Monday

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function liveSnapshot(over: Partial<WeeklyFeedbackSnapshot> = {}): WeeklyFeedbackSnapshot {
  return {
    weekStartIso: '2026-06-01T00:00:00.000Z',
    weekEndIso: '2026-06-08T00:00:00.000Z',
    revenueCents: 500_000,
    priorRevenueCents: 300_000,
    jobsCompleted: 6,
    priorJobsCompleted: 4,
    jobsBooked: 3,
    estimatesSent: 2,
    estimatesSentValueCents: 100_000,
    invoicesPaidCount: 3,
    callsAnswered: 9,
    newLeads: 1,
    outstandingCents: 120_000,
    ...over,
  };
}

function makeDeps(over: Partial<WeeklyFeedbackDeps> = {}): { deps: WeeklyFeedbackDeps; sendEmail: ReturnType<typeof vi.fn>; auditRepo: InMemoryAuditRepository } {
  const sendEmail = vi.fn().mockResolvedValue(undefined);
  const auditRepo = new InMemoryAuditRepository();
  const deps: WeeklyFeedbackDeps = {
    auditRepo,
    buildSnapshot: vi.fn().mockResolvedValue(liveSnapshot()),
    resolveOwnerEmail: vi.fn().mockResolvedValue('owner@example.com'),
    isFeedbackEnabled: vi.fn().mockResolvedValue(true),
    sendEmail,
    listTenantIds: vi.fn().mockResolvedValue(['t1']),
    logger,
    now: () => NOW,
    ...over,
  };
  return { deps, sendEmail, auditRepo };
}

describe('runWeeklyFeedbackSweep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends one email and records an audit marker for the completed week', async () => {
    const { deps, sendEmail, auditRepo } = makeDeps();
    const result = await runWeeklyFeedbackSweep(deps);
    expect(result).toEqual({ tenants: 1, sent: 1, failed: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: 'owner@example.com' });
    const marker = await auditRepo.findByEntity('t1', 'weekly_feedback_email', WEEK_KEY);
    expect(marker).toHaveLength(1);
  });

  it('is idempotent — a re-run sends nothing more', async () => {
    const { deps, sendEmail } = makeDeps();
    await runWeeklyFeedbackSweep(deps);
    const second = await runWeeklyFeedbackSweep(deps);
    expect(second.sent).toBe(0);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('respects opt-out (isFeedbackEnabled === false)', async () => {
    const { deps, sendEmail } = makeDeps({ isFeedbackEnabled: vi.fn().mockResolvedValue(false) });
    const result = await runWeeklyFeedbackSweep(deps);
    expect(result.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('skips tenants without an owner email', async () => {
    const { deps, sendEmail } = makeDeps({ resolveOwnerEmail: vi.fn().mockResolvedValue(null) });
    expect((await runWeeklyFeedbackSweep(deps)).sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not email a dead week (no activity)', async () => {
    const { deps, sendEmail } = makeDeps({
      buildSnapshot: vi.fn().mockResolvedValue(
        liveSnapshot({ revenueCents: 0, jobsCompleted: 0, jobsBooked: 0, estimatesSent: 0, callsAnswered: 0, newLeads: 0 }),
      ),
    });
    expect((await runWeeklyFeedbackSweep(deps)).sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('uses gateway suggestions when available', async () => {
    const composeSuggestions = vi.fn().mockResolvedValue({ wins: ['AI win'], misses: [], actions: ['AI action'] });
    const { deps, sendEmail } = makeDeps({ composeSuggestions });
    await runWeeklyFeedbackSweep(deps);
    expect(composeSuggestions).toHaveBeenCalled();
    expect(sendEmail.mock.calls[0][0].text).toContain('AI win');
  });

  it('falls back to deterministic suggestions when the composer throws', async () => {
    const composeSuggestions = vi.fn().mockRejectedValue(new Error('gateway down'));
    const { deps, sendEmail } = makeDeps({ composeSuggestions });
    const result = await runWeeklyFeedbackSweep(deps);
    expect(result.sent).toBe(1);
    // deterministic win for the +66% revenue jump still present
    expect(sendEmail.mock.calls[0][0].text).toMatch(/Revenue up|Collected/);
  });

  it('isolates per-tenant failures', async () => {
    const sendEmail = vi
      .fn()
      .mockRejectedValueOnce(new Error('smtp boom'))
      .mockResolvedValue(undefined);
    const { deps } = makeDeps({ sendEmail, listTenantIds: vi.fn().mockResolvedValue(['t1', 't2']) });
    const result = await runWeeklyFeedbackSweep(deps);
    expect(result).toEqual({ tenants: 2, sent: 1, failed: 1 });
  });
});
