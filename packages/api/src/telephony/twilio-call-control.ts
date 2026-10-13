/**
 * Twilio call-control surface used by the calling agent's escalation path.
 *
 * `TwilioCallControl` is the seam between the channel-agnostic
 * `escalate-to-human` skill (which picks the next dispatcher off the
 * rotation) and the Twilio TwiML the adapter writes back on a webhook
 * response. The interface lives here so tests can supply a stub
 * implementation without touching the live Twilio SDK or the network.
 *
 * The real implementation (`DefaultTwilioCallControl`) only emits
 * TwiML strings — it never makes outbound REST calls of its own.
 * Twilio drives the dial sequence by POSTing back to the `action` URL
 * with `DialCallStatus` once the `<Dial>` verb completes (answered,
 * no-answer, busy, failed). The `/api/telephony/dial-result` route
 * (P8-013) consumes those callbacks and advances the rotation.
 *
 * Phone-number safety
 * ───────────────────
 * `dispatcherPhone` is treated as PII. The implementation refuses to
 * log the full E.164 number; if any branch needs to log a number
 * (debug, audit metadata) it MUST go through `maskPhone()`. The risk
 * note in the dispatch block ("phone numbers leak via logs") is
 * enforced here, not just at the route layer.
 */

import { xmlEscape } from './twilio-adapter';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Per-session cursor tracking which rotation entry was last attempted. */
export interface RotationCursor {
  /** Index into `OnCallRepository.listRotation` entries. */
  index: number;
  /** Number of entries the cursor has stepped through. */
  attempts: number;
}

/** Options accepted by `dialDispatcher`. */
export interface DialDispatcherOptions {
  /**
   * Absolute (or absolute-ish) URL Twilio POSTs once the `<Dial>` verb
   * finishes. Must include a query string the adapter can use to
   * recover the session — e.g. `?sid=<sessionId>`. Required.
   */
  actionUrl: string;
  /**
   * Caller-id displayed to the dispatcher's phone. Defaults to omitted
   * (Twilio uses the inbound `To` number, which is usually correct).
   */
  callerId?: string;
  /**
   * Seconds Twilio waits before treating the dial as no-answer. v1 uses
   * 20s per the story spec.
   */
  timeoutSeconds?: number;
  /**
   * Absolute URL Twilio fetches when the dispatcher answers, before
   * connecting the caller. The returned TwiML plays in the dispatcher's
   * ear only (whisper). The caller hears ring/hold during this window.
   *
   * If omitted, no whisper is played and `<Number>` has no `url=`
   * attribute — preserving backward-compatibility.
   *
   * The value is XML-escaped before insertion into the TwiML document.
   */
  whisperUrl?: string;
  /**
   * Round-3 review of #1676 — press-1 SCREEN this leg (default OFF). Set by
   * the EMERGENCY-CLASS producers only (E2/emergency escalations, the P12-004
   * immediate dial, the vulnerable-caller patches, and the /dial-result
   * cascade of a screened leg): a carrier voicemail must never "answer" an
   * emergency and silence the page ladder. The leg's `<Number url>` becomes a
   * session-bound screen and the action is marked `screen=1`, so /dial-result
   * requires the keypress before it stamps `transferred`. Unset, the Dial is
   * byte-for-byte what it always was (ordinary transfers to IVR-fronted
   * numbers / untrained receptionists keep working).
   */
  screen?: boolean;
}

/**
 * Channel-agnostic call-control seam. The Twilio adapter holds one
 * instance of this; tests pass a stub.
 */
export interface TwilioCallControl {
  /**
   * Produce a TwiML `<Dial>` verb that connects the active call leg
   * (identified by `callSid`) to `dispatcherPhone`. The returned
   * string is a complete `<Response>` document the adapter can hand
   * back to Twilio as the webhook response.
   *
   * The verb sets `action` so Twilio POSTs the dial result back to
   * the route specified by `opts.actionUrl`; the route then advances
   * the rotation via `recordDialResult`.
   */
  dialDispatcher(
    callSid: string,
    dispatcherPhone: string,
    opts: DialDispatcherOptions,
  ): string;

