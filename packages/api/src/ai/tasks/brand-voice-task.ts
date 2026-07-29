/**
 * B1.18 — update_brand_voice voice on-ramp.
 *
 * "Set my brand voice: friendly, plain-spoken, no slang, always sign off
 * 'Thanks — Bob's HVAC'" → an `update_brand_voice` proposal whose payload
 * matches `updateBrandVoicePayloadSchema` (the six `brandVoiceSchema` fields
 * + an additive `freeText`). A dedicated LLM pass (routed through the
 * gateway, like every sibling task) maps the spoken instruction onto the
 * structured fields; anything it can't map lands verbatim in `freeText` so
 * AC-2's "nothing spoken is dropped" holds even on a partial extraction.
 *
 * Never guesses: only fields the model explicitly returned (and that pass
 * validation) are written onto the payload — there is no default register,
 * pronoun, or persona name. An invalid enum value (e.g. a `register` outside
 * formal/friendly/casual) is DROPPED, never coerced, and recorded as a
 * `_meta.markers` entry so the review card shows a low-confidence field was
 * discarded rather than silently guessed. Gateway/parse failures degrade to
 * the verbatim transcript in `freeText` (same fallback shape as
 * CreateStandingInstructionTaskHandler) — never a dropped utterance.
 *
 * That degraded payload is NOT approvable: a proposal carrying no persisted
 * brand-voice field is stamped `missingFields` so `approveProposal` blocks
 * it, because execution would deterministically refuse it. See
 * BRAND_VOICE_GATE_FIELD.
 *
 * A MIXED payload is also NOT approvable: when the model both maps a field
 * AND reports unmapped content in the same utterance (e.g. "be friendly, and
 * never quote prices by text"), the persisted field alone would otherwise let
 * the proposal through while the execution handler's strip-mode parse
 * silently discards the unmapped instruction. That case is stamped
 * `missingFields: [FREE_TEXT_GATE_FIELD]` too, so nothing spoken is ever lost
 * behind a card that reports success. See FREE_TEXT_GATE_FIELD.
 *
 * Execution note: this handler ONLY drafts. It never re-implements the
 * merge/cool-down/version-bump — that lives entirely in
 * `tenants/brand/brand-voice-service.ts:updateBrandVoice`, called by
 * `UpdateBrandVoiceExecutionHandler` (proposals/execution/brand-voice-handler.ts).
 */
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { BRAND_VOICE_FIELDS } from '../../tenants/brand/brand-voice';
import { LLMGateway } from '../gateway/gateway';
import { ExtractedEntities } from '../orchestration/intent-classifier';
import { assessConfidence, getConfidenceLevel } from '../guardrails/confidence';
import { TaskContext, TaskHandler, TaskResult } from './task-handlers';

const MAX_OPENING_LINE_LEN = 200;
const MAX_OPENING_LINES = 5;
const MAX_SIGNOFF_LEN = 200;
const MAX_BANNED_PHRASE_LEN = 200;
const MAX_BANNED_PHRASES = 50;
const MAX_PERSONA_NAME_LEN = 120;
const MAX_FREE_TEXT_LEN = 1000;

