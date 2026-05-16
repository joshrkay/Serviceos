/**
 * PII scrubber for the inbound-CSR RAG corpus (Phase 1).
 *
 * Two layers + a fail-loud gate. Both layers are deterministic; no
 * model calls. Future phases may add a learned classifier; for now we
 * intentionally lean on regex + caller-supplied known entities so the
 * behaviour is fully testable.
 *
 *   1. Entity-based redaction (most accurate when present): the caller
 *      passes the known phone numbers, names, emails, and addresses
 *      attached to the call (via the customers / service_locations /
 *      appointments tables for the inbound caller). Exact-match
 *      replacements with stable placeholders happen first so the regex
 *      sweep doesn't mangle "John Smith" by half-redacting his last
 *      name as a street suffix.
 *   2. Deterministic regex sweep: phone (E.164 + national + colloquial),
 *      email (RFC 5322 simple), street addresses (`<number> <name>
 *      <suffix>`).
 *   3. Post-scrub fail-loud gate: re-run the regex sweep on the scrubbed
 *      output plus a digit-density / entropy heuristic. If any signal
 *      trips we set `hasResidualPii = true`; callers decide whether to
 *      embed (tenant tier with `content`+`content_scrubbed` columns) or
 *      route to `pii_quarantine` (global tier — gated behind Phase 5).
 *
 * The scrubber does NOT pull from the database itself. Callers (the
 * ingestion workers landing in Phase 4a) are responsible for passing
 * the relevant entity sets. This keeps `scrub.ts` synchronous, side-
 * effect-free, and trivially testable.
 *
 * Reuses existing helpers where possible:
 *   - `maskPhone` (telephony/twilio-call-control.ts) — for the
 *     placeholder representation of redacted numbers.
 *   - `redactSecrets` (logging/redact.ts) — used out-of-band on log
 *     records, not in this path; documented here so future contributors
 *     don't reinvent it.
 */

import { maskPhone } from '../../telephony/twilio-call-control';

// ─── Types ───────────────────────────────────────────────────────────────────

export type RedactionKind =
  | 'phone'
  | 'email'
  | 'address'
  | 'name'
  | 'known_phone'
  | 'known_email'
  | 'known_name'
  | 'known_address';

export interface Redaction {
  kind: RedactionKind;
  /** The raw matched text (for audit). NEVER stored alongside the chunk; only used to drive the replacement. */
  matched: string;
  /** Placeholder substituted into the scrubbed output. */
  placeholder: string;
  /** Character offsets in the original input. Useful for downstream highlighting. */
  start: number;
  end: number;
}

export interface KnownEntities {
  phones?: readonly string[];
  emails?: readonly string[];
  names?: readonly string[];
  /** Free-form address strings; matched as substrings. */
  addresses?: readonly string[];
}

export interface ScrubOptions {
  /** Caller-supplied known PII to redact via exact match before the regex sweep. */
  knownEntities?: KnownEntities;
  /** When true, treat any residual PII signal as a hard error (caller must catch). Defaults to false (callers inspect `hasResidualPii`). */
  failOnResidual?: boolean;
}

export interface ScrubResult {
  /** Original text, unmodified. Tenant-tier callers should store this in `knowledge_chunks.content`. */
  text: string;
  /** Scrubbed text — what should be embedded. Stored in `knowledge_chunks.content_scrubbed`. */
  scrubbed: string;
  redactions: Redaction[];
  /** True if the post-scrub gate found any residual PII signal. Tenant-tier may still embed (with audit); global-tier MUST refuse. */
  hasResidualPii: boolean;
  /** Specific signals that tripped the post-scrub gate, for audit/debug. */
  residualSignals: string[];
}

// ─── Regex layer ─────────────────────────────────────────────────────────────

