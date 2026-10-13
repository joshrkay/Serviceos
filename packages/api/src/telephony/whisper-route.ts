import { Router, urlencoded, type Application, type Request, type Response } from 'express';
import type { WhisperCache } from './whisper-cache';
import { xmlEscape } from './twilio-adapter';
import {
  getVerifiedTwilioTenantId,
  requireTwilioSignature,
  sessionBelongsToAnotherTenant,
  type TwilioAuthTokenGetter,
} from './twilio-signature';
import { createLogger } from '../logging/logger';
import { routeParam } from '../shared/route-params';

const logger = createLogger({
  service: 'telephony.whisper',
  environment: process.env.NODE_ENV || 'development',
});

export interface WhisperRouterDeps {
  whisperCache: WhisperCache;
  /**
   * TTS voice for the whisper `<Say>` element. When unset, Twilio uses
   * its platform default voice. Pass an explicit value (e.g.,
   * `'Polly.Joanna'`) to match the rest of the agent's voice persona —
   * dispatchers will otherwise hear a generic Twilio voice that differs
   * from caller-facing speech.
   */
  voice?: string;
  /** Public base the screen's accept action is built on (absolute when known). */
  publicBaseUrl?: () => string | undefined;
  /**
   * H1 — a person pressed 1: the ONE signal that the hand-off was answered by
   * a person (it is what resolves the emergency page ladder and what lets
   * /dial-result stamp `transferred`). `tenantId` is the escalation's own
   * tenant when the whisper entry is known; `verifiedTenantId` is the tenant
   * whose credential verified the request (#1072) — the host refuses a session
   * of any other tenant. Must not throw; any failure still connects the call.
   */
  onAccepted?: (args: {
    sessionId: string;
    tenantId?: string;
    verifiedTenantId?: string;
    childCallSid?: string;
  }) => void | Promise<void>;
}

/** Seconds the dialled party has to press 1 after each prompt (M-a: hands-free answers). */
export const WHISPER_SCREEN_TIMEOUT_SECONDS = 10;

const SCREEN_COPY: Record<'en' | 'es', { intro: string; prompt: string }> = {
  en: {
    intro: 'Incoming call from your answering service. Press 1 to accept this call.',
    prompt: 'Press 1 to accept this call.',
  },
  es: {
    intro: 'Llamada entrante de su servicio de contestación. Oprima 1 para aceptar esta llamada.',
    prompt: 'Oprima 1 para aceptar esta llamada.',
  },
};

const EMPTY_RESPONSE = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
const HANGUP_RESPONSE = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';

