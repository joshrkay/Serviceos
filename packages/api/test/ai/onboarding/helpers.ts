import fs from 'fs';
import path from 'path';
import { createMockLLMGateway } from '../../../src/ai/gateway/factory';
import type { ExtractionContext } from '../../../src/ai/tasks/onboarding/types';

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'fixtures', 'onboarding');

export function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

// --- Default mock JSON responses for each extractor ---

export function mockBusinessProfileResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    business_name: 'Comfort Zone HVAC',
    city: 'Scottsdale',
    state: 'AZ',
    verticals: [
      { type: 'hvac', confidence: 0.95, source_text: 'We handle AC repair, maintenance tune-ups, and full system replacements' },
    ],
    service_descriptions: ['AC repair', 'maintenance tune-ups', 'full system replacements'],
    confidence_score: 0.9,
    ...overrides,
  });
}

export function mockCategoryResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    categories: [
      { vertical_type: 'hvac', category_id: 'repair', name: 'AC Repair', confidence: 0.9, source_text: 'AC repair' },
      { vertical_type: 'hvac', category_id: 'maintenance', name: 'Maintenance Tune-Up', confidence: 0.9, source_text: 'maintenance tune-ups' },
      { vertical_type: 'hvac', category_id: 'replacement', name: 'System Replacement', confidence: 0.85, source_text: 'full system replacements' },
    ],
    confidence_score: 0.88,
    ...overrides,
  });
}

export function mockPricingResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    prices: [
      { service_ref: 'diagnostic', amount_cents: 8900, price_type: 'exact', confidence: 0.95, source_text: 'Diagnostic fee is $89' },
      { service_ref: 'maintenance', amount_cents: 14900, price_type: 'exact', confidence: 0.95, source_text: 'tune-ups run $149' },
      { service_ref: 'replacement', amount_cents: 450000, price_type: 'range_start', qualifier: 'basic 3-ton system', confidence: 0.8, source_text: 'start at about $4,500' },
    ],
    confidence_score: 0.88,
    ...overrides,
  });
}

export function mockTeamResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    members: [
      { name: 'Marcus', inferred_role: 'technician', confidence: 0.9, source_text: 'two techs — Marcus and Tony' },
      { name: 'Tony', inferred_role: 'technician', confidence: 0.9, source_text: 'two techs — Marcus and Tony' },
    ],
    confidence_score: 0.9,
    ...overrides,
  });
}

export function mockScheduleResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    working_hours: [
      { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start_time: '08:00', end_time: '17:00' },
      { days: ['saturday'], start_time: '08:00', end_time: '17:00', seasonal: 'summer' },
    ],
    sla: { type: 'emergency', hours_target: 4, is_guarantee: false, source_text: 'Emergency calls we try to get to within 4 hours' },
    confidence_score: 0.85,
    ...overrides,
  });
}

export function buildExtractionContext(overrides: Partial<ExtractionContext> = {}): ExtractionContext {
  return {
    tenantId: 'tenant-test-001',
    transcript: loadFixture('fixture-01-hvac-happy-path.txt'),
    conversationId: 'conv-test-001',
    userId: 'user-test-001',
    ...overrides,
  };
}

/**
 * Create a mock gateway that returns different responses based on the LLM request's taskType.
 * Useful for orchestrator tests where multiple extractors are called sequentially.
 */
export function createTaskRoutedMock(responses: Record<string, string>) {
  const { gateway, provider } = createMockLLMGateway();
  const originalComplete = provider.complete.bind(provider);
  provider.complete = async (request) => {
    if (responses[request.taskType]) {
      provider.setDefaultResponse(responses[request.taskType]);
    }
    return originalComplete(request);
  };
  return { gateway, provider };
}

/**
 * Build a full set of task-routed mock responses for the HVAC happy-path scenario.
 */
export function hvacHappyPathResponses(): Record<string, string> {
  return {
    extract_business_profile: mockBusinessProfileResponse(),
    extract_categories: mockCategoryResponse(),
    extract_pricing: mockPricingResponse(),
    extract_team: mockTeamResponse(),
    extract_schedule: mockScheduleResponse(),
  };
}

/**
 * Build mock responses for the plumbing scenario (fixture-02).
 */
