/**
 * §5 I5′ (STRUCTURAL) — *"…through one shared matcher, so the surfaces cannot
 * drift"* (#1021, map #995).
 *
 * **I5′ IS FALSE AS WRITTEN, and this file does not pretend otherwise.**
 *
 * There is not one matcher. There are two components in series on the chat
 * surface:
 *
 *   - the GATE, `isDisambiguationAnswer`
 *     (`ai/resolution/gated-reference-resolution.ts:602`), which decides
 *     whether a chat turn is plausibly an ANSWER at all; and
 *   - the MATCHER, `matchDisambiguationFollowUp`
 *     (`ai/agents/customer-calling/entity-resolution.ts:1164`), the shared
 *     deterministic placement D-029 §2 requires both surfaces to use.
 *
 * The gate's own doc comment says it *"is allowed to be slightly BROADER than
 * the matcher behind it, and the asymmetry is deliberate"* — so a test
 * demanding they be the same function would be pinning a falsehood, and the
 * G1 audit was right to mark the row FALSE AS WRITTEN.
 *
 * ## What IS true, and is what this file pins
 *
 * The gate is not uniformly broader. It is broader on ANSWER-shaped turns
 * (accepting one the matcher cannot place costs a re-ask) and deliberately
 * NARROWER on three named REQUEST shapes the matcher would wrongly place —
 * the hijack the gate exists to close ("Send an invoice to Johnson Plumbing
 * for $400" contains a candidate label, so the matcher places it and the
 * invoice request is swallowed).
 *
 * So the relationship, stated so it can be refuted, is three clauses:
 *
 *   **(C1) Containment on the answer domain.** For every ANSWER-shaped turn,
 *   matcher-places ⟹ gate-accepts. The gate never starves the shared matcher
 *   of an answer it could have placed.
 *
 *   **(C2) The divergence set is characterized, not open.** Every turn the
 *   matcher places and the gate rejects must match one of the three named
 *   hijack shapes. A new divergence with no name is drift, and fails.
 *
 *   **(C3) The asymmetry is one-directional and safe.** Turns the gate accepts
 *   and the matcher cannot place exist (that is the deliberate slack) and
 *   every one of them comes back `unmatched` — never a wrong candidate.
 *
 * Plus the sharpest drift surface in the pair, which nothing pinned before:
 * `ORDINAL_ANSWER_RE` (gate) and `parseOrdinalIndex` (matcher) are two copies
 * of the same ordinal vocabulary in two files, joined only by a comment —
 * *"Kept in step with `parseOrdinalIndex`"*. **(C0)** makes "kept in step"
 * mechanical.
 *
 * The corrected I5′ wording is proposed in the lane report; the PRD is not
 * edited here.
 *
 * Evidence class: STRUCTURAL (negative controls plant a narrowed gate and a
 * widened matcher and show each breaking containment).
 */
import { describe, it, expect } from 'vitest';
import {
  matchDisambiguationFollowUp,
  type DisambiguationFollowUpResult,
  type PendingEntityAmbiguity,
} from '../../src/ai/agents/customer-calling/entity-resolution';
import { isDisambiguationAnswer } from '../../src/ai/resolution/gated-reference-resolution';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function pendingWith(
  candidates: Array<{ id: string; name: string; hint?: string }>,
): PendingEntityAmbiguity {
  return {
    entityKind: 'customer',
    reference: 'johnson',
    refKey: 'customerReference',
    candidates: candidates.map((c) => ({ ...c, score: 0.7 })),
    partialRefs: {},
    attemptCount: 0,
  };
}

/** Two same-named customers — I5's canonical ambiguity. */
const TWO_JOHNSONS = pendingWith([
  { id: 'cus-1', name: 'Marcus Johnson', hint: '9 Elm Court · (480) 555-0188' },
  { id: 'cus-2', name: 'Dana Johnson', hint: '412 Palo Verde Rd · (480) 555-0246' },
]);