  /**
   * Read the current per-session rotation cursor. Returns
   * `{index: 0, attempts: 0}` when the session has no recorded cursor
   * yet (first dispatcher in the rotation has not yet been dialed).
   */
  getCursor(sessionId: string): RotationCursor;

  /** Move the cursor forward by one rotation entry. */
  advanceCursor(sessionId: string): RotationCursor;

  /**
   * Record that a rotation entry at `scannedIndex` has been chosen so
   * subsequent walks resume past it. Necessary when earlier entries are
   * skipped (no resolvable phone) — `advanceCursor` alone only bumps `+1`
   * from the stored value and could redial the same dispatcher.
   */
  setCursorAfter(sessionId: string, scannedIndex: number): RotationCursor;

  /** Drop any cursor state for the session (call ended / cleanup). */
  clearCursor(sessionId: string): void;
}

// ─── Phone-number masking ────────────────────────────────────────────────────

/**
 * Mask the middle digits of an E.164 phone number for safe logging.
 * Leaves the country-code prefix and the last 4 digits intact so an
 * operator can spot the right line in dispatch records.
 *
 * Examples:
 *   +15125550100 → +1***0100
 *   +442012345678 → +44***5678
 *
 * Returns the input unchanged if it doesn't look like a phone number;
 * never throws.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '<unknown>';
  const trimmed = String(phone).trim();
  if (trimmed.length < 6) return '****';
  // Map well-known country-code lengths so US (+1, 1 digit) and UK
  // (+44, 2 digits) both mask the right amount of body. ITU-T E.164
  // country codes range 1–3 digits, but the common Tier-1 codes the
  // app sees are limited; we explicitly test for the longer codes
  // first so the +1 fallback doesn't grab the leading body digits.
  const e164 = trimmed.match(/^\+(\d+)$/);
  if (e164) {
    const digits = e164[1];
    if (digits.length >= 8) {
      // Determine country-code length: 3 if it begins with a known 3-digit
      // prefix (e.g. +1xx, +35x for some EU codes), 2 if it begins with a
      // known 2-digit prefix (e.g. +44, +33), else default to 1.
      const TWO_DIGIT_PREFIXES = new Set([
        '20', '27', '30', '31', '32', '33', '34', '36', '39',
        '40', '41', '43', '44', '45', '46', '47', '48', '49',
        '51', '52', '53', '54', '55', '56', '57', '58',
        '60', '61', '62', '63', '64', '65', '66',
        '81', '82', '84', '86',
        '90', '91', '92', '93', '94', '95', '98',
      ]);
      let ccLen = 1;
      if (TWO_DIGIT_PREFIXES.has(digits.slice(0, 2))) ccLen = 2;
      const cc = digits.slice(0, ccLen);
      const last4 = digits.slice(-4);
      return `+${cc}***${last4}`;
    }
  }
  // Non-E.164 fallback: keep last 4 only.
  return `***${trimmed.slice(-4)}`;
}

const DIAL_RESULT_PATH = '/api/telephony/dial-result';
const GENERIC_SCREEN_PATH = '/api/telephony/whisper/screen';

/**
 * H1-R / round-3 — the press-1 screen URL of a SCREENED leg: the producer's
 * whisper (when it has one) or the generic screen, both carrying the session
 * (`sid`, from the /dial-result action) the keypress is recorded for. Only a
 * leg whose action is /dial-result with a `sid` can be screened.
 */
function screenUrlFor(actionUrl: string, whisperUrl: string | undefined): string | undefined {
  const queryAt = actionUrl.indexOf('?');
  const path = queryAt === -1 ? actionUrl : actionUrl.slice(0, queryAt);
  if (!path.endsWith(DIAL_RESULT_PATH)) return undefined;
  const sid = new URLSearchParams(queryAt === -1 ? '' : actionUrl.slice(queryAt + 1)).get('sid');
  if (!sid) return undefined;
  const base = whisperUrl ?? `${path.slice(0, -DIAL_RESULT_PATH.length)}${GENERIC_SCREEN_PATH}`;
  return `${base}${base.includes('?') ? '&' : '?'}sid=${encodeURIComponent(sid)}`;
}