export function plumbingResponses(): Record<string, string> {
  return {
    extract_business_profile: mockBusinessProfileResponse({
      business_name: 'Reliable Plumbing',
      city: 'Tempe',
      state: 'AZ',
      verticals: [{ type: 'plumbing', confidence: 0.95, source_text: 'Reliable Plumbing' }],
      service_descriptions: ['drain clearing', 'water heater installs', 'repipes'],
    }),
    extract_categories: mockCategoryResponse({
      categories: [
        { vertical_type: 'plumbing', category_id: 'drain', name: 'Drain Clearing', confidence: 0.95, source_text: 'Drain clearing is our bread and butter' },
        { vertical_type: 'plumbing', category_id: 'water-heater', name: 'Water Heater Install', confidence: 0.9, source_text: 'water heater installs' },
        { vertical_type: 'plumbing', category_id: 'replacement', name: 'Repipe', confidence: 0.85, source_text: 'full repipes for older homes' },
      ],
    }),
    extract_pricing: mockPricingResponse({
      prices: [
        { service_ref: 'drain', amount_cents: 17500, price_type: 'exact', confidence: 0.95, source_text: 'drain clearing is usually $175' },
        { service_ref: 'water-heater', amount_cents: 50000, price_type: 'exact', qualifier: 'labor for standard tank', confidence: 0.8, source_text: 'labor is about $500' },
      ],
    }),
    extract_team: mockTeamResponse({
      members: [
        { name: 'Mike', inferred_role: 'owner', confidence: 0.9, source_text: 'I run the trucks myself' },
        { name: 'Javier', inferred_role: 'technician', confidence: 0.9, source_text: 'two guys, Javier and Sam' },
        { name: 'Sam', inferred_role: 'technician', confidence: 0.9, source_text: 'two guys, Javier and Sam' },
        { name: 'Linda', inferred_role: 'dispatcher', confidence: 0.85, source_text: 'my wife Linda answers the phones' },
      ],
    }),
    extract_schedule: mockScheduleResponse({
      working_hours: [
        { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'], start_time: '07:00', end_time: '16:00' },
      ],
      sla: null,
    }),
  };
}

/**
 * Build mock responses for the dual-trade scenario (fixture-03).
 */
export function dualTradeResponses(): Record<string, string> {
  return {
    extract_business_profile: mockBusinessProfileResponse({
      business_name: 'Desert Home Services',
      city: null,
      state: null,
      verticals: [
        { type: 'hvac', confidence: 0.9, source_text: 'AC side we focus on repair and tune-ups' },
        { type: 'plumbing', confidence: 0.9, source_text: 'plumbing side it\'s mainly drains and water heaters' },
      ],
      service_descriptions: ['AC repair', 'tune-ups', 'drains', 'water heaters'],
    }),
    extract_categories: mockCategoryResponse({
      categories: [
        { vertical_type: 'hvac', category_id: 'repair', name: 'AC Repair', confidence: 0.9, source_text: 'repair' },
        { vertical_type: 'hvac', category_id: 'maintenance', name: 'Tune-Up', confidence: 0.9, source_text: 'tune-ups' },
        { vertical_type: 'hvac', category_id: 'diagnostic', name: 'AC Diagnostic', confidence: 0.85, source_text: 'AC diagnostic is $89' },
        { vertical_type: 'plumbing', category_id: 'drain', name: 'Drain Clearing', confidence: 0.9, source_text: 'drains' },
        { vertical_type: 'plumbing', category_id: 'water-heater', name: 'Water Heater', confidence: 0.9, source_text: 'water heaters' },
        { vertical_type: 'plumbing', category_id: 'diagnostic', name: 'Plumbing Diagnostic', confidence: 0.85, source_text: 'plumbing diagnostic is $99' },
      ],
    }),
    extract_pricing: mockPricingResponse({
      prices: [
        { service_ref: 'AC Diagnostic', amount_cents: 8900, price_type: 'exact', confidence: 0.95, source_text: 'AC diagnostic is $89' },
        { service_ref: 'Plumbing Diagnostic', amount_cents: 9900, price_type: 'exact', confidence: 0.95, source_text: 'plumbing diagnostic is $99' },
        { service_ref: 'Tune-Up', amount_cents: 14900, price_type: 'exact', confidence: 0.95, source_text: 'tune-ups $149' },
      ],
    }),
    extract_team: mockTeamResponse({
      members: [
        { name: 'HVAC Tech 1', inferred_role: 'technician', confidence: 0.7, source_text: 'three HVAC guys' },
        { name: 'HVAC Tech 2', inferred_role: 'technician', confidence: 0.7, source_text: 'three HVAC guys' },
        { name: 'HVAC Tech 3', inferred_role: 'technician', confidence: 0.7, source_text: 'three HVAC guys' },
        { name: 'Plumber 1', inferred_role: 'technician', confidence: 0.7, source_text: 'two plumbers' },
        { name: 'Plumber 2', inferred_role: 'technician', confidence: 0.7, source_text: 'two plumbers' },
      ],
    }),
    extract_schedule: mockScheduleResponse({
      working_hours: [
        { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start_time: '07:30', end_time: '17:00' },
      ],
      sla: null,
    }),
  };
}

/**
 * Build mock responses for the vague/incomplete scenario (fixture-04).
 */
export function vagueResponses(): Record<string, string> {
  return {
    extract_business_profile: mockBusinessProfileResponse({
      business_name: null,
      city: null,
      state: null,
      verticals: [{ type: 'hvac', confidence: 0.4, source_text: 'mostly their air conditioners' }],
      service_descriptions: ['fix air conditioners'],
      confidence_score: 0.3,
    }),
    extract_categories: JSON.stringify({ categories: [], confidence_score: 0.2 }),
    extract_pricing: JSON.stringify({ prices: [], confidence_score: 0.1 }),
    extract_team: JSON.stringify({ members: [], confidence_score: 0.3 }),
    extract_schedule: JSON.stringify({ working_hours: [], sla: null, confidence_score: 0.2 }),
  };
}

/**
 * Build mock responses for the contradictory scenario (fixture-05).
 */
export function contradictoryResponses(): Record<string, string> {
  return {
    extract_business_profile: mockBusinessProfileResponse({
      business_name: null,
      city: null,
      state: null,
      verticals: [],
      service_descriptions: ['diagnostic', 'tune-ups'],
      confidence_score: 0.4,
    }),
    extract_categories: JSON.stringify({ categories: [], confidence_score: 0.3 }),
    extract_pricing: mockPricingResponse({
      prices: [
        { service_ref: 'diagnostic', amount_cents: 8900, price_type: 'exact', confidence: 0.7, source_text: 'actually we just raised it to $89' },
        { service_ref: 'tune-up', amount_cents: 14900, price_type: 'exact', confidence: 0.8, source_text: 'yeah $149' },
      ],
    }),
    extract_team: JSON.stringify({ members: [], confidence_score: 0.2 }),
    extract_schedule: JSON.stringify({ working_hours: [], sla: null, confidence_score: 0.2 }),
  };
}
