import { describe, it, expect, beforeEach } from 'vitest';
import { OnboardingConversationOrchestrator } from '../../../src/ai/orchestration/onboarding-conversation';
import { InMemoryOnboardingSessionRepository } from '../../../src/db/onboarding-session-repository';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository, missingFieldsFor } from '../../../src/proposals/proposal';
import { approveProposal, editProposal } from '../../../src/proposals/actions';
import { InMemorySettingsRepository } from '../../../src/settings/settings';
import { InMemoryPackActivationRepository } from '../../../src/settings/pack-activation';
import { OnboardingTenantSettingsExecutionHandler } from '../../../src/proposals/execution/onboarding-handlers';
import { deriveOnboardingStatus, type OnboardingFacts } from '../../../src/onboarding/derive-status';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';

const TENANT = 'tenant-no-rate-1';
const USER = 'user-no-rate-1';
const NOW = new Date('2026-07-29T15:00:00Z');

/**
 * B1.20 — the SILENT twin of the `verticalPacks` gate covered by the sibling
 * `onboarding-conversation-unsupported-trade.test.ts`.
 *
 * An owner who quotes only a service-call fee ("$95 to come out") or flat
 * per-job prices never produces a `price_type: 'hourly_rate'` entry, so
 * `pickHourlyRateCents` (tenant-settings-proposer.ts) returns undefined and
 * the settings payload carries no `hourlyRateCents`. Ungated, that proposal
 * is approvable and `OnboardingTenantSettingsExecutionHandler` executes it
 * SUCCESSFULLY — `upsertIdentityFields` simply never writes the key — leaving
 * `tenant_settings.hourly_rate_cents` NULL. `deriveOnboardingStatus`
 * (onboarding/derive-status.ts, `isIdentityDone`) requires that column
 * non-null, so the owner finishes the conversation, approves every card, sees
 * no error at all, and is bounced straight back to the identity form.
 *
 * Unlike the `verticalPacks` case there is no `execution_failed` to notice —
 * which is why the proposal must be GATED at draft time. The rate is asked
 * for, never fabricated: a guessed hourly rate is a money defect (it feeds
 * reports/time-given-back.ts). `jobBufferMinutes` may default to 30 because
 * that is genuine parity with the wizard's own pre-filled value; a price has
 * no equivalent safe default.
 */
function scriptedGateway(scripts: Record<string, unknown>): LLMGateway {
  return {
    async complete(req: LLMRequest): Promise<LLMResponse> {
      const payload = scripts[req.taskType];
      if (payload === undefined) {
        throw new Error(`No script for taskType=${req.taskType}`);
      }
      return {
        content: JSON.stringify(payload),
        model: 'test',
        provider: 'test',
        tokenUsage: { input: 0, output: 0, total: 0 },
        latencyMs: 0,
      };
    },
  } as unknown as LLMGateway;
}

const PLUMBING_PROFILE_SCRIPT = {
  business_name: 'Reliable Plumbing',
  city: 'Mesa',
  state: 'AZ',
  verticals: [{ type: 'plumbing', confidence: 0.95, source_text: 'plumbing' }],
  service_descriptions: ['drain cleaning'],
  confidence_score: 0.9,
};

const UNSUPPORTED_TRADE_PROFILE_SCRIPT = {
  business_name: 'Blue Water Pool Service',
  city: 'Mesa',
  state: 'AZ',
  verticals: [],
  service_descriptions: ['pool cleaning'],
  confidence_score: 0.9,
};

/** "$95 to come out" — a real price, but not an hourly rate. */
const SERVICE_CALL_ONLY_PRICING = {
  prices: [
    { service_ref: 'service call', amount_cents: 9500, price_type: 'exact', confidence: 0.9, source_text: '$95 to come out' },
  ],
  confidence_score: 0.9,
};

/** Flat-rate quotes plus a part — still no hourly rate. */
const FLAT_RATE_ONLY_PRICING = {
  prices: [
    { service_ref: 'water heater', amount_cents: 145000, price_type: 'range_start', qualifier: 'standard tank', confidence: 0.9, source_text: 'starts at $1,450' },
    { service_ref: 'filter', amount_cents: 2500, price_type: 'component', confidence: 0.9, source_text: '$25 filter' },
  ],
  confidence_score: 0.9,
};

const HOURLY_PRICING = {
  prices: [
    { service_ref: 'service call', amount_cents: 9500, price_type: 'exact', confidence: 0.9, source_text: '$95 to come out' },
    { service_ref: 'labor', amount_cents: 12000, price_type: 'hourly_rate', confidence: 0.9, source_text: '$120 an hour' },
  ],
  confidence_score: 0.9,
};

const OTHER_SCRIPTS = {
  extract_categories: {
    categories: [
      { vertical_type: 'plumbing', category_id: 'repair', name: 'Repair', confidence: 0.9, source_text: 'repair' },
    ],
    confidence_score: 0.9,
  },
  extract_team: {
    members: [{ name: 'Dana', inferred_role: 'owner', confidence: 0.95, source_text: 'Dana' }],
    confidence_score: 0.9,
  },
  extract_schedule: {
    working_hours: [{ days: ['monday', 'tuesday'], start_time: '08:00', end_time: '17:00' }],
    confidence_score: 0.9,
  },
  extract_tools: {
    tools: [{ name: 'paper', confidence: 0.9, source_text: 'paper' }],
    confidence_score: 0.9,
  },
};

