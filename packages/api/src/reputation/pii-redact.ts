/**
 * P7-026 PR b — Content-level PII redactor for free-form review text.
 *
 * Distinct from `packages/api/src/logging/redact.ts` (key-pattern
 * infra-redactor for object/JSON structures). This module operates on
 * raw user-authored strings — Google review comments, draft responses,
 * etc. — and replaces identifiable tokens with stable placeholders so
 * downstream LLM prompts and audit logs never carry full PII.
 *
 * Design contract: the redactor is DETERMINISTIC, and its placeholders are
 * INERT — `[email]`, `[phone]`, `[address]` and `[name]` contain `[` and `]`,
 * which no pattern in this module can match, so a span already replaced is
 * untouchable on every later pass. That is what PR c needs: running the
 * redactor twice (once on intake, once before LLM submission) never compounds
 * placeholders or redacts the placeholders themselves.
 *
 * Inert placeholders are NOT idempotence, and the stronger claim this comment
 * used to make —
 *
 *     redactPii(redactPii(text)) === redactPii(text)
 *
 * — is FALSE. A second pass can redact MORE (never less; see below). Two
 * shapes do it, both pre-existing and both independent of the email rule's
 * scanner rewrite:
 *
 *   1. ABUTTING emails. A match may not start before the end of the previous
 *      one, so a second address inside the same unbroken word-character run
 *      has no position at which `\b` can fire:
 *          x@y.io4155552671foo@bar.com
 *       -> [email]4155552671foo@bar.com   <- raw second address survives
 *       -> [email][email]
 *      The phone pass does not rescue it: `4155552671` is followed by `f`, so
 *      `US_PHONE_RE`'s trailing `\b` fails.
 *   2. Long DIGIT runs. That same trailing `\b` means the only place a US
 *      phone can END inside a 10,000-digit run is the run's end, so one pass
 *      consumes the last ten digits and no more. An n-digit run needs n/10
 *      passes and does NOT converge in a bounded number of them.
 *
 * Callers that must not emit partially-redacted text apply this function
 * REPEATEDLY — `redactPiiRepeatedly` below, which the reputation draft
 * composers use, and the equivalent loop in `redactedExecutionErrorCause`
 * (proposals/proposal.ts). Both CAP the iteration count, because of shape 2.
 *
 * The one property every pass does guarantee, and the one the callers rely
 * on, is MONOTONICITY: a pass only ever turns raw spans into placeholders and
 * can never turn a placeholder back into raw text, so pass k+1 is redacted at
 * least as much as pass k. Stopping early is safe; stopping early is not
 * complete.
 *
 * The order of operations matters: emails first (they contain dots and
 * could confuse address/name detection), then phones, then addresses,
 * then last names (most heuristic). Each pass runs against the output
 * of the previous pass, so later patterns never see tokens already
 * replaced.
 */

export interface RedactPiiOptions {
  /** Redact last names after a salutation or in FirstName-LastName patterns. Default true. */
  redactLastNames?: boolean;
  /** Redact US-format street addresses. Default true. */
  redactAddresses?: boolean;
  /** Redact phone numbers (US and international). Default true. */
  redactPhones?: boolean;
  /**
   * Require a US number to carry a separator, parentheses, or a `+1`
   * country code — a BARE 10/11-digit run then stays readable. Default
   * false (the review-text behavior: in a customer's prose a bare
   * `5551234567` is a phone number and redacting it is correct).
   *
   * Opt in when the text is machine-generated diagnostics rather than
   * prose, where a bare digit run is far more likely to be integer cents,
   * an epoch-millis timestamp, or an int4 bound than a phone number
   * (see `redactedExecutionErrorCause`, proposals/proposal.ts). Redacting
   * those destroys the only field that carries the diagnosis:
   * `amount 1234567890 exceeds int4 range 2147483647` becomes
   * `amount [phone] exceeds int4 range [phone]`.
   */
  requireSeparatedPhones?: boolean;
  /** Redact email addresses. Default true. */
  redactEmails?: boolean;
  /**
   * First names to preserve in addition to the built-in common-names
   * list. PR c passes the matched customer's first name here so we
   * keep "Hi Alice, ..." readable in draft responses while still
   * stripping their last name.
   */
  preserveKnownFirstNames?: string[];
}

