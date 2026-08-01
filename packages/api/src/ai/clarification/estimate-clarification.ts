/**
 * Story 7.2 — Clarifying questions for the Estimate Agent.
 *
 * The agent asks targeted questions when an estimate request is ambiguous
 * rather than guessing, with a HARD CAP of three clarification loops. After
 * the cap it stops asking and proposes a best-effort estimate FLAGGED FOR
 * REVIEW (a human checks it before it goes out).
 *
 * This module is the deterministic policy: it detects ambiguities, turns them
 * into targeted questions, and decides — given how many times we've already
 * asked — whether to ask again or finalize a flagged draft. It is pure (no
 * I/O); the AI estimate handler feeds it signals and acts on the decision.
 * Nothing here auto-executes: the outcome is always a human-reviewed proposal.
 */

/** The agent asks at most this many times before proposing a flagged draft. */
export const MAX_ESTIMATE_CLARIFICATION_LOOPS = 3;

export type EstimateAmbiguityCode =
  | 'no_line_items'
  | 'missing_customer'
  | 'missing_quantity'
  | 'uncatalogued_price'
  | 'ambiguous_catalog_match'
  | 'vague_description';

export interface EstimateAmbiguity {
  code: EstimateAmbiguityCode;
  /** Human-readable specifics (e.g. the line descriptions affected). */
  detail?: string;
}

export interface EstimateDraftSignals {
  /** The spoken/typed job description. */
  description: string;
  /** Whether the request is tied to a known customer. */
  hasCustomer: boolean;
  lineItems: Array<{
    description: string;
    quantity?: number;
    unitPriceCents?: number;
    /** From the catalog resolver: 'catalog' | 'manual' | 'uncatalogued' | 'ambiguous'. */
    pricingSource?: string;
  }>;
  /**
   * Line descriptions the catalog resolver matched to MORE THAN ONE catalog
   * item — the operator must pick which one. Surfaced from the resolver's
   * missingFields.
   */
  ambiguousCatalogFields?: string[];
}

/** Roughly how many words are in the description (vague when very short). */
function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Detect what's ambiguous about a drafted estimate. Conservative and
 * deterministic — each signal maps to a single, specific ambiguity so the
 * generated questions stay targeted ("how many?", "which AC unit?") rather
 * than a generic "tell me more".
 */
export function detectEstimateAmbiguities(signals: EstimateDraftSignals): EstimateAmbiguity[] {
  const ambiguities: EstimateAmbiguity[] = [];

  if (signals.lineItems.length === 0) {
    ambiguities.push({ code: 'no_line_items' });
    // A description with almost no content can't be priced — ask for the job.
    if (wordCount(signals.description) < 3) {
      ambiguities.push({ code: 'vague_description' });
    }
  }

  if (!signals.hasCustomer) {
    ambiguities.push({ code: 'missing_customer' });
  }

  const missingQty = signals.lineItems.filter(
    (li) => li.quantity === undefined || li.quantity === null || li.quantity <= 0,
  );
  if (missingQty.length > 0) {
    ambiguities.push({
      code: 'missing_quantity',
      detail: missingQty.map((li) => li.description).join(', '),
    });
  }

  const uncatalogued = signals.lineItems.filter((li) => li.pricingSource === 'uncatalogued');
  if (uncatalogued.length > 0) {
    ambiguities.push({
      code: 'uncatalogued_price',
      detail: uncatalogued.map((li) => li.description).join(', '),
    });
  }

  if (signals.ambiguousCatalogFields && signals.ambiguousCatalogFields.length > 0) {
    ambiguities.push({
      code: 'ambiguous_catalog_match',
      detail: signals.ambiguousCatalogFields.join(', '),
    });
  }

  return ambiguities;
}

/** Map each ambiguity to a specific, answerable question (deduped, ordered). */
export function generateEstimateClarifications(ambiguities: EstimateAmbiguity[]): string[] {
  const questions: string[] = [];
  const seen = new Set<EstimateAmbiguityCode>();

  for (const a of ambiguities) {
    if (seen.has(a.code)) continue;
    seen.add(a.code);
    switch (a.code) {
      case 'no_line_items':
        questions.push('What work should this estimate cover?');
        break;
      case 'vague_description':
        questions.push('Can you describe the job in a bit more detail (what needs doing, and where)?');
        break;
      case 'missing_customer':
        questions.push('Who is this estimate for?');
        break;
      case 'missing_quantity':
        questions.push(
          a.detail
            ? `How many / how much for: ${a.detail}?`
            : 'How many of each item should I include?',
        );
        break;
      case 'uncatalogued_price':
        questions.push(
          a.detail
            ? `I couldn't find a catalog price for: ${a.detail}. What should I charge?`
            : 'What should I charge for the items not in your catalog?',
        );
        break;
      case 'ambiguous_catalog_match':
        questions.push(
          a.detail
            ? `Which catalog item did you mean for: ${a.detail}?`
            : 'Which catalog item did you mean?',
        );
        break;
    }
  }

  return questions;
}

export interface ClarificationDecisionInput {
  /** How many clarification loops have already run for this estimate (0-based). */
  clarificationCount: number;
  ambiguities: EstimateAmbiguity[];
  /** Override the cap (tests); defaults to MAX_ESTIMATE_CLARIFICATION_LOOPS. */
  maxLoops?: number;
}

export interface ClarificationDecision {
  /**
   * 'clarify' — ask the questions and wait (under the cap, ambiguities remain).
   * 'draft'   — produce the estimate now (no ambiguities, OR cap reached).
   */
  action: 'clarify' | 'draft';
  questions: string[];
  /**
   * True when we're drafting DESPITE unresolved ambiguity because the loop cap
   * was hit. The estimate must be surfaced for human review, never auto-sent.
   */
  flaggedForReview: boolean;
  /** Echoes how many loops have run, for the caller to persist/increment. */
  loopCount: number;
  /** True once the cap has been reached (no more questions will be asked). */
  capped: boolean;
}

/**
 * Decide whether to ask another clarifying question or finalize the estimate.
 *
 *   - No ambiguities          → draft now (not flagged).
 *   - Ambiguities, under cap  → clarify (ask the targeted questions).
 *   - Ambiguities, cap hit    → draft now, FLAGGED FOR REVIEW (best-effort).
 */
export function decideEstimateClarification(
  input: ClarificationDecisionInput,
): ClarificationDecision {
  const maxLoops = input.maxLoops ?? MAX_ESTIMATE_CLARIFICATION_LOOPS;
  const loopCount = Math.max(0, input.clarificationCount);
  const capped = loopCount >= maxLoops;
  const questions = generateEstimateClarifications(input.ambiguities);

  if (input.ambiguities.length === 0) {
    return { action: 'draft', questions: [], flaggedForReview: false, loopCount, capped };
  }

  if (capped) {
    // Stop asking — propose a best-effort estimate flagged for review.
    return { action: 'draft', questions, flaggedForReview: true, loopCount, capped: true };
  }

  return { action: 'clarify', questions, flaggedForReview: false, loopCount, capped: false };
}