const BRAND_VOICE_SYSTEM_PROMPT = `You map a spoken brand-voice instruction for a field-service business onto a structured configuration. The business owner is describing how their AI-drafted customer messages should sound.

Return valid JSON only (no prose, no markdown fences):
{
  "register": "<one of: formal, friendly, casual — OMIT unless the speaker described an overall tone that maps cleanly to one of these three>",
  "pronoun": "<one of: we, i — OMIT unless the speaker said which pronoun the business should use for itself>",
  "persona_name": "<string, max ${MAX_PERSONA_NAME_LEN} chars — OMIT unless the speaker named a persona/office name for outbound messages>",
  "signoff": "<string, max ${MAX_SIGNOFF_LEN} chars — OMIT unless the speaker stated an exact sign-off line>",
  "opening_lines": ["<string, max ${MAX_OPENING_LINE_LEN} chars each, up to ${MAX_OPENING_LINES}>"],
  "banned_phrases": ["<string, max ${MAX_BANNED_PHRASE_LEN} chars each, up to ${MAX_BANNED_PHRASES}>"],
  "unmapped": "<string, max ${MAX_FREE_TEXT_LEN} chars — VERBATIM any part of the instruction that does NOT fit one of the fields above (e.g. 'keep replies under two sentences', 'never quote a price by text'). OMIT when everything mapped cleanly.>",
  "confidence_score": <number between 0 and 1 — how confident you are in this extraction>
}

Rules:
- Only include a field when the speaker's words support it directly. Never invent a register, pronoun, persona name, sign-off, or phrase the speaker did not say.
- "no slang" / "plain-spoken" / "professional" etc. are tone descriptions — map them to the closest of formal/friendly/casual ONLY when the mapping is unambiguous; otherwise put the raw phrase in "unmapped" instead of guessing.
- "always sign off ..." / "always end with ..." → signoff (the exact quoted text).
- "never say ..." / "don't say ..." / "banned phrases" → banned_phrases (one entry per phrase).
- "call the business ..." / "refer to us as ..." → persona_name.
- Put ANYTHING you could not confidently map into "unmapped" verbatim — never drop part of the instruction silently.
- If you can't map anything at all, still return "unmapped" with the full instruction and set confidence below 0.5.`;

function tryParseJson(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeRegister(value: unknown): 'formal' | 'friendly' | 'casual' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === 'formal' || normalized === 'friendly' || normalized === 'casual'
    ? normalized
    : undefined;
}

function normalizePronoun(value: unknown): 'we' | 'i' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === 'we' || normalized === 'i' ? normalized : undefined;
}

function normalizeShortString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeStringArray(value: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => (item.length > maxLen ? item.slice(0, maxLen) : item))
    .slice(0, maxItems);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Marker reason for a field the model returned but that failed validation — dropped, never coerced into a guess. */
const UNRECOGNIZED_VALUE_REASON = 'unrecognized_value';

/**
 * PR review finding (2026-07) — the approve-to-fail gate.
 *
 * `UpdateBrandVoiceExecutionHandler` projects the payload through
 * `brandVoiceSchema` (strip-mode), which DROPS `freeText` and `_meta`, and
 * then refuses an empty patch ("Payload carries no brand-voice fields to
 * apply"). So a payload carrying only `freeText` — which is exactly what an
 * extraction failure, unparseable JSON, an `unmapped`-only extraction, or the
 * deliberately non-executable "Lock my brand voice" utterance produces —
 * could be approved and was then GUARANTEED to fail execution. Approval
 * succeeding for an action that can never execute is the defect class this
 * branch exists to eliminate (see the same fix on SendInvoiceTaskHandler /
 * SendEstimateTaskHandler in voice-extended-tasks.ts): `approveProposal`
 * (proposals/actions.ts) blocks ONLY on `missingFields`, so the gate has to
 * live there.
 *
 * Gate key: `register`, not a synthetic "one of the six" token, because
 * `missingFields` gates in this repo must have a working unblock path —
 * `clearSatisfiedMissingFields` (proposals/missing-fields.ts) lifts an entry
 * only when THAT exact payload key is edited to a non-empty value. `register`
 * is the one always-present-in-the-contract field whose presence alone makes
 * the merge non-empty, so an operator edit that supplies it both clears the
 * gate and makes execution genuinely succeed. Supplying a different field
 * (e.g. `signoff`) leaves the gate up — deliberately fail-safe: an
 * un-liftable gate is a blocked card, an unlifted one is never a doomed
 * approval.
 *
 * AC-4 note: this MUST NOT become a lock affordance. The gate only ever asks
 * for one of the six persisted brand-voice fields; the payload contract has
 * no lock-shaped key (see proposals/contracts/brand-voice.ts) and nothing
 * here adds one. "Lock my brand voice" therefore lands as a gated,
 * non-approvable card — never a silent success, never a voice-reachable lock.
 */
const BRAND_VOICE_GATE_FIELD = 'register';

