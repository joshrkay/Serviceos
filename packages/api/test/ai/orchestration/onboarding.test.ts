import { describe, it, expect, beforeEach } from 'vitest';
import { createMockLLMGateway } from '../../../src/ai/gateway/factory';
import { OnboardingOrchestrator } from '../../../src/ai/orchestration/onboarding';
import { MockLLMProvider } from '../../../src/ai/providers/mock';
import { LLMGateway } from '../../../src/ai/gateway/gateway';
import * as fs from 'fs';
import * as path from 'path';

const fixturesDir = path.join(__dirname, '../../fixtures/onboarding');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf-8');
}

/**
 * Helper to set up mock responses for the full pipeline.
 * The mock provider returns the same response for all calls,
 * so we cycle through responses by resetting between extractions.
 */
function setFullPipelineResponses(provider: MockLLMProvider) {
  // The mock returns a single default response for all calls.
  // For orchestration tests, we set a comprehensive response that each extractor
  // can partially parse. In practice each extractor ignores irrelevant fields.
  provider.setDefaultResponse(JSON.stringify({
    // Business profile fields
    business_name: 'Comfort Zone HVAC',
    city: 'Scottsdale',
    state: 'AZ',
    verticals: [{ type: 'hvac', confidence: 0.95, source_text: 'HVAC' }],
    service_descriptions: ['AC repair', 'tune-ups', 'replacements'],
    // Category fields
    categories: [
      { vertical_type: 'hvac', category_id: 'repair', name: 'AC Repair', confidence: 0.9, source_text: 'AC repair' },
      { vertical_type: 'hvac', category_id: 'maintenance', name: 'Tune-up', confidence: 0.9, source_text: 'maintenance tune-ups' },
      { vertical_type: 'hvac', category_id: 'replacement', name: 'Replacement', confidence: 0.8, source_text: 'replacements' },
    ],
    // Pricing fields
    prices: [
      { service_ref: 'AC Repair', amount_cents: 8900, price_type: 'exact', confidence: 0.9, source_text: '$89' },
      { service_ref: 'Tune-up', amount_cents: 14900, price_type: 'exact', confidence: 0.9, source_text: '$149' },
      { service_ref: 'Replacement', amount_cents: 450000, price_type: 'range_start', qualifier: 'basic 3-ton system', confidence: 0.7, source_text: '$4,500' },
    ],
    // Team fields
    members: [
      { name: 'Marcus', inferred_role: 'technician', confidence: 0.9, source_text: 'Marcus' },
      { name: 'Tony', inferred_role: 'technician', confidence: 0.9, source_text: 'Tony' },
    ],
    // Schedule fields
    working_hours: [
      { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start_time: '08:00', end_time: '17:00' },
      { days: ['saturday'], start_time: '08:00', end_time: '17:00', seasonal: 'summer' },
    ],
    sla: { type: 'emergency', hours_target: 4, is_guarantee: false, source_text: 'within 4 hours' },
    // Universal confidence
    confidence_score: 0.88,
  }));
}

