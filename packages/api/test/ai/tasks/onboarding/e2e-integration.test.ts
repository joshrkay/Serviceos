import { describe, it, expect, beforeEach } from 'vitest';
import { createMockLLMGateway } from '../../../../src/ai/gateway/factory';
import { OnboardingOrchestrator } from '../../../../src/ai/orchestration/onboarding';
import { generateOnboardingClarifications, mergeSupplementalTranscript } from '../../../../src/ai/clarification/onboarding';
import { MockLLMProvider } from '../../../../src/ai/providers/mock';
import { LLMGateway } from '../../../../src/ai/gateway/gateway';
import * as fs from 'fs';
import * as path from 'path';

const fixturesDir = path.join(__dirname, '../../../fixtures/onboarding');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf-8');
}

describe('T7 — End-to-End Integration Tests', () => {
  let gateway: LLMGateway;
  let provider: MockLLMProvider;
  let orchestrator: OnboardingOrchestrator;

  beforeEach(() => {
    const mock = createMockLLMGateway();
    gateway = mock.gateway;
    provider = mock.provider;
    orchestrator = new OnboardingOrchestrator(gateway);
  });

  // T7-001: HVAC owner records 3min describing business
  it('T7-001 — full HVAC onboarding produces complete tenant configuration', async () => {
    provider.setDefaultResponse(JSON.stringify({
      business_name: 'Comfort Zone HVAC',
      city: 'Scottsdale',
      state: 'AZ',
      verticals: [{ type: 'hvac', confidence: 0.95, source_text: 'HVAC here in Scottsdale' }],
      service_descriptions: ['AC repair', 'maintenance tune-ups', 'full system replacements'],
      categories: [
        { vertical_type: 'hvac', category_id: 'repair', name: 'AC Repair', confidence: 0.9, source_text: 'AC repair' },
        { vertical_type: 'hvac', category_id: 'maintenance', name: 'Maintenance Tune-up', confidence: 0.9, source_text: 'maintenance tune-ups' },
        { vertical_type: 'hvac', category_id: 'replacement', name: 'System Replacement', confidence: 0.85, source_text: 'full system replacements' },
      ],
      prices: [
        { service_ref: 'AC Repair', amount_cents: 8900, price_type: 'exact', confidence: 0.95, source_text: '$89' },
        { service_ref: 'Maintenance Tune-up', amount_cents: 14900, price_type: 'exact', confidence: 0.95, source_text: '$149' },
        { service_ref: 'System Replacement', amount_cents: 450000, price_type: 'range_start', qualifier: 'basic 3-ton', confidence: 0.7, source_text: '$4,500' },
      ],
      members: [
        { name: 'Marcus', inferred_role: 'technician', confidence: 0.9, source_text: 'Marcus' },
        { name: 'Tony', inferred_role: 'technician', confidence: 0.9, source_text: 'Tony' },
      ],
      working_hours: [
        { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start_time: '08:00', end_time: '17:00' },
        { days: ['saturday'], start_time: '08:00', end_time: '17:00', seasonal: 'summer' },
      ],
      sla: { type: 'emergency', hours_target: 4, is_guarantee: false, source_text: 'within 4 hours' },
      confidence_score: 0.88,
    }));

    const result = await orchestrator.run(
      'tenant-001', 'user-001', loadFixture('fixture-01-hvac-happy-path.txt')
    );

    // Verify HVAC pack identified
    expect(result.extraction.businessProfile.verticalPacks).toHaveLength(1);
    expect(result.extraction.businessProfile.verticalPacks[0].type).toBe('hvac');

    // Verify 3 categories
    expect(result.extraction.categories.categories).toHaveLength(3);

    // Verify pricing extracted
    expect(result.extraction.pricing.prices.length).toBeGreaterThanOrEqual(3);

    // Verify 2 techs
    expect(result.extraction.team.members).toHaveLength(2);

    // Verify working hours with seasonal Saturday
    expect(result.extraction.schedule.workingHours).toHaveLength(2);
    expect(result.extraction.schedule.sla).toBeDefined();
    expect(result.extraction.schedule.sla!.hoursTarget).toBe(4);

    // Verify proposals generated
    expect(result.proposalIds.length).toBeGreaterThan(0);
    expect(result.needsClarification).toBe(false);
  });

  // T7-002: Plumber describes business
  it('T7-002 — full plumbing onboarding produces correct configuration', async () => {
    provider.setDefaultResponse(JSON.stringify({
      business_name: 'Reliable Plumbing',
      city: 'Tempe',
      state: 'AZ',
      verticals: [{ type: 'plumbing', confidence: 0.95, source_text: 'Reliable Plumbing' }],
      service_descriptions: ['drain clearing', 'water heater installs', 'repipes'],
      categories: [
        { vertical_type: 'plumbing', category_id: 'drain', name: 'Drain Clearing', confidence: 0.9, source_text: 'drain clearing' },
        { vertical_type: 'plumbing', category_id: 'water-heater', name: 'Water Heater Install', confidence: 0.9, source_text: 'water heater installs' },
        { vertical_type: 'plumbing', category_id: 'replacement', name: 'Repipe', confidence: 0.85, source_text: 'repipes' },
      ],
      prices: [
        { service_ref: 'Drain Clearing', amount_cents: 17500, price_type: 'exact', confidence: 0.9, source_text: '$175' },
        { service_ref: 'Water Heater Install', amount_cents: 50000, price_type: 'exact', qualifier: 'labor only', confidence: 0.85, source_text: '$500' },
      ],
      members: [
        { name: 'Mike', inferred_role: 'owner', confidence: 0.85, source_text: 'I run the trucks myself' },
        { name: 'Javier', inferred_role: 'technician', confidence: 0.9, source_text: 'Javier' },
        { name: 'Sam', inferred_role: 'technician', confidence: 0.9, source_text: 'Sam' },
        { name: 'Linda', inferred_role: 'dispatcher', confidence: 0.85, source_text: 'Linda answers the phones' },
      ],
      working_hours: [
        { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'], start_time: '07:00', end_time: '16:00' },
      ],
      sla: null,
      confidence_score: 0.87,
    }));

    const result = await orchestrator.run(
      'tenant-001', 'user-001', loadFixture('fixture-02-plumbing.txt')
    );

    expect(result.extraction.businessProfile.verticalPacks[0].type).toBe('plumbing');
    expect(result.extraction.categories.categories).toHaveLength(3);
    expect(result.extraction.team.members).toHaveLength(4);

    const dispatcher = result.extraction.team.members.find((m) => m.inferredRole === 'dispatcher');
    expect(dispatcher).toBeDefined();
    expect(dispatcher!.name).toBe('Linda');
  });

  // T7-003: "We do HVAC and plumbing" — dual vertical
  it('T7-003 — dual-trade onboarding activates both packs', async () => {
    provider.setDefaultResponse(JSON.stringify({
      business_name: 'Desert Home Services',
      city: null,
      state: null,
      verticals: [
        { type: 'hvac', confidence: 0.9, source_text: 'AC side' },
        { type: 'plumbing', confidence: 0.9, source_text: 'plumbing side' },
      ],
      service_descriptions: ['AC repair', 'tune-ups', 'drains', 'water heaters'],
      categories: [
        { vertical_type: 'hvac', category_id: 'repair', name: 'AC Repair', confidence: 0.9, source_text: 'repair' },
        { vertical_type: 'hvac', category_id: 'maintenance', name: 'Tune-up', confidence: 0.9, source_text: 'tune-ups' },
        { vertical_type: 'plumbing', category_id: 'drain', name: 'Drain Clearing', confidence: 0.9, source_text: 'drains' },
        { vertical_type: 'plumbing', category_id: 'water-heater', name: 'Water Heater', confidence: 0.9, source_text: 'water heaters' },
      ],
      prices: [
        { service_ref: 'AC Repair', amount_cents: 8900, price_type: 'exact', confidence: 0.9, source_text: '$89' },
        { service_ref: 'Drain Clearing', amount_cents: 9900, price_type: 'exact', confidence: 0.9, source_text: '$99' },
        { service_ref: 'Tune-up', amount_cents: 14900, price_type: 'exact', confidence: 0.9, source_text: '$149' },
      ],
      members: [],
      working_hours: [
        { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start_time: '07:30', end_time: '17:00' },
      ],
      sla: null,
      confidence_score: 0.85,
    }));

    const result = await orchestrator.run(
      'tenant-001', 'user-001', loadFixture('fixture-03-dual-trade.txt')
    );

    const verticalTypes = result.extraction.businessProfile.verticalPacks.map((v) => v.type).sort();
    expect(verticalTypes).toEqual(['hvac', 'plumbing']);

    const hvacCategories = result.extraction.categories.categories.filter((c) => c.verticalType === 'hvac');
    const plumbingCategories = result.extraction.categories.categories.filter((c) => c.verticalType === 'plumbing');
    expect(hvacCategories.length).toBeGreaterThan(0);
    expect(plumbingCategories.length).toBeGreaterThan(0);
  });

  // T7-007: Owner says only "We're an HVAC company in Phoenix" — minimal info
  it('T7-007 — minimal input generates clarification questions', async () => {
    provider.setDefaultResponse(JSON.stringify({
      business_name: null,
      city: null,
      state: null,
      verticals: [{ type: 'hvac', confidence: 0.7, source_text: 'air conditioners' }],
      service_descriptions: ['fix air conditioners'],
      categories: [],
      prices: [],
      members: [],
      working_hours: [],
      sla: null,
      confidence_score: 0.3,
    }));

    const result = await orchestrator.run(
      'tenant-001', 'user-001', loadFixture('fixture-04-vague-incomplete.txt')
    );

    expect(result.needsClarification).toBe(true);
    expect(result.clarificationQuestions.length).toBeGreaterThan(0);

    // Also test the standalone clarification generator
    const questions = generateOnboardingClarifications(result.extraction);
    expect(questions.length).toBeGreaterThan(0);
  });

  // Test supplemental transcript merge
  it('merges supplemental transcript without overwriting original', () => {
    const original = {
      tenantId: 'tenant-001',
      transcript: 'We do HVAC.',
      userId: 'user-001',
    };

    const merged = mergeSupplementalTranscript(original, 'Our diagnostic fee is $89.');

    expect(merged.transcript).toContain('We do HVAC.');
    expect(merged.transcript).toContain('Our diagnostic fee is $89.');
    expect(merged.transcript).toContain('[Follow-up recording]');
    expect(merged.tenantId).toBe('tenant-001');
  });
});