/**
 * PR review finding (2026-07) — the approved-then-silently-partial gate.
 *
 * "Be friendly, and never quote prices by text" maps `register: 'friendly'`
 * AND reports `unmapped: 'never quote prices by text'`. Before this gate,
 * `mappedAnything` was true (register persisted), so the proposal shipped
 * with NO `missingFields` entry — fully approvable. On approval,
 * `UpdateBrandVoiceExecutionHandler` projects the payload through
 * `brandVoiceSchema` (strip-mode), which drops `freeText` on the floor
 * un-forwarded, applies only `register`, and reports SUCCESS. The owner's
 * explicit pricing prohibition vanished with no failure, no card, nothing —
 * worse than the approved-then-failed class the sibling gate above closes,
 * because here nothing surfaces the loss at all.
 *
 * Gate key: `freeText` itself, not a synthetic token, for the same
 * clear-on-fill reason as `BRAND_VOICE_GATE_FIELD` above — `freeText` is a
 * real flat key of `updateBrandVoicePayloadSchema` (proposals/contracts/
 * brand-voice.ts), so `editProposal`'s re-validation against that schema
 * accepts it, and `clearSatisfiedMissingFields` (proposals/missing-fields.ts)
 * lifts the gate only when an operator edits THAT exact key to a non-empty
 * value — i.e. only once they've actually seen and handled the unmapped
 * instruction (folding it into a banned phrase, a sign-off, or wherever it
 * belongs) rather than the gate silently clearing itself.
 *
 * Only stamped for the MIXED case (something mapped AND something the model
 * flagged as unmapped) — the "nothing mapped at all" case is already fully
 * blocked by `BRAND_VOICE_GATE_FIELD` above (execution would refuse an empty
 * patch regardless), so adding this key there would be redundant, not wrong.
 */
const FREE_TEXT_GATE_FIELD = 'freeText';

export class UpdateBrandVoiceTaskHandler implements TaskHandler {
  readonly taskType = 'update_brand_voice' as const;

  constructor(private readonly gateway: LLMGateway) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = (context.existingEntities ?? {}) as ExtractedEntities;
    const spoken =
      typeof ee.brandVoiceInstruction === 'string' && ee.brandVoiceInstruction.trim().length > 0
        ? ee.brandVoiceInstruction.trim()
        : context.message.trim();

    const parsed = await this.extract(context, spoken);

    const payload: Record<string, unknown> = {};
    const markers: Array<{ path: string; reason: string }> = [];

    const register = normalizeRegister(parsed?.register);
    if (parsed?.register !== undefined && register === undefined) {
      markers.push({ path: 'register', reason: UNRECOGNIZED_VALUE_REASON });
    } else if (register) {
      payload.register = register;
    }

    const pronoun = normalizePronoun(parsed?.pronoun);
    if (parsed?.pronoun !== undefined && pronoun === undefined) {
      markers.push({ path: 'pronoun', reason: UNRECOGNIZED_VALUE_REASON });
    } else if (pronoun) {
      payload.pronoun = pronoun;
    }

    const personaName = normalizeShortString(parsed?.persona_name, MAX_PERSONA_NAME_LEN);
    if (personaName) payload.persona_name = personaName;

    const signoff = normalizeShortString(parsed?.signoff, MAX_SIGNOFF_LEN);
    if (signoff) payload.signoff = signoff;

    const openingLines = normalizeStringArray(parsed?.opening_lines, MAX_OPENING_LINES, MAX_OPENING_LINE_LEN);
    if (openingLines) payload.opening_lines = openingLines;

    const bannedPhrases = normalizeStringArray(parsed?.banned_phrases, MAX_BANNED_PHRASES, MAX_BANNED_PHRASE_LEN);
    if (bannedPhrases) payload.banned_phrases = bannedPhrases;

    // AC-2 — nothing spoken is dropped: whatever the model flagged as
    // unmapped, verbatim. If extraction failed outright (no gateway
    // response, unparseable JSON) OR mapped nothing at all, fall back to the
    // full spoken instruction so the proposal always preserves what was
    // said, even when the review card can't offer structured fields.
    const modelUnmapped = normalizeShortString(parsed?.unmapped, MAX_FREE_TEXT_LEN);
    // Read the canonical six-field list rather than counting payload keys, so
    // this stays correct if a field is ever added to the Brand-Voice
    // Configurator or this block is reordered.
    const mappedAnything = BRAND_VOICE_FIELDS.some((field) => payload[field] !== undefined);
    const freeText = modelUnmapped ?? (!mappedAnything ? spoken.slice(0, MAX_FREE_TEXT_LEN) : undefined);
    if (freeText) payload.freeText = freeText;

