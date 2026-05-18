import { Router } from 'express';
import { z } from 'zod';
import type { VoiceSessionStore } from '../ai/agents/customer-calling/voice-session-store';

const OutcomeSchema = z.object({
  outcome: z.enum(['resolved', 'hung_up', 'needs_callback']),
});

export interface OutcomeRouteDeps {
  store: VoiceSessionStore;
}

/**
 * POST /api/escalations/:escalationId/outcome
 *
 * Records the dispatcher's outcome after handling an escalated call.
 * Best-effort: returns 200 even when no matching session is found.
 * `findByEscalationId` does not yet exist on VoiceSessionStore — per the
 * Section 11 task notes we skip the session lookup and return 200.
 * The call quality scoring spec will handle durable persistence.
 */
export function escalationOutcomeRouter(_deps: OutcomeRouteDeps): Router {
  const router = Router();
  router.post('/:escalationId/outcome', (req, res) => {
    const parsed = OutcomeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_outcome' });
      return;
    }
    // Outcome acknowledged — no session lookup since findByEscalationId
    // is not yet implemented. Call quality scoring persists outcomes later.
    res.status(200).json({ ok: true });
  });
  return router;
}
