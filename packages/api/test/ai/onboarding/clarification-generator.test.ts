import { createMockLLMGateway } from '../../../src/ai/gateway/factory';
import { generateAIClarificationQuestions } from '../../../src/ai/tasks/onboarding/clarification-generator';
import type { OnboardingExtraction } from '../../../src/ai/tasks/onboarding/types';

describe('P4-EXT-009 — Onboarding clarification and follow-up flow', () => {
  const completeExtraction: Partial<OnboardingExtraction> = {
    businessProfile: {
      businessName: 'Comfort Zone HVAC',
      city: 'Scottsdale',
      state: 'AZ',
      verticalPacks: [{ type: 'hvac', confidence: 0.95, sourceText: 'HVAC' }],
      serviceDescriptions: ['AC repair', 'maintenance', 'replacements'],
      confidence: 0.9,
      lowConfidenceFields: [],
    },
    categories: {
      categories: [
        { verticalType: 'hvac', categoryId: 'repair', name: 'AC Repair', confidence: 0.9, sourceText: 'AC repair' },
        { verticalType: 'hvac', categoryId: 'maintenance', name: 'Tune-Up', confidence: 0.9, sourceText: 'tune-ups' },
      ],
    },
    pricing: {
      prices: [
        { serviceRef: 'diagnostic', amountCents: 8900, priceType: 'exact', confidence: 0.95, sourceText: '$89' },
      ],
    },
    team: {
      members: [
        { name: 'Marcus', inferredRole: 'technician', confidence: 0.9, sourceText: 'Marcus' },
      ],
    },
    schedule: {
      workingHours: [
        { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], startTime: '08:00', endTime: '17:00' },
      ],
    },
  };

  it('complete extraction — returns questions (may be empty)', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({ questions: [] }));

    const questions = await generateAIClarificationQuestions(gateway, completeExtraction);

    expect(Array.isArray(questions)).toBe(true);
  });

  it('missing business profile — generates questions about business type', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({
      questions: ['What type of business do you operate?', 'What is the name of your company?'],
    }));

    const partial: Partial<OnboardingExtraction> = {
      ...completeExtraction,
      businessProfile: undefined,
    };
    const questions = await generateAIClarificationQuestions(gateway, partial);

    expect(questions.length).toBeGreaterThan(0);
    // Verify the context sent to the LLM mentions missing profile
    const calls = provider.getCalls();
    const userMsg = calls[0].messages.find((m) => m.role === 'user');
    expect(userMsg!.content).toContain('NOT extracted');
  });

  it('missing pricing — generates questions about service pricing', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({
      questions: ['What do you typically charge for your most common services?'],
    }));

    const partial: Partial<OnboardingExtraction> = {
      ...completeExtraction,
      pricing: undefined,
    };
    const questions = await generateAIClarificationQuestions(gateway, partial);

    expect(questions.length).toBeGreaterThan(0);
    const calls = provider.getCalls();
    const userMsg = calls[0].messages.find((m) => m.role === 'user');
    expect(userMsg!.content).toContain('Pricing: NOT extracted');
  });

  it('missing schedule — generates questions about hours', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({
      questions: ['What are your typical business hours and days of operation?'],
    }));

    const partial: Partial<OnboardingExtraction> = {
      ...completeExtraction,
      schedule: undefined,
    };
    const questions = await generateAIClarificationQuestions(gateway, partial);

    expect(questions.length).toBeGreaterThan(0);
    const calls = provider.getCalls();
    const userMsg = calls[0].messages.find((m) => m.role === 'user');
    expect(userMsg!.content).toContain('Schedule: NOT extracted');
  });

  it('partial extraction — sends correct context summary to LLM', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({
      questions: ['What specific services do you offer?'],
    }));

    const partial: Partial<OnboardingExtraction> = {
      businessProfile: completeExtraction.businessProfile,
      // categories, pricing, team, schedule all missing
    };
    const questions = await generateAIClarificationQuestions(gateway, partial);

    expect(questions.length).toBeGreaterThan(0);

    const calls = provider.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].taskType).toBe('generate_clarification_questions');
    const userMsg = calls[0].messages.find((m) => m.role === 'user');
    expect(userMsg!.content).toContain('Comfort Zone HVAC');
    expect(userMsg!.content).toContain('Service categories: NOT extracted');
  });

  it('filters non-string questions from LLM response', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({
      questions: ['Valid question?', 42, null, 'Another valid question?'],
    }));

    const questions = await generateAIClarificationQuestions(gateway, {});

    expect(questions).toHaveLength(2);
    expect(questions[0]).toBe('Valid question?');
    expect(questions[1]).toBe('Another valid question?');
  });

  it('invalid JSON from LLM — returns empty array', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse('Not valid JSON {{{');

    const questions = await generateAIClarificationQuestions(gateway, {});

    expect(questions).toEqual([]);
  });

  it('LLM returns no questions array — returns empty array', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(JSON.stringify({ result: 'no questions key' }));

    const questions = await generateAIClarificationQuestions(gateway, {});

    expect(questions).toEqual([]);
  });
});
