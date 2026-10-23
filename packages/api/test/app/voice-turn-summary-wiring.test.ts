/**
 * A4-2 — every voice-turn processor app.ts builds stores its end-of-call
 * summary.
 *
 * Since A2 the processor persists a call_summaries row only when
 * `deps.callSummaryRepo` is wired (runSummary passes it to summarizeSession;
 * absent, the summary LLM call still runs and its result is dropped). The
 * webchat processors were built without it, so every web chat paid for a
 * summary nobody could read. A processor that leaves the key out compiles
 * and runs; only this source-level check notices.
 *
 * Covered: each `createVoiceTurnProcessor(...)` call in app.ts, and the two
 * adapter dep objects app.ts hands to adapters that build their processor
 * (TwilioGatherAdapter spreads its deps into createVoiceTurnProcessor) or
 * summarize themselves (InAppVoiceAdapter calls summarizeSession).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');

/** The source text from `open` (an opening bracket) to its matching close. */
function balanced(text: string, open: number): string {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch in pairs) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return text.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced bracket at offset ${open}`);
}

/** Each match of `pattern` (ending on an opening bracket) with its argument text. */
function argumentsOf(pattern: RegExp): Array<{ line: number; args: string }> {
  const found: Array<{ line: number; args: string }> = [];
  for (const m of src.matchAll(pattern)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    found.push({ line: src.slice(0, open).split('\n').length, args: balanced(src, open) });
  }
  return found;
}

const PASSES_SUMMARY_REPO = /\bcallSummaryRepo\b/;

describe('A4-2 — voice-turn processors app.ts builds persist their call summary', () => {
  const processorCalls = argumentsOf(/\bcreateVoiceTurnProcessor\(/g);

  it('finds the processor calls (the check is not vacuous)', () => {
    expect(processorCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('every createVoiceTurnProcessor(...) call passes callSummaryRepo', () => {
    const missing = processorCalls.filter((c) => !PASSES_SUMMARY_REPO.test(c.args)).map((c) => `app.ts:${c.line}`);
    expect(missing).toEqual([]);
  });

  it('the Twilio and in-app adapter deps pass callSummaryRepo', () => {
    const twilio = argumentsOf(/\bconst twilioAdapterDeps = \{/g);
    const inApp = argumentsOf(/\bnew InAppVoiceAdapter\(/g);
    expect(twilio).toHaveLength(1);
    expect(inApp).toHaveLength(1);
    expect(twilio[0].args).toMatch(PASSES_SUMMARY_REPO);
    expect(inApp[0].args).toMatch(PASSES_SUMMARY_REPO);
  });
});
