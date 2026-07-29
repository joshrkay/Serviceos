import { describe, it, expect, beforeEach } from 'vitest';
import { OnboardingConversationOrchestrator } from '../../../src/ai/orchestration/onboarding-conversation';
import { InMemoryOnboardingSessionRepository } from '../../../src/db/onboarding-session-repository';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';

const TENANT = 'tenant-clarify-1';
const USER = 'user-clarify-1';
const NOW = new Date('2026-06-17T15:00:00Z');

/**
 * B1.19 AC-4 — demonstrates the clarification loop the PRD names
 * explicitly: "me and my cousin Carlos" names a team member (Carlos)
 * without stating his role. This is a scripted, mocked-gateway turn
 * test — each `taskType` routes to a canned extractor response, driving
 * the FSM through profile → category → pricing to team_capture, then
 * feeding the ambiguous team utterance and asserting BOTH that
 * `clarificationCountByState.team_capture` increments AND that the
 * follow-up question is actually the one asked back to the user (not
 * silently skipped/guessed).
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

const PROFILE_SCRIPT = {
  business_name: 'Mike & Cousin Plumbing',
  city: 'Tucson',
  state: 'AZ',
  verticals: [{ type: 'plumbing', confidence: 0.95, source_text: 'plumbing' }],
  service_descriptions: ['plumbing'],
  confidence_score: 0.9,
};

const CATEGORY_SCRIPT = {
  categories: [
    { vertical_type: 'plumbing', category_id: 'repair', name: 'Repair', confidence: 0.9, source_text: 'repair' },
  ],
  confidence_score: 0.9,
};

const PRICING_SCRIPT = {
  prices: [
    { service_ref: 'service_call', amount_cents: 9500, price_type: 'exact', confidence: 0.9, source_text: '$95 service call' },
  ],
  confidence_score: 0.9,
};

/**
 * The ambiguous team script: Mike is confidently the owner, but Carlos
 * is only named — no role stated — so the model's own per-member
 * confidence for Carlos comes back low. This is exactly what
 * team-extractor.ts's ROLE_CLARIFICATION_THRESHOLD gate catches.
 */
const AMBIGUOUS_TEAM_SCRIPT = {
  members: [
    { name: 'Mike', inferred_role: 'owner', confidence: 0.95, source_text: 'I run the shop' },
    { name: 'Carlos', inferred_role: 'technician', confidence: 0.3, source_text: 'me and my cousin Carlos' },
  ],
  confidence_score: 0.9,
};

describe('OnboardingConversationOrchestrator — clarification loop (B1.19 AC-4)', () => {
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

  it('"me and my cousin Carlos" opens a role follow-up: clarificationCountByState increments AND the question is asked', async () => {
    const orch = newOrchestrator(scriptedGateway({
      extract_business_profile: PROFILE_SCRIPT,
      extract_categories: CATEGORY_SCRIPT,
      extract_pricing: PRICING_SCRIPT,
      extract_team: AMBIGUOUS_TEAM_SCRIPT,
    }));

    const opened = await orch.turn({ tenantId: TENANT, userId: USER });
    // Drive profile → category → pricing → team_capture (three
    // high-confidence turns land us in team_capture; see the sibling
    // "drives the full pipeline" test for the state-by-state mapping).
    let last = opened;
    for (let i = 0; i < 3; i++) {
      last = await orch.turn({
        tenantId: TENANT,
        userId: USER,
        sessionId: opened.sessionId,
        userMessage: `Turn ${i}`,
      });
    }
    expect(last.state).toBe('team_capture');

    // The ambiguous utterance.
    const result = await orch.turn({
      tenantId: TENANT,
      userId: USER,
      sessionId: opened.sessionId,
      userMessage: "It's me and my cousin Carlos.",
    });

    // Does NOT advance — stays in team_capture pending the follow-up.
    expect(result.state).toBe('team_capture');
    expect(result.completed).toBe(false);

    // clarificationCountByState increments for team_capture.
    const session = await sessionRepo.findById(TENANT, opened.sessionId);
    expect(session?.clarificationCountByState.team_capture).toBe(1);

    // The question is actually asked — not skipped, not a generic
    // fallback, and not a silent guess at Carlos' role.
    expect(result.assistantMessage).toContain('Carlos');
    expect(result.assistantMessage.toLowerCase()).toContain('role');
    expect(session?.pendingClarifications[0]).toBe(result.assistantMessage);

    // The last assistant transcript turn is the same question — it was
    // actually spoken into the conversation, not just returned.
    const lastAssistantTurn = [...(session?.transcriptTurns ?? [])].reverse().find((t) => t.role === 'assistant');
    expect(lastAssistantTurn?.text).toBe(result.assistantMessage);
    expect(lastAssistantTurn?.state).toBe('team_capture');
  });

  it('answering the follow-up with a confident role advances past team_capture', async () => {
    const orch = newOrchestrator(scriptedGateway({
      extract_business_profile: PROFILE_SCRIPT,
      extract_categories: CATEGORY_SCRIPT,
      extract_pricing: PRICING_SCRIPT,
      extract_team: AMBIGUOUS_TEAM_SCRIPT,
    }));

    const opened = await orch.turn({ tenantId: TENANT, userId: USER });
    let last = opened;
    for (let i = 0; i < 3; i++) {
      last = await orch.turn({ tenantId: TENANT, userId: USER, sessionId: opened.sessionId, userMessage: `Turn ${i}` });
    }
    expect(last.state).toBe('team_capture');

    await orch.turn({
      tenantId: TENANT,
      userId: USER,
      sessionId: opened.sessionId,
      userMessage: "It's me and my cousin Carlos.",
    });

    // Re-script the SAME taskType with Carlos now confidently a
    // technician — mirrors the owner answering the follow-up.
    const orchWithAnswer = new OnboardingConversationOrchestrator({
      gateway: scriptedGateway({
        extract_team: {
          members: [
            { name: 'Mike', inferred_role: 'owner', confidence: 0.95, source_text: 'I run the shop' },
            { name: 'Carlos', inferred_role: 'technician', confidence: 0.92, source_text: 'Carlos is a technician' },
          ],
          confidence_score: 0.9,
        },
      }),
      sessionRepo,
      proposalRepo,
      auditRepo,
      now: () => NOW,
    });

    const answered = await orchWithAnswer.turn({
      tenantId: TENANT,
      userId: USER,
      sessionId: opened.sessionId,
      userMessage: 'Carlos is a technician.',
    });

    expect(answered.state).toBe('schedule_capture');
    const session = await sessionRepo.findById(TENANT, opened.sessionId);
    expect(session?.clarificationCountByState.team_capture).toBe(1);
    expect(session?.extractions.team?.members.find((m) => m.name === 'Carlos')?.inferredRole).toBe('technician');
  });
});
