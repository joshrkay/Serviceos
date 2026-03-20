import { Router, Request, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import {
  createVoiceRecording,
  validateVoiceIngest,
  VoiceRepository,
  TranscribeAudioFn,
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

const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // 25 MB

export function createVoiceRouter(
  voiceRepo: VoiceRepository,
  queue: Queue,
  transcribeAudio?: TranscribeAudioFn
): Router {
  const router = Router();

  /**
   * POST /transcribe — Synchronous transcription.
   * Accepts multipart form with 'audio' field, returns { transcript, metadata } immediately.
   */
  router.post(
    '/transcribe',
    requireAuth,
    requireTenant,
    async (req: Request, res: Response) => {
      if (!transcribeAudio) {
        res.status(501).json({ error: 'NOT_CONFIGURED', message: 'Transcription is not configured' });
        return;
      }

      const contentType = req.headers['content-type'] || '';

      // Handle multipart/form-data by collecting the raw body from the audio field
      if (contentType.includes('multipart/form-data')) {
        try {
          const chunks: Buffer[] = [];
          let audioContentType = 'audio/webm';
          let totalSize = 0;

          // Parse multipart manually using the raw request stream
          // The body is multipart — we need to extract the audio part
          const boundary = contentType.split('boundary=')[1];
          if (!boundary) {
            res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Missing multipart boundary' });
            return;
          }

          const rawBody = await collectRequestBody(req, MAX_AUDIO_SIZE);
          if (!rawBody) {
            res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'Audio file exceeds 25MB limit' });
            return;
          }

          const audioPart = extractMultipartFile(rawBody, boundary, 'audio');
          if (!audioPart) {
            res.status(400).json({ error: 'VALIDATION_ERROR', message: 'No audio field found in multipart body' });
            return;
          }

          audioContentType = audioPart.contentType || 'audio/webm';
          const result = await transcribeAudio(audioPart.data, audioContentType);
          res.json(result);
        } catch (err) {
          res.status(500).json({
            error: 'TRANSCRIPTION_FAILED',
            message: err instanceof Error ? err.message : 'Transcription failed',
          });
        }
        return;
      }

      // Fallback: raw audio body (Content-Type: audio/*)
      if (contentType.startsWith('audio/')) {
        try {
          const rawBody = await collectRequestBody(req, MAX_AUDIO_SIZE);
          if (!rawBody) {
            res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'Audio file exceeds 25MB limit' });
            return;
          }
          const result = await transcribeAudio(rawBody, contentType);
          res.json(result);
        } catch (err) {
          res.status(500).json({
            error: 'TRANSCRIPTION_FAILED',
            message: err instanceof Error ? err.message : 'Transcription failed',
          });
        }
        return;
      }

      res.status(415).json({
        error: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Expected multipart/form-data with audio field, or raw audio/* body',
      });
    }
  );

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

/** Collect raw request body into a Buffer, enforcing a max size. Returns null if exceeded. */
function collectRequestBody(req: Request, maxSize: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Extract a named file field from a multipart body. */
function extractMultipartFile(
  body: Buffer,
  boundary: string,
  fieldName: string
): { data: Buffer; contentType: string } | null {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const bodyStr = body.toString('latin1');
  const parts = bodyStr.split(`--${boundary}`);

  for (const part of parts) {
    if (!part.includes(`name="${fieldName}"`)) continue;

    // Find the header/body separator (double CRLF)
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headers = part.substring(0, headerEnd);
    const content = part.substring(headerEnd + 4);

    // Strip trailing \r\n-- if present (end boundary)
    const trimmed = content.replace(/\r\n$/, '');

    // Extract content type from part headers
    const ctMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    const contentType = ctMatch ? ctMatch[1].trim() : 'audio/webm';

    // Convert back to buffer preserving binary data
    return {
      data: Buffer.from(trimmed, 'latin1'),
      contentType,
    };
  }
  return null;
}
