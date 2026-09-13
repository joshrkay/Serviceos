import { describe, it, expect, beforeEach } from 'vitest';
import { OnboardingConversationOrchestrator } from '../../../src/ai/orchestration/onboarding-conversation';
import { InMemoryOnboardingSessionRepository } from '../../../src/db/onboarding-session-repository';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository, missingFieldsFor, type Proposal } from '../../../src/proposals/proposal';
import { approveProposal, editProposal } from '../../../src/proposals/actions';
import { InMemorySettingsRepository } from '../../../src/settings/settings';
import { OnboardingScheduleExecutionHandler } from '../../../src/proposals/execution/onboarding-handlers';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';

const TENANT = 'tenant-seasonal-schedule-1';
const USER = 'user-seasonal-schedule-1';
const NOW = new Date('2026-07-29T15:00:00Z');

/**
 * Review finding #2 — `ScheduleExtractor` deliberately keeps a seasonal-only
 * entry ("we work Saturdays in summer" → `{ days: ['saturday'], seasonal:
 * 'summer' }`, per its own SYSTEM_PROMPT's "Seasonal patterns" rule) rather
 * than dropping it. Before this fix, `onboarding-conversation.ts` emitted the
 * `onboarding_schedule` proposal fully approvable
 * (`ex.schedule.workingHours.length > 0` was the only gate, and a seasonal-
 * only array satisfies it). `OnboardingScheduleExecutionHandler.
 * buildBusinessHours` then strips EVERY seasonal entry (tenant_settings has
 * no seasonal-hours column) and, left with zero base weekly entries, refuses
 * with `ALL_ENTRIES_SEASONAL` — an execution_failed card AFTER the operator
 * already approved a card that had reported no missing fields. Same
 * "approved-then-failed" shape as B7.4 and the `onboarding_team_member`
 * `email` gate.
 *
 * The fix gates on `workingHours` — a real top-level key of
 * `onboardingSchedulePayloadSchema` — whenever every captured entry is
 * seasonal-only, so `editProposal`'s flat-key clear-on-fill only lifts the
 * gate once the operator supplies a `workingHours` array containing at
 * least one base (non-seasonal) entry.
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

// "We work Saturdays in summer" — and nothing else. No base weekly hours at
// all, exactly the case the reviewer describes.
const SEASONAL_ONLY_SCRIPTS = {
  extract_business_profile: {
    business_name: 'Sunbelt Pools',
    city: 'Tempe',
    state: 'AZ',
    verticals: [{ type: 'plumbing', confidence: 0.9, source_text: 'plumbing' }],
    service_descriptions: ['pool service'],
    confidence_score: 0.9,
  },
  extract_categories: {
    categories: [
      { vertical_type: 'plumbing', category_id: 'repair', name: 'Repair', confidence: 0.9, source_text: 'repair' },
    ],
    confidence_score: 0.9,
  },
  extract_pricing: {
    prices: [
      { service_ref: 'labor', amount_cents: 12000, price_type: 'hourly_rate', confidence: 0.9, source_text: '$120 an hour' },
    ],
    confidence_score: 0.9,
  },
  extract_team: { members: [], confidence_score: 0.9 },
  extract_schedule: {
    working_hours: [
      { days: ['saturday'], start_time: '09:00', end_time: '13:00', seasonal: 'summer' },
    ],
    confidence_score: 0.9,
  },
  extract_tools: { tools: [], confidence_score: 0.9 },
};

describe('OnboardingConversationOrchestrator — a seasonal-only schedule must be gated, not approved-then-execution_failed', () => {
  let sessionRepo: InMemoryOnboardingSessionRepository;
  let auditRepo: InMemoryAuditRepository;
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    sessionRepo = new InMemoryOnboardingSessionRepository();
    auditRepo = new InMemoryAuditRepository();
    proposalRepo = new InMemoryProposalRepository();
  });

  async function scheduleProposal(scripts: Record<string, unknown>): Promise<Proposal> {
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
    const proposals = await Promise.all(
      last.proposalIds.map((id) => proposalRepo.findById(TENANT, id)),
    );
    const schedule = proposals.find((p) => p?.proposalType === 'onboarding_schedule');
    expect(schedule).toBeTruthy();
    return schedule!;
  }

  it('seasonal-only working hours draft GATED on workingHours, keeping the seasonal entry the owner actually said', async () => {
    const schedule = await scheduleProposal(SEASONAL_ONLY_SCRIPTS);

    const workingHours = schedule.payload.workingHours as Array<Record<string, unknown>>;
    expect(workingHours).toHaveLength(1);
    expect(workingHours[0].seasonal).toBe('summer');
    expect(missingFieldsFor(schedule)).toEqual(['workingHours']);
    expect(schedule.status).toBe('draft');

    await expect(
      approveProposal(proposalRepo, TENANT, schedule.id, USER, 'owner'),
    ).rejects.toThrow(/unfilled required fields/i);
  });

  it('the counterfactual: without the gate this exact card approves clean and THEN fails at execution with ALL_ENTRIES_SEASONAL', async () => {
    const schedule = await scheduleProposal(SEASONAL_ONLY_SCRIPTS);
    const settingsRepo = new InMemorySettingsRepository();
    const handler = new OnboardingScheduleExecutionHandler(settingsRepo, auditRepo);

    // Simulate the pre-fix world: same payload, as if the (missing) gate had
    // let it straight through to 'approved'.
    const result = await handler.execute(
      { ...schedule, status: 'approved' },
      { tenantId: TENANT, executedBy: USER, executedByRole: 'owner' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ALL_ENTRIES_SEASONAL/);
  });

  it('the gate is fillable end to end: edit in a base weekly entry → gate clears → approve → execute → business hours persisted', async () => {
    const schedule = await scheduleProposal(SEASONAL_ONLY_SCRIPTS);

    const { proposal: edited } = await editProposal(
      proposalRepo,
      TENANT,
      schedule.id,
      USER,
      'owner',
      {
        workingHours: [
          { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], startTime: '08:00', endTime: '17:00' },
          { days: ['saturday'], startTime: '09:00', endTime: '13:00', seasonal: 'summer' },
        ],
      },
    );
    expect(missingFieldsFor(edited)).toEqual([]);

    const approved = await approveProposal(proposalRepo, TENANT, schedule.id, USER, 'owner');
    expect(approved.status).toBe('approved');

    const settingsRepo = new InMemorySettingsRepository();
    const result = await new OnboardingScheduleExecutionHandler(settingsRepo, auditRepo).execute(
      approved,
      { tenantId: TENANT, executedBy: USER, executedByRole: 'owner' },
    );

    expect(result.success).toBe(true);
    const settings = await settingsRepo.findByTenant(TENANT);
    expect(settings?.businessHours?.mon).toEqual({ open: '08:00', close: '17:00' });
    expect(settings?.businessHours?.sat).toBeUndefined();
  });

  it('a schedule with a base weekly entry never gates, even alongside a seasonal one (parity)', async () => {
    const schedule = await scheduleProposal({
      ...SEASONAL_ONLY_SCRIPTS,
      extract_schedule: {
        working_hours: [
          { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start_time: '08:00', end_time: '17:00' },
          { days: ['saturday'], start_time: '09:00', end_time: '13:00', seasonal: 'summer' },
        ],
        confidence_score: 0.9,
      },
    });
    expect(missingFieldsFor(schedule)).toEqual([]);
    expect(schedule.status).toBe('draft');
    const approved = await approveProposal(proposalRepo, TENANT, schedule.id, USER, 'owner');
    expect(approved.status).toBe('approved');
  });
});
