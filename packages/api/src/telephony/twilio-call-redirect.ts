/**
 * WS7 — mid-call REST update of a LIVE call (the realtime transport's only way
 * to change what Twilio does next: a `<Connect><Stream>` call has no follow-on
 * verb and no next webhook).
 *
 * Two uses, one client:
 *   - degrade: POST a new `Url` so Twilio re-requests TwiML from the
 *     Gather-only fallback webhook and the caller lands on the Gather loop
 *     instead of hearing dead air;
 *   - hand-off: POST inline `Twiml` (the parked `<Dial>` / announce TwiML) so
 *     the caller is connected to a human. Inline TwiML is limited by Twilio to
 *     4,000 characters; an over-long document is rejected (non-2xx → `false`)
 *     and the caller falls back to the degrade path, whose webhook response has
 *     no such limit.
 *
 * Mirrors the authenticated fetch + basic-auth pattern of
 * `outbound-call-service.ts` (no Twilio SDK call object). Best-effort: returns
 * `false` on any non-2xx, thrown error or timeout, and NEVER throws — the
 * caller decides the fallback.
 */
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'telephony.call-redirect',
  environment: process.env.NODE_ENV || 'development',
});

/**
 * Bound on one Calls REST update. The caller is on a live line while this is
 * in flight, so a hung Twilio API must not hold it: past this the request is
 * aborted and treated as failed (the caller's fallback runs).
 */
export const TWILIO_CALL_UPDATE_TIMEOUT_MS = 3_000;

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
  /** Per-request timeout. Default {@link TWILIO_CALL_UPDATE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export type TwilioCallRedirector = (args: {
  callSid: string;
  accountSid?: string;
  /**
   * When set, the live call executes THIS TwiML (REST `Twiml=`) — the realtime
   * hand-off. When absent, the call is redirected to the Gather-fallback
   * webhook (REST `Url=`) — the WS7 degrade.
   */
  twiml?: string;
}) => Promise<boolean>;

export function createTwilioCallRedirector(deps: TwilioCallRedirectorDeps): TwilioCallRedirector {
  const apiBaseUrl = deps.apiBaseUrl ?? 'https://api.twilio.com/2010-04-01';
  const base = deps.publicBaseUrl.replace(/\/+$/, '');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? TWILIO_CALL_UPDATE_TIMEOUT_MS;

  return async ({ callSid, accountSid, twiml }): Promise<boolean> => {
    const sid = accountSid ?? deps.defaultAccountSid;
    if (!sid || !callSid) return false;

    let authToken: string | undefined;
    try {
      authToken = await deps.resolveAuthToken(accountSid);
    } catch {
      authToken = undefined;
    }
    if (!authToken) return false;

    const body =
      twiml !== undefined
        ? new URLSearchParams({ Twiml: twiml })
        : new URLSearchParams({
            Url: `${base}/api/telephony/voice/gather-fallback`,
            Method: 'POST',
          });
    const auth = Buffer.from(`${sid}:${authToken}`).toString('base64');
    const kind = twiml !== undefined ? 'twiml' : 'gather_fallback';

    try {
      const response = await fetchImpl(`${apiBaseUrl}/Accounts/${sid}/Calls/${callSid}.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        logger.warn('twilio call redirect: non-2xx', { callSid, kind, status: response.status });
        return false;
      }
      return true;
    } catch (err) {
      logger.warn('twilio call redirect: request failed', {
        callSid,
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };
}
