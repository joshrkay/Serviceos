/**
 * U7 (S6-3) — what a demo `Calls` request did, sorted before the lease, the
 * budget reservation or the visitor's allowance is touched (plan "Only a
 * `Calls` request that provably created no call releases anything at
 * once").
 *
 * Three outcomes. `created`: a 2xx whose body parses and carries a `sid`.
 * `not_created`, the only one that releases at once: the request was never
 * made (a local failure), the connection failed before the request was
 * written (a closed list of Node `cause.code` values), or Twilio answered
 * with its own error body at a status on a closed list. `unconfirmed`:
 * everything else, because Twilio can accept a request, create the call and
 * still fail on the way back to us, so a billable call may exist. Nothing
 * is not-created by default. Pure.
 */

/**
 * Twilio statuses that reject the request while validating it, so no call
 * was created. Each entry is this plan's reading of Twilio's REST error
 * reference; any entry a staging probe cannot show is dropped (owner action,
 * S6 work package section 5 item 7), which moves it to unconfirmed. No 5xx
 * is ever on this list.
 */
export const NOT_CREATED_RESPONSES: readonly number[] = Object.freeze([
  // 400: parameter validation (e.g. 21211 invalid To, 21212 invalid From,
  // 21205 invalid Url). https://www.twilio.com/docs/errors/21211 — staging
  // probe "invalid To" pending (owner action 7).
  400,
  // 401: authentication failed (20003), before any resource is created.
  // https://www.twilio.com/docs/errors/20003 — staging probe "wrong auth
  // token" pending (owner action 7).
  401,
  // 403: the account may not perform the request (e.g. 21215 geo
  // permissions, 20005 account suspended). https://www.twilio.com/docs/errors/21215
  403,
  // 404: the Accounts/{sid}/Calls.json resource does not exist (20404).
  // https://www.twilio.com/docs/errors/20404
  404,
  // 429: concurrency / rate limit (20429), the request was refused.
  // https://www.twilio.com/docs/errors/20429
  429,
]);

/**
 * Connection failures Node raises before a request byte is written: name
 * resolution, a refused or unreachable connect, and certificate-verification
 * failures in the TLS handshake. Any other code (a reset, a peer close, a
 * protocol error) may have followed a written request: unconfirmed.
 */
export const NOT_CREATED_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  // Chain-verification failures, raised in the same handshake before any
  // request byte (the plan's list named three; Node 22 reports a self-signed
  // peer with these codes).
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

/** What the request did, as the service observed it. */
export type CallsRequestResult =
  /** No request was made (credentials, the From number, a token, the URL). */
  | { kind: 'local_failure'; error: unknown }
  /** The fetch (or its body read) threw. */
  | { kind: 'thrown'; error: unknown }
  /** A status came back; `bodyText` is null when the body could not be read. */
  | { kind: 'response'; status: number; bodyText: string | null };

/** Why an outcome is unconfirmed (audited as `demo_call_unconfirmed`). */
export type UnconfirmedReason = 'timeout' | 'reset_after_send' | 'http_5xx' | 'unparsable_body' | 'unlisted_response';

export type CallsOutcome =
  | { outcome: 'created'; callSid: string }
  | { outcome: 'not_created'; reason: 'local_failure' }
  | { outcome: 'not_created'; reason: 'connect_failed'; causeCode: string }
  | { outcome: 'not_created'; reason: 'twilio_rejected'; httpStatus: number; twilioCode: number }
  | { outcome: 'unconfirmed'; reason: UnconfirmedReason; httpStatus?: number };

function parseJson(text: string | null): { ok: true; value: unknown } | { ok: false } {
  if (text === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function classifyResponse(status: number, bodyText: string | null): CallsOutcome {
  if (status >= 200 && status < 300) {
    const parsed = parseJson(bodyText);
    if (parsed.ok && isRecord(parsed.value) && typeof parsed.value.sid === 'string' && parsed.value.sid.length > 0) {
      return { outcome: 'created', callSid: parsed.value.sid };
    }
    return { outcome: 'unconfirmed', reason: 'unparsable_body', httpStatus: status };
  }
  if (status >= 500) return { outcome: 'unconfirmed', reason: 'http_5xx', httpStatus: status };
  if (NOT_CREATED_RESPONSES.includes(status)) {
    const parsed = parseJson(bodyText);
    if (!parsed.ok) return { outcome: 'unconfirmed', reason: 'unparsable_body', httpStatus: status };
    const body = parsed.value;
    if (
      isRecord(body) &&
      typeof body.code === 'number' &&
      Number.isInteger(body.code) &&
      typeof body.message === 'string' &&
      body.status === status
    ) {
      return { outcome: 'not_created', reason: 'twilio_rejected', httpStatus: status, twilioCode: body.code };
    }
  }
  return { outcome: 'unconfirmed', reason: 'unlisted_response', httpStatus: status };
}

/** The listed code a fetch failure carries, or null (unlisted, mixed, or none). */
function listedCauseCode(error: Error): string | null {
  const cause = (error as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return null;
  if (cause instanceof AggregateError) {
    const codes = cause.errors.map((e) => (e as { code?: unknown } | null)?.code);
    if (codes.length === 0) return null;
    const first = codes[0];
    if (typeof first !== 'string' || !NOT_CREATED_CODES.has(first)) return null;
    return codes.every((c) => c === first) ? first : null;
  }
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' && NOT_CREATED_CODES.has(code) ? code : null;
}

function classifyThrown(error: unknown): CallsOutcome {
  if (!(error instanceof Error)) return { outcome: 'unconfirmed', reason: 'unlisted_response' };
  // fetch does not say which phase an abort interrupted, so even a connect
  // timeout counts as a request that may have been written.
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return { outcome: 'unconfirmed', reason: 'timeout' };
  }
  const code = listedCauseCode(error);
  if (code) return { outcome: 'not_created', reason: 'connect_failed', causeCode: code };
  return { outcome: 'unconfirmed', reason: 'reset_after_send' };
}

export function classifyCallsOutcome(result: CallsRequestResult): CallsOutcome {
  switch (result.kind) {
    case 'local_failure':
      return { outcome: 'not_created', reason: 'local_failure' };
    case 'thrown':
      return classifyThrown(result.error);
    case 'response':
      return classifyResponse(result.status, result.bodyText);
    default:
      return { outcome: 'unconfirmed', reason: 'unlisted_response' };
  }
}
