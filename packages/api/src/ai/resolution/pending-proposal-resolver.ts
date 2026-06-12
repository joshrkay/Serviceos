/**
 * RV-072 — pendingProposals candidate source for the entity resolver.
 *
 * Given a tenant + a free-text reference ("the Henderson estimate",
 * "the $450 invoice", "the second one"), resolve among the tenant's
 * proposals awaiting review (status 'draft' / 'ready_for_review' — the
 * same reviewable set the SMS reply transport targets).
 *
 * Follows the existing candidate-source rules exactly
 * (`pg-entity-resolver.ts`):
 *   - candidates are scored in [0,1];
 *   - exactly one candidate ≥ τ_ent (0.80) → resolved;
 *   - several ≥ τ_ent → ambiguous (ONE clarification, never a guess);
 *   - none → not_found;
 *   - empty reference → skipped.
 *
 * Scoring is signal-based: the reference is decomposed into the signals
 * it actually carries — customer-name tokens, proposal-type words
 * ("estimate", "invoice"…), and an amount mention — and each candidate
 * scores matched/present. "The Henderson estimate" carries two signals,
 * so only a Henderson-named estimate-typed proposal reaches 1.0; a
 * Henderson invoice scores 0.5 and stays below τ_ent.
 *
 * Ordinal references ("the first one", "the second", "the last one")
 * resolve positionally against an ordered id list the CALLER provides
 * from session context — i.e. the list the agent just read out. An
 * ordinal with no provided list is not_found (never a positional guess
 * against an order the owner never heard).
 *
 * Tenant isolation is structural: every lookup goes through the
 * tenant-scoped proposal repository methods.
 */
import type { Proposal, ProposalRepository } from '../../proposals/proposal';
import { TAU_ENT, type EntityCandidate, type EntityResolverResult } from './entity-resolver';
import { payloadAmountsCents as sharedPayloadAmountsCents } from '../../proposals/payload-money';

/** Reviewable statuses — mirrors `isReviewable` in the SMS reply handler. */
const PENDING_STATUSES = ['draft', 'ready_for_review'] as const;

/** Cap on candidates returned for disambiguation (same as pg sources). */
const MAX_CANDIDATES = 5;

// ─── Reference decomposition ─────────────────────────────────────────────────

/** Proposal-type words → the proposal types they refer to. */
const TYPE_WORDS: ReadonlyArray<{ rx: RegExp; types: ReadonlyArray<string> }> = [
  {
    rx: /\b(estimates?|quotes?)\b/i,
    types: ['draft_estimate', 'update_estimate', 'send_estimate'],
  },
  {
    rx: /\b(invoices?|bills?)\b/i,
    types: [
      'draft_invoice',
      'update_invoice',
      'issue_invoice',
      'send_invoice',
      'create_invoice_schedule',
      'batch_invoice',
    ],
  },
  {
    rx: /\b(appointments?|bookings?|visits?)\b/i,
    types: [
      'create_appointment',
      'create_booking',
      'reschedule_appointment',
      'cancel_appointment',
      'reassign_appointment',
      'confirm_appointment',
    ],
  },
  { rx: /\bpayments?\b/i, types: ['record_payment'] },
  { rx: /\bcustomers?\b/i, types: ['create_customer', 'update_customer'] },
  { rx: /\bjobs?\b/i, types: ['create_job'] },
];

/**
 * Words that carry no identity: articles, fillers, the verbs the intent
 * classifier already consumed, and the type/ordinal vocabulary handled by
 * the dedicated signals.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'that', 'this', 'one', 'ones', 'for', 'of', 'to', 'on',
  'it', 'them', 'me', 'us', 'him', 'her', 'go', 'ahead', 'and',
  'please', 'approve', 'reject', 'decline', 'yes', 'no', 'okay', 'ok',
  'proposal', 'proposals', 'pending', 'new', 'my', 'our', 'their',
  'dollar', 'dollars', 'bucks',
]);

const ORDINAL_WORDS: Record<string, number> = {
  first: 0,
  second: 1,
  third: 2,
  fourth: 3,
  fifth: 4,
};

/**
 * Parse an ordinal reference ("the second one", "number 3", "the last
 * one"). Returns a zero-based index, 'last', or null when the reference
 * is not ordinal.
 *
 * Ambiguity rule: if the utterance contains both an anchored ordinal
 * (Nth-suffix or "number N") AND a bare digit that disagrees with it
 * (e.g. "approve 2 of the 3rd"), the reference is ambiguous — return null
 * rather than guessing. A bare digit that MATCHES the anchored value (or
 * no bare digit at all) resolves as before.
 */