// E.164 (e.g. +14155550123), North-American national in several
// stylings: (415) 555-0123, 415-555-0123, 415.555.0123, 1-415-555-0123.
// The parenthesised form needs its own alternative because `(` is not a
// word character — `\b\(` doesn't match at the start of a parenthesised
// number that follows a space.
const PHONE_REGEX = new RegExp(
  [
    // E.164-ish, country code 1-3 digits then 7-15 trailing digits with
    // optional separators. Anchored at `+`.
    '\\+\\d{1,3}[\\s.-]?\\(?\\d{1,4}\\)?[\\s.-]?\\d{1,4}[\\s.-]?\\d{1,9}',
    // (415) 555-0123 / (415)555-0123
    '\\(\\d{3}\\)\\s?\\d{3}[\\s.-]?\\d{4}',
    // 1-415-555-0123 with optional leading 1, requires at least one separator
    '\\b1[\\s.-]\\d{3}[\\s.-]\\d{3}[\\s.-]\\d{4}\\b',
    // 415-555-0123 / 415.555.0123 — separator-required to avoid grabbing
    // bare 10-digit account-number-like strings (those are caught by the
    // residual-signal digit-density heuristic instead).
    '\\b\\d{3}[\\s.-]\\d{3}[\\s.-]\\d{4}\\b',
  ].join('|'),
  'g',
);

