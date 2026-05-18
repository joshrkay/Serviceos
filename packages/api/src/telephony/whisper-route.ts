import { Router } from 'express';
import type { WhisperCache } from './whisper-cache';

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface WhisperRouterDeps {
  whisperCache: WhisperCache;
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
 */
export function whisperRouter(deps: WhisperRouterDeps): Router {
  const router = Router();
  router.get('/whisper/:escalationId', (req, res) => {
    const text = deps.whisperCache.get(req.params.escalationId);
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