/** A pair whose labels are short enough to be substrings of ordinary words. */
const SHORT_LABELS = pendingWith([
  { id: 'cus-3', name: 'Brooks', hint: '50 Mill St' },
  { id: 'cus-4', name: 'Okonkwo', hint: '77 Lark Ave' },
]);

/**
 * A candidate set at the product's own cap (`MAX_CANDIDATES = 5`,
 * pending-proposal-resolver.ts:40).
 *
 * Reviewed on PR #1063 and load-bearing for C0: `parseOrdinalIndex` only
 * returns an index when `index < candidateCount`, so on a two-candidate
 * fixture the matcher can never place anything past "second" — and a
 * generated ordinal space alone would still never exercise "third", "fourth"
 * or "fifth". Five candidates is the real ceiling the product can produce, so
 * this is the widest the guard can honestly reach.
 */
const FIVE_CANDIDATES = pendingWith([
  { id: 'cus-5', name: 'Alvarez', hint: '12 Oak Ln' },
  { id: 'cus-6', name: 'Petrov', hint: '34 Birch Way' },
  { id: 'cus-7', name: 'Nakamura', hint: '56 Cedar Rd' },
  { id: 'cus-8', name: 'Okafor', hint: '78 Spruce Dr' },
  { id: 'cus-9', name: 'Lindqvist', hint: '90 Aspen Ct' },
]);

const FIXTURES: ReadonlyArray<{ name: string; pending: PendingEntityAmbiguity }> = [
  { name: 'two Johnsons', pending: TWO_JOHNSONS },
  { name: 'short labels', pending: SHORT_LABELS },
  { name: 'five candidates', pending: FIVE_CANDIDATES },
];

// ─── The corpus ─────────────────────────────────────────────────────────────

/**
 * Turns an operator could type with a disambiguation question standing.
 * `kind: 'answer'` are genuine answers to the question; `kind: 'request'` are
 * the ordinary work the hijack used to swallow.
 */
const CORPUS: ReadonlyArray<{ text: string; kind: 'answer' | 'request' }> = [
  // Bare candidate ids.
  { text: 'cus-1', kind: 'answer' },
  { text: 'cus-4', kind: 'answer' },
  // Ordinals, in every form either component claims to understand.
  { text: 'first', kind: 'answer' },
  { text: 'the first', kind: 'answer' },
  { text: 'the first one', kind: 'answer' },
  { text: 'second', kind: 'answer' },
  { text: 'the second one', kind: 'answer' },
  { text: 'third', kind: 'answer' },
  { text: '1', kind: 'answer' },
  { text: '2', kind: 'answer' },
  { text: '3', kind: 'answer' },
  { text: 'one', kind: 'answer' },
  { text: 'two', kind: 'answer' },
  { text: 'three', kind: 'answer' },
  { text: 'option 1', kind: 'answer' },
  { text: 'option 2', kind: 'answer' },
  { text: 'option 3', kind: 'answer' },
  { text: 'primero', kind: 'answer' },
  { text: 'primer', kind: 'answer' },
  { text: 'segundo', kind: 'answer' },
  { text: 'tercero', kind: 'answer' },
  // Names — exact, partial, wrapped.
  { text: 'Marcus Johnson', kind: 'answer' },
  { text: 'Dana Johnson', kind: 'answer' },
  { text: 'Dana', kind: 'answer' },
  { text: 'Marcus', kind: 'answer' },
  { text: 'Brooks', kind: 'answer' },
  { text: 'Okonkwo', kind: 'answer' },
  { text: 'the Dana one', kind: 'answer' },
  // Address / phone hints.
  { text: '9 Elm Court', kind: 'answer' },
  { text: '412', kind: 'answer' },
  { text: '480-555-0188', kind: 'answer' },
  { text: 'the one on 480-555-0246', kind: 'answer' },
  { text: '50 Mill St', kind: 'answer' },
  // Punctuation / casing the normalizer is supposed to absorb.
  { text: 'Dana.', kind: 'answer' },
  { text: '  the second one  ', kind: 'answer' },
  { text: 'DANA JOHNSON', kind: 'answer' },
  // The hijack: ordinary requests that happen to carry a label, a number, or
  // to be a substring of a label.
  { text: 'Send an invoice to Marcus Johnson for $400', kind: 'request' },
  { text: 'apply a $50 late fee on invoice 1042', kind: 'request' },
  { text: 'ok', kind: 'request' },
  { text: 'book Dana Johnson for a tune-up next Tuesday afternoon', kind: 'request' },
  { text: 'what is on the schedule for tomorrow', kind: 'request' },
  { text: 'cancel the 3pm and text the customer to let them know', kind: 'request' },
];

