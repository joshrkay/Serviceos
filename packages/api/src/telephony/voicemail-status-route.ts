/**
 * Twilio recordingStatusCallback for product voicemail (B4).
 * Creates a lead from the caller's number when a voicemail is left.
 */
import { Router, Request, Response } from 'express';
import type { Pool } from 'pg';
import type { VoiceSessionStore } from '../ai/agents/customer-calling/voice-session-store';
import { createLogger } from '../logging/logger';
import { createLead } from '../leads/lead-service';
import type { LeadRepository } from '../leads/lead';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import { v4 as uuidv4 } from 'uuid';

const logger = createLogger({
  service: 'telephony.voicemail-status',
  environment: process.env.NODE_ENV || 'development',
});

export interface VoicemailStatusRouterDeps {
  store: VoiceSessionStore;
  pool?: Pool;
  leadRepo?: LeadRepository;
  auditRepo?: AuditRepository;
}

export function createVoicemailStatusRouter(deps: VoicemailStatusRouterDeps): Router {
  const router = Router();

  router.post('/voicemail-status', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string | undefined>;
    const callSid = body.CallSid ?? '';
    const recordingSid = body.RecordingSid ?? '';
    const from = body.From ?? '';
    const recordingUrl = body.RecordingUrl;

    if (!callSid || !recordingSid) {
      res.status(200).send('OK');
      return;
    }

    const session = deps.store.findByCallSid(callSid);
    const tenantId = session?.tenantId;
    if (!tenantId || !deps.leadRepo || !deps.auditRepo) {
      logger.warn('voicemail-status: missing tenant or repos', {
        callSid,
        hasSession: Boolean(session),
      });
      res.status(200).send('OK');
      return;
    }

    try {
      const lead = await createLead(
        {
          tenantId,
          firstName: 'Voicemail',
          lastName: 'Caller',
          primaryPhone: from || undefined,
          source: 'phone_call',
          sourceDetail: `Voicemail recording ${recordingSid}`,
          createdBy: 'voicemail_webhook',
          actorRole: 'system',
        },
        deps.leadRepo,
        deps.auditRepo,
      );

      await deps.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: 'voicemail_webhook',
          actorRole: 'system',
          eventType: 'voicemail.received',
          entityType: 'lead',
          entityId: lead.id,
          correlationId: uuidv4(),
          metadata: {
            callSid,
            recordingSid,
            hasRecordingUrl: Boolean(recordingUrl),
          },
        }),
      );
    } catch (err) {
      logger.warn('voicemail-status: lead create failed', {
        tenantId,
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    res.status(200).send('OK');
  });

  return router;
}