const EMAIL_PLACEHOLDER = '[email]';
const PHONE_PLACEHOLDER = '[phone]';
const ADDRESS_PLACEHOLDER = '[address]';
const NAME_PLACEHOLDER = '[name]';

/**
 * Curated list of common English first names — kept small on purpose.
 * We err on the side of NOT redacting a first name when we're not sure
 * it's a name (false positives are worse than false negatives here:
 * a redacted "Mary" inside the phrase "I had a Mary little lamb"
 * isn't catastrophic, but redacting half of every paragraph would
 * gut review-text usability).
 *
 * If a name isn't on this list, the LastName-after-FirstName heuristic
 * won't fire — but the salutation heuristic ("Mr./Ms./Mrs./Dr. X")
 * still catches the surname regardless of first-name knowledge.
 */
const COMMON_FIRST_NAMES = new Set([
  'alice', 'bob', 'carol', 'charles', 'dave', 'david', 'emma', 'frank',
  'grace', 'henry', 'irene', 'jack', 'james', 'jane', 'jen', 'jennifer',
  'john', 'jonathan', 'joseph', 'josh', 'joshua', 'karen', 'kate', 'kevin',
  'laura', 'linda', 'lisa', 'mark', 'mary', 'matt', 'matthew', 'michael',
  'mike', 'nancy', 'nick', 'nicholas', 'olivia', 'pam', 'paul', 'peter',
  'rachel', 'robert', 'rob', 'sam', 'samuel', 'sara', 'sarah', 'steve',
  'steven', 'sue', 'susan', 'tom', 'thomas', 'tony', 'victoria', 'will',
  'william',
]);

// Emails — RFC-ish, good enough for free-form text.
//
// This rule is expressed as a scanner (`replaceEmails`) rather than a single
// `String.replace(regex, …)`. It is EXACTLY EQUIVALENT to the regex it
// replaces —
//
//     /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
//
// — byte for byte, but runs in linear time instead of quadratic. Both halves
// of that sentence matter, so both are pinned by tests.
//
// WHY THE REGEX HAD TO GO (ReDoS). `\b` sits between a word and a non-word
// character, but the local-part class straddles that line: `.`, `%`, `+` and
// `-` are non-word characters INSIDE the class. So in a run like `a.a.a.a.…`
// EVERY character is a legal place for `\b` to fire — O(n) match starts
// inside ONE token — and `[local]+` rescans the rest of the run from each of
// them. That is O(n²), and it needs no `@` anywhere in the input. Measured
// through `redactPii`: 64KB of `('a.'×n/2) + '@' + ('b'×n)` took ~2.4s, a
// clean 4x per doubling, and plain `'a.'×n` with no `@` at all cost the same.
// `redactPii` runs on `review.commentText` and on LLM output, neither of
// which this service length-bounds, on the Express event loop.
//
// Restructuring the DOMAIN — the `(?:[A-Za-z0-9-]+\.)+` shape a reviewer
// proposed — does not help: the cost is the restart across the LOCAL part,
// which is why the two shapes above fire with the domain empty or absent. JS
// has no atomic groups, and emulating one with `(?=(…))\1` would not help
// either: it removes the give-back steps but not the O(n) forward scan that
// each of the O(n) starts performs.
//
// NO TRAILING `\b`, as before. It used to be there and it was a LEAK: `\b`
// after the TLD means an email immediately followed by a word character never
// matches at all — `jane.doe@example.com4155552671` (a Postgres
// unique-constraint `DETAIL: Key (contact)=(…)` over a concatenated column)
// and `jane.doe@example.com2026-08-09T12:00:00Z` both sailed through whole.
// The TLD class is letters-only, so the match still ends at the last letter
// run after the final dot.