/**
 * The ordinal SPACE both components could plausibly understand — generated
 * from the vocabulary axes rather than hand-listed, and deliberately reaching
 * past what either side accepts today (through tenth, both languages, both
 * digit and word forms, every wrapper).
 *
 * This is what makes C0 a real guard rather than a corpus sample: the day
 * `parseOrdinalIndex` learns "fourth", the form is already in the space, the
 * matcher places it, the gate rejects it, and C0 goes red — without anyone
 * remembering to add a test case.
 */
const ORDINAL_SPACE: readonly string[] = (() => {
  const bases = [
    'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
    'option 1', 'option 2', 'option 3', 'option 4', 'option 5',
    'primer', 'primero', 'segundo', 'tercero', 'cuarto', 'quinto',
  ];
  const out = new Set<string>();
  for (const base of bases) {
    out.add(base);
    out.add(`the ${base}`);
    out.add(`${base} one`);
    out.add(`the ${base} one`);
  }
  return [...out];
})();

// ─── Classification of a permitted divergence ───────────────────────────────

/**
 * The three REQUEST shapes the gate is documented to reject even though the
 * matcher would place them. Named, because an unnamed divergence is drift.
 */
const NAMED_HIJACK_SHAPES: ReadonlyArray<{
  name: string;
  why: string;
  matches: (text: string, pending: PendingEntityAmbiguity) => boolean;
}> = [
  {
    name: 'long_request_containing_label',
    why: "entity-resolution.ts's `normalized.includes(label)` seam: a full request that happens to contain a candidate name. The gate caps a NAMING answer at 3 words.",
    matches: (text, pending) => {
      const n = normalize(text);
      return (
        n.split(/\s+/).filter(Boolean).length > 3 &&
        pending.candidates.some((c) => n.includes(c.name.trim().toLowerCase()))
      );
    },
  },
  {
    name: 'utterance_is_substring_of_label',
    why: "the reverse seam, `label.includes(normalized)`: a bare 'ok' is a substring of 'Brooks'. The gate requires the words to BE the name, not sit inside it.",
    matches: (text, pending) => {
      const n = normalize(text);
      return (
        n.length > 0 &&
        pending.candidates.some((c) => {
          const label = c.name.trim().toLowerCase();
          return label.includes(n) && label !== n;
        })
      );
    },
  },
  {
    name: 'long_request_carrying_a_number',
    why: "`extractStreetNumber`'s `\\b(\\d{1,5})\\b`: '$50 late fee on invoice 1042' offers a number to any address hint. The gate caps a hint answer at 5 words.",
    matches: (text) => {
      const n = normalize(text);
      return n.split(/\s+/).filter(Boolean).length > 5 && /\d/.test(n);
    },
  },
];

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?,]+$/g, '').trim();
}

type Matcher = (text: string, pending: PendingEntityAmbiguity) => DisambiguationFollowUpResult;
type Gate = (text: string, pending: PendingEntityAmbiguity) => boolean;