export function parseOrdinalReference(reference: string): number | 'last' | null {
  const ref = reference.toLowerCase();

  /**
   * Extract the anchored ordinal value from ref (Nth-suffix or "number N"),
   * if one is present.  Returns the 1-based integer, or null.
   */
  function anchoredOrdinal(): number | null {
    const m = ref.match(/\b(number\s+(\d+)|(\d+)(st|nd|rd|th))\b/);
    if (!m) return null;
    const raw = m[2] ?? m[3];
    const n = raw !== undefined ? parseInt(raw, 10) : NaN;
    return Number.isNaN(n) || n < 1 ? null : n;
  }

  /**
   * Bare-digit disagreement helper — scans the full `ref` string for bare
   * digit sequences (no ordinal suffix, not preceded by "number ") that
   * disagree with a resolved ordinal value `n` (1-based).  Returns true
   * when a disagreeing digit is found.
   *
   * Used by the word-ordinal and 'last' paths as well as the anchored-
   * ordinal ("Nth" / "number N") path so ASR word/digit transcription
   * ambiguity is handled consistently.
   */
  function hasDisagreeingBareDigit(n: number | null): boolean {
    // Collect all bare digit sequences (not followed by an ordinal suffix,
    // not preceded by "number").
    const bareNumbers = [...ref.matchAll(/\b(\d+)\b/g)]
      .filter((m) => {
        const after = ref.slice((m.index ?? 0) + m[0].length);
        if (/^(st|nd|rd|th)\b/.test(after)) return false; // ordinal suffix
        const before = ref.slice(0, m.index ?? 0);
        if (/\bnumber\s+$/.test(before)) return false; // "number N" form
        return true;
      })
      .map((m) => parseInt(m[1], 10))
      .filter((v) => !Number.isNaN(v));

    if (n === null) return bareNumbers.length > 0;
    return bareNumbers.some((v) => v !== n);
  }

  if (/\blast\s*(one)?\b/.test(ref)) {
    // 'last' with any disagreeing bare digit OR any anchored ordinal → ambiguous.
    if (hasDisagreeingBareDigit(null) || anchoredOrdinal() !== null) return null;
    return 'last';
  }
  for (const [word, index] of Object.entries(ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(ref)) {
      // Word-ordinal with a disagreeing bare digit or a non-matching anchored
      // ordinal → ambiguous.  A matching anchored ordinal is fine (they agree).
      const anchored = anchoredOrdinal();
      if (anchored !== null && anchored !== index + 1) return null;
      if (hasDisagreeingBareDigit(index + 1)) return null;
      return index;
    }
  }
  // Anchored ordinal: "Nth" suffix form or "number N" form.
  const numbered = ref.match(/\b(number\s+(\d+)|(\d+)(st|nd|rd|th))\b/);
  if (numbered) {
    // Group 2: "number N" form. Group 3: "Nth" ordinal form.
    const raw = numbered[2] ?? numbered[3];
    const n = raw !== undefined ? parseInt(raw, 10) : NaN;
    if (Number.isNaN(n) || n < 1) return null;

    // Detect bare digit references — digits NOT anchored by an ordinal suffix
    // and NOT preceded by "number ". Slice out the already-matched anchored
    // token by position so only content outside the anchor is scanned.
    const anchorEnd = (numbered.index ?? 0) + numbered[0].length;
    const withoutAnchor = ref.slice(0, numbered.index ?? 0) + ' ' + ref.slice(anchorEnd);
    const bareNumbers = [...withoutAnchor.matchAll(/\b(\d+)\b/g)]
      .map((m) => parseInt(m[1], 10))
      .filter((v) => !Number.isNaN(v));

    // If any bare number disagrees with the anchored value → ambiguous → null.
    if (bareNumbers.some((v) => v !== n)) return null;

    return n - 1;
  }
  return null;
}

/** Extract a cents amount from a spoken/written reference, when present. */
export function parseAmountMention(reference: string): number | null {
  const m = reference.match(/\$?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars?|bucks)?/i);
  if (!m) return null;
  // Only treat the number as money when it is marked as money ($ or a
  // currency word) — a bare "2" in "the 2pm appointment" is not an amount.
  const marked = /\$\s*\d/.test(reference) || /\d[\d,.]*\s*(dollars?|bucks)\b/i.test(reference);
  if (!marked) return null;
  const value = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** All plausible integer-cent money values carried by a proposal payload. */
const payloadAmountsCents = sharedPayloadAmountsCents;

/** Customer-name-ish strings carried by a proposal (payload first, then summary). */
function candidateNameHaystack(proposal: Proposal): string {
  const payload = proposal.payload ?? {};
  const parts: string[] = [];
  for (const key of ['customerName', 'name', 'displayName']) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === 'string') parts.push(v);
  }
  // The summary regularly carries the customer name ("Book Mrs Lee
  // Tuesday 2pm") — weaker provenance than the payload but the same
  // tenant-scoped record, so it is a safe match surface for SCORING.
  // (The RV-071 readback is composed from payload fields only.)
  parts.push(proposal.summary ?? '');
  return parts.join(' ').toLowerCase();
}

interface ReferenceSignals {
  nameTokens: string[];
  /** Proposal types implied by a type word, when one was spoken. */
  types: string[] | null;
  amountCents: number | null;
}

