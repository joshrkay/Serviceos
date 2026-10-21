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
 *
 * Host alone is not enough (Cursor security review on #1744): the same
 * credential is valid for EVERY `api.twilio.com` resource, so a path such as
 * `/2010-04-01/Accounts.json?.mp3` would turn the fetcher into a confused
 * deputy that reads account metadata (which can include auth tokens) and
 * stores the response as a "recording". The path must therefore be exactly
 * one of the two media resource shapes Twilio hands out in webhooks, and the
 * URL may carry no query string or fragment:
 *
 *   /2010-04-01/Accounts/{AccountSid}/Recordings/{RecordingSid}[.mp3|.wav]
 *   /2010-04-01/Accounts/{AccountSid}/Messages/{MessageSid}/Media/{MediaSid}
 */

const TWILIO_APEX = 'twilio.com';

const SID = '[A-Za-z0-9]+';
const MEDIA_PATH = new RegExp(
  `^/2010-04-01/Accounts/${SID}/(?:Recordings/${SID}(?:\.(?:mp3|wav))?|Messages/${SID}/Media/${SID})$`,
);

export function isTwilioMediaUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.search || url.hash) return false;
  const host = url.hostname.toLowerCase();
  if (host !== TWILIO_APEX && !host.endsWith(`.${TWILIO_APEX}`)) return false;
  return MEDIA_PATH.test(url.pathname);
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
    throw new Error(`${what} is not a Twilio media URL (host: ${host}); refusing to send credentials`);
  }
}