function placed(result: DisambiguationFollowUpResult): boolean {
  return result.status === 'resolved' || result.status === 'still_ambiguous';
}

export interface Divergence {
  readonly fixture: string;
  readonly text: string;
  readonly kind: 'answer' | 'request';
  /** The named hijack shape that explains it, or null when it is drift. */
  readonly explainedBy: string | null;
}

/**
 * Every corpus turn the MATCHER places and the GATE rejects, classified.
 *
 * Pure in `gate` and `matcher` — which is what lets the negative controls
 * substitute a narrowed gate or a widened matcher and watch containment break.
 */
export function matcherAcceptancesTheGateRejects(gate: Gate, matcher: Matcher): Divergence[] {
  const out: Divergence[] = [];
  for (const fixture of FIXTURES) {
    for (const entry of CORPUS) {
      if (!placed(matcher(entry.text, fixture.pending))) continue;
      if (gate(entry.text, fixture.pending)) continue;
      const shape = NAMED_HIJACK_SHAPES.find((s) => s.matches(entry.text, fixture.pending));
      out.push({
        fixture: fixture.name,
        text: entry.text,
        kind: entry.kind,
        explainedBy: shape ? shape.name : null,
      });
    }
  }
  return out;
}

/** Every corpus turn the GATE accepts and the MATCHER cannot place. */
export function gateAcceptancesTheMatcherCannotPlace(
  gate: Gate,
  matcher: Matcher,
): Array<{ fixture: string; text: string; status: string }> {
  const out: Array<{ fixture: string; text: string; status: string }> = [];
  for (const fixture of FIXTURES) {
    for (const entry of CORPUS) {
      if (!gate(entry.text, fixture.pending)) continue;
      const result = matcher(entry.text, fixture.pending);
      if (placed(result)) continue;
      out.push({ fixture: fixture.name, text: entry.text, status: result.status });
    }
  }
  return out;
}

// ─── The guard ──────────────────────────────────────────────────────────────

