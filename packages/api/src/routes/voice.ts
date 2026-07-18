import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { createRateLimitStore } from '../middleware/rate-limit-store';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import {
  enableVoiceAgentLive,
  pauseVoiceAgentLive,
  subscriptionAllowsVoice,
} from '../voice/go-live';
import {
  createVoiceRecording,
  validateVoiceIngest,
  VoiceRepository,
  TranscribeAudioFn,
} from '../voice/voice-service';
import { Queue } from '../queues/queue';
import {
  mintDeepgramStreamToken,
  DeepgramTokenUnavailableError,
  DeepgramTokenPermissionError,
} from '../voice/deepgram-token';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { Logger } from '../logging/logger';
import type { FileRepository, StorageProvider } from '../files/file-service';
import type { JobRepository } from '../jobs/job';

interface CreateVoiceRecordingBody {
  fileId: string;
  conversationId?: string;
  audioUrl: string;
  jobId?: string;
}

interface RetryTranscriptionBody {
  audioUrl: string;
}

const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // 25 MB
const JOB_ID_SCHEMA = z.string().uuid();

const ALLOWED_MIME_TYPES = new Set([
  'audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg',
  'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-m4a',
]);

function isAllowedMimeType(contentType: string): boolean {
  // Normalize: strip parameters like codec info
  const base = contentType.split(';')[0].trim().toLowerCase();
  return ALLOWED_MIME_TYPES.has(base) || base.startsWith('audio/');
}

export interface VoiceRouterOpts {
  pool?: Pool;
  /**
   * RV-132 — deps for the audio-download endpoint. The retention worker
   * deletes the S3 object but keeps the voice_recordings row (tombstoned
   * via purged_at) and its files FK target intact, so the download path
   * must consult purged_at instead of letting callers chase a dangling
   * S3 404. Optional: absent → the audio endpoint answers 501.
   */
  fileRepo?: FileRepository;
  storage?: StorageProvider;
  /** Tenant-scoped job lookup for optional mobile job-context verification. */
  jobRepo?: Pick<JobRepository, 'findById'>;
}