describe('OnboardingConversationOrchestrator — a captured price that is not an hourly rate must draft GATED', () => {
  let sessionRepo: InMemoryOnboardingSessionRepository;
  let auditRepo: InMemoryAuditRepository;
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    sessionRepo = new InMemoryOnboardingSessionRepository();
    auditRepo = new InMemoryAuditRepository();
    proposalRepo = new InMemoryProposalRepository();
  });

  /**
   * Drives the FSM to completion and returns the emitted proposal ids.
   * `turn()` is called until the session completes (rather than a fixed loop)
   * because a pricing script with no hourly rate legitimately spends extra
   * turns in pricing_capture — the extractor asks for the rate before the FSM
   * force-advances past it.
   */
  async function runToCompletion(scripts: Record<string, unknown>): Promise<string[]> {
    const orch = new OnboardingConversationOrchestrator({
      gateway: scriptedGateway(scripts),
      sessionRepo,
      proposalRepo,
      auditRepo,
      now: () => NOW,
    });
    const opened = await orch.turn({ tenantId: TENANT, userId: USER });
    let last = opened;
    for (let i = 0; i < 14 && !last.completed; i++) {
      last = await orch.turn({
        tenantId: TENANT,
        userId: USER,
        sessionId: opened.sessionId,
        userMessage: last.state === 'review' ? 'looks good' : `Turn ${i}`,
      });
    }
    expect(last.completed).toBe(true);
    return last.proposalIds;
  }

  async function tenantSettingsProposal(ids: string[]) {
    const proposals = await Promise.all(ids.map((id) => proposalRepo.findById(TENANT, id)));
    const settings = proposals.find((p) => p?.proposalType === 'onboarding_tenant_settings');
    expect(settings).toBeTruthy();
    return settings!;
  }

  it('a service-call fee with no hourly rate drafts a GATED (non-approvable) tenant-settings proposal', async () => {
    const ids = await runToCompletion({
      extract_business_profile: PLUMBING_PROFILE_SCRIPT,
      extract_pricing: SERVICE_CALL_ONLY_PRICING,
      ...OTHER_SCRIPTS,
    });
    const settings = await tenantSettingsProposal(ids);

    // Everything the owner DID say is still on the card, and no rate is invented.
    expect(settings.payload.businessName).toBe('Reliable Plumbing');
    expect(settings.payload.verticalPacks).toEqual(['plumbing']);
    expect(settings.payload.hourlyRateCents).toBeUndefined();

    // The gate: unfilled required field ⇒ approveProposal refuses.
    expect(missingFieldsFor(settings)).toContain('hourlyRateCents');
    await expect(
      approveProposal(proposalRepo, TENANT, settings.id, USER, 'owner'),
    ).rejects.toThrow(/unfilled required fields/i);
  });

  it('flat-rate-only pricing (ranges + components) is gated the same way', async () => {
    const ids = await runToCompletion({
      extract_business_profile: PLUMBING_PROFILE_SCRIPT,
      extract_pricing: FLAT_RATE_ONLY_PRICING,
      ...OTHER_SCRIPTS,
    });
    const settings = await tenantSettingsProposal(ids);

    expect(settings.payload.hourlyRateCents).toBeUndefined();
    expect(missingFieldsFor(settings)).toContain('hourlyRateCents');
  });

  it('rate AND pack both missing — both gates are present, and approval stays refused after only one is filled', async () => {
    const ids = await runToCompletion({
      extract_business_profile: UNSUPPORTED_TRADE_PROFILE_SCRIPT,
      extract_pricing: SERVICE_CALL_ONLY_PRICING,
      ...OTHER_SCRIPTS,
    });
    const settings = await tenantSettingsProposal(ids);

    expect(missingFieldsFor(settings).sort()).toEqual(['hourlyRateCents', 'verticalPacks']);

    // Filling one gate must not lift the other.
    await editProposal(proposalRepo, TENANT, settings.id, USER, 'owner', {
      verticalPacks: ['plumbing'],
    });
    const halfFilled = await proposalRepo.findById(TENANT, settings.id);
    expect(missingFieldsFor(halfFilled!)).toEqual(['hourlyRateCents']);
    await expect(
      approveProposal(proposalRepo, TENANT, settings.id, USER, 'owner'),
    ).rejects.toThrow(/unfilled required fields/i);

    // Filling the second clears the list and unblocks approval.
    await editProposal(proposalRepo, TENANT, settings.id, USER, 'owner', {
      hourlyRateCents: 12000,
    });
    const filled = await proposalRepo.findById(TENANT, settings.id);
    expect(missingFieldsFor(filled!)).toEqual([]);
    const approved = await approveProposal(proposalRepo, TENANT, settings.id, USER, 'owner');
    expect(approved.status).toBe('approved');
  });

  it('positive control — a captured hourly rate drafts an APPROVABLE proposal carrying the rate', async () => {
    const ids = await runToCompletion({
      extract_business_profile: PLUMBING_PROFILE_SCRIPT,
      extract_pricing: HOURLY_PRICING,
      ...OTHER_SCRIPTS,
    });
    const settings = await tenantSettingsProposal(ids);

    expect(settings.payload.hourlyRateCents).toBe(12000);
    expect(missingFieldsFor(settings)).toEqual([]);
    const approved = await approveProposal(proposalRepo, TENANT, settings.id, USER, 'owner');
    expect(approved.status).toBe('approved');
  });

  it('the gate is fillable end to end: edit → gate clears → approve → execute → identity derives as DONE', async () => {
    const ids = await runToCompletion({
      extract_business_profile: PLUMBING_PROFILE_SCRIPT,
      extract_pricing: SERVICE_CALL_ONLY_PRICING,
      ...OTHER_SCRIPTS,
    });
    const settings = await tenantSettingsProposal(ids);
    expect(missingFieldsFor(settings)).toEqual(['hourlyRateCents']);

    // `hourlyRateCents` is a real flat key of the payload AND of
    // onboardingTenantSettingsPayloadSchema, which is what makes it fillable:
    // editProposal re-validates the merged payload, then
    // clearSatisfiedMissingFields drops the gate because that exact key was
    // edited to a non-empty value.
    await editProposal(proposalRepo, TENANT, settings.id, USER, 'owner', {
      hourlyRateCents: 12000,
    });

    const refetched = await proposalRepo.findById(TENANT, settings.id);
    expect(missingFieldsFor(refetched!)).toEqual([]);
    const approved = await approveProposal(proposalRepo, TENANT, settings.id, USER, 'owner');
    expect(approved.status).toBe('approved');

    // …and the approved proposal actually closes the identity step. Asserting
    // the USER-VISIBLE outcome (the onboarding gate opens), not merely that a
    // column is non-null — column-level assertions are what let the original
    // B1.20 defect slip through.
    const settingsRepo = new InMemorySettingsRepository();
    const handler = new OnboardingTenantSettingsExecutionHandler(
      settingsRepo,
      new InMemoryPackActivationRepository(),
      auditRepo,
    );
    const result = await handler.execute(approved, {
      tenantId: TENANT,
      executedBy: USER,
      executedByRole: 'owner',
    });
    expect(result.success).toBe(true);

    const written = await settingsRepo.findByTenant(TENANT);
    expect(written?.hourlyRateCents).toBe(12000);

    const status = deriveOnboardingStatus(factsFrom({
      businessName: written?.businessName ?? null,
      businessHours: { monday: { start: '08:00', end: '17:00' } },
      jobBufferMinutes: written?.jobBufferMinutes ?? null,
      hourlyRateCents: written?.hourlyRateCents ?? null,
    }));
    expect(status.steps.find((s) => s.id === 'identity')?.status).toBe('done');
    expect(status.currentStep).not.toBe('identity');
  });

  it('mutation guard — the SAME flow with the rate left unfilled still bounces the owner back to identity', async () => {
    // The counterfactual the gate exists to prevent: had the proposal been
    // approvable without a rate, execution would SUCCEED and the identity step
    // would still not be done. This is the silent failure, spelled out.
    const ids = await runToCompletion({
      extract_business_profile: PLUMBING_PROFILE_SCRIPT,
      extract_pricing: SERVICE_CALL_ONLY_PRICING,
      ...OTHER_SCRIPTS,
    });
    const settings = await tenantSettingsProposal(ids);

    const settingsRepo = new InMemorySettingsRepository();
    const handler = new OnboardingTenantSettingsExecutionHandler(
      settingsRepo,
      new InMemoryPackActivationRepository(),
      auditRepo,
    );
    // Execute the gated payload directly (bypassing approval) to show the
    // handler is perfectly happy with it — the failure is silent, not loud.
    const result = await handler.execute(settings, {
      tenantId: TENANT,
      executedBy: USER,
      executedByRole: 'owner',
    });
    expect(result.success).toBe(true);

    const written = await settingsRepo.findByTenant(TENANT);
    expect(written?.hourlyRateCents).toBeUndefined();

    const status = deriveOnboardingStatus(factsFrom({
      businessName: written?.businessName ?? null,
      businessHours: { monday: { start: '08:00', end: '17:00' } },
      jobBufferMinutes: written?.jobBufferMinutes ?? null,
      hourlyRateCents: written?.hourlyRateCents ?? null,
    }));
    expect(status.currentStep).toBe('identity');
  });
});

/** Minimal facts with everything except identity already satisfied. */
function factsFrom(identity: OnboardingFacts['identity']): OnboardingFacts {
  return {
    tenantId: TENANT,
    tenantExists: true,
    identity,
    packActivated: true,
    twilioStatus: 'full_readiness',
    subscription: { stripeSubscriptionId: 'sub_1', status: 'active' },
    inboundCallCount: 1,
    testCallSkippedAt: null,
    voiceAgentLiveAt: NOW,
    activatedAt: NOW,
    aiConfigPresent: true,
    aiVerificationStatus: 'passed',
  };
}