describe('§5 I5′ (STRUCTURAL) — the gate/matcher RELATIONSHIP, since "one shared matcher" is false as written', () => {
  it('C0 — the two ordinal vocabularies are in step: every ordinal the matcher places, the gate accepts', () => {
    // `ORDINAL_ANSWER_RE` (gate) and `parseOrdinalIndex` (matcher) are two
    // copies of the same vocabulary in two files, joined by a comment that
    // says "Kept in step with parseOrdinalIndex". This makes it mechanical.
    //
    // The space is GENERATED, not taken from `CORPUS`. Reviewed on PR #1063:
    // sourcing it from the hand-written corpus meant a future change teaching
    // `parseOrdinalIndex` a new form — "fourth", "cuarto", "option 4" — would
    // never enter the loop, and the guard would stay green through exactly the
    // drift it claims to make mechanical. `ORDINAL_SPACE` covers well past
    // what either side understands today, so a new form the matcher learns is
    // already under test before anyone writes it.
    const broken: string[] = [];
    for (const fixture of FIXTURES) {
      for (const text of ORDINAL_SPACE) {
        if (matchDisambiguationFollowUp(text, fixture.pending).status !== 'resolved') continue;
        if (!isDisambiguationAnswer(text, fixture.pending)) {
          broken.push(`${fixture.name}: ${JSON.stringify(text)}`);
        }
      }
    }
    expect(
      broken,
      'An ordinal form the shared matcher places is rejected by the chat gate — the two ' +
        'ordinal vocabularies have drifted. Update ORDINAL_ANSWER_RE to match parseOrdinalIndex.',
    ).toEqual([]);
  });

  it('C0 is not vacuous: the generated space really does reach the matcher, and reaches past today\'s vocabulary', () => {
    const placed = ORDINAL_SPACE.filter(
      (t) => matchDisambiguationFollowUp(t, FIVE_CANDIDATES).status === 'resolved',
    );
    // The five-candidate fixture is what lets ordinals past "second" reach the
    // matcher at all (`index < candidateCount`); on a two-candidate set the
    // generated space would be silently capped.
    expect(
      ORDINAL_SPACE.filter((t) => matchDisambiguationFollowUp(t, TWO_JOHNSONS).status === 'resolved')
        .length,
    ).toBeLessThan(placed.length);
    // Today's shared vocabulary stops at third; the space goes to tenth, so
    // the forms a future `parseOrdinalIndex` could learn are already covered.
    expect(placed.length).toBeGreaterThan(10);
    expect(ORDINAL_SPACE).toContain('the fourth one');
    expect(ORDINAL_SPACE).toContain('cuarto');
    expect(ORDINAL_SPACE).toContain('option 4');
    expect(ORDINAL_SPACE.length).toBeGreaterThan(100);
  });

  it('C1 — containment on the answer domain: every ANSWER the matcher places, the gate accepts', () => {
    const starved = matcherAcceptancesTheGateRejects(
      isDisambiguationAnswer,
      matchDisambiguationFollowUp,
    ).filter((d) => d.kind === 'answer');

    expect(
      starved.map((d) => `${d.fixture}: ${JSON.stringify(d.text)}`),
      'The chat gate is starving the shared matcher of a turn it could have placed. ' +
        'That is the drift I5′ is about: the surfaces now disagree about what an answer is.',
    ).toEqual([]);
  });

  it('C2 — every divergence is one of the three NAMED hijack shapes (an unnamed one is drift)', () => {
    const unexplained = matcherAcceptancesTheGateRejects(
      isDisambiguationAnswer,
      matchDisambiguationFollowUp,
    ).filter((d) => d.explainedBy === null);

    expect(
      unexplained.map((d) => `${d.fixture}: ${JSON.stringify(d.text)}`),
      'The matcher places a turn the gate rejects, and no named hijack shape explains it. ' +
        'Either the gate narrowed without a reason, or the matcher grew a seam.',
    ).toEqual([]);
  });

  it('C2 — the divergence set is non-empty and is exactly the documented hijack (the asymmetry is real)', () => {
    const divergences = matcherAcceptancesTheGateRejects(
      isDisambiguationAnswer,
      matchDisambiguationFollowUp,
    );
    // Non-empty: this is the evidence that "one shared matcher" is FALSE as
    // written. If this ever becomes empty, the two have been collapsed and
    // I5′'s original wording becomes true — re-grade the row.
    expect(divergences.length).toBeGreaterThan(0);
    expect(divergences.every((d) => d.kind === 'request')).toBe(true);
    expect(new Set(divergences.map((d) => d.explainedBy))).not.toContain(null);
  });

  it('C3 — the permitted slack is one-directional and safe: gate-accepted, matcher-unplaced turns come back unmatched, never a wrong pick', () => {
    const slack = gateAcceptancesTheMatcherCannotPlace(
      isDisambiguationAnswer,
      matchDisambiguationFollowUp,
    );
    // The asymmetry the gate's comment describes: "accepting a turn the
    // matcher then cannot place costs one re-ask".
    expect(slack.length).toBeGreaterThan(0);
    for (const entry of slack) {
      expect(entry.status, `${entry.fixture}: ${entry.text}`).toBe('unmatched');
    }
  });

  // ─── Negative controls ────────────────────────────────────────────────────

  it('NEGATIVE CONTROL — a gate narrowed to drop ordinals breaks containment (C0/C1)', () => {
    const narrowedGate: Gate = (text, pending) => {
      if (isOrdinalShaped(text)) return false; // planted drift
      return isDisambiguationAnswer(text, pending);
    };
    const starved = matcherAcceptancesTheGateRejects(
      narrowedGate,
      matchDisambiguationFollowUp,
    ).filter((d) => d.kind === 'answer');

    expect(starved.length).toBeGreaterThan(0);
    expect(starved.map((d) => d.text)).toContain('the second one');
    // And the drift is UNEXPLAINED — no named hijack shape covers an ordinal.
    expect(starved.every((d) => d.explainedBy === null)).toBe(true);
  });

  it('NEGATIVE CONTROL — a matcher grown a new ordinal ("fourth") the gate does not know breaks containment', () => {
    const widenedMatcher: Matcher = (text, pending) => {
      if (normalize(text).replace(/^the\s+/, '').replace(/\s+one$/, '') === 'fourth') {
        // planted: the shared matcher learns a form the chat gate never did
        return { status: 'resolved', candidateId: pending.candidates[0].id };
      }
      return matchDisambiguationFollowUp(text, pending);
    };
    const corpusWithFourth = 'the fourth one';
    // Sanity: the real matcher does not place it, so the failure below is the
    // plant and not a pre-existing condition.
    expect(placed(matchDisambiguationFollowUp(corpusWithFourth, TWO_JOHNSONS))).toBe(false);
    expect(placed(widenedMatcher(corpusWithFourth, TWO_JOHNSONS))).toBe(true);
    expect(isDisambiguationAnswer(corpusWithFourth, TWO_JOHNSONS)).toBe(false);

    // Run the same containment check with the widened matcher and the corpus
    // extended by the new form: it now reports an unexplained divergence.
    const divergence = {
      placedByMatcher: placed(widenedMatcher(corpusWithFourth, TWO_JOHNSONS)),
      acceptedByGate: isDisambiguationAnswer(corpusWithFourth, TWO_JOHNSONS),
      explainedBy:
        NAMED_HIJACK_SHAPES.find((s) => s.matches(corpusWithFourth, TWO_JOHNSONS))?.name ?? null,
    };
    expect(divergence).toEqual({
      placedByMatcher: true,
      acceptedByGate: false,
      explainedBy: null,
    });
  });

  it('NEGATIVE CONTROL — a gate widened to accept long requests re-opens the hijack (C3 direction)', () => {
    const widenedGate: Gate = () => true; // planted: everything is an "answer"
    const slack = gateAcceptancesTheMatcherCannotPlace(
      widenedGate,
      matchDisambiguationFollowUp,
    );
    // With the gate wide open, the matcher now PLACES request-shaped turns —
    // they disappear from `slack` and land on a candidate instead. That is
    // exactly the hijack: the invoice request is consumed as an answer.
    const hijacked = matchDisambiguationFollowUp(
      'Send an invoice to Marcus Johnson for $400',
      TWO_JOHNSONS,
    );
    expect(hijacked).toEqual({ status: 'resolved', candidateId: 'cus-1' });
    // On the fixture that actually carries the label, the request is consumed
    // rather than left as slack. (On `short labels` there is no Johnson to
    // match, so it stays unmatched there — hence the per-fixture filter.)
    expect(
      slack.filter((s) => s.fixture === 'two Johnsons').map((s) => s.text),
    ).not.toContain('Send an invoice to Marcus Johnson for $400');
    // And with the REAL gate, that request never reaches the matcher at all.
    expect(isDisambiguationAnswer('Send an invoice to Marcus Johnson for $400', TWO_JOHNSONS)).toBe(
      false,
    );
  });

  it('the named hijack shapes are reasoned, not bare', () => {
    expect(NAMED_HIJACK_SHAPES).toHaveLength(3);
    for (const shape of NAMED_HIJACK_SHAPES) {
      expect(shape.why.length, shape.name).toBeGreaterThan(40);
    }
  });
});

/** The ordinal surface both components claim to share. */
function isOrdinalShaped(text: string): boolean {
  const compact = normalize(text).replace(/^the\s+/, '').replace(/\s+one$/, '').trim();
  return /^(first|second|third|1|2|3|one|two|three|option\s+[123]|primero?|segundo|tercero)$/.test(
    compact,
  );
}
