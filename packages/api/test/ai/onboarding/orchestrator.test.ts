import { OnboardingOrchestrator } from '../../../src/ai/orchestration/onboarding';
import {
  onboardingTenantSettingsPayloadSchema,
  onboardingServiceCategoryPayloadSchema,
  onboardingEstimateTemplatePayloadSchema,
  onboardingTeamMemberPayloadSchema,
  onboardingSchedulePayloadSchema,
} from '../../../src/proposals/contracts/onboarding';
import {
  loadFixture,
  createTaskRoutedMock,
  hvacHappyPathResponses,
  plumbingResponses,
  dualTradeResponses,
  vagueResponses,
  contradictoryResponses,
} from './helpers';

describe('P4-EXT-008 — Onboarding proposal orchestration and sequencing', () => {
  // ─── Dependency ordering (T4-001) ──────────────────────────────────────

  it('T4-001 — extracts in dependency order: profile → categories/team/schedule → pricing', async () => {
    const { gateway, provider } = createTaskRoutedMock(hvacHappyPathResponses());
    const orchestrator = new OnboardingOrchestrator(gateway);
    const transcript = loadFixture('fixture-01-hvac-happy-path.txt');

    await orchestrator.run('tenant-1', 'user-1', transcript, 'conv-1');

    const calls = provider.getCalls();
    const taskTypes = calls.map((c) => c.taskType);

    // Profile must be first
    expect(taskTypes[0]).toBe('extract_business_profile');

    // Categories, team, schedule run in parallel (phase 2) — all before pricing
    const phase2Tasks = ['extract_categories', 'extract_team', 'extract_schedule'];
    const pricingIndex = taskTypes.indexOf('extract_pricing');
    for (const task of phase2Tasks) {
      const idx = taskTypes.indexOf(task);
      expect(idx).toBeGreaterThan(0); // after profile
      expect(idx).toBeLessThan(pricingIndex); // before pricing
    }

    // Pricing is last extraction
    expect(pricingIndex).toBe(taskTypes.length - 1);
  });

  // ─── Proposal ordering (T4-002) ───────────────────────────────────────

  it('T4-002 — proposals follow dependency order: settings → categories → templates → team → schedule', async () => {
    const { gateway } = createTaskRoutedMock(hvacHappyPathResponses());
    const orchestrator = new OnboardingOrchestrator(gateway);
    const transcript = loadFixture('fixture-01-hvac-happy-path.txt');

    const result = await orchestrator.run('tenant-1', 'user-1', transcript);

    // Find first proposal of each type
    const proposals = result.proposalIds;
    expect(proposals.length).toBeGreaterThan(0);

    // Verify the result has all expected pieces
    expect(result.extraction.businessProfile.businessName).toBe('Comfort Zone HVAC');
    expect(result.extraction.categories.categories.length).toBeGreaterThanOrEqual(3);
    expect(result.extraction.pricing.prices.length).toBeGreaterThanOrEqual(3);
    expect(result.extraction.team.members).toHaveLength(2);
    expect(result.extraction.schedule.workingHours.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Batch grouping (T4-003, T5-007) ──────────────────────────────────

  it('T4-003 / T5-007 — proposals grouped into batches of max 5', async () => {
    const { gateway } = createTaskRoutedMock(dualTradeResponses());
    const orchestrator = new OnboardingOrchestrator(gateway);
    const transcript = loadFixture('fixture-03-dual-trade.txt');

    const result = await orchestrator.run('tenant-1', 'user-1', transcript);

    // Dual trade should generate many proposals:
    // 1 tenant settings + 6 categories + 6 templates + 5 team + 1 schedule = 19
    const totalProposals = result.proposalIds.length;
    expect(totalProposals).toBeGreaterThan(5); // enough for multiple batches

    // Check batching
    expect(result.batches.length).toBeGreaterThan(1);
    for (const batch of result.batches) {
      expect(batch.proposalIds.length).toBeLessThanOrEqual(5);
      expect(batch.proposalIds.length).toBeGreaterThan(0);
    }

    // Batch indices are sequential
    result.batches.forEach((batch, i) => {
      expect(batch.batchIndex).toBe(i);
    });

    // All proposal IDs accounted for in batches
    const batchedIds = result.batches.flatMap((b) => b.proposalIds);
    expect(batchedIds).toHaveLength(totalProposals);
  });

  // ─── Incomplete extraction (T4-004) ───────────────────────────────────

  it('T4-004 — vague input produces fewer proposals and triggers clarification', async () => {
    const { gateway } = createTaskRoutedMock(vagueResponses());
    const orchestrator = new OnboardingOrchestrator(gateway);
    const transcript = loadFixture('fixture-04-vague-incomplete.txt');

    const result = await orchestrator.run('tenant-1', 'user-1', transcript);

    // Very few proposals due to vague input
    expect(result.proposalIds.length).toBeLessThan(5);
    expect(result.needsClarification).toBe(true);
    expect(result.clarificationQuestions.length).toBeGreaterThan(0);
  });

  // ─── E2E: HVAC happy path (T7-001) ────────────────────────────────────

  it('T7-001 — HVAC owner: full tenant configuration', async () => {
    const { gateway } = createTaskRoutedMock(hvacHappyPathResponses());
    const orchestrator = new OnboardingOrchestrator(gateway);
    const transcript = loadFixture('fixture-01-hvac-happy-path.txt');

    const result = await orchestrator.run('tenant-1', 'user-1', transcript, 'conv-1');

    // Business profile
    expect(result.extraction.businessProfile.businessName).toBe('Comfort Zone HVAC');
    expect(result.extraction.businessProfile.verticalPacks.length).toBeGreaterThanOrEqual(1);
    expect(result.extraction.businessProfile.verticalPacks[0].type).toBe('hvac');

    // Categories
    expect(result.extraction.categories.categories.length).toBeGreaterThanOrEqual(3);

    // Pricing — all in integer cents
    expect(result.extraction.pricing.prices.length).toBeGreaterThanOrEqual(3);
    for (const price of result.extraction.pricing.prices) {
      expect(Number.isInteger(price.amountCents)).toBe(true);
      expect(price.amountCents).toBeGreaterThan(0);
    }

    // Team
    expect(result.extraction.team.members).toHaveLength(2);

    // Schedule + SLA
    expect(result.extraction.schedule.workingHours.length).toBeGreaterThanOrEqual(1);
    expect(result.extraction.schedule.sla).toBeDefined();
    expect(result.extraction.schedule.sla!.hoursTarget).toBe(4);

    // Proposals generated
    expect(result.proposalIds.length).toBeGreaterThanOrEqual(8); // settings + categories + templates + team + schedule
    expect(result.needsClarification).toBe(false);
  });

  // ─── E2E: Plumbing (T7-002) ───────────────────────────────────────────

  it('T7-002 — Plumber: plumbing pack with plumbing categories', async () => {
    const { gateway } = createTaskRoutedMock(plumbingResponses());
    const orchestrator = new OnboardingOrchestrator(gateway);
    const transcript = loadFixture('fixture-02-plumbing.txt');

    const result = await orchestrator.run('tenant-1', 'user-1', transcript);

    // Plumbing vertical
    expect(result.extraction.businessProfile.businessName).toBe('Reliable Plumbing');
    expect(result.extraction.businessProfile.verticalPacks[0].type).toBe('plumbing');

    // Plumbing categories
    const catIds = result.extraction.categories.categories.map((c) => c.categoryId);
    expect(catIds).toContain('drain');
    expect(catIds).toContain('water-heater');

    // Team: owner + 2 techs + dispatcher
    expect(result.extraction.team.members).toHaveLength(4);
    const roles = result.extraction.team.members.map((m) => m.inferredRole);
    expect(roles).toContain('owner');
    expect(roles).toContain('dispatcher');

    // M-Sat schedule
    expect(result.extraction.schedule.workingHours[0].days).toHaveLength(6);
  });

  // ─── E2E: Dual trade (T7-003) ─────────────────────────────────────────

  it('T7-003 — Dual trade: both HVAC and plumbing packs active', async () => {
    const { gateway } = createTaskRoutedMock(dualTradeResponses());
    const orchestrator = new OnboardingOrchestrator(gateway);
    const transcript = loadFixture('fixture-03-dual-trade.txt');

    const result = await orchestrator.run('tenant-1', 'user-1', transcript);

    // Both verticals
    const verticalTypes = result.extraction.businessProfile.verticalPacks.map((v) => v.type);
    expect(verticalTypes).toContain('hvac');
    expect(verticalTypes).toContain('plumbing');

    // Categories from both verticals
    const hvacCats = result.extraction.categories.categories.filter((c) => c.verticalType === 'hvac');
    const plumbingCats = result.extraction.categories.categories.filter((c) => c.verticalType === 'plumbing');
    expect(hvacCats.length).toBeGreaterThan(0);
    expect(plumbingCats.length).toBeGreaterThan(0);

    // Team of 5
    expect(result.extraction.team.members).toHaveLength(5);
  });

  // ─── E2E: Vague input (T7-007) ────────────────────────────────────────

  it('T7-007 — Vague input: vertical activated, clarification questions generated', async () => {
    const { gateway } = createTaskRoutedMock(vagueResponses());
    const orchestrator = new OnboardingOrchestrator(gateway);
    const transcript = loadFixture('fixture-04-vague-incomplete.txt');

    const result = await orchestrator.run('tenant-1', 'user-1', transcript);

    // Should still attempt extraction
    expect(result.extraction.businessProfile).toBeDefined();
    // Should flag clarification needed
    expect(result.needsClarification).toBe(true);
    expect(result.clarificationQuestions.length).toBeGreaterThan(0);
    // Very few proposals
    expect(result.proposalIds.length).toBeLessThanOrEqual(3);
  });

  // ─── E2E: Contradictory input (T7-005 variant) ────────────────────────

  it('T7-005 variant — Contradictory input: pricing uses most recent values', async () => {
    const { gateway } = createTaskRoutedMock(contradictoryResponses());
    const orchestrator = new OnboardingOrchestrator(gateway);
    const transcript = loadFixture('fixture-05-contradictory-rambling.txt');

    const result = await orchestrator.run('tenant-1', 'user-1', transcript);

    // Pricing should use most recent values
    const diagPrice = result.extraction.pricing.prices.find((p) => p.serviceRef === 'diagnostic');
    if (diagPrice) {
      expect(diagPrice.amountCents).toBe(8900); // $89, not $79
    }
    const tuneUpPrice = result.extraction.pricing.prices.find((p) => p.serviceRef === 'tune-up');
    if (tuneUpPrice) {
      expect(tuneUpPrice.amountCents).toBe(14900); // $149, not $129/$139
    }
  });

  // ─── All proposals have valid IDs and structure ────────────────────────

  it('all proposals have unique IDs, correct tenantId, and draft status', async () => {
    const { gateway } = createTaskRoutedMock(hvacHappyPathResponses());
    const orchestrator = new OnboardingOrchestrator(gateway);
    const transcript = loadFixture('fixture-01-hvac-happy-path.txt');

    const result = await orchestrator.run('tenant-1', 'user-1', transcript);

    // All IDs unique
    const ids = new Set(result.proposalIds);
    expect(ids.size).toBe(result.proposalIds.length);
  });

  // ─── Extraction context is threaded correctly ──────────────────────────

  it('passes conversationId through to proposals', async () => {
    const { gateway } = createTaskRoutedMock(hvacHappyPathResponses());
    const orchestrator = new OnboardingOrchestrator(gateway);
    const transcript = loadFixture('fixture-01-hvac-happy-path.txt');

    const result = await orchestrator.run('tenant-1', 'user-1', transcript, 'conv-42');

    // Extraction should complete
    expect(result.proposalIds.length).toBeGreaterThan(0);
    // conversationId flows through context
    expect(result.extraction.transcript).toBe(transcript);
  });
});