    // Confidence: prefer the model's self-report; fall back to the generic
    // field-coverage heuristic when it's absent/invalid (e.g. a parse
    // failure). Always stamped — a low-confidence extraction surfaces a
    // marker rather than silently landing as if it were certain.
    const rawScore = parsed?.confidence_score;
    const modelScore =
      typeof rawScore === 'number' && rawScore >= 0 && rawScore <= 1
        ? rawScore
        : assessConfidence(parsed ?? {}).score;
    // A total extraction failure (no gateway response / unparseable JSON) is
    // 'very_low' regardless of the generic field-coverage heuristic — there
    // is no structured output to be confident about.
    const effectiveScore = parsed === null ? 0 : modelScore;
    const confidenceLevel = getConfidenceLevel(effectiveScore);

    const meta: Record<string, unknown> = { overallConfidence: confidenceLevel };
    if (markers.length > 0) meta.markers = markers;
    payload._meta = meta;

    // Belt-and-braces: the payload always carries SOMETHING (a structured
    // field or freeText derived from the verbatim instruction), so this
    // should never trip — but guarantee it structurally rather than assume.
    if (Object.keys(payload).length === 1 /* only _meta */) {
      payload.freeText = spoken.slice(0, MAX_FREE_TEXT_LEN) || context.message.slice(0, MAX_FREE_TEXT_LEN);
    }

    const summary = personaName
      ? `Update brand voice — ${personaName}`
      : register
        ? `Update brand voice — ${register}`
        : 'Update brand voice';

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload,
      summary,
      sourceContext: context.conversationId ? { conversationId: context.conversationId } : undefined,
      createdBy: context.userId,
      confidenceScore: effectiveScore,
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
      // No sourceTrustTier: the action class ('manual') is what makes this
      // structurally never-auto-approve — see AC-1's unit test on
      // decideInitialStatus.
      //
      // missingFields is the APPROVAL gate (decideInitialStatus forces
      // 'draft'; approveProposal refuses outright).
      //
      // Case 1 — nothing mapped: stamped when the extraction produced NONE
      // of the six persisted brand-voice fields — the freeText-only payload
      // the execution handler deterministically refuses. See
      // BRAND_VOICE_GATE_FIELD above.
      //
      // Case 2 — mixed: something mapped AND the model explicitly reported
      // unmapped content alongside it. Without this, the proposal would be
      // approvable while the unmapped instruction is silently dropped by the
      // execution handler's strip-mode parse. See FREE_TEXT_GATE_FIELD above.
      ...(!mappedAnything
        ? { missingFields: [BRAND_VOICE_GATE_FIELD] }
        : modelUnmapped
          ? { missingFields: [FREE_TEXT_GATE_FIELD] }
          : {}),
    };

    return { proposal: createProposal(input), taskType: this.taskType };
  }

  /**
   * LLM extraction pass. Failure-soft: any gateway error or unparseable JSON
   * degrades to `null`, which `handle()` turns into the verbatim spoken
   * instruction landing in `freeText` at 'very_low' confidence — never a
   * dropped utterance.
   */
  private async extract(
    context: TaskContext,
    spoken: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.gateway.complete({
        taskType: 'update_brand_voice',
        tenantId: context.tenantId,
        messages: [
          { role: 'system', content: BRAND_VOICE_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ instruction: spoken }) },
        ],
        responseFormat: 'json',
        metadata: { tenantId: context.tenantId },
      });
      return tryParseJson(response.content);
    } catch {
      return null;
    }
  }
}

export { BRAND_VOICE_SYSTEM_PROMPT, BRAND_VOICE_GATE_FIELD, FREE_TEXT_GATE_FIELD, tryParseJson };
