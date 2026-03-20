import { createMockLLMGateway } from '../../../src/ai/gateway/factory';
import { BusinessProfileExtractor } from '../../../src/ai/tasks/onboarding/business-profile-extractor';
import {
  loadFixture,
  buildExtractionContext,
  mockBusinessProfileResponse,
} from './helpers';

describe('P4-EXT-001 — Business profile extraction from voice transcript', () => {
  it('T3-001 — identifies HVAC vertical from clear description', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(mockBusinessProfileResponse());
    const extractor = new BusinessProfileExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    expect(result.data.verticalPacks).toHaveLength(1);
    expect(result.data.verticalPacks[0].type).toBe('hvac');
    expect(result.data.verticalPacks[0].confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.needsClarification).toBe(false);
  });

  it('T3-002 — identifies dual verticals (HVAC + plumbing)', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(
      mockBusinessProfileResponse({
        business_name: 'Desert Home Services',
        verticals: [
          { type: 'hvac', confidence: 0.9, source_text: 'AC side' },
          { type: 'plumbing', confidence: 0.9, source_text: 'plumbing side' },
        ],
      })
    );
    const extractor = new BusinessProfileExtractor(gateway);
    const transcript = loadFixture('fixture-03-dual-trade.txt');

    const result = await extractor.extract(buildExtractionContext({ transcript }));

    expect(result.data.verticalPacks).toHaveLength(2);
    const types = result.data.verticalPacks.map((v) => v.type);
    expect(types).toContain('hvac');
    expect(types).toContain('plumbing');
  });

  it('T3-010 — extracts company name and city', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(
      mockBusinessProfileResponse({
        business_name: "Johnson's HVAC",
        city: 'Mesa',
        state: 'AZ',
      })
    );
    const extractor = new BusinessProfileExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    expect(result.data.businessName).toBe("Johnson's HVAC");
    expect(result.data.city).toBe('Mesa');
    expect(result.data.state).toBe('AZ');
  });

  it('T3-012 — does not hallucinate plumbing from AC-only transcript', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(
      mockBusinessProfileResponse({
        verticals: [
          { type: 'hvac', confidence: 0.95, source_text: 'AC repair' },
        ],
      })
    );
    const extractor = new BusinessProfileExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    const types = result.data.verticalPacks.map((v) => v.type);
    expect(types).not.toContain('plumbing');
    expect(types).toContain('hvac');
  });

  it('T3-013 — vague input triggers clarification', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(
      mockBusinessProfileResponse({
        business_name: null,
        city: null,
        state: null,
        verticals: [],
        service_descriptions: ['fix stuff'],
        confidence_score: 0.2,
      })
    );
    const extractor = new BusinessProfileExtractor(gateway);
    const transcript = loadFixture('fixture-04-vague-incomplete.txt');

    const result = await extractor.extract(buildExtractionContext({ transcript }));

    expect(result.needsClarification).toBe(true);
    expect(result.data.verticalPacks).toHaveLength(0);
    expect(result.clarificationQuestions).toBeDefined();
    expect(result.clarificationQuestions!.length).toBeGreaterThan(0);
  });

  it('gateway failure — returns empty extraction with zero confidence', async () => {
    const { gateway, provider } = createMockLLMGateway();
    // Make gateway throw on complete
    const originalComplete = provider.complete.bind(provider);
    provider.complete = async () => {
      throw new Error('Network timeout');
    };
    const extractor = new BusinessProfileExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    expect(result.data.businessName).toBeNull();
    expect(result.data.verticalPacks).toHaveLength(0);
    expect(result.data.confidence).toBe(0);
    expect(result.needsClarification).toBe(true);
  });

  it('invalid JSON from LLM — returns empty extraction gracefully', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse('This is not JSON at all {{{');
    const extractor = new BusinessProfileExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    expect(result.data.businessName).toBeNull();
    expect(result.data.verticalPacks).toHaveLength(0);
    expect(result.data.confidence).toBe(0);
  });

  it('filters out invalid vertical types', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(
      mockBusinessProfileResponse({
        verticals: [
          { type: 'hvac', confidence: 0.9, source_text: 'HVAC' },
          { type: 'electrical', confidence: 0.8, source_text: 'electrical' }, // invalid
          { type: 'plumbing', confidence: 0.7, source_text: 'plumbing' },
        ],
      })
    );
    const extractor = new BusinessProfileExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    const types = result.data.verticalPacks.map((v) => v.type);
    expect(types).toContain('hvac');
    expect(types).toContain('plumbing');
    expect(types).not.toContain('electrical');
  });

  it('sends transcript in LLM request within character limit', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(mockBusinessProfileResponse());
    const extractor = new BusinessProfileExtractor(gateway);

    await extractor.extract(buildExtractionContext());

    const calls = provider.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].taskType).toBe('extract_business_profile');
    expect(calls[0].responseFormat).toBe('json');
    // User message should contain the transcript wrapped in <transcript> tags
    const userMsg = calls[0].messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain('<transcript>');
  });

  it('missing business name triggers clarification question', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(
      mockBusinessProfileResponse({
        business_name: null,
        verticals: [{ type: 'hvac', confidence: 0.9, source_text: 'HVAC' }],
        confidence_score: 0.6,
      })
    );
    const extractor = new BusinessProfileExtractor(gateway);

    const result = await extractor.extract(buildExtractionContext());

    // Has verticals so needsClarification is false, but should have question about name
    expect(result.clarificationQuestions).toBeDefined();
    const questions = result.clarificationQuestions ?? [];
    expect(questions.some((q) => q.toLowerCase().includes('business name'))).toBe(true);
  });
});
