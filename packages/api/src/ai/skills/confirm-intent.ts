/**
 * confirm_intent skill — TTS readback + yes/no classifier.
 *
 * After the intent classifier resolves what the caller wants, this
 * skill reads back a plain-language summary ("Just to confirm — schedule
 * an AC diagnostic for Friday 2pm for Johnson residence. Is that right?")
 * and classifies the caller's spoken response as confirmed or a
 * correction.
 *
 * Design decisions:
 * - Ambiguous responses are treated as corrections (safe default).
 *   It's cheaper to re-ask than to queue the wrong proposal.
 * - TTS failure is non-fatal: the call continues without audio.
 *   The caller still hears the readback via the agent's TwiML <Say>
 *   fallback or the browser's own TTS shim.
 * - Gateway timeout propagates as a thrown error — the state machine
 *   in `intent_confirm` handles retry / escalation.
 */

import { LLMGateway } from '../gateway/gateway';
import { TtsProvider } from '../tts/tts-provider';
import { t, type Language } from '../i18n/i18n';

export interface ConfirmIntentInput {
  /**
   * Human-readable summary of what will happen.
   * Example: "schedule an AC diagnostic for Friday 2pm for Johnson residence"
   */
  intentSummary: string;
  /** The caller's spoken response to the readback question. */
  callerResponse: string;
  tenantId: string;
  gateway: LLMGateway;
  /**
   * When provided, the readback text is synthesized to audio and
   * returned in `readbackAudio`. TTS failure is non-fatal — if
   * synthesis throws, the skill logs and returns without audio.
   */
  ttsProvider?: TtsProvider;
  /** P11-002: spoken-readback language. Defaults to 'en'. */
  language?: Language;
}

export interface ConfirmIntentResult {
  confirmed: boolean;
  /** When not confirmed, the caller's raw correction text. */
  correction?: string;
  /** TTS audio of the readback question, if ttsProvider was provided and synthesis succeeded. */
  readbackAudio?: Buffer;
  /** Token usage from the yes/no classification call — fed into the per-session cost cap. */
  tokenUsage?: { input: number; output: number };
}

/** Shape we expect the LLM to return for the yes/no classification. */
interface YesNoClassification {
  answer: 'yes' | 'no';
  reasoning: string;
}

function parseYesNo(content: string): YesNoClassification | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.answer !== 'yes' && obj.answer !== 'no') return null;
  return {
    answer: obj.answer,
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
  };
}

export async function confirmIntent(input: ConfirmIntentInput): Promise<ConfirmIntentResult> {
  const { intentSummary, callerResponse, tenantId, gateway, ttsProvider } = input;
  const lang: Language = input.language ?? 'en';

  // Step 1: Build the readback question.
  const readbackText = t('confirm.readback', lang, { summary: intentSummary });

  // Step 2: Optionally synthesize the readback to audio. TTS failure is
  // non-fatal — the caller flow still has a text-based path.
  let readbackAudio: Buffer | undefined;
  if (ttsProvider) {
    try {
      const result = await ttsProvider.synthesize({
        text: readbackText,
        tenantId,
        language: lang,
      });
      readbackAudio = result.audio;
    } catch {
      // Non-fatal: continue without audio.
    }
  }

  // Step 3: Classify the caller's response as yes or no using the LLM gateway.
  // Use a cheap, short prompt — this is a single yes/no question with no
  // entities to extract. taskType 'classify_intent' routes to the same
  // low-cost model tier as the intent classifier.
  const classifyPrompt = `Classify the caller's response as YES or NO.
The agent asked: "${readbackText}"
The caller said: "${callerResponse}"
Return JSON: { "answer": "yes" | "no", "reasoning": "..." }

Rules:
- YES: "yes", "yep", "correct", "that's right", "sure", "sounds good", "go ahead", and clear affirmatives
- NO: "no", "actually", "wait", "that's not right", corrections, re-statements, or anything that suggests the summary was wrong
- Ambiguous responses → NO (safer to re-capture than to queue the wrong proposal)`;

  // Throws on timeout/provider error — callers must handle retry/escalation.
  const response = await gateway.complete({
    taskType: 'classify_intent',
    // Top-level tenantId — the quota/cache resilience wrappers key on
    // this, not metadata.tenantId (see gateway.ts's tenant-id guard).
    tenantId,
    messages: [
      { role: 'user', content: classifyPrompt },
    ],
    responseFormat: 'json',
    temperature: 0,
    metadata: { tenantId, skill: 'confirm_intent' },
  });

  const classification = parseYesNo(response.content);
  const tokenUsage = response.tokenUsage
    ? { input: response.tokenUsage.input, output: response.tokenUsage.output }
    : undefined;

  // Step 4: Parse result. Unparseable response → treat as correction (safe default).
  if (!classification || classification.answer === 'no') {
    return {
      confirmed: false,
      correction: callerResponse,
      ...(readbackAudio !== undefined ? { readbackAudio } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
    };
  }

  return {
    confirmed: true,
    ...(readbackAudio !== undefined ? { readbackAudio } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
  };
}
