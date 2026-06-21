import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OnboardingConversationOrchestrator } from '../../../src/ai/orchestration/onboarding-conversation';
import { InMemoryOnboardingSessionRepository } from '../../../src/db/onboarding-session-repository';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';
import { COMPLETED_PROMPT, STATE_OPENING_PROMPT } from '../../../src/ai/agents/onboarding/transitions';

const TENANT = 'tenant-1';
const USER = 'user-1';
const NOW = new Date('2026-06-17T15:00:00Z');

/**
 * Scripted gateway: each call routes by `taskType` to one of the
 * extractor canonical task ids, and we hand back canned JSON keyed by
 * what the extractor's `tryParseJson + buildExtraction` expects.
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

const HIGH_CONFIDENCE_SCRIPTS = {
  extract_business_profile: {
    business_name: 'Acme Plumbing',
    city: 'Phoenix',
    state: 'AZ',
    verticals: [{ type: 'plumbing', confidence: 0.95, source_text: 'plumbing' }],
    service_descriptions: ['plumbing'],
    confidence_score: 0.9,
  },
  extract_categories: {
    categories: [
      { vertical_type: 'plumbing', category_id: 'repair', name: 'Repair', confidence: 0.95, source_text: 'repair' },
    ],
    confidence_score: 0.9,
  },
  extract_pricing: {
    prices: [
      { service_ref: 'service_call', amount_cents: 12500, price_type: 'exact', confidence: 0.9, source_text: '$125 service call' },
    ],
    confidence_score: 0.9,
  },
  extract_team: {
    members: [{ name: 'Mike', inferred_role: 'owner', confidence: 0.9, source_text: 'Mike' }],
    confidence_score: 0.9,
  },
  extract_schedule: {
    working_hours: [{ days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start_time: '08:00', end_time: '17:00' }],
    confidence_score: 0.9,
  },
};

describe('OnboardingConversationOrchestrator', () => {
  let sessionRepo: InMemoryOnboardingSessionRepository;
  let auditRepo: InMemoryAuditRepository;
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    sessionRepo = new InMemoryOnboardingSessionRepository();
    auditRepo = new InMemoryAuditRepository();
    proposalRepo = new InMemoryProposalRepository();
  });

  function newOrchestrator(gateway: LLMGateway): OnboardingConversationOrchestrator {
    return new OnboardingConversationOrchestrator({
      gateway,
      sessionRepo,
      proposalRepo,
      auditRepo,
      now: () => NOW,
    });
  }

  it('opens a new session with the profile-capture prompt when no sessionId + no userMessage is provided', async () => {
    const orch = newOrchestrator(scriptedGateway({}));
    const result = await orch.turn({ tenantId: TENANT, userId: USER });

    expect(result.sessionId).toBeDefined();
    expect(result.assistantMessage).toBe(STATE_OPENING_PROMPT.profile_capture);
    expect(result.state).toBe('profile_capture');
    expect(result.completed).toBe(false);

    const session = await sessionRepo.findById(TENANT, result.sessionId);
    expect(session?.transcriptTurns).toHaveLength(1);
    expect(session?.transcriptTurns[0]).toMatchObject({ role: 'assistant', state: 'profile_capture' });
  });

  it('a high-confidence profile turn advances to category_capture and emits the category opening prompt', async () => {
    const orch = newOrchestrator(scriptedGateway({
      extract_business_profile: HIGH_CONFIDENCE_SCRIPTS.extract_business_profile,
    }));
    const opened = await orch.turn({ tenantId: TENANT, userId: USER });
    const result = await orch.turn({
      tenantId: TENANT,
      userId: USER,
      sessionId: opened.sessionId,
      userMessage: "I'm Mike, I run Acme Plumbing in Phoenix.",
    });

    expect(result.state).toBe('category_capture');
    expect(result.assistantMessage).toBe(STATE_OPENING_PROMPT.category_capture);
    const session = await sessionRepo.findById(TENANT, opened.sessionId);
    expect(session?.fsmState).toBe('category_capture');
    expect(session?.extractions.businessProfile?.businessName).toBe('Acme Plumbing');
  });

  it('drives the full pipeline (profile → categories → pricing → team → schedule → review) over five high-confidence turns', async () => {
    const orch = newOrchestrator(scriptedGateway(HIGH_CONFIDENCE_SCRIPTS));
    const opened = await orch.turn({ tenantId: TENANT, userId: USER });
    let last = opened;
    for (let i = 0; i < 5; i++) {
      last = await orch.turn({
        tenantId: TENANT,
        userId: USER,
        sessionId: opened.sessionId,
        userMessage: `Turn ${i}`,
      });
    }
    expect(last.state).toBe('review');
    const session = await sessionRepo.findById(TENANT, opened.sessionId);
    expect(session?.extractions.businessProfile).toBeDefined();
    expect(session?.extractions.categories).toBeDefined();
    expect(session?.extractions.pricing).toBeDefined();
    expect(session?.extractions.team).toBeDefined();
    expect(session?.extractions.schedule).toBeDefined();
  });

  it('an utterance in review state confirms and emits onboarding_* proposals into the proposal repo', async () => {
    const orch = newOrchestrator(scriptedGateway(HIGH_CONFIDENCE_SCRIPTS));
    const opened = await orch.turn({ tenantId: TENANT, userId: USER });
    // Drive to review.
    for (let i = 0; i < 5; i++) {
      await orch.turn({ tenantId: TENANT, userId: USER, sessionId: opened.sessionId, userMessage: `Turn ${i}` });
    }
    const confirmation = await orch.turn({
      tenantId: TENANT,
      userId: USER,
      sessionId: opened.sessionId,
      userMessage: 'looks good',
    });

    expect(confirmation.state).toBe('completed');
    expect(confirmation.completed).toBe(true);
    expect(confirmation.assistantMessage).toBe(COMPLETED_PROMPT);
    expect(confirmation.proposalIds.length).toBeGreaterThan(0);

    // Verify the proposal repo actually holds the rows (the dormant
    // single-shot orchestrator returns IDs without persisting; we MUST
    // persist).
    for (const id of confirmation.proposalIds) {
      const proposal = await proposalRepo.findById(TENANT, id);
      expect(proposal).not.toBeNull();
      expect(proposal?.proposalType.startsWith('onboarding_')).toBe(true);
    }
  });

  it('a gateway throw on the extractor surfaces as a low-confidence result and reprompts (does not crash the request)', async () => {
    const throwingGateway: LLMGateway = {
      async complete() {
        throw new Error('upstream timeout');
      },
    } as unknown as LLMGateway;
    const orch = newOrchestrator(throwingGateway);
    const opened = await orch.turn({ tenantId: TENANT, userId: USER });
    const result = await orch.turn({
      tenantId: TENANT,
      userId: USER,
      sessionId: opened.sessionId,
      userMessage: 'hello',
    });

    expect(result.state).toBe('profile_capture');
    expect(result.completed).toBe(false);
    expect(result.assistantMessage.length).toBeGreaterThan(0);
  });

  it('rejects a request whose sessionId belongs to a different tenant (RLS-equivalent at the InMemory layer)', async () => {
    const orch = newOrchestrator(scriptedGateway({}));
    const opened = await orch.turn({ tenantId: TENANT, userId: USER });
    await expect(
      orch.turn({ tenantId: 'tenant-2', userId: USER, sessionId: opened.sessionId, userMessage: 'hi' }),
    ).rejects.toThrow('ONBOARDING_SESSION_NOT_FOUND');
  });

  it('a terminal session short-circuits — subsequent turn() calls return the last assistant message without re-driving the FSM', async () => {
    const orch = newOrchestrator(scriptedGateway(HIGH_CONFIDENCE_SCRIPTS));
    const opened = await orch.turn({ tenantId: TENANT, userId: USER });
    for (let i = 0; i < 5; i++) {
      await orch.turn({ tenantId: TENANT, userId: USER, sessionId: opened.sessionId, userMessage: `T${i}` });
    }
    await orch.turn({ tenantId: TENANT, userId: USER, sessionId: opened.sessionId, userMessage: 'looks good' });
    const followup = await orch.turn({
      tenantId: TENANT,
      userId: USER,
      sessionId: opened.sessionId,
      userMessage: 'one more thing',
    });
    expect(followup.completed).toBe(true);
    expect(followup.state).toBe('completed');
  });

  it('every state transition emits an audit event scoped to onboarding_session', async () => {
    const orch = newOrchestrator(scriptedGateway({
      extract_business_profile: HIGH_CONFIDENCE_SCRIPTS.extract_business_profile,
    }));
    const opened = await orch.turn({ tenantId: TENANT, userId: USER });
    await orch.turn({
      tenantId: TENANT,
      userId: USER,
      sessionId: opened.sessionId,
      userMessage: 'Acme Plumbing in Phoenix',
    });

    const events = await auditRepo.findByEntity(TENANT, 'onboarding_session', opened.sessionId);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.eventType.startsWith('agent.onboarding.'))).toBe(true);
  });
});