function queryString(req: Request, key: string): string | undefined {
  const value = (req.query as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * GET|POST /api/telephony/whisper/:escalationId[?sid=<sessionId>]
 *
 * Twilio fetches this when the dialled party picks up — the returned TwiML
 * plays in THEIR ear before the caller is connected. The caller hears
 * standard ring + hold during this window.
 *
 * H1 / H1-R — for an EMERGENCY-CLASS leg (its URL carries `?sid=`, see
 * DialDispatcherOptions.screen) it is a press-1 SCREEN: a carrier voicemail answering
 * looks exactly like a person to Twilio, and treating that as "answered"
 * silenced the emergency page ladder for a real unanswered emergency. The
 * prompt comes FIRST (M-a), then the summary when the escalation has one,
 * then the prompt again; a second Gather re-prompts once; only a keypress
 * (POST …/accept) connects and marks the hand-off answered. No keypress →
 * `<Hangup/>` ends the dialled leg, the caller is not bridged to a mailbox,
 * and /dial-result continues the cascade. `screen` (no cache entry) and a
 * cache miss serve the generic screen, still bound to the session through
 * `?sid=`. Any other leg (no `sid`) gets the plain whisper, as it always did.
 *
 * Never a 404 or a 403 — an error on this URL risks dropping the call.
 *
 * #1084 — the whisper carries the caller's name, phone and intent, and the
 * escalation id is not authorization. The entry records its tenant; when a
 * tenant's own credential verified this request (the AccountSid view mounted
 * in app.ts) and it is not that tenant, the generic screen is served with no
 * summary and no session. The deployment-wide token implies no tenant
 * (single-account deployments), so the check stands down there.
 */
export function whisperRouter(deps: WhisperRouterDeps): Router {
  const router = Router();

  /** The escalation's entry when it is this tenant's; the session to accept for. */
  const resolve = (req: Request) => {
    const escalationId = routeParam(req, 'escalationId');
    const entry = deps.whisperCache.get(escalationId);
    const foreign = sessionBelongsToAnotherTenant(req, entry);
    if (foreign) logger.warn('telephony.whisper_tenant_mismatch', { escalationId });
    const own = foreign ? undefined : entry;
    const sessionId = own?.sessionId ?? (foreign ? undefined : queryString(req, 'sid'));
    return { escalationId, entry: own, sessionId };
  };

  // #4 — the dial TwiML asks Twilio for a GET (`<Number method="GET">`), but
  // `<Number url>` defaults to POST and a failed fetch here can drop the call,
  // so a POST is answered by the very same handler.
  const serveScreen = (req: Request, res: Response): void => {
    const { escalationId, entry, sessionId } = resolve(req);
    res.set('Content-Type', 'text/xml; charset=utf-8');
    // Round-3 — only an emergency-class leg is screened, and only its URL is
    // session-bound (`?sid=`). Every other leg gets the plain whisper exactly
    // as before (an empty <Response/> when there is none to give).
    if (!queryString(req, 'sid')) {
      const text = entry?.text;
      const voiceAttr = deps.voice ? ` voice="${xmlEscape(deps.voice)}"` : '';
      res
        .status(200)
        .send(
          text
            ? `<?xml version="1.0" encoding="UTF-8"?><Response><Say${voiceAttr}>${xmlEscape(text)}</Say></Response>`
            : EMPTY_RESPONSE,
        );
      return;
    }
    const copy = SCREEN_COPY[entry?.language === 'es' ? 'es' : 'en'];
    const base = (deps.publicBaseUrl?.() ?? '').replace(/\/+$/, '');
    const acceptUrl =
      `${base}/api/telephony/whisper/${encodeURIComponent(escalationId)}/accept` +
      (sessionId ? `?sid=${encodeURIComponent(sessionId)}` : '');
    const voiceAttr = deps.voice ? ` voice="${xmlEscape(deps.voice)}"` : '';
    const say = (text: string): string => `<Say${voiceAttr}>${xmlEscape(text)}</Say>`;
    const gather = (inner: string): string =>
      `<Gather numDigits="1" timeout="${WHISPER_SCREEN_TIMEOUT_SECONDS}" action="${xmlEscape(acceptUrl)}" method="POST">${inner}</Gather>`;
    res
      .status(200)
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><Response>` +
          gather(say(copy.intro) + (entry?.text ? say(entry.text) + say(copy.prompt) : '')) +
          gather(say(copy.prompt)) +
          `<Hangup/>` +
          `</Response>`,
      );
  };
  router.get('/whisper/:escalationId', serveScreen);
  router.post('/whisper/:escalationId', serveScreen);

  /**
   * The screen's `<Gather>` action. Digits=1 → connect (empty TwiML ends the
   * dialled leg's script and Twilio bridges) and record the acceptance. Any
   * other key → `<Hangup/>` (declined; the cascade continues). Any error
   * while recording connects anyway: a person who pressed 1 must never be
   * dropped — at worst the ladder keeps paging (the safe direction).
   */
  router.post('/whisper/:escalationId/accept', async (req: Request, res: Response) => {
    res.set('Content-Type', 'text/xml; charset=utf-8');
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    if (body.Digits !== '1') {
      res.status(200).send(HANGUP_RESPONSE);
      return;
    }
    try {
      const { escalationId, entry, sessionId } = resolve(req);
      if (sessionId && deps.onAccepted) {
        const verifiedTenantId = getVerifiedTwilioTenantId(req);
        await deps.onAccepted({
          sessionId,
          ...(entry ? { tenantId: entry.tenantId } : {}),
          ...(verifiedTenantId ? { verifiedTenantId } : {}),
          ...(body.CallSid ? { childCallSid: body.CallSid } : {}),
        });
      } else if (!sessionId) {
        logger.warn('telephony.whisper_accept_without_session', { escalationId });
      }
    } catch (err) {
      logger.warn('telephony.whisper_accept_record_failed', {
        escalationId: routeParam(req, 'escalationId'),
        error: err instanceof Error ? err.message : String(err),
      });
    }
    res.status(200).send(EMPTY_RESPONSE);
  });

  return router;
}

export interface MountWhisperRouteDeps extends Omit<WhisperRouterDeps, 'publicBaseUrl'> {
  /**
   * #1072/#1084 — the AccountSid-keyed credential view. This is the OUTBOUND
   * dispatcher leg, so its `To` is the dispatcher's number, not the tenant's
   * DID; binding on it would refuse legitimate whispers (see app.ts). The
   * screen's accept action rides the same mount for the same reason.
   */
  credentialView: TwilioAuthTokenGetter;
  publicBaseUrl: () => string | undefined;
}

/**
 * The production whisper mount: signature verification scoped to the whisper
 * path (the whisper and its screen's accept action), then the router —
 * mounted BEFORE the telephony router, whose own signature middleware
 * (dialled-number binding) runs for every /api/telephony/* request.
 */
export function mountWhisperRoute(app: Application, deps: MountWhisperRouteDeps): void {
  app.use(
    '/api/telephony/whisper',
    // A POST's call params are form-encoded and are part of what Twilio
    // signs: parse them BEFORE verification, or a genuine POST can never
    // verify. A GET has no body, so this is a no-op for it.
    urlencoded({ extended: false }),
    requireTwilioSignature(deps.credentialView, { publicBaseUrl: deps.publicBaseUrl }),
  );
  app.use(
    '/api/telephony',
    whisperRouter({
      whisperCache: deps.whisperCache,
      publicBaseUrl: deps.publicBaseUrl,
      ...(deps.voice ? { voice: deps.voice } : {}),
      ...(deps.onAccepted ? { onAccepted: deps.onAccepted } : {}),
    }),
  );
}