/** Domain half, sticky so it can be applied at one exact offset. */
const EMAIL_DOMAIN_RE = /[A-Za-z0-9.-]+\.[A-Za-z]{2,}/y;

/** `[A-Za-z0-9._%+-]` — the local-part class, by char code. */
function isEmailLocalCode(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) || // 0-9
    code === 46 || // .
    code === 95 || // _
    code === 37 || // %
    code === 43 || // +
    code === 45 // -
  );
}

/**
 * `\w` — what `\b` is defined in terms of. NaN (from `charCodeAt` past
 * either end of the string) fails every comparison, which is exactly the
 * "off the end counts as non-word" rule `\b` uses.
 */
function isWordCode(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 95
  );
}

/**
 * Replace every email in `text` with `[email]`, in one linear pass.
 *
 * The equivalence argument, which is why this is safe to swap in under a PII
 * control. For a match starting at `p`, the greedy `[local]+` runs to the end
 * of `p`'s local-part run — call it `m` — and `@` must then match at `m`; any
 * shorter local part would need `@` at a position holding a local-part
 * character, which is impossible. So:
 *
 *   - the local part is always the whole run from `p` to the next `@`, and
 *   - whether the domain matches depends only on `m`, never on `p`.
 *
 * Every start position inside one run therefore succeeds or fails together,
 * and the regex's leftmost-match rule just picks the smallest `p` in the run
 * at which `\b` holds. That makes the `@` the natural thing to iterate: find
 * each `@`, walk back over its local-part run, take the leftmost `\b` in it,
 * and match the domain once. Because `@` is in neither the local-part class
 * nor the domain class, the runs belonging to distinct `@`s are disjoint, so
 * the total work is linear in the length of the text.
 *
 * `pos` carries the regex's `lastIndex`: a match may not start before the end
 * of the previous one. `\b` itself is still evaluated against the ORIGINAL
 * string on both sides of the position, exactly as the engine did.
 *
 * Verified by differential fuzzing against the original regex over 3.2M
 * generated strings (four fragment alphabets, including abutting emails and
 * dense local-class punctuation soup): zero output differences.
 */
function replaceEmails(text: string): string {
  let out = '';
  let pos = 0;
  let at = text.indexOf('@');
  while (at !== -1) {
    // Local-part run, clipped at `pos` — a match cannot start before it.
    let lo = at;
    while (lo > pos && isEmailLocalCode(text.charCodeAt(lo - 1))) lo--;

    let start = -1;
    let end = -1;
    if (lo < at) {
      EMAIL_DOMAIN_RE.lastIndex = at + 1;
      const domain = EMAIL_DOMAIN_RE.exec(text);
      if (domain) {
        for (let p = lo; p < at; p++) {
          if (isWordCode(text.charCodeAt(p - 1)) !== isWordCode(text.charCodeAt(p))) {
            start = p;
            end = at + 1 + domain[0].length;
            break;
          }
        }
      }
    }

    if (start === -1) {
      at = text.indexOf('@', at + 1);
      continue;
    }
    out += text.slice(pos, start) + EMAIL_PLACEHOLDER;
    pos = end;
    // The domain class excludes `@`, so the next candidate is at or after
    // `pos`; no `@` can hide inside the span just consumed.
    at = text.indexOf('@', pos);
  }
  return pos === 0 ? text : out + text.slice(pos);
}

