function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Append query params to a URL, preserving any existing query string.
 * Values are URL-encoded; empty values are dropped.
 */
function appendQueryParams(url: string, params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  if (pairs.length === 0) return url;
  return url + (url.includes('?') ? '&' : '?') + pairs.join('&');
}

export interface VoicemailTwimlOptions {
  shopName: string;
  recordingStatusCallback: string;
  maxLengthSeconds?: number;
  /**
   * U9 (voicemail → action) — the live call's caller-ID, threaded onto the
   * `recordingStatusCallback` URL as a `From` query param. Twilio's
   * recordingStatusCallback POST carries only recording metadata (CallSid,
   * RecordingSid, RecordingUrl, …) — NOT the call's From/To — so without
   * this the /voicemail-status handler cannot identify the caller for the
   * owner-line gate (approver-identity match) or attach a phone to the
   * voicemail lead. The callback URL is part of what Twilio signs, so the
   * value rides back tamper-proof; trust level is carrier caller-ID, the
   * same boundary as `resolveOwnerSession` / the SMS reply transport.
   */
  callerPhone?: string;
  /**
   * U9 — the dialed business number (`To`), threaded the same way so the
   * handler can resolve the tenant when no in-process voice session exists
   * for the CallSid (the after-hours voicemail branch answers before any
   * session is created, and callbacks can land on a different instance).
   */
  dialedNumber?: string;
}

/**
 * TwiML for product voicemail — branded prompt + Record.
 * Twilio POSTs recording metadata to `recordingStatusCallback`.
 */
export function buildVoicemailTwiml(opts: VoicemailTwimlOptions): string {
  const safeName = xmlEscape(opts.shopName);
  const maxLen = opts.maxLengthSeconds ?? 120;
  const callbackUrl = appendQueryParams(opts.recordingStatusCallback, {
    From: opts.callerPhone,
    To: opts.dialedNumber,
  });
  const callback = xmlEscape(callbackUrl);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say voice="Polly.Joanna">Thanks for calling ${safeName}. ` +
    `We're not available right now. Please leave a message after the tone.</Say>` +
    `<Record maxLength="${maxLen}" playBeep="true" recordingStatusCallback="${callback}" ` +
    `recordingStatusCallbackMethod="POST"/>` +
    `<Hangup/>` +
    `</Response>`
  );
}
