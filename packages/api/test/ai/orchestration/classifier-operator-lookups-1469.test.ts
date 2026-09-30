/**
 * #1469 — operator-voiced read-only lookups the live classifier missed.
 *
 * Live run 36504593489 (gpt-4o-mini, 89.5% vs the 92% gate) sent operator
 * phrasings of three lookups to `unknown`: "Summarize this customer's
 * history" (lookup_account_summary), "Pull up the … work order"
 * (lookup_jobs), "Show me leads I haven't called back yet" (lookup_leads).
 * The blocks only carried caller-voiced examples, and lookup_leads was
 * defined as a COUNT of open leads only. It also split "is my visit still
 * on?" between confirm_appointment and lookup_appointments with no rule.
 *
 * Seam: classifyIntent with a stub gateway — the test observes the system
 * message the classifier actually sends on the operator profile (in-app
 * voice/chat, and the profile the live intent eval measures). The model's
 * answer itself is proven by the live intent eval, not here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { classifyIntent } from '../../../src/ai/orchestration/intent-classifier';
import type { ClassifierProfile } from '../../../src/ai/orchestration/classifier-profile';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

function stubGateway(): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify({ intentType: 'unknown', confidence: 0.3, reasoning: 'stub' }),
      model: 'stub-model',
      provider: 'stub',
      tokenUsage: { input: 100, output: 50, total: 150 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

async function systemPromptSent(profile?: ClassifierProfile): Promise<string> {
  const gateway = stubGateway();
  // An utterance no fast path claims, so the LLM (and its prompt) is used.
  await classifyIntent(
    'Hmm, okay, so about that thing from earlier',
    { tenantId: 't1', ...(profile ? { classifierProfile: profile } : {}) },
    gateway,
  );
  const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
    messages: Array<{ role: string; content: string }>;
  };
  return call.messages[0].content;
}

function block(prompt: string, intent: string): string {
  const m = prompt.match(new RegExp(`^- "${intent}"[\\s\\S]*?(?=^- ")`, 'm'));
  expect(m, `${intent} block is advertised`).not.toBeNull();
  return m![0];
}

/** Quoted example lines in a block (the text between straight quotes after "Examples:"). */
function examples(b: string): string[] {
  const tail = b.slice(b.indexOf('Example'));
  return [...tail.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const GOLDEN_TEXTS = new Set(
  readFileSync(resolve(__dirname, '../../../../../data/corpus/utterances.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => (JSON.parse(l) as { text: string }).text.toLowerCase()),
);

describe('#1469 — operator lookups are advertised on the operator prompt', () => {
  it('lookup_leads covers lists of leads filtered by source or follow-up status, not only a count', async () => {
    const b = block(await systemPromptSent(), 'lookup_leads');
    expect(b).toMatch(/source/i);
    expect(b).toMatch(/follow-?up/i);
  });

  it('lookup_jobs names the operator pulling up a job, with an example naming the job by customer', async () => {
    const b = block(await systemPromptSent(), 'lookup_jobs');
    const definition = b.slice(0, b.indexOf('Example'));
    expect(definition).toMatch(/operator|dispatcher|owner/i);
    // An operator names whose job it is ("the Garcia …"); callers say "my".
    expect(examples(b).some((e) => /\bthe [A-Z][a-z]+\b/.test(e))).toBe(true);
  });

  it('lookup_account_summary covers an operator asking for a customer\'s summary/history', async () => {
    const b = block(await systemPromptSent(), 'lookup_account_summary');
    const definition = b.slice(0, b.indexOf('Example'));
    expect(definition).toMatch(/operator/i);
    expect(definition).toMatch(/history/i);
    expect(examples(b).some((e) => /\bthe [A-Z][a-z]+\b/.test(e))).toBe(true);
  });

  it('a distinction rule sends a QUESTION about a booking to lookup_appointments and a STATEMENT of attendance to confirm_appointment', async () => {
    const prompt = await systemPromptSent();
    const distinctions = prompt.slice(prompt.indexOf('Distinctions that matter:'));
    const rule = distinctions.match(/^- [^\n]*(?:\n {2}[^\n]*)*/gm)?.find(
      (r) => r.includes('confirm_appointment') && r.includes('lookup_appointments'),
    );
    expect(rule, 'confirm_appointment vs lookup_appointments rule').toBeDefined();
    expect(rule!).toMatch(/QUESTION[\s\S]*= lookup_appointments/);
    expect(rule!).toMatch(/STATEMENT[\s\S]*= confirm_appointment/);
  });

  it('the caller profile (no confirm_appointment) does not carry that rule', async () => {
    const prompt = await systemPromptSent('caller');
    expect(prompt).not.toContain('confirm_appointment');
  });

  it.each(['lookup_jobs', 'lookup_account_summary', 'lookup_leads'])(
    '%s examples never reuse a golden-set utterance (no test-set leak into the prompt)',
    async (intent) => {
      const b = block(await systemPromptSent(), intent);
      for (const e of examples(b)) expect(GOLDEN_TEXTS.has(e.toLowerCase()), e).toBe(false);
    },
  );
});