// US phone with optional country code, parens, dashes, dots, spaces.
const US_PHONE_RE = /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g;
// Same shape, but every optional separator is mandatory in at least one
// position: the number must carry `(`/`)`, a `-`/`.`/space, or a `+1`
// prefix. A bare 10- or 11-digit run therefore does NOT match. The leading
// `(?<![0-9])` stops the pattern from starting mid-run and clipping a long
// integer. See `RedactPiiOptions.requireSeparatedPhones`.
const US_PHONE_SEPARATED_RE =
  /(?<![0-9])(?:\+?1[-.\s])?(?:\([0-9]{3}\)[-.\s]?|[0-9]{3}[-.\s])[0-9]{3}[-.\s][0-9]{4}\b/g;
// International phone: +<country><7-15 digits>. Restricted to leading + so we
// don't double-match a US number already caught above.
const INTL_PHONE_RE = /\+[0-9]{7,15}\b/g;

// US-style street addresses. The trailing street-type keyword is what
// makes this safe to apply over free-form text without nuking every
// numbered list ("1. Buy milk" won't trigger).
const ADDRESS_RE = /\b\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)\b\.?/g;

// Salutation + capitalized surname. We capture the full title-with-
// optional-period so the replacement preserves "Mr." vs "Mr" exactly
// as written. Trailing period optional ("Mr Smith" and "Mr. Smith"
// both fire).
const SALUTATION_RE = /\b(Mr\.?|Ms\.?|Mrs\.?|Dr\.?|Mister|Miss|Misses|Doctor)\s+([A-Z][a-z]+)\b/g;

// FirstName LastName — two consecutive Capitalized words. We only
// redact the LastName when FirstName matches a known-first-name list
// or the caller-supplied preserve list, to keep false-positive rate
// low.
const FIRST_LAST_RE = /\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/g;

/**
 * Redact PII tokens from a free-form text string. ONE pass.
 *
 * Placeholder-inertness note: each pass uses placeholders like `[email]`
 * that contain characters (`[`, `]`) which none of the other patterns can
 * match. Re-running the function on its own output is therefore a
 * no-op for already-redacted spans.
 *
 * It is NOT a no-op for the whole string: one pass can leave raw PII that a
 * further pass removes (abutting emails, long digit runs — see the module
 * header). Callers that must not emit partially-redacted text want
 * `redactPiiRepeatedly` instead.
 */
export function redactPii(text: string, options: RedactPiiOptions = {}): string {
  const {
    redactEmails = true,
    redactPhones = true,
    requireSeparatedPhones = false,
    redactAddresses = true,
    redactLastNames = true,
    preserveKnownFirstNames = [],
  } = options;

  if (!text) return text;

  let result = text;

  // 1. Emails first — they contain "@" and "." that could otherwise
  // confuse later passes (e.g. "a.b@c.com" looks salutation-adjacent).
  if (redactEmails) {
    result = replaceEmails(result);
  }

  // 2. Phones — international (leading +) first so longer matches win
  // before the US regex eats the last 10 digits of a +44 number and
  // strands "+44" in the output. US format runs second.
  if (redactPhones) {
    result = result.replace(INTL_PHONE_RE, PHONE_PLACEHOLDER);
    result = result.replace(
      requireSeparatedPhones ? US_PHONE_SEPARATED_RE : US_PHONE_RE,
      PHONE_PLACEHOLDER,
    );
  }

  // 3. Street addresses — the digit-prefix + street-type-suffix shape
  // is specific enough that idempotency holds (the placeholder
  // `[address]` has no leading digits).
  if (redactAddresses) {
    result = result.replace(ADDRESS_RE, ADDRESS_PLACEHOLDER);
  }

  // 4. Last names — two passes:
  //   (a) Salutation-anchored ("Mr Smith") — surname only, keep title.
  //   (b) FirstName-LastName where FirstName is recognized.
  if (redactLastNames) {
    result = result.replace(SALUTATION_RE, (_match, title: string, _surname: string) => {
      // Preserve original "Mr." vs "Mr" — the title capture group
      // includes the optional trailing period.
      return `${title} ${NAME_PLACEHOLDER}`;
    });

    const preserveSet = new Set<string>(
      preserveKnownFirstNames.map((n) => n.toLowerCase()),
    );

    result = result.replace(FIRST_LAST_RE, (match, first: string, last: string) => {
      const firstLower = first.toLowerCase();
      // Only redact if we're confident the first token is a name.
      if (COMMON_FIRST_NAMES.has(firstLower) || preserveSet.has(firstLower)) {
        return `${first} ${NAME_PLACEHOLDER}`;
      }
      return match;
    });
  }

  return result;
}

