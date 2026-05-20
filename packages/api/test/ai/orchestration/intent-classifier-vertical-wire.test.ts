import { describe, expect, it, vi } from 'vitest';
import { classifyIntent } from '../../../src/ai/orchestration/intent-classifier';
import { createHvacPack } from '../../../src/verticals/packs/hvac';
import { formatVerticalForCallerPrompt } from '../../../src/verticals/context-assembly';

describe('intent classifier §3B vertical wire-up', () => {
  it('includes verticalPromptSection in LLM messages when provided', async () => {
    const verticalPromptSection = formatVerticalForCallerPrompt(createHvacPack());
    const gateway = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          intent: 'unknown',
          confidence: 0.2,
          entities: {},
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };

    await classifyIntent('schedule something tomorrow', {
      tenantId: '00000000-0000-4000-8000-000000000099',
      verticalPromptSection,
    }, gateway as never);

    const call = gateway.complete.mock.calls[0]?.[0];
    const messages = call?.messages ?? call;
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain('Tenant vertical context');
    expect(serialized).toContain('HVAC');
  });
});
