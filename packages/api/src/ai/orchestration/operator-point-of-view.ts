/**
 * The OPERATOR's point of view on a customer-scoped lookup answer.
 *
 * The lookup skills are shared with the live phone, where the caller IS the
 * customer, so their summaries open in the second person ("Your account is
 * paid in full"). On the operator surfaces — assistant chat and in-app voice,
 * which both answer through `lookup-dispatch.ts#dispatchAssistantLookup` — the
 * operator asks ABOUT a customer, so the answer is re-pointed at the customer
 * it is about. Before #1498 only in-app voice did this; chat answered "Your
 * account is paid in full" to "what does Morgan Tatebrook owe us?" — addressed
 * to the wrong party, and never saying which record answered. Applied once,
 * inside the one dispatch both surfaces call, the two can no longer differ.
 */
import type { CustomerRepository } from '../../customers/customer';

/**
 * Second-person openings the customer-scoped skills use, and what each
 * becomes once the LISTENER is the operator rather than the customer.
 *
 * Order matters: the negated forms are matched before the plain ones so
 * "You don't have" cannot be half-rewritten, and `Your` carries a word
 * boundary so it never eats the `You` forms.
 *
 * Everything not in this table is left EXACTLY as the skill wrote it. The
 * summaries carry money, dates and record numbers; a broad "swap pronouns"
 * regex over that is how you end up speaking a number that isn't in the
 * database. This is a copy fix, not a rewriter.
 */
const OPERATOR_VOICE_REWRITES: ReadonlyArray<{
  readonly match: RegExp;
  /** `adverb` is the captured "currently "/"still " etc., or '' when absent. */
  readonly replace: (name: string, adverb: string) => string;
}> = [
  // The adverb group is why this is a table and not four string swaps: the
  // shipped copy says "You currently owe $488.25 across 2 open invoice(s)",
  // and the verb has to inflect on the far side of the adverb.
  { match: /^You ((?:currently|now|also|still) )?don't have\b/i, replace: (n, a) => `${n} ${a}doesn't have` },
  { match: /^You ((?:currently|now|also|still) )?do not have\b/i, replace: (n, a) => `${n} ${a}does not have` },
  { match: /^You ((?:currently|now|also|still) )?have\b/i, replace: (n, a) => `${n} ${a}has` },
  { match: /^You ((?:currently|now|also|still) )?owe\b/i, replace: (n, a) => `${n} ${a}owes` },
  { match: /^Your\b/i, replace: (n) => `${n}'s` },
];

/** Sentence starts: the beginning of the summary, and after `.`/`!`/`?` + space. */
const SENTENCE_SPLIT = /(?<=[.!?]\s)/;

/**
 * Re-point a customer-scoped skill summary at the customer it is ABOUT.
 *
 * Pure and total: with no name, or a summary that opens some other way, the
 * input is returned unchanged. Rewriting happens at SENTENCE starts only, so
 * a "you" inside a sentence (a skill's advice line, a quoted note) is never
 * touched.
 */
export function speakForOperator(summary: string, customerDisplayName?: string): string {
  const name = customerDisplayName?.trim();
  if (!name) return summary;
  return summary
    .split(SENTENCE_SPLIT)
    .map((sentence) => {
      for (const { match, replace } of OPERATOR_VOICE_REWRITES) {
        if (!match.test(sentence)) continue;
        // Function replacer, not a `$1` template: a display name is tenant
        // data and could contain `$&`, which a string replacement would
        // expand into the matched text.
        return sentence.replace(match, (_full, adverb?: string) => replace(name, adverb ?? ''));
      }
      return sentence;
    })
    .join('');
}

/**
 * The name to use for the customer an answer is about.
 *
 * The resolver's own label IS the customer's `display_name` on every wired
 * resolver (PgEntityResolver selects it; AliasFirstEntityResolver reads the
 * same column), so the normal path costs no query. The repo read is the
 * fallback for a resolver that returned an id without a label, and it is
 * failure-soft: a name we cannot get means the summary is left unchanged,
 * never that the lookup fails.
 */
export async function customerDisplayName(
  customerRepo: Pick<CustomerRepository, 'findById'> | undefined,
  tenantId: string,
  resolved: { id: string; label?: string },
): Promise<string | undefined> {
  if (resolved.label) return resolved.label;
  if (!customerRepo) return undefined;
  try {
    const customer = await customerRepo.findById(tenantId, resolved.id);
    return customer?.displayName;
  } catch {
    return undefined;
  }
}
