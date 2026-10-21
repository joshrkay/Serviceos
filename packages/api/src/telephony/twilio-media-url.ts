/**
 * Hardening sweep 2026-10 — host allowlist for Twilio-supplied media URLs.
 *
 * `RecordingUrl` (recording / voicemail status callbacks) and `MediaUrlN`
 * (inbound MMS) arrive in webhook bodies, and the code that downloads them
 * sends HTTP Basic credentials with the request: the deployment's own
 * `TWILIO_ACCOUNT_SID:TWILIO_AUTH_TOKEN` on the recording path, the tenant's
 * subaccount token on the MMS path. The body is signature-verified, but a
 * tenant that connects its OWN Twilio account can sign a payload with its own
 * token (#1072), so "signed" never meant "the URL is Twilio's". Without this
 * check such a payload could name `https://attacker.example/x` and collect
 * the credential from the Authorization header.
 *
 * Twilio serves both resources from `api.twilio.com` (recordings may also be
 * addressed through the regional `api.<region>.twilio.com` hosts), so the
 * allowlist is `https:` + `twilio.com` or any of its subdomains — nothing a
 * tenant can point elsewhere.
 */

const TWILIO_APEX = 'twilio.com';

export function isTwilioMediaUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return host === TWILIO_APEX || host.endsWith(`.${TWILIO_APEX}`);
}

/**
 * Throws before any credential-bearing request is built. The message names
 * only the host, never the full URL, so a log line cannot echo a query string.
 */
export function assertTwilioMediaUrl(value: string, what: string): void {
  if (!isTwilioMediaUrl(value)) {
    let host = 'invalid-url';
    try {
      host = new URL(value).host || 'invalid-url';
    } catch {
      // keep the placeholder
    }
    throw new Error(`${what} is not a Twilio URL (host: ${host}); refusing to send credentials`);
  }
}
