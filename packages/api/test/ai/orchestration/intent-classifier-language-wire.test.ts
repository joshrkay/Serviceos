/**
 * #890 — the intent classifier was language-blind.
 *
 * A Spanish caller got the all-English taxonomy prompt, the only Spanish
 * example utterances in it sat under `language_switch`, and `ClassifyContext`
 * had no language field to condition on. The model was therefore primed to
 * read ANY Spanish sentence as a language-switch request rather than as the
 * booking / lookup / complaint it actually was.
 *
 * Fix under test: `ClassifyContext.language`. When the call language is
 * Spanish, a separate system message tells the model the transcript is
 * Spanish, that it must classify by MEANING into the same English intent ids,
 * that speaking Spanish is not itself a `language_switch`, and gives Spanish
 * example utterances — only for intents the session's profile accepts. An
 * English (or unset) language leaves the request byte-identical.
 *
 * Same idiom as intent-classifier-b2b-account-wire.test.ts: drive
 * `classifyIntent` directly and inspect the messages handed to the gateway.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  classifyIntent,
  buildSpanishCallerPromptSection,
} from '../../../src/ai/orchestration/intent-classifier';

function makeGateway() {
  return {
    complete: vi.fn().mockResolvedValue({
      content: JSON.stringify({ intentType: 'unknown', confidence: 0.2 }),
      tokenUsage: { input: 1, output: 1, total: 2 },
    }),
  };
}

function messagesFrom(gateway: ReturnType<typeof makeGateway>): Array<{ role: string; content: string }> {
  return gateway.complete.mock.calls[0]?.[0]?.messages ?? [];
}

const TENANT = '00000000-0000-4000-8000-000000000890';
const UTTERANCE = 'Quisiera agendar una cita para el martes a las dos de la tarde.';

describe('#890 — intent classifier language conditioning', () => {
  it('appends a Spanish-caller system section when the call language is es', async () => {
    const gateway = makeGateway();
    await classifyIntent(
      UTTERANCE,
      { tenantId: TENANT, classifierProfile: 'caller', language: 'es' },
      gateway as never,
    );

    const system = messagesFrom(gateway).filter((m) => m.role === 'system');
    const spanish = system.find((m) => m.content.includes('The caller is speaking Spanish'));
    expect(spanish, 'no Spanish-caller section on an es call').toBeDefined();
    // Classify by meaning into the SAME English intent ids.
    expect(spanish!.content).toContain('"create_appointment"');
    // Speaking Spanish is not a switch request.
    expect(spanish!.content).toMatch(/not.*language_switch/i);
  });

  it('keeps an en call (and an unset language) byte-identical to today', async () => {
    const base = makeGateway();
    await classifyIntent(UTTERANCE, { tenantId: TENANT, classifierProfile: 'caller' }, base as never);
    const en = makeGateway();
    await classifyIntent(
      UTTERANCE,
      { tenantId: TENANT, classifierProfile: 'caller', language: 'en' },
      en as never,
    );
    // System messages only: the caller-profile user message is fenced with a
    // per-request random fence id (#894), so it differs between any two calls.
    const system = (g: ReturnType<typeof makeGateway>) =>
      JSON.stringify(messagesFrom(g).filter((m) => m.role === 'system'));
    expect(system(en)).toBe(system(base));
    expect(system(base)).not.toContain('The caller is speaking Spanish');
  });

  it('only gives Spanish examples for intents the profile accepts', () => {
    // The caller profile advertises no invoicing; the operator profile does.
    const caller = buildSpanishCallerPromptSection('caller');
    const operator = buildSpanishCallerPromptSection('operator');
    expect(caller).not.toContain('"create_invoice"');
    expect(operator).toContain('"create_invoice"');
    // Every profile gets booking + the human hand-off in Spanish.
    for (const section of [caller, operator]) {
      expect(section).toContain('"create_appointment"');
      expect(section).toContain('"operator_request"');
    }
  });
});
