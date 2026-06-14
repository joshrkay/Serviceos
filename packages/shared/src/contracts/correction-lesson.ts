/**
 * N-009 / P2-038 — Correction-loop lesson contract.
 *
 * When the owner edits (or rejects) an AI-drafted proposal, the correction
 * loop distills the edit into a STRUCTURED LESSON that applies forward to the
 * rest of the tenant's day. Extraction is deliberately conservative — only
 * clear, single-pattern edits become lessons; ambiguous edits produce
 * nothing (no silent guess).
 *
 * Four lesson types map 1:1 to the four edit categories the owner makes:
 *   - `labor_rate_changed`  — a labor line's per-hour rate was changed →
 *                             update the tenant's default labor rate.
 *   - `part_price_changed`  — a material/part line's SKU price was changed →
 *                             update the tenant catalog price for that SKU.
 *   - `banned_phrase`       — a phrase was removed from copy (or named in a
 *                             rejection) → add it to the brand-voice
 *                             negative prompt.
 *   - `scope_reclassified`  — the job's category/vertical was re-classified →
 *                             nudge the vertical-pack template weight.
 *
 * Every lesson carries its cascaded config change as `{ before, after }` so a
 * single undo can reverse BOTH the lesson and the config it cascaded into.
 *
 * This is the single shared contract; the api producer (extractor) and any
 * consumer (digest, undo UX) agree on the shape. Money is integer cents.
 */
import { z } from 'zod';

export const CORRECTION_LESSON_TYPES = [
  'labor_rate_changed',
  'part_price_changed',
  'banned_phrase',
  'scope_reclassified',
] as const;

export type CorrectionLessonType = (typeof CORRECTION_LESSON_TYPES)[number];

export const CORRECTION_LESSON_STATUSES = ['applied', 'reverted'] as const;
export type CorrectionLessonStatus = (typeof CORRECTION_LESSON_STATUSES)[number];

/**
 * Discriminated payload — what the lesson learned and what it cascaded into.
 * `before`/`after` are the cascaded config values so undo is a pure reversal.
 */
export const LaborRatePayloadSchema = z.object({
  kind: z.literal('labor_rate_changed'),
  beforeCents: z.number().int().nonnegative().nullable(),
  afterCents: z.number().int().nonnegative(),
});

export const PartPricePayloadSchema = z.object({
  kind: z.literal('part_price_changed'),
  /** Catalog item / SKU whose price the lesson updated. */
  catalogItemId: z.string().min(1),
  sku: z.string().min(1).optional(),
  beforeCents: z.number().int().nonnegative().nullable(),
  afterCents: z.number().int().nonnegative(),
});

export const BannedPhrasePayloadSchema = z.object({
  kind: z.literal('banned_phrase'),
  phrase: z.string().min(1),
  /** Phrases already present before this lesson (for exact reversal). */
  beforePhrases: z.array(z.string()),
  afterPhrases: z.array(z.string()),
});

export const ScopeReclassifiedPayloadSchema = z.object({
  kind: z.literal('scope_reclassified'),
  packId: z.string().min(1),
  templateKey: z.string().min(1),
  beforeWeight: z.number(),
  afterWeight: z.number(),
});

export const CorrectionLessonPayloadSchema = z.discriminatedUnion('kind', [
  LaborRatePayloadSchema,
  PartPricePayloadSchema,
  BannedPhrasePayloadSchema,
  ScopeReclassifiedPayloadSchema,
]);

export type CorrectionLessonPayload = z.infer<typeof CorrectionLessonPayloadSchema>;
export type LaborRatePayload = z.infer<typeof LaborRatePayloadSchema>;
export type PartPricePayload = z.infer<typeof PartPricePayloadSchema>;
export type BannedPhrasePayload = z.infer<typeof BannedPhrasePayloadSchema>;
export type ScopeReclassifiedPayload = z.infer<typeof ScopeReclassifiedPayloadSchema>;

export const CorrectionLessonSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  lessonType: z.enum(CORRECTION_LESSON_TYPES),
  status: z.enum(CORRECTION_LESSON_STATUSES),
  /** Proposal the owner edited that produced this lesson. */
  sourceProposalId: z.string().min(1),
  /** Owner who made the edit (for audit + reversibility provenance). */
  ownerId: z.string().min(1),
  /** Human-readable one-liner surfaced in the digest. */
  summary: z.string().min(1),
  payload: CorrectionLessonPayloadSchema,
  /**
   * Tenant-local calendar day (YYYY-MM-DD) the lesson applies forward within.
   * Forward application is scoped to this day; storage timestamps are UTC.
   */
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  createdAt: z.date(),
  revertedAt: z.date().nullable(),
});

export type CorrectionLesson = z.infer<typeof CorrectionLessonSchema>;
