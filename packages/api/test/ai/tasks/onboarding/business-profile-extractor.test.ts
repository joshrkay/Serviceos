import { describe, it, expect, beforeEach } from 'vitest';
import { createMockLLMGateway } from '../../../../src/ai/gateway/factory';
import { BusinessProfileExtractor } from '../../../../src/ai/tasks/onboarding/business-profile-extractor';
import { ExtractionContext } from '../../../../src/ai/tasks/onboarding/types';
import { MockLLMProvider } from '../../../../src/ai/providers/mock';
import { LLMGateway } from '../../../../src/ai/gateway/gateway';
import * as fs from 'fs';
import * as path from 'path';

const fixturesDir = path.join(__dirname, '../../../fixtures/onboarding');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf-8');
}

function makeContext(transcript: string): ExtractionContext {
  return {
    tenantId: 'tenant-001',
    transcript,
    userId: 'user-001',
  };
}

describe('P4-EXT-001 — Business profile extraction from voice transcript', () => {
  let gateway: LLMGateway;
  let provider: MockLLMProvider;
  let extractor: BusinessProfileExtractor;

  beforeEach(() => {
    const mock = createMockLLMGateway();
    gateway = mock.gateway;
    provider = mock.provider;
    extractor = new BusinessProfileExtractor(gateway);
  });

  // T3-001: Vertical identification — "We're an HVAC company"
  it('T3-001 — identifies HVAC vertical from clear description', async () => {
    provider.setDefaultResponse(JSON.stringify({
      business_name: 'Comfort Zone HVAC',
      city: 'Scottsdale',
      state: 'AZ',
      verticals: [{ type: 'hvac', confidence: 0.95, source_text: 'We handle AC repair, maintenance tune-ups, and full system replacements' }],
      service_descriptions: ['AC repair', 'maintenance tune-ups', 'full system replacements'],
      confidence_score: 0.92,
    }));

    const result = await extractor.extract(makeContext(loadFixture('fixture-01-hvac-happy-path.txt')));

    expect(result.data.verticalPacks).toHaveLength(1);
    expect(result.data.verticalPacks[0].type).toBe('hvac');
    expect(result.data.verticalPacks[0].confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.data.businessName).toBe('Comfort Zone HVAC');
    expect(result.needsClarification).toBe(false);
  });

  // T3-002: Dual vertical — "We do HVAC and plumbing"
  it('T3-002 — identifies both HVAC and plumbing verticals', async () => {
    provider.setDefaultResponse(JSON.stringify({
      business_name: 'Desert Home Services',
      city: null,
      state: null,
      verticals: [
        { type: 'hvac', confidence: 0.9, source_text: 'AC side we focus on repair and tune-ups' },
        { type: 'plumbing', confidence: 0.9, source_text: 'plumbing side it\'s mainly drains and water heaters' },
      ],
      service_descriptions: ['AC repair', 'tune-ups', 'drains', 'water heaters'],
      confidence_score: 0.88,
    }));

    const result = await extractor.extract(makeContext(loadFixture('fixture-03-dual-trade.txt')));

    expect(result.data.verticalPacks).toHaveLength(2);
    const types = result.data.verticalPacks.map((v) => v.type).sort();
    expect(types).toEqual(['hvac', 'plumbing']);
  });

  // T3-010: Company info — "Johnson's HVAC out of Mesa"
  it('T3-010 — extracts business name and city', async () => {
    provider.setDefaultResponse(JSON.stringify({
      business_name: 'Comfort Zone HVAC',
      city: 'Scottsdale',
      state: 'AZ',
      verticals: [{ type: 'hvac', confidence: 0.95, source_text: 'HVAC here in Scottsdale' }],
      service_descriptions: [],
      confidence_score: 0.9,
    }));

    const result = await extractor.extract(makeContext(loadFixture('fixture-01-hvac-happy-path.txt')));

    expect(result.data.businessName).toBe('Comfort Zone HVAC');
    expect(result.data.city).toBe('Scottsdale');
  });

  // T3-012: No hallucination — transcript mentions AC repair only, no plumbing
  it('T3-012 — does not hallucinate verticals not in transcript', async () => {
    provider.setDefaultResponse(JSON.stringify({
      business_name: 'Comfort Zone HVAC',
      city: 'Scottsdale',
      state: 'AZ',
      verticals: [{ type: 'hvac', confidence: 0.95, source_text: 'AC repair' }],
      service_descriptions: ['AC repair', 'maintenance tune-ups', 'system replacements'],
      confidence_score: 0.92,
    }));

    const result = await extractor.extract(makeContext(loadFixture('fixture-01-hvac-happy-path.txt')));

    // Should NOT contain plumbing
    const plumbing = result.data.verticalPacks.find((v) => v.type === 'plumbing');
    expect(plumbing).toBeUndefined();
  });

  // T3-013: Vague input — "We fix stuff for people"
  it('T3-013 — requests clarification for vague input', async () => {
    provider.setDefaultResponse(JSON.stringify({
      business_name: null,
      city: null,
      state: null,
      verticals: [],
      service_descriptions: ['fix air conditioners'],
      confidence_score: 0.2,
    }));

    const result = await extractor.extract(makeContext(loadFixture('fixture-04-vague-incomplete.txt')));

    expect(result.needsClarification).toBe(true);
    expect(result.clarificationQuestions).toBeDefined();
    expect(result.clarificationQuestions!.length).toBeGreaterThan(0);
  });

  it('handles unparseable LLM response gracefully', async () => {
    provider.setDefaultResponse('not valid json at all');

    const result = await extractor.extract(makeContext('We do HVAC'));

    expect(result.data.verticalPacks).toEqual([]);
    expect(result.data.businessName).toBeNull();
    expect(result.needsClarification).toBe(true);
  });

  it('filters out invalid vertical types from LLM response', async () => {
    provider.setDefaultResponse(JSON.stringify({
      business_name: 'Test Co',
      verticals: [
        { type: 'hvac', confidence: 0.9, source_text: 'AC' },
        { type: 'electrical', confidence: 0.8, source_text: 'wiring' }, // invalid
      ],
      service_descriptions: [],
      confidence_score: 0.8,
    }));

    const result = await extractor.extract(makeContext('We do HVAC and electrical'));

    expect(result.data.verticalPacks).toHaveLength(1);
    expect(result.data.verticalPacks[0].type).toBe('hvac');
  });
});
