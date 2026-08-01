/**
 * WS7 — mid-call REST redirect to the Gather-only fallback webhook.
 *
 * When the realtime (media-streams) transport fails terminally mid-call, the
 * adapter can steer the LIVE call back to `<Gather>` by POSTing a new `Url` to
 * Twilio's Calls REST resource — Twilio then re-requests TwiML from that URL and
 * the caller lands on the Gather loop instead of hearing dead air.
 *
 * Mirrors the authenticated fetch + basic-auth pattern of
 * `outbound-call-service.ts` (no Twilio SDK call object). Best-effort: returns
 * `false` on any non-2xx or thrown error, and NEVER throws — the caller falls
 * back to today's WS-close behavior.
 */
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'telephony.call-redirect',
  environment: process.env.NODE_ENV || 'development',
});

export interface TwilioCallRedirectorDeps {
  /** Resolves the Twilio auth token for the call's AccountSid (subaccount-aware). */
  resolveAuthToken: (accountSid: string | undefined) => Promise<string | undefined>;
  /** Fallback AccountSid when the start frame carried none (process.env.TWILIO_ACCOUNT_SID). */
  defaultAccountSid?: string;
  /** Public base URL Twilio will POST the fallback TwiML request to (PUBLIC_API_URL). */
  publicBaseUrl: string;
  /** Test seam — same as outbound-call-service. */
  fetchImpl?: typeof fetch;
  /** Twilio REST base. Default `https://api.twilio.com/2010-04-01`. */
  apiBaseUrl?: string;
}

export type TwilioCallRedirector = (args: {
  callSid: string;
  accountSid?: string;
}) => Promise<boolean>;

export function createTwilioCallRedirector(deps: TwilioCallRedirectorDeps): TwilioCallRedirector {
  const apiBaseUrl = deps.apiBaseUrl ?? 'https://api.twilio.com/2010-04-01';
  const base = deps.publicBaseUrl.replace(/\/+$/, '');
  const fetchImpl = deps.fetchImpl ?? fetch;

  return async ({ callSid, accountSid }): Promise<boolean> => {
    const sid = accountSid ?? deps.defaultAccountSid;
    if (!sid || !callSid) return false;

    let authToken: string | undefined;
    try {
      authToken = await deps.resolveAuthToken(accountSid);
    } catch {
      authToken = undefined;
    }
    if (!authToken) return false;

    const body = new URLSearchParams({
      Url: `${base}/api/telephony/voice/gather-fallback`,
      Method: 'POST',
    });
    const auth = Buffer.from(`${sid}:${authToken}`).toString('base64');

    try {
      const response = await fetchImpl(`${apiBaseUrl}/Accounts/${sid}/Calls/${callSid}.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      if (!response.ok) {
        logger.warn('twilio call redirect: non-2xx', { callSid, status: response.status });
        return false;
      }
      return true;
    } catch (err) {
      logger.warn('twilio call redirect: request failed', {
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };
}
