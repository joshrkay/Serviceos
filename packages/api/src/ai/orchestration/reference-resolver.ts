/**
 * Pronoun / cross-turn reference rewriter.
 *
 * Runs BEFORE the intent classifier. When the current transcript
 * refers to an entity via a pronoun ("send it to him", "cancel that
 * one"), this stage rewrites the transcript with the concrete
 * referent pulled from the most recent proposal in the same
 * conversation. The classifier then sees "send invoice INV-0042 to
 * Rodriguez" instead of "send it to him" and routes cleanly.
 *
 * Design choice: pure deterministic rewriter, no LLM call. Keeping
 * this free of the gateway means the router doesn't make two
 * LLM calls per turn — the classifier is the single LLM round-trip.
 * The rewriter ONLY fires when pronouns actually appear; otherwise
 * it returns the transcript unchanged.
 *
 * Scope:
 *   - Subject pronouns and proforms: "it", "that", "that one", "this"
 *   - Person pronouns (non-gendered handling): "them", "him", "her"
 *   - Direct "the X" references match a referent of kind X from the
 *     last turn (e.g., "the invoice", "the appointment").
 *
 * What it does NOT do:
 *   - Possessive chains ("his invoice")
 *   - Plural referents ("both of them")
 *   - Cross-conversation referents
 * These stay as-is and either classify cleanly or fall into
 * voice_clarification like any other ambiguous transcript.
 */

export interface ConversationReferent {
  /**
   * The most recent proposal-like action the operator took in this
   * conversation. Rewriting prefers the most-recent referent of a
   * matching kind over older ones.
   */
  proposalType: string;
  /** Key entity labels from the prior proposal, used to rewrite. */
  customerName?: string;
  invoiceReference?: string;
  estimateReference?: string;
  appointmentReference?: string;
  jobReference?: string;
  createdAt: Date;
}

export interface ReferenceResolverContext {
  /** Recent proposals, most recent first. */
  recentReferents: ConversationReferent[];
}

export interface ResolutionResult {
  /** Rewritten transcript (or original if no pronouns fired). */
  transcript: string;
  /** True when at least one substitution was made. */
  rewrote: boolean;
  /** Debug trail — which pronoun was replaced with what. */
  substitutions: Array<{ pronoun: string; replacement: string }>;
}

// Whole-word match only; case-insensitive. Word boundaries keep us
// from mangling "hit", "itemize", etc.
const PRONOUN_PATTERNS = {
  it: /\b(it|that|that one|this)\b/i,
  person: /\b(them|him|her)\b/i,
  theInvoice: /\bthe invoice\b/i,
  theEstimate: /\b(the estimate|the quote)\b/i,
  theAppointment: /\b(the appointment|the job)\b/i,
};

function pickMostRecent(
  referents: ConversationReferent[],
  matcher: (r: ConversationReferent) => string | undefined
): string | undefined {
  for (const r of referents) {
    const value = matcher(r);
    if (value) return value;
  }
  return undefined;
}

export function resolveReferences(
  transcript: string,
  context: ReferenceResolverContext
): ResolutionResult {
  const substitutions: ResolutionResult['substitutions'] = [];
  let result = transcript;

  if (!context.recentReferents || context.recentReferents.length === 0) {
    return { transcript, rewrote: false, substitutions };
  }

  // "the invoice" → most recent invoiceReference
  if (PRONOUN_PATTERNS.theInvoice.test(result)) {
    const ref = pickMostRecent(context.recentReferents, (r) => r.invoiceReference);
    if (ref) {
      const replacement = `invoice ${ref}`;
      result = result.replace(PRONOUN_PATTERNS.theInvoice, replacement);
      substitutions.push({ pronoun: 'the invoice', replacement });
    }
  }

  // "the estimate" / "the quote" → most recent estimateReference
  if (PRONOUN_PATTERNS.theEstimate.test(result)) {
    const ref = pickMostRecent(context.recentReferents, (r) => r.estimateReference);
    if (ref) {
      const replacement = `estimate ${ref}`;
      result = result.replace(PRONOUN_PATTERNS.theEstimate, replacement);
      substitutions.push({ pronoun: 'the estimate', replacement });
    }
  }

  // "the appointment" / "the job" → most recent appointmentReference or jobReference
  if (PRONOUN_PATTERNS.theAppointment.test(result)) {
    const ref = pickMostRecent(
      context.recentReferents,
      (r) => r.appointmentReference ?? r.jobReference
    );
    if (ref) {
      const replacement = `appointment ${ref}`;
      result = result.replace(PRONOUN_PATTERNS.theAppointment, replacement);
      substitutions.push({ pronoun: 'the appointment', replacement });
    }
  }

  // Person pronouns (him/her/them) → most recent customerName. We do
  // this AFTER concrete "the X" rewrites because "send it to him"
  // should first resolve "it" to the invoice, then "him" to the
  // customer.
  if (PRONOUN_PATTERNS.person.test(result)) {
    const customer = pickMostRecent(context.recentReferents, (r) => r.customerName);
    if (customer) {
      result = result.replace(PRONOUN_PATTERNS.person, customer);
      substitutions.push({ pronoun: 'him/her/them', replacement: customer });
    }
  }

  // Neuter pronouns ("it", "that", "that one", "this") — fall back
  // to the most-recent referent of any kind. Order of preference
  // matches user intuition: invoice > estimate > appointment.
  if (PRONOUN_PATTERNS.it.test(result)) {
    const ref = pickMostRecent(
      context.recentReferents,
      (r) =>
        (r.invoiceReference && `invoice ${r.invoiceReference}`) ??
        (r.estimateReference && `estimate ${r.estimateReference}`) ??
        (r.appointmentReference && `appointment ${r.appointmentReference}`) ??
        (r.jobReference && `job ${r.jobReference}`)
    );
    if (ref) {
      result = result.replace(PRONOUN_PATTERNS.it, ref);
      substitutions.push({ pronoun: 'it/that/this', replacement: ref });
    }
  }

  return {
    transcript: result,
    rewrote: substitutions.length > 0,
    substitutions,
  };
}