export function extractReferenceSignals(reference: string): ReferenceSignals {
  const types = TYPE_WORDS.filter((t) => t.rx.test(reference)).flatMap((t) => [...t.types]);
  const amountCents = parseAmountMention(reference);

  const nameTokens = reference
    .toLowerCase()
    // Strip money mentions so "450" never doubles as a name token.
    .replace(/\$?\s*\d[\d,]*(?:\.\d{1,2})?\s*(?:dollars?|bucks)?/gi, ' ')
    .split(/[^a-z']+/)
    .filter(
      (w) =>
        w.length >= 2 &&
        !STOPWORDS.has(w) &&
        !(w in ORDINAL_WORDS) &&
        w !== 'last' &&
        !TYPE_WORDS.some((t) => t.rx.test(w)),
    );

  return {
    nameTokens,
    types: types.length > 0 ? types : null,
    amountCents,
  };
}

/**
 * Score one pending proposal against the decomposed reference:
 * matched signals / present signals. Returns 0 when the reference
 * carries no usable signal.
 */
export function scorePendingProposal(signals: ReferenceSignals, proposal: Proposal): number {
  let present = 0;
  let matched = 0;

  if (signals.nameTokens.length > 0) {
    present += 1;
    const haystack = candidateNameHaystack(proposal);
    if (signals.nameTokens.some((token) => haystack.includes(token))) matched += 1;
  }

  if (signals.types) {
    present += 1;
    if (signals.types.includes(proposal.proposalType)) matched += 1;
  }

  if (signals.amountCents !== null) {
    present += 1;
    if (payloadAmountsCents(proposal.payload ?? {}).includes(signals.amountCents)) matched += 1;
  }

  if (present === 0) return 0;
  return matched / present;
}

function toCandidate(proposal: Proposal, score: number): EntityCandidate {
  return {
    id: proposal.id,
    kind: 'pending_proposal',
    label: proposal.summary,
    hint: proposal.proposalType,
    score,
  };
}

/**
 * Pure resolution over an already-loaded pending list. Exported for the
 * unit tests and for callers that already hold the list.
 */
export function resolvePendingProposalReference(
  pending: Proposal[],
  reference: string,
  opts: {
    /**
     * Ordered proposal ids the agent last read out (session context).
     * Ordinal references resolve positionally against THIS list — and
     * only against it.
     */
    orderedIds?: string[];
  } = {},
): EntityResolverResult {
  if (!reference || reference.trim() === '') {
    return { kind: 'skipped' };
  }

  // Ordinals resolve positionally — but only against a list the owner
  // actually heard. No list → not_found (never a positional guess).
  const ordinal = parseOrdinalReference(reference);
  if (ordinal !== null) {
    const ordered = opts.orderedIds ?? [];
    if (ordered.length === 0) return { kind: 'not_found', reference };
    const index = ordinal === 'last' ? ordered.length - 1 : ordinal;
    const id = ordered[index];
    const proposal = id ? pending.find((p) => p.id === id) : undefined;
    if (!proposal) return { kind: 'not_found', reference };
    return { kind: 'resolved', candidate: toCandidate(proposal, 1.0) };
  }

  const signals = extractReferenceSignals(reference);
  const scored = pending
    .map((p) => ({ proposal: p, score: scorePendingProposal(signals, p) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);

  // Same τ_ent classification as every other candidate source.
  const above = scored.filter((s) => s.score >= TAU_ENT);
  if (above.length === 0) return { kind: 'not_found', reference };
  if (above.length === 1) {
    return { kind: 'resolved', candidate: toCandidate(above[0].proposal, above[0].score) };
  }
  return {
    kind: 'ambiguous',
    candidates: above.map((s) => toCandidate(s.proposal, s.score)),
  };
}

// ─── Repository-backed source ────────────────────────────────────────────────

export interface PendingProposalResolverInput {
  tenantId: string;
  reference: string;
  /** Ordered ids from session context, for ordinal references. */
  orderedIds?: string[];
}

export interface PendingProposalResolution {
  result: EntityResolverResult;
  /**
   * The reviewable set the reference was resolved against, newest first.
   * Callers (RV-071) keep this as the session-context ordered list so a
   * follow-up "the second one" resolves against what was just spoken.
   */
  pending: Proposal[];
}

export class PendingProposalResolver {
  constructor(
    private readonly proposalRepo: Pick<ProposalRepository, 'findByStatus'>,
  ) {}

  /** List the tenant's reviewable proposals, newest first. */
  async listPending(tenantId: string): Promise<Proposal[]> {
    const lists = await Promise.all(
      PENDING_STATUSES.map((status) => this.proposalRepo.findByStatus(tenantId, status)),
    );
    return lists
      .flat()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async resolve(input: PendingProposalResolverInput): Promise<PendingProposalResolution> {
    const pending = await this.listPending(input.tenantId);
    const result = resolvePendingProposalReference(pending, input.reference, {
      ...(input.orderedIds ? { orderedIds: input.orderedIds } : {}),
    });
    return { result, pending };
  }
}
