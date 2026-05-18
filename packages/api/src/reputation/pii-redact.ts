/**
 * P7-026 PR b — Content-level PII redactor for free-form review text.
 *
 * Distinct from `packages/api/src/logging/redact.ts` (key-pattern
 * infra-redactor for object/JSON structures). This module operates on
 * raw user-authored strings — Google review comments, draft responses,
 * etc. — and replaces identifiable tokens with stable placeholders so
 * downstream LLM prompts and audit logs never carry full PII.
 *
 * Design contract: the redactor is DETERMINISTIC and IDEMPOTENT.
 *   redactPii(redactPii(text)) === redactPii(text)
 *
 * This is critical because PR c may run the redactor twice (once on
 * intake, once before LLM submission) and we MUST NOT compound
 * placeholders or accidentally redact the placeholders themselves.
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
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// US phone with optional country code, parens, dashes, dots, spaces.
const US_PHONE_RE = /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g;
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
 * Redact PII tokens from a free-form text string.
 *
 * Idempotency note: each pass uses placeholders like `[email]` that
 * contain characters (`[`, `]`) which none of the other patterns can
 * match. Re-running the function on its own output is therefore a
 * no-op for already-redacted spans.
 */
export function redactPii(text: string, options: RedactPiiOptions = {}): string {
  const {
    redactEmails = true,
    redactPhones = true,
    redactAddresses = true,
    redactLastNames = true,
    preserveKnownFirstNames = [],
  } = options;

  if (!text) return text;

  let result = text;

  // 1. Emails first — they contain "@" and "." that could otherwise
  // confuse later passes (e.g. "a.b@c.com" looks salutation-adjacent).
  if (redactEmails) {
    result = result.replace(EMAIL_RE, EMAIL_PLACEHOLDER);
  }

  // 2. Phones — international (leading +) first so longer matches win
  // before the US regex eats the last 10 digits of a +44 number and
  // strands "+44" in the output. US format runs second.
  if (redactPhones) {
    result = result.replace(INTL_PHONE_RE, PHONE_PLACEHOLDER);
    result = result.replace(US_PHONE_RE, PHONE_PLACEHOLDER);
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
