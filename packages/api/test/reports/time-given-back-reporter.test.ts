import { describe, it, expect } from 'vitest';
import { RepoBackedTimeGivenBackReporter } from '../../src/reports/time-given-back';
import { InMemoryProposalRepository, createProposal } from '../../src/proposals/proposal';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';

function makeSettings(tenantId: string, hourlyRateCents: number | null): TenantSettings {
  const now = new Date();
  return {
    id: `settings-${tenantId}`,
    tenantId,
    businessName: 'Test Business',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    hourlyRateCents,
    createdAt: now,
    updatedAt: now,
  };
}

/** Minimal in-memory stand-in for the voice-session repo's findByTenant. */
class StubVoiceSessionRepo {
  constructor(private readonly rows: Array<{ tenantId: string; endedAt?: Date }>) {}
  async findByTenant(tenantId: string): Promise<Array<{ endedAt?: Date }>> {
    return this.rows.filter((r) => r.tenantId === tenantId);
  }
}

describe('RepoBackedTimeGivenBackReporter', () => {
  const NOW = new Date('2026-05-14T12:00:00.000Z');

  it('composes proposals + voice sessions + hourly rate into a summary', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.create(makeSettings('t1', 12000));

    // An executed proposal inside the week window.
    const p = createProposal({
      tenantId: 't1',
      proposalType: 'draft_estimate',
      payload: {},
      summary: 's',
      createdBy: 'u1',
    });
    await proposalRepo.create(p);
    // currentWeekWindow returns [NOW - 7d, NOW) — exclusive upper bound — so
    // executedAt must be strictly less than NOW to land inside the window.
    await proposalRepo.updateStatus('t1', p.id, 'executed', {
      executedAt: new Date(NOW.getTime() - 1000),
    });

    const voiceRepo = new StubVoiceSessionRepo([
      { tenantId: 't1', endedAt: new Date('2026-05-13') },
      { tenantId: 't1', endedAt: undefined },
      { tenantId: 't2', endedAt: new Date('2026-05-13') },
    ]);

    const reporter = new RepoBackedTimeGivenBackReporter(
      proposalRepo,
      settingsRepo,
      voiceRepo,
    );
    const summary = await reporter.query('t1', NOW);

    expect(summary.receipt.proposalsHandled).toBe(1);
    expect(summary.receipt.callsAnswered).toBe(1);
    expect(summary.totalMinutes).toBe(20); // 12 (draft_estimate) + 8 (call)
    expect(summary.dollarValueCents).toBeGreaterThan(0);
  });

  it('returns dollarValueCents null when the tenant has no hourly rate', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.create(makeSettings('t1', null));
    const reporter = new RepoBackedTimeGivenBackReporter(
      proposalRepo,
      settingsRepo,
      new StubVoiceSessionRepo([]),
    );
    const summary = await reporter.query('t1', NOW);
    expect(summary.dollarValueCents).toBeNull();
  });

  it('works with no voice-session repo wired (calls contribute zero)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.create(makeSettings('t1', 12000));
    const reporter = new RepoBackedTimeGivenBackReporter(proposalRepo, settingsRepo);
    const summary = await reporter.query('t1', NOW);
    expect(summary.receipt.callsAnswered).toBe(0);
    expect(summary.totalMinutes).toBe(0);
  });
});
