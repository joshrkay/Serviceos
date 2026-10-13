import { Router, urlencoded, type Application, type Request, type Response } from 'express';
import type { WhisperCache } from './whisper-cache';
import { xmlEscape } from './twilio-adapter';
import {
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
}

/**
 * GET|POST /api/telephony/whisper/:escalationId
 *
 * Twilio fetches this when the dispatcher answers — the returned TwiML
 * plays in the dispatcher's ear before the caller is connected. The
 * caller hears standard ring + hold during this window.
 *
 * If the escalationId is unknown (expired, never stored), return an
 * empty <Response/> so Twilio connects the caller anyway without
 * whisper. NEVER 404 — that would drop the call.
 *
 * #1084 — the whisper carries the caller's name, phone and intent, and the
 * escalation id is not authorization. The entry records its tenant; when a
 * tenant's own credential verified this GET (the AccountSid view mounted in
 * app.ts) and it is not that tenant, answer the same empty whisper — never a
 * 403, for the same drop-the-call reason. The deployment-wide token implies no
 * tenant (single-account deployments), so the check stands down there.
 */
export function whisperRouter(deps: WhisperRouterDeps): Router {
  const router = Router();
  // #4 — the dial TwiML asks Twilio for a GET (`<Number method="GET">`), but
  // `<Number url>` defaults to POST and a failed fetch here can drop the call,
  // so a POST is answered by the very same handler.
  const serveWhisper = (req: Request, res: Response): void => {
    const entry = deps.whisperCache.get(routeParam(req, 'escalationId'));
    const foreign = sessionBelongsToAnotherTenant(req, entry);
    if (foreign) {
      logger.warn('telephony.whisper_tenant_mismatch', {
        escalationId: routeParam(req, 'escalationId'),
      });
    }
    const text = foreign ? undefined : entry?.text;
    res.set('Content-Type', 'text/xml; charset=utf-8');
    if (!text) {
      res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      return;
    }
    const voiceAttr = deps.voice ? ` voice="${xmlEscape(deps.voice)}"` : '';
    res
      .status(200)
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Say${voiceAttr}>${xmlEscape(
          text,
        )}</Say></Response>`,
      );
  };
  router.get('/whisper/:escalationId', serveWhisper);
  router.post('/whisper/:escalationId', serveWhisper);

  return router;
}

export interface MountWhisperRouteDeps extends WhisperRouterDeps {
  /**
   * #1072/#1084 — the AccountSid-keyed credential view. This is the OUTBOUND
   * dispatcher leg, so its `To` is the dispatcher's number, not the tenant's
   * DID; binding on it would refuse legitimate whispers (see app.ts).
   */
  credentialView: TwilioAuthTokenGetter;
  publicBaseUrl: () => string | undefined;
}

/**
 * The production whisper mount: signature verification scoped to the whisper
 * path, then the router — mounted BEFORE the telephony router, whose own
 * signature middleware (dialled-number binding) runs for every
 * /api/telephony/* request.
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
    whisperRouter({ whisperCache: deps.whisperCache, ...(deps.voice ? { voice: deps.voice } : {}) }),
  );
}