/**
 * Mark a screened leg's /dial-result action, so that route knows THIS leg
 * required a person's keypress (and cascades a screened next leg) — carried
 * in our own URL (signed by Twilio's request signature), not inferred.
 */
function markScreened(actionUrl: string): string {
  return `${actionUrl}${actionUrl.includes('?') ? '&' : '?'}screen=1`;
}

// ─── Default implementation ──────────────────────────────────────────────────

/**
 * In-process implementation. Holds the per-session rotation cursor in
 * a `Map`; the adapter constructs one of these for the lifetime of
 * the process. The map is keyed by sessionId, not callSid, because
 * the FSM/session is the cursor's lifetime — a single Twilio call
 * could have multiple dial attempts as the rotation cascades.
 */
export class DefaultTwilioCallControl implements TwilioCallControl {
  private readonly cursors = new Map<string, RotationCursor>();

  dialDispatcher(
    callSid: string,
    dispatcherPhone: string,
    opts: DialDispatcherOptions,
  ): string {
    if (!callSid) throw new Error('dialDispatcher: callSid is required');
    if (!dispatcherPhone) throw new Error('dialDispatcher: dispatcherPhone is required');
    if (!opts.actionUrl) throw new Error('dialDispatcher: actionUrl is required');

    const timeout = opts.timeoutSeconds ?? 20;
    const callerIdAttr = opts.callerId
      ? ` callerId="${xmlEscape(opts.callerId)}"`
      : '';
    // A screened leg (emergency-class producers only) points `<Number url>`
    // at the session-bound press-1 screen, fetched with an explicit GET; an
    // unscreened leg keeps its plain whisper exactly as before (Twilio's
    // default POST is served by the whisper route too).
    const screenUrl = opts.screen === true ? screenUrlFor(opts.actionUrl, opts.whisperUrl) : undefined;
    const actionUrl = screenUrl ? markScreened(opts.actionUrl) : opts.actionUrl;
    const whisperAttr = screenUrl
      ? ` url="${xmlEscape(screenUrl)}" method="GET"`
      : opts.whisperUrl
        ? ` url="${xmlEscape(opts.whisperUrl)}"`
        : '';

    // The dispatcher number is wrapped in <Number> so Twilio's verb
    // parser handles E.164 cleanly. Both `dispatcherPhone` and
    // `actionUrl` are XML-escaped: even though phone numbers shouldn't
    // contain XML metacharacters, escaping is the safe default.
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response>` +
      `<Dial timeout="${timeout}" action="${xmlEscape(actionUrl)}" method="POST"${callerIdAttr}>` +
      `<Number${whisperAttr}>${xmlEscape(dispatcherPhone)}</Number>` +
      `</Dial>` +
      `</Response>`
    );
  }

  getCursor(sessionId: string): RotationCursor {
    const existing = this.cursors.get(sessionId);
    if (existing) return { ...existing };
    return { index: 0, attempts: 0 };
  }

  advanceCursor(sessionId: string): RotationCursor {
    const current = this.cursors.get(sessionId) ?? { index: 0, attempts: 0 };
    const next: RotationCursor = {
      index: current.index + 1,
      attempts: current.attempts + 1,
    };
    this.cursors.set(sessionId, next);
    return { ...next };
  }

  /**
   * Record that a rotation entry at `scannedIndex` has been chosen and
   * should not be considered again on subsequent walks. Use this from
   * `escalateToHuman` after picking an entry, especially when earlier
   * entries were skipped (no resolvable phone). Without it, `advanceCursor`
   * only bumps `+1` from the stored index and the next walk could redial
   * the same dispatcher when its predecessors were unresolvable.
   */
  setCursorAfter(sessionId: string, scannedIndex: number): RotationCursor {
    const current = this.cursors.get(sessionId) ?? { index: 0, attempts: 0 };
    const next: RotationCursor = {
      index: Math.max(current.index, scannedIndex + 1),
      attempts: current.attempts,
    };
    this.cursors.set(sessionId, next);
    return { ...next };
  }

  clearCursor(sessionId: string): void {
    this.cursors.delete(sessionId);
  }
}
