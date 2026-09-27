/**
 * #1427 — a plain customer quote request must be advertised as draft_estimate.
 *
 * The production classifier (gpt-4o-mini, via createLLMGateway) returned
 * `unknown` @0.40 for the path-smoke `[quote]` utterance ("How much would it
 * cost to install a new water heater? Can you send me an estimate?"). The
 * draft_estimate block only ever showed OPERATOR dictation ("Quote Johnson
 * diagnostic labor, $150"); nothing told the model that a customer asking
 * what NEW work would cost is a quote request, while the neighbouring
 * lookup_estimates block ("How much was that estimate?", "Did you send me an
 * estimate yet?") and send_estimate ("send ... estimate") pulled the other
 * way, so the model split the difference and fell to `unknown`.
 *
 * Seam: classifyIntent with a mock gateway — the test observes the system
 * message the classifier actually sends, on the profiles that carry
 * draft_estimate: operator (what path-smoke and in-app voice/chat use) and
 * caller (inbound phone). The model's answer itself is proven live by the
 * PR's path-smoke run, not here.
 */
import { describe, it, expect, vi } from 'vitest';
import { classifyIntent } from '../../../src/ai/orchestration/intent-classifier';
import type { ClassifierProfile } from '../../../src/ai/orchestration/classifier-profile';
import { PATH_SMOKE_CASES } from '../../../src/ai/voice-quality/path-smoke';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

const QUOTE_UTTERANCE = PATH_SMOKE_CASES.find((c) => c.pathId === 'quote')!.turns[0].utterance;

function mockGateway(): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify({ intentType: 'draft_estimate', confidence: 0.9, reasoning: 'test' }),
      model: 'mock-model',
      provider: 'mock',
      tokenUsage: { input: 100, output: 50, total: 150 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

async function draftEstimateBlockSent(profile: ClassifierProfile | undefined): Promise<string> {
  const gateway = mockGateway();
  await classifyIntent(
    QUOTE_UTTERANCE,
    { tenantId: 't1', ...(profile ? { classifierProfile: profile } : {}) },
    gateway,
  );
  const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
    messages: Array<{ role: string; content: string }>;
  };
  const base = call.messages[0].content;
  const block = base.match(/^- "draft_estimate"[\s\S]*?(?=^- ")/m);
  expect(block, 'draft_estimate block is advertised').not.toBeNull();
  return block![0];
}

describe('#1427 — quote requests are advertised as draft_estimate', () => {
  it.each([
    ['operator (default — path-smoke, in-app voice, chat)', undefined],
    ['caller (inbound phone)', 'caller' as const],
  ])('%s: the draft_estimate block names a customer asking what new work costs', async (_n, profile) => {
    const block = await draftEstimateBlockSent(profile);
    expect(block).toMatch(/customer asking what new work would cost/i);
  });

  it.each([
    ['operator', undefined],
    ['caller', 'caller' as const],
  ])('%s: the draft_estimate block carries a customer-voiced price-question example', async (_n, profile) => {
    const block = await draftEstimateBlockSent(profile);
    // A quoted example that is a question AND asks for a quote/estimate.
    expect(block).toMatch(/"[^"]*\?[^"]*\b(quote|estimate)\b[^"]*"/i);
    // Taught by a different phrasing — never the smoke utterance itself.
    expect(block).not.toContain(QUOTE_UTTERANCE);
    expect(block.toLowerCase()).not.toContain('water heater');
  });
});
