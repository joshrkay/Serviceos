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
  /** Public base the screen's accept action is built on (absolute when known). */
  publicBaseUrl?: () => string | undefined;
  /**
   * H1 — the screen was played for this escalation's hand-off. From here the
   * hand-off only counts as answered once a human presses 1, so the host can
   * stop trusting a bare DialCallStatus=completed (a voicemail pickup).
   */
  onScreenOffered?: (args: { sessionId: string; tenantId: string }) => void;
  /**
   * H1 — a human pressed 1: the ONE signal that the hand-off was answered by a
   * person (it is what resolves the emergency page ladder). Must not throw;
   * any failure still connects the call.
   */
  onAccepted?: (args: { sessionId: string; tenantId: string; childCallSid?: string }) => void | Promise<void>;
}

/** Seconds the dialled party has to press 1 after the whisper finishes. */
export const WHISPER_SCREEN_TIMEOUT_SECONDS = 8;

const SCREEN_PROMPT: Record<'en' | 'es', string> = {
  en: 'Press 1 to accept this call.',
  es: 'Oprima 1 para aceptar esta llamada.',
};

const EMPTY_RESPONSE = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
const HANGUP_RESPONSE = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';

/**
 * GET|POST /api/telephony/whisper/:escalationId
 *
 * Twilio fetches this when the dialled party picks up — the returned TwiML
 * plays in THEIR ear before the caller is connected. The caller hears
 * standard ring + hold during this window.
 *
 * H1 — it is a SCREEN, not just a whisper: a carrier voicemail answering
 * looks exactly like a human to Twilio, and treating that as "answered"
 * silenced the emergency page ladder for a real unanswered emergency. The
 * summary plays inside `<Gather numDigits="1">`; only a keypress (POST
 * …/accept) connects and marks the hand-off answered. No keypress → the
 * `<Hangup/>` ends the dialled leg, the caller is not bridged to a mailbox,
 * and /dial-result continues the cascade.
 *
 * If the escalationId is unknown (expired, never stored), return an
 * empty <Response/> so Twilio connects the caller anyway without
 * whisper. NEVER 404 — that would drop the call.
 *
 * #1084 — the whisper carries the caller's name, phone and intent, and the
 * escalation id is not authorization. The entry records its tenant; when a
 * tenant's own credential verified this request (the AccountSid view mounted
 * in app.ts) and it is not that tenant, answer the same empty whisper — never
 * a 403, for the same drop-the-call reason. The deployment-wide token implies
 * no tenant (single-account deployments), so the check stands down there.
 */
export function whisperRouter(deps: WhisperRouterDeps): Router {
  const router = Router();
  // #4 — the dial TwiML asks Twilio for a GET (`<Number method="GET">`), but
  // `<Number url>` defaults to POST and a failed fetch here can drop the call,
  // so a POST is answered by the very same handler.
  const serveWhisper = (req: Request, res: Response): void => {
    const escalationId = routeParam(req, 'escalationId');
    const entry = deps.whisperCache.get(escalationId);
    const foreign = sessionBelongsToAnotherTenant(req, entry);
    if (foreign) {
      logger.warn('telephony.whisper_tenant_mismatch', { escalationId });
    }
    const text = foreign ? undefined : entry?.text;
    res.set('Content-Type', 'text/xml; charset=utf-8');
    if (!text || !entry) {
      res.status(200).send(EMPTY_RESPONSE);
      return;
    }
    if (entry.sessionId && deps.onScreenOffered) {
      try {
        deps.onScreenOffered({ sessionId: entry.sessionId, tenantId: entry.tenantId });
      } catch (err) {
        logger.warn('telephony.whisper_screen_offer_hook_failed', {
          escalationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const base = (deps.publicBaseUrl?.() ?? '').replace(/\/+$/, '');
    const acceptUrl = `${base}/api/telephony/whisper/${encodeURIComponent(escalationId)}/accept`;
    const voiceAttr = deps.voice ? ` voice="${xmlEscape(deps.voice)}"` : '';
    const prompt = SCREEN_PROMPT[entry.language === 'es' ? 'es' : 'en'];
    res
      .status(200)
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><Response>` +
          `<Gather numDigits="1" timeout="${WHISPER_SCREEN_TIMEOUT_SECONDS}" action="${xmlEscape(acceptUrl)}" method="POST">` +
          `<Say${voiceAttr}>${xmlEscape(`${text} ${prompt}`)}</Say>` +
          `</Gather>` +
          `<Hangup/>` +
          `</Response>`,
      );
  };
  router.get('/whisper/:escalationId', serveWhisper);
  router.post('/whisper/:escalationId', serveWhisper);

  /**
   * H1 — the screen's `<Gather>` action. Digits=1 → connect (empty TwiML ends
   * the dialled leg's script and Twilio bridges) and record the acceptance.
   * Any other key → `<Hangup/>` (declined; the cascade continues). Any error
   * while recording connects anyway: a person who pressed 1 must never be
   * dropped — at worst the ladder keeps paging (the safe direction).
   */
  router.post('/whisper/:escalationId/accept', async (req: Request, res: Response) => {
    res.set('Content-Type', 'text/xml; charset=utf-8');
    const escalationId = routeParam(req, 'escalationId');
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    if (body.Digits !== '1') {
      res.status(200).send(HANGUP_RESPONSE);
      return;
    }
    try {
      const entry = deps.whisperCache.get(escalationId);
      if (entry?.sessionId && !sessionBelongsToAnotherTenant(req, entry) && deps.onAccepted) {
        await deps.onAccepted({
          sessionId: entry.sessionId,
          tenantId: entry.tenantId,
          ...(body.CallSid ? { childCallSid: body.CallSid } : {}),
        });
      }
    } catch (err) {
      logger.warn('telephony.whisper_accept_record_failed', {
        escalationId,
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
      ...(deps.onScreenOffered ? { onScreenOffered: deps.onScreenOffered } : {}),
      ...(deps.onAccepted ? { onAccepted: deps.onAccepted } : {}),
    }),
  );
}