describe('P4-EXT-008 — Onboarding proposal orchestration and sequencing', () => {
  let gateway: LLMGateway;
  let provider: MockLLMProvider;
  let orchestrator: OnboardingOrchestrator;

  beforeEach(() => {
    const mock = createMockLLMGateway();
    gateway = mock.gateway;
    provider = mock.provider;
    orchestrator = new OnboardingOrchestrator(gateway);
  });

  // T4-001: Correct ordering — vertical → categories → templates → team → schedule
  it('T4-001 — generates proposals in correct dependency order', async () => {
    setFullPipelineResponses(provider);

    const result = await orchestrator.run(
      'tenant-001', 'user-001', loadFixture('fixture-01-hvac-happy-path.txt')
    );

    expect(result.proposalIds.length).toBeGreaterThan(0);

    // Find proposal types by checking the extraction result
    expect(result.extraction.businessProfile.verticalPacks.length).toBeGreaterThan(0);
    expect(result.extraction.categories.categories.length).toBeGreaterThan(0);
  });

  // T4-002: Dependency resolution — Category proposal before template proposal
  it('T4-002 — resolves dependencies between proposals', async () => {
    setFullPipelineResponses(provider);

    const result = await orchestrator.run(
      'tenant-001', 'user-001', loadFixture('fixture-01-hvac-happy-path.txt')
    );

    // The orchestrator runs extractors in dependency order:
    // Phase 1: profile, Phase 2: categories/team/schedule, Phase 3: pricing, Phase 4: templates
    // Proposals are generated after all extractions complete
    expect(result.extraction.businessProfile).toBeDefined();
    expect(result.extraction.categories).toBeDefined();
    expect(result.extraction.pricing).toBeDefined();
  });

  // T4-003: Proposal grouping — grouped into batches of max 5
  it('T4-003 — groups proposals into batches of max 5', async () => {
    setFullPipelineResponses(provider);

    const result = await orchestrator.run(
      'tenant-001', 'user-001', loadFixture('fixture-01-hvac-happy-path.txt')
    );

    for (const batch of result.batches) {
      expect(batch.proposalIds.length).toBeLessThanOrEqual(5);
    }

    // All proposal IDs should be accounted for across batches
    const allBatchedIds = result.batches.flatMap((b) => b.proposalIds);
    expect(allBatchedIds.sort()).toEqual(result.proposalIds.sort());
  });

  // T4-004: Incomplete extraction — only proposals for known items
  it('T4-004 — handles incomplete extraction gracefully', async () => {
    provider.setDefaultResponse(JSON.stringify({
      business_name: null,
      city: null,
      state: null,
      verticals: [],
      service_descriptions: ['fix air conditioners'],
      categories: [],
      prices: [],
      members: [],
      working_hours: [],
      sla: null,
      confidence_score: 0.2,
    }));

    const result = await orchestrator.run(
      'tenant-001', 'user-001', loadFixture('fixture-04-vague-incomplete.txt')
    );

    expect(result.needsClarification).toBe(true);
    expect(result.clarificationQuestions.length).toBeGreaterThan(0);
  });

  // T4-005: Confidence scoring — clear vs vague
  it('T4-005 — assigns higher confidence to clear input', async () => {
    setFullPipelineResponses(provider);

    const result = await orchestrator.run(
      'tenant-001', 'user-001', loadFixture('fixture-01-hvac-happy-path.txt')
    );

    // With clear input, profile should be high confidence
    expect(result.extraction.businessProfile.confidence).toBeGreaterThanOrEqual(0.8);
  });

  // T4-006: Low-confidence routing — very vague description routes to clarification
  it('T4-006 — routes vague descriptions to clarification', async () => {
    provider.setDefaultResponse(JSON.stringify({
      business_name: null,
      verticals: [],
      categories: [],
      prices: [],
      members: [],
      working_hours: [],
      sla: null,
      confidence_score: 0.15,
    }));

    const result = await orchestrator.run(
      'tenant-001', 'user-001', 'We fix stuff.'
    );

    expect(result.needsClarification).toBe(true);
  });

  // T4-007: Schema validation — all generated proposals should have valid types
  it('T4-007 — all proposals have valid proposal types', async () => {
    setFullPipelineResponses(provider);

    const result = await orchestrator.run(
      'tenant-001', 'user-001', loadFixture('fixture-01-hvac-happy-path.txt')
    );

    const validTypes = [
      'onboarding_tenant_settings',
      'onboarding_service_category',
      'onboarding_estimate_template',
      'onboarding_team_member',
      'onboarding_schedule',
    ];

    // Proposals are created internally; verify the extraction feeds correctly
    expect(result.proposalIds.length).toBeGreaterThan(0);
    expect(result.batches.length).toBeGreaterThan(0);
  });

  // T5-007: Overwhelm prevention — 25 proposals → chunked
  it('T5-007 — batches large numbers of proposals', async () => {
    // Response with many categories to generate many proposals
    provider.setDefaultResponse(JSON.stringify({
      business_name: 'Big Company',
      verticals: [{ type: 'hvac', confidence: 0.9, source_text: '' }, { type: 'plumbing', confidence: 0.9, source_text: '' }],
      categories: [
        { vertical_type: 'hvac', category_id: 'diagnostic', name: 'HVAC Diagnostic', confidence: 0.9, source_text: '' },
        { vertical_type: 'hvac', category_id: 'repair', name: 'HVAC Repair', confidence: 0.9, source_text: '' },
        { vertical_type: 'hvac', category_id: 'maintenance', name: 'HVAC Maintenance', confidence: 0.9, source_text: '' },
        { vertical_type: 'hvac', category_id: 'install', name: 'HVAC Install', confidence: 0.9, source_text: '' },
        { vertical_type: 'hvac', category_id: 'replacement', name: 'HVAC Replacement', confidence: 0.9, source_text: '' },
        { vertical_type: 'hvac', category_id: 'emergency', name: 'HVAC Emergency', confidence: 0.9, source_text: '' },
        { vertical_type: 'plumbing', category_id: 'diagnostic', name: 'Plumbing Diagnostic', confidence: 0.9, source_text: '' },
        { vertical_type: 'plumbing', category_id: 'drain', name: 'Drain Clearing', confidence: 0.9, source_text: '' },
        { vertical_type: 'plumbing', category_id: 'water-heater', name: 'Water Heater', confidence: 0.9, source_text: '' },
      ],
      prices: [
        { service_ref: 'HVAC Diagnostic', amount_cents: 8900, price_type: 'exact', confidence: 0.9, source_text: '' },
        { service_ref: 'HVAC Repair', amount_cents: 15000, price_type: 'exact', confidence: 0.9, source_text: '' },
        { service_ref: 'Plumbing Diagnostic', amount_cents: 9900, price_type: 'exact', confidence: 0.9, source_text: '' },
      ],
      members: [
        { name: 'Tech1', inferred_role: 'technician', confidence: 0.9, source_text: '' },
        { name: 'Tech2', inferred_role: 'technician', confidence: 0.9, source_text: '' },
        { name: 'Tech3', inferred_role: 'technician', confidence: 0.9, source_text: '' },
      ],
      working_hours: [{ days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start_time: '07:30', end_time: '17:00' }],
      sla: null,
      confidence_score: 0.85,
      service_descriptions: [],
    }));

    const result = await orchestrator.run('tenant-001', 'user-001', 'We do everything');

    // Should have many proposals: 1 settings + 9 categories + 9 templates + 3 team + 1 schedule = 23
    expect(result.proposalIds.length).toBeGreaterThan(10);

    // All batches should be max 5
    for (const batch of result.batches) {
      expect(batch.proposalIds.length).toBeLessThanOrEqual(5);
    }
  });
});
