import { describe, it, expect, beforeEach } from 'vitest';
import { OnboardingConversationOrchestrator } from '../../../src/ai/orchestration/onboarding-conversation';
import { InMemoryOnboardingSessionRepository } from '../../../src/db/onboarding-session-repository';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository, missingFieldsFor, type Proposal } from '../../../src/proposals/proposal';
import { approveProposal, editProposal } from '../../../src/proposals/actions';
import { InMemoryEstimateTemplateRepository } from '../../../src/templates/estimate-template';
import { OnboardingEstimateTemplateExecutionHandler } from '../../../src/proposals/execution/onboarding-handlers';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';

const TENANT = 'tenant-template-price-gate-1';
const USER = 'user-template-price-gate-1';
const NOW = new Date('2026-07-29T15:00:00Z');

/**
 * Review finding #1 — `template-assembler.ts` falls back to a placeholder
 * line item (`defaultUnitPriceCents: 0`) whenever nothing captured lexically
 * matches the category. "AC Repair" against the spoken price "$85 per hour"
 * (service ref "labor") is a REALISTIC non-match, not a contrived edge case —
 * "ac repair" and "labor" share no substring either direction.
 *
 * Before this fix, `onboarding-conversation.ts` persisted these proposals
 * DIRECTLY via `proposalRepo.create(proposal)` (bypassing the `inputs[]` path
 * every other proposal's `missingFields` gating flows through) with no gate
 * at all — the card was fully approvable, and approving installs a template
 * whose default price feeds straight into future estimates as a free line.
 * Worse than the `onboarding_team_member` `email` shape this mirrors:
 * execution does not even fail here, so nothing ever surfaces the defect.
 *
 * The fix gates on `lineItems` — a real top-level key of
 * `onboardingEstimateTemplatePayloadSchema` — so `editProposal`'s flat-key
 * clear-on-fill (missing-fields.ts) only lifts the gate once the operator
 * supplies a `lineItems` array that re-validates against the schema (which
 * requires `defaultUnitPriceCents` on every line to be a non-negative
 * integer — it doesn't by itself forbid $0, but the point of the gate is
 * that a human looked at the card and typed a real number).
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

// The reviewer's own example: category "AC Repair", spoken price "$85 per
// hour" recorded under service ref "labor" — no lexical match either way.
const SCRIPTS = {
  extract_business_profile: {
    business_name: 'Desert Air HVAC',
    city: 'Mesa',
    state: 'AZ',
    verticals: [{ type: 'hvac', confidence: 0.95, source_text: 'hvac' }],
    service_descriptions: ['AC repair'],
    confidence_score: 0.9,
  },
  extract_categories: {
    categories: [
      { vertical_type: 'hvac', category_id: 'repair', name: 'AC Repair', confidence: 0.9, source_text: 'AC repair' },
    ],
    confidence_score: 0.9,
  },
  extract_pricing: {
    prices: [
      { service_ref: 'labor', amount_cents: 8500, price_type: 'hourly_rate', confidence: 0.9, source_text: '$85 per hour' },
    ],
    confidence_score: 0.9,
  },
  extract_team: { members: [], confidence_score: 0.9 },
  extract_schedule: {
    working_hours: [{ days: ['monday', 'tuesday'], start_time: '08:00', end_time: '17:00' }],
    confidence_score: 0.9,
  },
  extract_tools: { tools: [], confidence_score: 0.9 },
};

describe('OnboardingConversationOrchestrator — the estimate-template placeholder price must be gated, not silently $0', () => {
  let sessionRepo: InMemoryOnboardingSessionRepository;
  let auditRepo: InMemoryAuditRepository;
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    sessionRepo = new InMemoryOnboardingSessionRepository();
    auditRepo = new InMemoryAuditRepository();
    proposalRepo = new InMemoryProposalRepository();
  });

  async function templateProposal(): Promise<Proposal> {
    const orch = new OnboardingConversationOrchestrator({
      gateway: scriptedGateway(SCRIPTS),
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
    const proposals = await Promise.all(
      last.proposalIds.map((id) => proposalRepo.findById(TENANT, id)),
    );
    const template = proposals.find((p) => p?.proposalType === 'onboarding_estimate_template');
    expect(template).toBeTruthy();
    return template!;
  }

  it('a category with no lexically-matching price drafts GATED on lineItems, keeping the $0 placeholder visible', async () => {
    const template = await templateProposal();

    const lineItems = template.payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0].defaultUnitPriceCents).toBe(0);
    expect(missingFieldsFor(template)).toEqual(['lineItems']);
    expect(template.status).toBe('draft');

    await expect(
      approveProposal(proposalRepo, TENANT, template.id, USER, 'owner'),
    ).rejects.toThrow(/unfilled required fields/i);
  });

  it('the counterfactual: without the gate this exact card would have installed a $0 template — silently, no execution failure at all', async () => {
    const template = await templateProposal();
    const handler = new OnboardingEstimateTemplateExecutionHandler(
      new InMemoryEstimateTemplateRepository(),
      auditRepo,
    );
    // Simulate the pre-fix world: same payload, no gate.
    const result = await handler.execute(
      { ...template, status: 'approved' },
      { tenantId: TENANT, executedBy: USER, executedByRole: 'owner' },
    );
    expect(result.success).toBe(true); // <- the defect: this "succeeds" at $0.
  });

  it('the gate is fillable end to end: edit in a real price → gate clears → approve → execute → a correctly-priced template', async () => {
    const template = await templateProposal();

    const { proposal: edited } = await editProposal(
      proposalRepo,
      TENANT,
      template.id,
      USER,
      'owner',
      {
        lineItems: [
          {
            description: 'AC Repair labor',
            category: 'labor',
            defaultQuantity: 1,
            defaultUnitPriceCents: 8500,
            taxable: true,
            sortOrder: 0,
          },
        ],
      },
    );
    expect(missingFieldsFor(edited)).toEqual([]);

    const approved = await approveProposal(proposalRepo, TENANT, template.id, USER, 'owner');
    expect(approved.status).toBe('approved');

    const templateRepo = new InMemoryEstimateTemplateRepository();
    const result = await new OnboardingEstimateTemplateExecutionHandler(
      templateRepo,
      auditRepo,
    ).execute(approved, { tenantId: TENANT, executedBy: USER, executedByRole: 'owner' });

    expect(result.success).toBe(true);
    const templates = await templateRepo.findByTenant(TENANT);
    expect(templates).toHaveLength(1);
    expect(templates[0].lineItemTemplates[0].defaultUnitPriceCents).toBe(8500);
  });

  it('a real matching price never gates (parity: T3-014-style input stays fully approvable)', async () => {
    const orch = new OnboardingConversationOrchestrator({
      gateway: scriptedGateway({
        ...SCRIPTS,
        extract_pricing: {
          prices: [
            { service_ref: 'AC Repair', amount_cents: 8500, price_type: 'exact', confidence: 0.9, source_text: '$85' },
          ],
          confidence_score: 0.9,
        },
      }),
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
    const proposals = await Promise.all(
      last.proposalIds.map((id) => proposalRepo.findById(TENANT, id)),
    );
    const template = proposals.find((p) => p?.proposalType === 'onboarding_estimate_template');
    expect(template).toBeTruthy();
    expect(missingFieldsFor(template!)).toEqual([]);
  });
});
