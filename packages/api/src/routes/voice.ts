import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import {
  createVoiceRecording,
  validateVoiceIngest,
  VoiceRepository,
} from '../voice/voice-service';
import { Queue } from '../queues/queue';

interface CreateVoiceRecordingBody {
  fileId: string;
  conversationId?: string;
  audioUrl: string;
}

interface RetryTranscriptionBody {
  audioUrl: string;
}

export function createVoiceRouter(
  voiceRepo: VoiceRepository,
  queue: Queue
): Router {
  const router = Router();

  router.post(
    '/recordings',
    requireAuth,
    requireTenant,
    requirePermission('files:upload'),
    async (req: AuthenticatedRequest, res: Response) => {
      const body = req.body as CreateVoiceRecordingBody;
      if (!body?.audioUrl) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'audioUrl is required' });
        return;
      }

      const errors = validateVoiceIngest({
        tenantId: req.auth!.tenantId,
        fileId: body.fileId,
        conversationId: body.conversationId,
        createdBy: req.auth!.userId,
      });
      if (errors.length > 0) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: errors.join(', ') });
        return;
      }

      const recording = await voiceRepo.create(
        createVoiceRecording({
          tenantId: req.auth!.tenantId,
          fileId: body.fileId,
          conversationId: body.conversationId,
          createdBy: req.auth!.userId,
        })
      );

      const queueMessageId = await queue.send(
        'transcription',
        {
          tenantId: req.auth!.tenantId,
          recordingId: recording.id,
          audioUrl: body.audioUrl,
          conversationId: body.conversationId,
        },
        `${req.auth!.tenantId}:${recording.id}:transcription:create`
      );

      res.status(202).json({
        recording,
        queueMessageId,
      });
    }
  );

  router.get(
    '/recordings/:id',
    requireAuth,
    requireTenant,
    requirePermission('files:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      const recording = await voiceRepo.findById(req.auth!.tenantId, req.params.id);
      if (!recording) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Voice recording not found' });
        return;
      }
      res.json(recording);
    }
  );

  router.post(
    '/recordings/:id/retry',
    requireAuth,
    requireTenant,
    requirePermission('files:upload'),
    async (req: AuthenticatedRequest, res: Response) => {
      const body = req.body as RetryTranscriptionBody;
      if (!body?.audioUrl) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'audioUrl is required' });
        return;
      }

      const existing = await voiceRepo.findById(req.auth!.tenantId, req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Voice recording not found' });
        return;
      }

      await voiceRepo.updateStatus(req.auth!.tenantId, existing.id, 'pending');
      const queueMessageId = await queue.send(
        'transcription',
        {
          tenantId: req.auth!.tenantId,
          recordingId: existing.id,
          audioUrl: body.audioUrl,
          conversationId: existing.conversationId,
        },
        `${req.auth!.tenantId}:${existing.id}:transcription:retry`
      );

      const updated = await voiceRepo.findById(req.auth!.tenantId, existing.id);
      res.status(202).json({
        recording: updated,
        queueMessageId,
      });
    }
  );

  return router;
}
