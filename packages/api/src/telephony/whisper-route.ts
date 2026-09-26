import { Router } from 'express';
import type { WhisperCache } from './whisper-cache';
import { xmlEscape } from './twilio-adapter';
import { sessionBelongsToAnotherTenant } from './twilio-signature';
import { createLogger } from '../logging/logger';

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
 * GET /api/telephony/whisper/:escalationId
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
  router.get('/whisper/:escalationId', (req, res) => {
    const entry = deps.whisperCache.get(req.params.escalationId);
    const foreign = sessionBelongsToAnotherTenant(req, entry);
    if (foreign) {
      logger.warn('telephony.whisper_tenant_mismatch', {
        escalationId: req.params.escalationId,
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
  });

  return router;
}
