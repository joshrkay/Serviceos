import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSupervisorReviewGate } from '../../../src/ai/supervisor/reviewer';
import type { ReviewerGateway, PricingBaseline } from '../../../src/ai/supervisor/reviewer';
import { InMemorySupervisorReviewRepository } from '../../../src/ai/supervisor/reviews-repo';
import { InMemoryAiRunRepository } from '../../../src/ai/ai-run';
import type { SupervisorReviewMode } from '../../../src/ai/supervisor/types';
import type { Proposal } from '../../../src/proposals/proposal';
import type { AccountType } from '../../../src/ai/supervisor/checks';
import { OwnerNotificationService } from '../../../src/notifications/owner-notification-service';
import { InMemoryPushDeliveryProvider } from '../../../src/notifications/push-delivery-provider';
import { InMemoryDeviceTokenRepository } from '../../../src/push/device-token-service';
import { setOwnerNotifications } from '../../../src/notifications/owner-notifications-instance';

const TENANT = 'tenant-sup-1';
const MODEL = 'claude-haiku-4-5-20251001';

const silentLogger = { info() {}, warn() {}, error() {} };

function buildProposal(overrides: Partial<Proposal> = {}): Proposal {
  const now = new Date('2026-07-10T12:00:00Z');
  return {
    id: 'prop-1',
    tenantId: TENANT,
    proposalType: 'draft_estimate',
    status: 'ready_for_review',
    payload: { lineItems: [], summary: 'Estimate' },
    summary: 'Estimate for Jane D.',
    createdBy: 'system',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Minimal proposalRepo double capturing status/payload writes. */
function makeProposalRepo() {
  const statusWrites: Array<{ id: string; status: string }> = [];
  const payloadWrites: Array<{ id: string; payload: Record<string, unknown> }> = [];
  return {
    statusWrites,
    payloadWrites,
    async update(_t: string, id: string, updates: Partial<Proposal>) {
      if (updates.payload) payloadWrites.push({ id, payload: updates.payload });
      return null;
    },
    async updateStatus(_t: string, id: string, status: string) {
      statusWrites.push({ id, status });
      return null;
    },
  };
}

interface GateOpts {
  mode?: SupervisorReviewMode;
  gateway?: ReviewerGateway;
  baseline?: PricingBaseline;
  accountType?: AccountType | null;
  bannedPhrases?: string[];
  budgetMs?: number;
}

function jsonGateway(signals: Record<string, unknown>): ReviewerGateway {
  return {
    async complete() {
      return {
        content: JSON.stringify(signals),
        model: MODEL,
        provider: 'test',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    },
  };
}

function setup(opts: GateOpts = {}) {
  const aiRunRepo = new InMemoryAiRunRepository();
  const reviewsRepo = new InMemorySupervisorReviewRepository();
  const proposalRepo = makeProposalRepo();
  const gate = createSupervisorReviewGate({
    gateway:
      opts.gateway ??
      jsonGateway({ missedUrgency: false, medicalMentionUnescalated: false, registerDrift: false }),
    aiRunRepo,
    reviewsRepo,
    proposalRepo,
    supervisorModel: MODEL,
    resolveMode: async () => opts.mode ?? 'shadow',
    resolveBaseline: async () => opts.baseline ?? { avgCents: null, sampleSize: 0 },
    resolveAccountType: async () => opts.accountType ?? null,
    resolveBannedPhrases: async () => opts.bannedPhrases ?? [],
    logger: silentLogger,
    ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
  });
  return { gate, aiRunRepo, reviewsRepo, proposalRepo };
}

describe('N-004 Supervisor reviewer — bad-day sims + budget + modes', () => {
  let provider: InMemoryPushDeliveryProvider;

  beforeEach(async () => {
    const tokenRepo = new InMemoryDeviceTokenRepository();
    await tokenRepo.register({
      tenantId: TENANT,
      userId: 'owner-1',
      expoPushToken: 'ExponentPushToken[sup-owner]',
      platform: 'ios',
    });
    provider = new InMemoryPushDeliveryProvider();
    setOwnerNotifications(new OwnerNotificationService({ deviceTokenRepo: tokenRepo, provider }));
  });

  afterEach(() => {
    setOwnerNotifications(undefined);
  });

  it('flat-voice elder / medical mention → enforce HOLD + escalation alert + verdict=hold', async () => {
    const { gate, reviewsRepo, proposalRepo } = setup({
      mode: 'enforce',
      gateway: jsonGateway({
        missedUrgency: true,
        medicalMentionUnescalated: true,
        registerDrift: false,
      }),
    });
    const proposal = buildProposal({ payload: { _meta: { severity: 'urgent' } } });

    const res = await gate.review({ proposal });

    expect(res.hold).toBe(true);
    // Forced to draft (no one-tap link minted).
    expect(proposalRepo.statusWrites).toContainEqual({ id: proposal.id, status: 'draft' });
    // High-priority escalation alert fired.
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].data?.type).toBe('escalation');
    const reviews = await reviewsRepo.findByProposal(TENANT, proposal.id);
    expect(reviews[0].verdict).toBe('hold');
    expect(reviews[0].critical).toBe(true);
    expect(reviews[0].shadow).toBe(false);
  });

  it('pricing anomaly → flag only, NEVER holds, dispatch proceeds, no alert (even in enforce)', async () => {
    const { gate, reviewsRepo, proposalRepo } = setup({
      mode: 'enforce',
      baseline: { avgCents: 10000, sampleSize: 20 },
    });
    const proposal = buildProposal({ payload: { totalCents: 15000 } }); // 50% above

    const res = await gate.review({ proposal });

    expect(res.hold).toBe(false);
    expect(proposalRepo.statusWrites).toHaveLength(0); // never forced to draft
    expect(provider.sent).toHaveLength(0); // no escalation
    const reviews = await reviewsRepo.findByProposal(TENANT, proposal.id);
    expect(reviews[0].verdict).toBe('flag');
    expect(reviews[0].critical).toBe(false);
    // Marker attached for the review queue.
    expect(proposalRepo.payloadWrites.length).toBeGreaterThan(0);
  });

  it('shadow mode does NOT hold even on a customer-harm critical (logs + marks only)', async () => {
    const { gate, reviewsRepo, proposalRepo } = setup({
      mode: 'shadow',
      gateway: jsonGateway({
        missedUrgency: true,
        medicalMentionUnescalated: true,
        registerDrift: false,
      }),
    });
    const proposal = buildProposal({ payload: { _meta: { severity: 'emergency' } } });

    const res = await gate.review({ proposal });

    expect(res.hold).toBe(false);
    expect(proposalRepo.statusWrites).toHaveLength(0);
    expect(provider.sent).toHaveLength(0);
    const reviews = await reviewsRepo.findByProposal(TENANT, proposal.id);
    expect(reviews[0].shadow).toBe(true);
    expect(reviews[0].critical).toBe(true); // criticality recorded…
    expect(reviews[0].verdict).toBe('flag'); // …but not held
  });

  it('60s budget exceeded → fail-open (verdict=timeout, no hold)', async () => {
    const hangingGateway: ReviewerGateway = {
      complete: () => new Promise(() => {}), // never resolves
    };
    const { gate, reviewsRepo } = setup({
      mode: 'enforce',
      gateway: hangingGateway,
      budgetMs: 20,
    });
    const proposal = buildProposal({ payload: { _meta: { severity: 'urgent' } } });

    const res = await gate.review({ proposal });

    expect(res.hold).toBe(false);
    const reviews = await reviewsRepo.findByProposal(TENANT, proposal.id);
    expect(reviews[0].verdict).toBe('timeout');
  });

  it('logs one ai_runs row per LLM-bearing review (taskType supervisor_review)', async () => {
    const { gate, aiRunRepo, reviewsRepo } = setup({ mode: 'shadow' });
    const proposal = buildProposal();

    await gate.review({ proposal });

    const runs = await aiRunRepo.findByTaskType(TENANT, 'supervisor_review');
    expect(runs).toHaveLength(1);
    expect(runs[0].model).toBe(MODEL);
    // The review row references the persisted ai_run (real id, not fabricated).
    const reviews = await reviewsRepo.findByProposal(TENANT, proposal.id);
    expect(reviews[0].aiRunId).toBe(runs[0].id);
  });

  it('mode=off fully skips (no review row, no ai_run)', async () => {
    const { gate, aiRunRepo, reviewsRepo } = setup({ mode: 'off' });
    const proposal = buildProposal();

    const res = await gate.review({ proposal });

    expect(res.hold).toBe(false);
    expect(await reviewsRepo.findByProposal(TENANT, proposal.id)).toHaveLength(0);
    expect(await aiRunRepo.findByTaskType(TENANT, 'supervisor_review')).toHaveLength(0);
  });

  it('tier=internal bypasses the gate', async () => {
    const { gate, reviewsRepo } = setup({ mode: 'enforce' });
    const proposal = buildProposal({ sourceContext: { tier: 'internal' } });

    const res = await gate.review({ proposal });

    expect(res.hold).toBe(false);
    expect(await reviewsRepo.findByProposal(TENANT, proposal.id)).toHaveLength(0);
  });
});
