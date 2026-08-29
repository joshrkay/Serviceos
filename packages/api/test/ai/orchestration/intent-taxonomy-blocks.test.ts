import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildClassifierSystemPrompt,
  PROFILE_INTENTS,
} from '../../../src/ai/orchestration/classifier-profile';
import {
  SUPPORTED_INTENTS,
  SYSTEM_PROMPT,
} from '../../../src/ai/orchestration/intent-classifier';
import {
  DISTINCTION_RULES,
  ENTITY_FIELDS,
  INTENT_BLOCK_ORDER,
} from '../../../src/ai/orchestration/intent-taxonomy-blocks';

/**
 * Byte-identity pins for the taxonomy extraction (#887 groundwork).
 *
 * SYSTEM_PROMPT is now ASSEMBLED from intent-taxonomy-blocks.ts. These pins
 * were measured against the original single literal BEFORE the extraction
 * (main @ the commit this test landed in) — they prove the extraction moved
 * every byte, and from now on they prove nobody edits the operator prompt
 * accidentally. The 74 Layer-1 voice-quality cassettes and the gateway
 * cache keys both hash these bytes.
 *
 * If this test fails you either (a) unintentionally changed prompt text in
 * intent-taxonomy-blocks.ts — revert; or (b) are deliberately changing the
 * live prompt — re-pin hash+length here IN THE SAME PR as the cassette
 * re-record and voice-eval sign-off.
 */
const OPERATOR_PROMPT_LENGTH = 58158;
const OPERATOR_PROMPT_SHA256 =
  'e933b929fd5fc736365bac88b008f9f1171f5ea97af787b8169e10b009bd3115';

describe('intent-taxonomy-blocks extraction', () => {
  it("buildClassifierSystemPrompt('operator') IS the exported SYSTEM_PROMPT", () => {
    expect(buildClassifierSystemPrompt('operator')).toBe(SYSTEM_PROMPT);
  });

  it('the operator prompt is byte-identical to the pre-extraction literal', () => {
    const prompt = buildClassifierSystemPrompt('operator');
    expect(prompt.length).toBe(OPERATOR_PROMPT_LENGTH);
    expect(createHash('sha256').update(prompt, 'utf8').digest('hex')).toBe(
      OPERATOR_PROMPT_SHA256,
    );
  });

  it('memoizes per profile (hot path: one assembly per process)', () => {
    expect(buildClassifierSystemPrompt('operator')).toBe(
      buildClassifierSystemPrompt('operator'),
    );
  });

  it('moved the whole taxonomy: 68 distinct blocks (+ trailing unknown), 6 rules, 57 fields', () => {
    // 69 blocks in the literal; 'unknown' appears twice (full + trailing
    // catch-all), so the keyed table holds 68.
    expect(INTENT_BLOCK_ORDER).toHaveLength(68);
    expect(DISTINCTION_RULES).toHaveLength(6);
    expect(ENTITY_FIELDS).toHaveLength(57);
  });

  it('PROFILE_INTENTS.operator is exactly SUPPORTED_INTENTS (the literal list in classifier-profile.ts cannot drift)', () => {
    // classifier-profile.ts duplicates the intent list as literals to avoid
    // a module-load cycle with intent-classifier.ts; this is the runtime
    // half of that pin (the type annotation is the compile-time half).
    expect([...PROFILE_INTENTS.operator].sort()).toEqual([...SUPPORTED_INTENTS].sort());
    expect(PROFILE_INTENTS.operator.size).toBe(SUPPORTED_INTENTS.length);
  });

  it('every taxonomy block and every tagged intent name is a real IntentType', () => {
    const known = new Set<string>(SUPPORTED_INTENTS);
    for (const intent of INTENT_BLOCK_ORDER) expect(known.has(intent)).toBe(true);
    for (const rule of DISTINCTION_RULES) {
      for (const intent of rule.intents) expect(known.has(intent)).toBe(true);
    }
    for (const field of ENTITY_FIELDS) {
      if (field.intents === '*') continue;
      for (const intent of field.intents) expect(known.has(intent)).toBe(true);
    }
  });
});
