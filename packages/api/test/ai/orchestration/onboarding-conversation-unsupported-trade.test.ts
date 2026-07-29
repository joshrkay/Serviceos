import { describe, it, expect, beforeEach } from 'vitest';
import { OnboardingConversationOrchestrator } from '../../../src/ai/orchestration/onboarding-conversation';
import { InMemoryOnboardingSessionRepository } from '../../../src/db/onboarding-session-repository';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository, missingFieldsFor } from '../../../src/proposals/proposal';
import { InMemorySettingsRepository } from '../../../src/settings/settings';
import { approveProposal, editProposal } from '../../../src/proposals/actions';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';
import { MAX_CLARIFICATIONS_PER_STATE } from '../../../src/ai/agents/onboarding/constants';

const TENANT = 'tenant-unsupported-1';
const USER = 'user-unsupported-1';
const NOW = new Date('2026-07-29T15:00:00Z');

/**
 * An owner whose trade is not one of the four supported verticals (pool
 * service) — or whom the extractor simply never pins down — drives the
 * profile_capture clarification loop to its limit, at which point the FSM
 * FORCE-ADVANCES (agents/onboarding/transitions.ts, `forcedAdvance`) with
 * `verticalPacks: []` still on the business profile.
 *
 * The resulting `onboarding_tenant_settings` proposal must be GATED:
 * `OnboardingTenantSettingsExecutionHandler` always refuses an empty
 * `verticalPacks`, so an approvable proposal here is an approve-then-fail
 * card — the exact defect class this branch exists to eliminate.
 *
 * Same scripted-gateway shape as the sibling
 * `onboarding-conversation-clarification.test.ts`.
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

/**
 * "I do pool service" — the business name and city come through, but
 * `parseVerticals` (business-profile-extractor.ts) drops anything outside
 * hvac/plumbing/electrical/painting, so `verticals` stays empty and the
 * extractor keeps asking for clarification.
 */
const UNSUPPORTED_TRADE_PROFILE_SCRIPT = {
  business_name: 'Blue Water Pool Service',
  city: 'Mesa',
  state: 'AZ',
  verticals: [],
  service_descriptions: ['pool cleaning', 'filter replacement'],
  confidence_score: 0.9,
};

const SUPPORTED_TRADE_PROFILE_SCRIPT = {
  business_name: 'Blue Water Plumbing',
  city: 'Mesa',
  state: 'AZ',
  verticals: [{ type: 'plumbing', confidence: 0.95, source_text: 'plumbing' }],
  service_descriptions: ['drain cleaning'],
  confidence_score: 0.9,
};

