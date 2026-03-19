import { describe, it, expect, beforeEach } from 'vitest';
import { createMockLLMGateway } from '../../../../src/ai/gateway/factory';
import { CategoryExtractor } from '../../../../src/ai/tasks/onboarding/category-extractor';
import { ExtractionContext } from '../../../../src/ai/tasks/onboarding/types';
import { MockLLMProvider } from '../../../../src/ai/providers/mock';
import { LLMGateway } from '../../../../src/ai/gateway/gateway';
import * as fs from 'fs';
import * as path from 'path';

const fixturesDir = path.join(__dirname, '../../../fixtures/onboarding');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf-8');
}

function makeContext(transcript: string, verticals: Array<{ type: 'hvac' | 'plumbing'; confidence: number; sourceText: string }> = []): ExtractionContext {
  return {
    tenantId: 'tenant-001',
    transcript,
    userId: 'user-001',
    previousExtractions: {
      businessProfile: {
        businessName: 'Test Co',
        city: null,
        state: null,
        verticalPacks: verticals,
        serviceDescriptions: [],
        confidence: 0.8,
        lowConfidenceFields: [],
      },
    },
  };
}

describe('P4-EXT-002 — Service category extraction from voice transcript', () => {
  let gateway: LLMGateway;
  let provider: MockLLMProvider;
  let extractor: CategoryExtractor;

  beforeEach(() => {
    const mock = createMockLLMGateway();
    gateway = mock.gateway;
    provider = mock.provider;
    extractor = new CategoryExtractor(gateway);
  });

  // T3-003: Service category extraction — "AC repair, maintenance tune-ups, and full system replacements"
  it('T3-003 — extracts HVAC service categories', async () => {
    provider.setDefaultResponse(JSON.stringify({
      categories: [
        { vertical_type: 'hvac', category_id: 'repair', name: 'AC Repair', confidence: 0.9, source_text: 'AC repair' },
        { vertical_type: 'hvac', category_id: 'maintenance', name: 'Maintenance Tune-ups', confidence: 0.9, source_text: 'maintenance tune-ups' },
        { vertical_type: 'hvac', category_id: 'replacement', name: 'System Replacement', confidence: 0.85, source_text: 'full system replacements' },
      ],
      confidence_score: 0.88,
    }));

    const hvacVerticals = [{ type: 'hvac' as const, confidence: 0.95, sourceText: 'HVAC' }];
    const result = await extractor.extract(makeContext(loadFixture('fixture-01-hvac-happy-path.txt'), hvacVerticals));

    expect(result.data.categories).toHaveLength(3);
    expect(result.data.categories.every((c) => c.verticalType === 'hvac')).toBe(true);
    const ids = result.data.categories.map((c) => c.categoryId).sort();
    expect(ids).toEqual(['maintenance', 'repair', 'replacement']);
  });

  // T3-004: Plumbing terminology — "Tankless water heater install, PEX repipe, sewer scope"
  it('T3-004 — extracts plumbing categories', async () => {
    provider.setDefaultResponse(JSON.stringify({
      categories: [
        { vertical_type: 'plumbing', category_id: 'drain', name: 'Drain Clearing', confidence: 0.9, source_text: 'Drain clearing' },
        { vertical_type: 'plumbing', category_id: 'water-heater', name: 'Water Heater Install', confidence: 0.9, source_text: 'water heater installs' },
        { vertical_type: 'plumbing', category_id: 'replacement', name: 'Repipe', confidence: 0.85, source_text: 'full repipes' },
      ],
      confidence_score: 0.87,
    }));

    const plumbingVerticals = [{ type: 'plumbing' as const, confidence: 0.95, sourceText: 'plumbing' }];
    const result = await extractor.extract(makeContext(loadFixture('fixture-02-plumbing.txt'), plumbingVerticals));

    expect(result.data.categories).toHaveLength(3);
    expect(result.data.categories.every((c) => c.verticalType === 'plumbing')).toBe(true);
  });

  // T3-012: No hallucination — should not create plumbing categories from HVAC-only transcript
  it('T3-012 — does not hallucinate categories not in transcript', async () => {
    provider.setDefaultResponse(JSON.stringify({
      categories: [
        { vertical_type: 'hvac', category_id: 'repair', name: 'AC Repair', confidence: 0.9, source_text: 'AC repair' },
      ],
      confidence_score: 0.9,
    }));

    const result = await extractor.extract(makeContext(loadFixture('fixture-01-hvac-happy-path.txt')));

    // Should not include plumbing categories
    const plumbing = result.data.categories.filter((c) => c.verticalType === 'plumbing');
    expect(plumbing).toHaveLength(0);
  });

  it('filters out invalid category IDs', async () => {
    provider.setDefaultResponse(JSON.stringify({
      categories: [
        { vertical_type: 'hvac', category_id: 'repair', name: 'AC Repair', confidence: 0.9, source_text: 'AC repair' },
        { vertical_type: 'hvac', category_id: 'nonexistent', name: 'Fake', confidence: 0.5, source_text: 'fake' },
      ],
      confidence_score: 0.7,
    }));

    const result = await extractor.extract(makeContext('We do AC repair and other stuff'));

    expect(result.data.categories).toHaveLength(1);
    expect(result.data.categories[0].categoryId).toBe('repair');
  });

  it('requests clarification when no categories extracted', async () => {
    provider.setDefaultResponse(JSON.stringify({
      categories: [],
      confidence_score: 0.2,
    }));

    const result = await extractor.extract(makeContext('We fix things'));

    expect(result.needsClarification).toBe(true);
    expect(result.clarificationQuestions!.length).toBeGreaterThan(0);
  });
});
