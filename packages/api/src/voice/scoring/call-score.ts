/**
 * #1736 — post-call scoring: the rubric, the judge's output contract and the
 * score arithmetic. Pure; no I/O.
 *
 * Distinct from #1602's `voice_session_grades` (a pass/fail gate on a SAMPLE of
 * calls, feeding the SLO monitor): a call score is a 0-100 owner-facing
 * read of EVERY call the owner opted in, with flagged moments and a
 * "correct this call" action. It reuses #1602's store seam to load the
 * consent-gated transcript, not its table.
 *
 * Rubric v1 — four items, each pass / fail / not_applicable:
 *   booked              the caller wanted work done and left with an appointment
 *   price_grounded      every price the agent spoke came from the tenant catalog
 *   escalation_handled  a request the agent can't do (money, complaint,
 *                       emergency, "talk to a person") was handed to a human
 *   follow_up_set       the call ended with a next step (callback, quote, visit)
 * A not_applicable item drops out and the remaining weights renormalise, so a
 * pure information call is not punished for "not booking".
 */
import { z } from 'zod';

export const CALL_SCORE_RUBRIC_VERSION = 'v1';

export const RUBRIC_ITEM_IDS = ['booked', 'price_grounded', 'escalation_handled', 'follow_up_set'] as const;
export type RubricItemId = (typeof RUBRIC_ITEM_IDS)[number];

/** Weights sum to 100. Booking and price honesty are what cost a shop money. */
export const RUBRIC_WEIGHTS: Record<RubricItemId, number> = {
  booked: 35,
  price_grounded: 25,
  escalation_handled: 25,
  follow_up_set: 15,
};

export const FLAG_KINDS = [
  'missed_opportunity',
  'ungrounded_price',
  'escalation_mishandled',
  'no_follow_up',
  'strength',
] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

export const MAX_EXCERPT_CHARS = 240;
export const MAX_RATIONALE_CHARS = 240;
export const MAX_FLAGS = 8;

/** The judge's JSON reply. Strict: anything off-contract fails the score, never a guess. */
export const JudgeVerdictSchema = z.object({
  items: z.array(
    z.object({
      id: z.enum(RUBRIC_ITEM_IDS),
      verdict: z.enum(['pass', 'fail', 'not_applicable']),
      rationale: z.string().max(MAX_RATIONALE_CHARS),
    }),
  ),
  flags: z
    .array(
      z.object({
        kind: z.enum(FLAG_KINDS),
        /** 0-based index of the CALLER turn the moment belongs to. */
        turnIndex: z.number().int().min(0),
        note: z.string().max(MAX_RATIONALE_CHARS),
      }),
    )
    .max(MAX_FLAGS),
  summary: z.string().max(MAX_RATIONALE_CHARS),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export interface CallScoreItem {
  id: RubricItemId;
  verdict: 'pass' | 'fail' | 'not_applicable';
  rationale: string;
}

export interface CallScoreFlag {
  kind: FlagKind;
  turnIndex: number;
  /** The caller line and the agent's reply for that turn, so the owner sees the moment without opening the call. */
  excerpt: string;
  note: string;
}

export interface CallScore {
  id: string;
  tenantId: string;
  sessionId: string;
  scoredAt: Date;
  /** Integer 0-100. */
  score: number;
  rubricVersion: string;
  items: CallScoreItem[];
  flags: CallScoreFlag[];
  summary: string;
  model: string;
  costMicroCents: number;
  callEndedAt: Date;
}

/**
 * Weighted share of the applicable items that passed, as an integer 0-100.
 * Returns null when no item applies (nothing to score — the caller skips the
 * call rather than inventing a number). Missing items count as not applicable;
 * duplicate ids keep the first.
 */
export function computeScore(items: ReadonlyArray<Pick<CallScoreItem, 'id' | 'verdict'>>): number | null {
  const seen = new Set<RubricItemId>();
  let earned = 0;
  let possible = 0;
  for (const item of items) {
    if (seen.has(item.id) || item.verdict === 'not_applicable') continue;
    seen.add(item.id);
    possible += RUBRIC_WEIGHTS[item.id];
    if (item.verdict === 'pass') earned += RUBRIC_WEIGHTS[item.id];
  }
  if (possible === 0) return null;
  return Math.round((earned / possible) * 100);
}

/** A call needs the owner's eye when any item failed (a pure-strength flag alone does not). */
export function needsReview(score: Pick<CallScore, 'items' | 'flags'>): boolean {
  return score.items.some((i) => i.verdict === 'fail') || score.flags.some((f) => f.kind !== 'strength');
}