const REMAINING_SCRIPTS = {
  extract_categories: {
    categories: [
      { vertical_type: 'plumbing', category_id: 'repair', name: 'Repair', confidence: 0.9, source_text: 'repair' },
    ],
    confidence_score: 0.9,
  },
  // B1.20 — an hourly_rate entry is required for the tenant-settings
  // proposal to be approvable at all (see the `hourlyRateCents` gate in
  // tenant-settings-proposer.ts, and its end-to-end coverage in
  // onboarding-conversation-no-hourly-rate.test.ts). Scripted here so these
  // cases stay about the verticalPacks gate, and so the positive control
  // below is a real one rather than passing for the wrong reason.
  extract_pricing: {
    prices: [
      { service_ref: 'service_call', amount_cents: 9500, price_type: 'exact', confidence: 0.9, source_text: '$95' },
      { service_ref: 'labor', amount_cents: 12000, price_type: 'hourly_rate', confidence: 0.9, source_text: '$120 an hour' },
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

describe('OnboardingConversationOrchestrator — unresolved vertical pack must draft GATED', () => {
  let sessionRepo: InMemoryOnboardingSessionRepository;
  let auditRepo: InMemoryAuditRepository;
  let proposalRepo: InMemoryProposalRepository;
  let settingsRepo: InMemorySettingsRepository;

  beforeEach(async () => {
    sessionRepo = new InMemoryOnboardingSessionRepository();
    auditRepo = new InMemoryAuditRepository();
    proposalRepo = new InMemoryProposalRepository();
    // This suite is about the `verticalPacks` gate, so the OTHER two gates
    // are held open by giving the tenant what they need: an hourly rate on
    // the pricing script, and a timezone this tenant had ALREADY chosen
    // (the one non-gating source — see tenant-settings-proposer.ts). Nothing
    // here guesses a zone; a tenant without one is covered by the dedicated
    // timezone suite.
    settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.upsertIdentityFields(TENANT, { timezone: 'America/Phoenix', bootstrapAiModel: 'test-model' });
  });

  function newOrchestrator(gateway: LLMGateway): OnboardingConversationOrchestrator {
    return new OnboardingConversationOrchestrator({
      gateway,
      sessionRepo,
      proposalRepo,
      auditRepo,
      settingsRepo,
      now: () => NOW,
    });
  }

  /**
   * Drives profile_capture through the clarification limit (or straight
   * through on a confident script), then the remaining five capture states
   * and the review confirmation. Returns the emitted proposal ids.
   */
  async function runToCompletion(profileScript: unknown, profileTurns: number): Promise<string[]> {
    const orch = newOrchestrator(
      scriptedGateway({ extract_business_profile: profileScript, ...REMAINING_SCRIPTS }),
    );
    const opened = await orch.turn({ tenantId: TENANT, userId: USER });
    let last = opened;
    for (let i = 0; i < profileTurns; i++) {
      last = await orch.turn({
        tenantId: TENANT,
        userId: USER,
        sessionId: opened.sessionId,
        userMessage: `Profile turn ${i}`,
      });
    }
    expect(last.state).toBe('category_capture');
    // category → pricing → team → schedule → tools → review
    for (let i = 0; i < 5; i++) {
      last = await orch.turn({
        tenantId: TENANT,
        userId: USER,
        sessionId: opened.sessionId,
        userMessage: `Turn ${i}`,
      });
    }
    expect(last.state).toBe('review');
    const confirmed = await orch.turn({
      tenantId: TENANT,
      userId: USER,
      sessionId: opened.sessionId,
      userMessage: 'looks good',
    });
    expect(confirmed.completed).toBe(true);
    return confirmed.proposalIds;
  }

  async function tenantSettingsProposal(ids: string[]) {
    const proposals = await Promise.all(ids.map((id) => proposalRepo.findById(TENANT, id)));
    const settings = proposals.find((p) => p?.proposalType === 'onboarding_tenant_settings');
    expect(settings).toBeTruthy();
    return settings!;
  }

  it('an unsupported trade force-advances with verticalPacks: [] and drafts a GATED (non-approvable) tenant-settings proposal', async () => {
    // MAX_CLARIFICATIONS_PER_STATE clarifying turns, then the forced advance.
    const ids = await runToCompletion(
      UNSUPPORTED_TRADE_PROFILE_SCRIPT,
      MAX_CLARIFICATIONS_PER_STATE + 1,
    );
    const settings = await tenantSettingsProposal(ids);

    // The identity the owner DID give is still on the card — nothing spoken
    // is lost, it just can't execute until the pack is supplied.
    expect(settings.payload.businessName).toBe('Blue Water Pool Service');
    expect(settings.payload.city).toBe('Mesa');
    expect(settings.payload.verticalPacks).toEqual([]);

    // The gate: unfilled required field ⇒ approveProposal refuses.
    expect(missingFieldsFor(settings)).toContain('verticalPacks');
    await expect(
      approveProposal(proposalRepo, TENANT, settings.id, USER, 'owner'),
    ).rejects.toThrow(/unfilled required fields/i);
  });

  it('positive control — a supported trade still drafts an APPROVABLE tenant-settings proposal with the pack set', async () => {
    const ids = await runToCompletion(SUPPORTED_TRADE_PROFILE_SCRIPT, 1);
    const settings = await tenantSettingsProposal(ids);

    expect(settings.payload.verticalPacks).toEqual(['plumbing']);
    expect(missingFieldsFor(settings)).toEqual([]);
    const approved = await approveProposal(proposalRepo, TENANT, settings.id, USER, 'owner');
    expect(approved.status).toBe('approved');
  });

  it('supplying the pack on the review card clears the gate and makes the proposal approvable', async () => {
    const ids = await runToCompletion(
      UNSUPPORTED_TRADE_PROFILE_SCRIPT,
      MAX_CLARIFICATIONS_PER_STATE + 1,
    );
    const settings = await tenantSettingsProposal(ids);

    // Same one-tap edit path the team-member `email` gate uses:
    // editProposal → clearSatisfiedMissingFields → approve.
    await editProposal(proposalRepo, TENANT, settings.id, USER, 'owner', {
      verticalPacks: ['plumbing'],
    });

    const refetched = await proposalRepo.findById(TENANT, settings.id);
    expect(missingFieldsFor(refetched!)).toEqual([]);
    const approved = await approveProposal(proposalRepo, TENANT, settings.id, USER, 'owner');
    expect(approved.status).toBe('approved');
  });
});