export function createVoiceRouter(
  voiceRepo: VoiceRepository,
  queue: Queue,
  transcribeAudio?: TranscribeAudioFn,
  auditRepo?: AuditRepository,
  logger?: Logger,
  opts?: VoiceRouterOpts,
): Router {
  const router = Router();

  // UB-B1 — dedicated per-tenant mint limiter. The global /api per-tenant
  // limiter (1000 req/min, app.ts) still applies; conversation mode mints a
  // token per session start, far more often than dictation, so token minting
  // gets its own tighter bucket. Same store/keying conventions as the global
  // limiter (Redis-backed when REDIS_URL is set, per-process MemoryStore
  // otherwise).
  const mintLimitPerMin = Math.max(
    1,
    Number(process.env.VOICE_STREAM_TOKEN_MINTS_PER_MIN) || 30,
  );
  const mintLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: mintLimitPerMin,
    standardHeaders: true,
    legacyHeaders: false,
    // requireTenant runs first, so auth.tenantId is always present; the IP
    // fallback mirrors the global per-tenant limiter's defensive keying.
    keyGenerator: (req) =>
      (req as AuthenticatedRequest).auth?.tenantId ?? ipKeyGenerator(req.ip ?? ''),
    handler: (_req, res) => {
      res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many live-transcription starts. Please wait a minute and try again.',
      });
    },
    store: createRateLimitStore(process.env.REDIS_URL, 'voice-mint:'),
  });

  /**
   * POST /stream-token — Story 3.2: mint a 30s Deepgram grant token for the
   * browser dictation client. The long-lived DEEPGRAM_API_KEY never leaves the
   * server; the browser opens the streaming WebSocket with this short-lived
   * token. Authenticated + tenant-scoped like every other voice route.
   */
  router.post(
    '/stream-token',
    requireAuth,
    requireTenant,
    mintLimiter,
    asyncRoute(async (req: Request, res: Response) => {
      const authReq = req as AuthenticatedRequest;
      const tenantId = authReq.auth!.tenantId;
      const actorId = authReq.auth!.userId;
      const routeName = 'POST /api/voice/stream-token';
      // A2 — session/tenant language hint for the dictation WS, same
      // `?language=` query-param convention as /transcribe's languageHint
      // below. Not used to alter minting (the Deepgram grant token is not
      // language-scoped) — recorded on the audit trail only, so a future
      // per-surface WER/keyterm rollup can attribute mints by language.
      // The browser threads the same value onto the Deepgram WS URL itself
      // (see useDeepgramDictation.ts) independently of this audit record.
      const languageParam = typeof req.query.language === 'string' ? req.query.language : undefined;
      const language = languageParam === 'en' || languageParam === 'es' ? languageParam : undefined;

      // UB-B1 — audit trail for every mint attempt (mirrors the
      // voice.transcription.completed/.failed emission in /transcribe below):
      // conversation mode makes token minting a high-frequency surface, so
      // both successful mints AND mint failures must be attributable per
      // tenant/actor. Failure-soft: an audit-write error never blocks the
      // response, but it is logged at warn level so a silently-broken audit
      // sink is observable instead of swallowed.
      async function auditMint(eventType: string, metadata: Record<string, unknown>) {
        if (!auditRepo) return;
        try {
          await auditRepo.create(createAuditEvent({
            tenantId,
            actorId,
            actorRole: 'user',
            eventType,
            entityType: 'voice_stream_token',
            entityId: `mint-${Date.now()}`,
            metadata,
          }));
        } catch (auditErr) {
          logger?.warn('voice.stream-token: audit write failed', {
            route: routeName,
            tenantId,
            eventType,
            error: auditErr instanceof Error ? auditErr.message : String(auditErr),
          });
        }
      }

      try {
        const minted = await mintDeepgramStreamToken({ apiKey: process.env.DEEPGRAM_API_KEY });
        await auditMint('voice.stream_token_minted', {
          model: minted.model,
          expiresInSeconds: minted.expiresInSeconds,
          ...(language ? { language } : {}),
        });
        res.json({
          token: minted.token,
          expiresIn: minted.expiresInSeconds,
          model: minted.model,
        });
      } catch (err) {
        if (err instanceof DeepgramTokenUnavailableError) {
          await auditMint('voice.stream_token_mint_failed', {
            reason: 'not_configured',
            ...(language ? { language } : {}),
          });
          res.status(503).json({
            error: 'NOT_CONFIGURED',
            message: 'Live transcription is not configured',
          });
          return;
        }
        if (err instanceof DeepgramTokenPermissionError) {
          // Key is set but cannot mint browser grant tokens (needs Member+).
          // Same operator-facing posture as NOT_CONFIGURED: not a transient retry.
          logger?.error('voice.stream-token: key lacks grant permissions', {
            error: err.message,
          });
          await auditMint('voice.stream_token_mint_failed', {
            reason: 'permission_denied',
            ...(language ? { language } : {}),
          });
          res.status(503).json({
            error: 'NOT_CONFIGURED',
            message:
              'Live transcription is misconfigured: Deepgram API key needs Member permissions',
          });
          return;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        logger?.error('voice.stream-token: mint failed', { error: errMsg });
        await auditMint('voice.stream_token_mint_failed', {
          reason: 'provider_error',
          error: errMsg,
          ...(language ? { language } : {}),
        });
        res.status(502).json({
          error: 'TOKEN_MINT_FAILED',
          message: 'Could not start live transcription. Please try again.',
        });
      }
    }),
  );

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

      const authReq = req as AuthenticatedRequest;
      const tenantId = authReq.auth!.tenantId;
      const actorId = authReq.auth!.userId;
      // Optional language hint (ISO 639-1 code) via query param, e.g. ?language=es
      const languageHint = typeof req.query.language === 'string' ? req.query.language : undefined;

      // Helper: emit transcription audit event. Failure-soft: an audit-write
      // error never blocks transcription, but it is logged at warn level so
      // a silently-broken audit sink is observable instead of swallowed.
      async function emitAudit(eventType: string, metadata: Record<string, unknown>) {
        if (!auditRepo) return;
        try {
          await auditRepo.create(createAuditEvent({
            tenantId,
            actorId,
            actorRole: 'user',
            eventType,
            entityType: 'voice_transcription',
            entityId: `txn-${Date.now()}`,
            metadata,
          }));
        } catch (auditErr) {
          logger?.warn('voice.transcribe: audit write failed', {
            route: 'POST /api/voice/transcribe',
            tenantId,
            eventType,
            error: auditErr instanceof Error ? auditErr.message : String(auditErr),
          });
        }
      }

      // Helper: validate and transcribe a buffer
      async function validateAndTranscribe(audioBuffer: Buffer, audioContentType: string) {
        // MIME type validation
        if (!isAllowedMimeType(audioContentType)) {
          logger?.warn('voice.transcribe: rejected unsupported MIME type', {
            tenantId, audioContentType, sizeBytes: audioBuffer.length,
          });
          res.status(415).json({
            error: 'UNSUPPORTED_MEDIA_TYPE',
            message: `Audio type '${audioContentType}' is not supported. Use webm, ogg, wav, mp3, mp4, aac, or flac.`,
          });
          return;
        }

        logger?.info('voice.transcribe: starting', {
          tenantId, audioContentType, sizeBytes: audioBuffer.length,
        });

        const startTime = Date.now();
        const result = await transcribeAudio!(audioBuffer, audioContentType, { language: languageHint });
        const durationMs = Date.now() - startTime;

        logger?.info('voice.transcribe: completed', {
          tenantId,
          audioContentType,
          sizeBytes: audioBuffer.length,
          transcriptionDurationMs: durationMs,
          transcriptLength: result.transcript.length,
          provider: (result.metadata as Record<string, unknown>)?.provider,
        });

        await emitAudit('voice.transcription.completed', {
          audioSizeBytes: audioBuffer.length,
          audioContentType,
          transcriptionDurationMs: durationMs,
          transcriptLength: result.transcript.length,
        });

        res.json(result);
      }

      // Handle multipart/form-data by collecting the raw body from the audio field
      if (contentType.includes('multipart/form-data')) {
        try {
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

          await validateAndTranscribe(audioPart.data, audioPart.contentType || 'audio/webm');
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Unknown error';
          logger?.error('voice.transcribe: failed (multipart)', {
            tenantId, error: errMsg,
            errorCategory: categorizeError(errMsg),
          });
          await emitAudit('voice.transcription.failed', { error: errMsg });
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
          await validateAndTranscribe(rawBody, contentType);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Unknown error';
          logger?.error('voice.transcribe: failed (raw)', {
            tenantId, error: errMsg,
            errorCategory: categorizeError(errMsg),
          });
          await emitAudit('voice.transcription.failed', { error: errMsg });
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
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
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

      let verifiedJobId: string | undefined;
      if (body.jobId !== undefined) {
        const parsedJobId = JOB_ID_SCHEMA.safeParse(body.jobId);
        if (!parsedJobId.success) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'jobId must be a valid UUID',
          });
          return;
        }
        if (!opts?.jobRepo) {
          res.status(503).json({
            error: 'NOT_CONFIGURED',
            message: 'Job verification is not configured',
          });
          return;
        }
        const job = await opts.jobRepo.findById(req.auth!.tenantId, parsedJobId.data);
        if (!job) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' });
          return;
        }
        verifiedJobId = parsedJobId.data;
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
          ...(verifiedJobId ? { jobId: verifiedJobId } : {}),
        },
        `${req.auth!.tenantId}:${recording.id}:transcription:create`
      );

      res.status(202).json({
        recording,
        queueMessageId,
      });
    })
  );

  router.get(
    '/recordings/:id',
    requireAuth,
    requireTenant,
    requirePermission('files:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const recording = await voiceRepo.findById(req.auth!.tenantId, req.params.id);
      if (!recording) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Voice recording not found' });
        return;
      }
      res.json(recording);
    })
  );

  /**
   * RV-132 — recording audio download. Resolves the joined files row to a
   * presigned download URL. A retention-purged recording (purged_at set;
   * audio object deleted, metadata/transcript kept) answers a clear
   * 410 GONE instead of handing out a URL that 404s at S3.
   */
  router.get(
    '/recordings/:id/audio',
    requireAuth,
    requireTenant,
    requirePermission('files:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const recording = await voiceRepo.findById(req.auth!.tenantId, req.params.id);
      if (!recording) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Voice recording not found' });
        return;
      }
      if (recording.purgedAt) {
        res.status(410).json({
          error: 'RECORDING_PURGED',
          message:
            'This recording\'s audio was purged under the tenant retention policy. The transcript and metadata are still available.',
          purgedAt: recording.purgedAt.toISOString(),
        });
        return;
      }
      if (!opts?.fileRepo || !opts?.storage) {
        res.status(501).json({ error: 'NOT_CONFIGURED', message: 'Audio download is not configured' });
        return;
      }
      if (!recording.fileId) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Recording has no stored audio file' });
        return;
      }
      const file = await opts.fileRepo.findById(req.auth!.tenantId, recording.fileId);
      if (!file) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Recording audio file not found' });
        return;
      }
      const downloadUrl = await opts.storage.generateDownloadUrl(
        file.storageBucket,
        file.storageKey,
      );
      res.json({ downloadUrl });
    })
  );

  router.post(
    '/go-live',
    requireAuth,
    requireTenant,
    requirePermission('tenant:manage'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const pool = opts?.pool;
      if (!pool || !auditRepo) {
        res.status(503).json({ error: 'NOT_CONFIGURED', message: 'Voice go-live requires database' });
        return;
      }
      const tenantId = req.auth!.tenantId;
      const userId = req.auth!.userId;
      if (!(await subscriptionAllowsVoice(pool, tenantId))) {
        res.status(402).json({ error: 'BILLING_REQUIRED', message: 'Active subscription required' });
        return;
      }
      const body = await enableVoiceAgentLive(
        { pool, auditRepo },
        { tenantId, actorId: userId, source: 'manual' },
      );
      res.json(body);
    }),
  );

  router.post(
    '/pause',
    requireAuth,
    requireTenant,
    requirePermission('tenant:manage'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const pool = opts?.pool;
      if (!pool || !auditRepo) {
        res.status(503).json({ error: 'NOT_CONFIGURED', message: 'Voice pause requires database' });
        return;
      }
      const body = await pauseVoiceAgentLive(
        { pool, auditRepo },
        { tenantId: req.auth!.tenantId, actorId: req.auth!.userId },
      );
      res.json(body);
    }),
  );

  router.post(
    '/recordings/:id/retry',
    requireAuth,
    requireTenant,
    requirePermission('files:upload'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
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

      // RV-132 — a purged recording has no audio object left to transcribe;
      // re-enqueueing would just send the worker to a dangling S3 404.
      if (existing.purgedAt) {
        res.status(410).json({
          error: 'RECORDING_PURGED',
          message:
            'This recording\'s audio was purged under the tenant retention policy and cannot be re-transcribed.',
          purgedAt: existing.purgedAt.toISOString(),
        });
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
    })
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

/** Categorize transcription errors for observability dashboards. */
function categorizeError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('rate limit') || m.includes('429')) return 'rate_limit';
  if (m.includes('timeout') || m.includes('timed out')) return 'timeout';
  if (m.includes('401') || m.includes('unauthorized') || m.includes('invalid api key')) return 'auth';
  if (m.includes('413') || m.includes('too large')) return 'payload_too_large';
  if (m.includes('network') || m.includes('econnrefused') || m.includes('fetch failed')) return 'network';
  if (m.includes('500') || m.includes('internal server')) return 'provider_error';
  return 'unknown';
}
