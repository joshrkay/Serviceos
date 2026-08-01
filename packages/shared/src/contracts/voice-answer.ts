/**
 * U3 (iOS blueprint) — E-lane answer contract for the recorded-memo path.
 *
 * A spoken read-only ask ("what's my balance?") is classified by the
 * voice-action-router worker, which executes the matching lookup skill
 * server-side and persists the result on the `voice_recordings` row
 * (`answer_status` + `answer` columns). The mobile client's bounded
 * second poll phase reads these fields off `GET /api/voice/recordings/:id`
 * and renders an AnswerCard — so the shape crosses the wire and lives
 * here, validated on write (worker) and parse (mobile).
 *
 * Design notes:
 *   - `answer_status` is the ROUTED OUTCOME of the whole memo (any
 *     intent), not just lookups: `pending` until the router lands,
 *     then exactly one terminal state. The transcription worker flips
 *     `status='completed'` BEFORE the router job even enqueues, so the
 *     client contract is two-phase: `status` first, `answerStatus` second.
 *   - Money stays integer cents end-to-end (`amountCents`); the CLIENT
 *     formats via its canonical money formatter. Never floats, never
 *     pre-formatted currency strings on the wire.
 *   - Lookup skill result shapes are NOT uniform (lookup_availability
 *     returns message/slots, not {summary, data}), so the wire shape is
 *     a flattened, typed row list every skill maps into — one renderer
 *     on the client instead of one per intent.
 */
import { z } from 'zod';

/**
 * Routed-outcome states persisted on `voice_recordings.answer_status`.
 *
 *   pending       — recording created; router outcome not yet landed.
 *   answered      — a lookup executed and `answer` holds the payload
 *                   (including "nothing found" and refusal answers).
 *   proposal      — the memo drafted one or more proposals (review queue).
 *   clarification — a voice_clarification proposal was minted instead.
 *   skipped       — nothing actionable (empty transcript, unsupported
 *                   intent, or a surface without answer execution wired).
 *   failed        — lookup execution errored; the client may offer retry.
 */
export const VOICE_ANSWER_STATUSES = [
  'pending',
  'answered',
  'proposal',
  'clarification',
  'skipped',
  'failed',
] as const;
export type VoiceAnswerStatus = (typeof VOICE_ANSWER_STATUSES)[number];

export const voiceAnswerStatusSchema = z.enum(VOICE_ANSWER_STATUSES);

/** Result grade inside an `answered` payload. `refused` = the memo
 *  creator's role does not permit this (owner-grade) lookup — copy only,
 *  never data. */
export const VOICE_ANSWER_RESULTS = ['found', 'none', 'refused'] as const;
export type VoiceAnswerResult = (typeof VOICE_ANSWER_RESULTS)[number];

const answerLabel = z.string().min(1).max(80);

/**
 * One structured row on the answer card. Discriminated so money renders
 * through the client's cents formatter while text/count rows pass through.
 */
export const voiceAnswerRowSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('money'), label: answerLabel, amountCents: z.number().int() }),
  z.object({ kind: z.literal('text'), label: answerLabel, text: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('count'), label: answerLabel, count: z.number().int().min(0) }),
]);
export type VoiceAnswerRow = z.infer<typeof voiceAnswerRowSchema>;

/**
 * Optional deep-link hint: the entity family (and, when unambiguous, the
 * concrete id) the answer is about. The CLIENT owns the kind → screen
 * mapping (e.g. agreements land on customer detail until a dedicated
 * screen exists) — the server never emits client routes.
 */
export const VOICE_ANSWER_ENTITY_KINDS = [
  'customer',
  'invoice',
  'estimate',
  'job',
  'agreement',
  'appointment',
] as const;
export type VoiceAnswerEntityKind = (typeof VOICE_ANSWER_ENTITY_KINDS)[number];

export const voiceAnswerEntityRefSchema = z.object({
  kind: z.enum(VOICE_ANSWER_ENTITY_KINDS),
  id: z.string().uuid().optional(),
});
export type VoiceAnswerEntityRef = z.infer<typeof voiceAnswerEntityRefSchema>;

export const MAX_VOICE_ANSWER_ROWS = 24;

export const voiceLookupAnswerSchema = z.object({
  /** Contract version — bump on breaking shape changes. */
  version: z.literal(1),
  /** The lookup intent that produced this answer, e.g. `lookup_balance`. */
  intent: z.string().min(1).max(64),
  result: z.enum(VOICE_ANSWER_RESULTS),
  /** TTS-ready single-paragraph summary (same string the skills speak). */
  summary: z.string().min(1).max(2000),
  rows: z.array(voiceAnswerRowSchema).max(MAX_VOICE_ANSWER_ROWS),
  entityRef: voiceAnswerEntityRefSchema.optional(),
});
export type VoiceLookupAnswer = z.infer<typeof voiceLookupAnswerSchema>;

/**
 * Lenient parse for poll responses: returns null (never throws) on a
 * missing / malformed payload so an older server or a hand-edited row
 * degrades to "no answer rendered", not a client crash.
 */
export function parseVoiceLookupAnswer(value: unknown): VoiceLookupAnswer | null {
  const parsed = voiceLookupAnswerSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Type guard for the answer-status wire field (unknown → typed). */
export function isVoiceAnswerStatus(value: unknown): value is VoiceAnswerStatus {
  return (
    typeof value === 'string' && (VOICE_ANSWER_STATUSES as readonly string[]).includes(value)
  );
}