/**
 * Iteration cap for `redactPiiRepeatedly`.
 *
 * WHY THERE IS A CAP AT ALL, and why it is small. `redactPii` does NOT always
 * reach a fixed point: `US_PHONE_RE` ends in `\b`, and inside a run of n
 * digits the only word boundary is the run's end, so each pass eats the last
 * ten digits and n/10 passes are needed. Measured through this loop with the
 * cap removed, on `'4155552671'.repeat(n/10)`:
 *
 *     len  1,000 ->   100 passes,    1ms      (one pass: <1ms)
 *     len  4,000 ->   400 passes,   21ms
 *     len 16,000 -> 1,600 passes,  326ms
 *     len 32,000 -> 3,200 passes, 1290ms
 *
 * — a clean 4x per doubling. An UNCAPPED loop here is therefore quadratic in
 * the input, which is the exact defect class the email scanner rewrite
 * removed, on the exact same unbounded attacker-authored input
 * (`review.commentText`), on the same Express event loop. The cap is what
 * keeps the loop linear: worst-case work is MAX_REDACT_PII_PASSES times one
 * linear pass, full stop.
 *
 * WHY 4. The defect this loop exists to fix is ABUTTING EMAILS (module
 * header, shape 1), and the email rule DOES converge: over 300,000 generated
 * strings across the three differential-corpus alphabets, plus abutting-email
 * chains up to 512 addresses long, the worst case was 2 productive passes.
 * Four gives that a pass of headroom and still bounds the work at 4x linear.
 *
 * Raising this number is not free — it multiplies the worst-case cost of
 * every reputation draft by the same factor. The budget test in
 * test/reputation/pii-redact.test.ts is what holds that line.
 */
export const MAX_REDACT_PII_PASSES = 4;

/**
 * Apply `redactPii` until it stops changing the text, or until
 * `MAX_REDACT_PII_PASSES` passes have run — whichever comes first.
 *
 * Use this, not bare `redactPii`, anywhere partially-redacted output would
 * escape the process: into an LLM provider's context, into a persisted draft,
 * into anything a third party can read. One pass is not enough (module
 * header): abutting emails leave the second address raw.
 *
 * WHAT HAPPENS IF THE CAP IS REACHED. The text returned is the output of the
 * last pass that ran, which by the monotonicity property in the module header
 * is redacted AT LEAST AS MUCH as any earlier pass and strictly more than the
 * single pass these callers used to do. So exhausting the cap can never
 * produce a worse result than the previous behaviour — it degrades toward
 * "not yet finished", never toward "leaked something one pass would have
 * caught".
 *
 * The cap is genuinely reachable — a ~40-digit run in a review comment does
 * it — so this is a real branch, not a defensive one, and it is deliberately
 * NOT an exception. `review.commentText` is authored by whoever left the
 * Google review; throwing here would let any reviewer kill the drafting
 * pipeline by typing digits. The residual in that case is a partially
 * redacted DIGIT RUN, never a raw email address: shape 1 converges within the
 * cap and shape 2 is the only non-converging shape. Both facts are pinned by
 * tests in test/reputation/pii-redact.test.ts.
 */
export function redactPiiRepeatedly(
  text: string,
  options: RedactPiiOptions = {},
): string {
  let out = text;
  for (let pass = 0; pass < MAX_REDACT_PII_PASSES; pass++) {
    const next = redactPii(out, options);
    if (next === out) break;
    out = next;
  }
  return out;
}