// RFC 5322 simple form. Doesn't catch every legal address but catches
// every address you'd expect from a CSR transcript.
const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Street addresses: <number> <street name> <suffix>. Suffixes drawn
// from USPS Publication 28 (common ones; the long tail is captured by
// the residual-signal heuristic).
const STREET_SUFFIXES = [
  'St', 'Street', 'Ave', 'Avenue', 'Blvd', 'Boulevard', 'Rd', 'Road',
  'Ln', 'Lane', 'Dr', 'Drive', 'Ct', 'Court', 'Pl', 'Place',
  'Ter', 'Terrace', 'Way', 'Pkwy', 'Parkway', 'Hwy', 'Highway',
  'Cir', 'Circle', 'Trl', 'Trail',
];
const ADDRESS_REGEX = new RegExp(
  `\\b\\d+\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3})\\s+(?:${STREET_SUFFIXES.join('|')})\\b\\.?`,
  'g',
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Escape a literal string for use inside a RegExp. */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace all non-overlapping occurrences of `needle` in `text` (case-
 * insensitive) and record a redaction for each. Used by the entity-based
 * pass; needle is treated as a literal, never as a regex.
 */
function replaceLiteral(
  text: string,
  needle: string,
  placeholder: string,
  kind: RedactionKind,
  redactions: Redaction[],
): string {
  if (needle.length === 0) return text;
  const re = new RegExp(escapeRegex(needle), 'gi');
  return text.replace(re, (match, offset: number) => {
    redactions.push({ kind, matched: match, placeholder, start: offset, end: offset + match.length });
    return placeholder;
  });
}

/**
 * Replace via a regex and record each match. Mutates `redactions`.
 */
function replaceRegex(
  text: string,
  re: RegExp,
  placeholder: string | ((match: string) => string),
  kind: RedactionKind,
  redactions: Redaction[],
): string {
  return text.replace(re, (match, ...rest) => {
    // The last element of `rest` is the offset (when no capture groups
    // are referenced explicitly). String.replace's callback signature.
    const offset = typeof rest[rest.length - 2] === 'number'
      ? (rest[rest.length - 2] as number)
      : (rest[rest.length - 1] as number);
    const sub = typeof placeholder === 'string' ? placeholder : placeholder(match);
    redactions.push({ kind, matched: match, placeholder: sub, start: offset, end: offset + match.length });
    return sub;
  });
}

// ─── Residual-signal heuristics (the fail-loud gate) ─────────────────────────

/**
 * If the scrubbed text still contains digit runs of ≥ 7 characters
 * that AREN'T inside an obvious placeholder, flag it. Catches account
 * numbers, card-fragment leakage ("ending in 4242 8765"), unusual
 * phone formats the regex missed, etc.
 */
const DIGIT_RUN_REGEX = /[0-9]{7,}/g;

/**
 * Detects strings that look like 4+ all-caps tokens, which often
 * indicate full names dictated to the agent ("MY NAME IS JOHN ANDREW
 * SMITH") that the entity-based pass missed because the customer
 * record lists them in title case.
 */
const ALL_CAPS_NAME_REGEX = /\b[A-Z]{2,}\s+[A-Z]{2,}\s+[A-Z]{2,}\b/g;

function testRegex(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  const matched = re.test(text);
  re.lastIndex = 0;
  return matched;
}

function detectResidualPii(scrubbed: string): string[] {
  const signals: string[] = [];

  // Strip out our own placeholders before checking digit runs so we
  // don't false-positive on `[CALLER_PHONE]` etc. Placeholders are
  // bracketed literals.
  const placeholderless = scrubbed.replace(/\[[A-Z_]+\]/g, '');

  if (testRegex(DIGIT_RUN_REGEX, placeholderless)) {
    signals.push('digit_run_ge_7');
  }
  if (testRegex(ALL_CAPS_NAME_REGEX, placeholderless)) {
    signals.push('all_caps_name_run');
  }
  if (testRegex(PHONE_REGEX, placeholderless)) {
    signals.push('residual_phone_match');
  }
  if (testRegex(EMAIL_REGEX, placeholderless)) {
    signals.push('residual_email_match');
  }
  // ADDRESS_REGEX runs after the entity pass — anything caught here is a real residual.
  if (testRegex(ADDRESS_REGEX, placeholderless)) {
    signals.push('residual_address_match');
  }

  return signals;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Scrub PII from `text`. Pure function — no I/O, no side effects.
 *
 * Recommended usage:
 *   - Tenant tier: persist BOTH the original `text` (in
 *     `knowledge_chunks.content`) AND `scrubbed` (in `content_scrubbed`).
 *     Embed `scrubbed`. RLS keeps the raw content tenant-isolated.
 *   - Global tier (Phase 5+): refuse insertion if `hasResidualPii` is
 *     true; route to `pii_quarantine` for human audit.
 */
export function scrubPii(text: string, opts: ScrubOptions = {}): ScrubResult {
  const redactions: Redaction[] = [];
  let working = text;

  // ── Layer 1: entity-based ──────────────────────────────────────────────────
  const entities = opts.knownEntities ?? {};
  for (const phone of entities.phones ?? []) {
    working = replaceLiteral(working, phone, '[CALLER_PHONE]', 'known_phone', redactions);
    // Also replace the masked form if logging has already partially redacted.
    const masked = maskPhone(phone);
    if (masked && masked !== phone) {
      working = replaceLiteral(working, masked, '[CALLER_PHONE]', 'known_phone', redactions);
    }
  }
  for (const email of entities.emails ?? []) {
    working = replaceLiteral(working, email, '[CALLER_EMAIL]', 'known_email', redactions);
  }
  for (const name of entities.names ?? []) {
    working = replaceLiteral(working, name, '[CALLER_NAME]', 'known_name', redactions);
  }
  for (const address of entities.addresses ?? []) {
    working = replaceLiteral(working, address, '[CALLER_ADDRESS]', 'known_address', redactions);
  }

  // ── Layer 2: regex sweep ───────────────────────────────────────────────────
  // Order matters: address before phone, since address contains a digit
  // prefix that could otherwise be partially matched as a phone.
  working = replaceRegex(working, ADDRESS_REGEX, '[ADDRESS]', 'address', redactions);
  working = replaceRegex(working, EMAIL_REGEX, '[EMAIL]', 'email', redactions);
  working = replaceRegex(working, PHONE_REGEX, '[PHONE]', 'phone', redactions);

  // ── Layer 3: post-scrub gate ───────────────────────────────────────────────
  const residualSignals = detectResidualPii(working);
  const hasResidualPii = residualSignals.length > 0;

  if (hasResidualPii && opts.failOnResidual) {
    throw new Error(
      `scrubPii: residual PII detected (${residualSignals.join(', ')}) and failOnResidual is set`,
    );
  }

  return {
    text,
    scrubbed: working,
    redactions,
    hasResidualPii,
    residualSignals,
  };
}
