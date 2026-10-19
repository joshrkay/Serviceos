import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { createRateLimitStore } from '../middleware/rate-limit-store';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { notFoundOnMalformedId } from '../middleware/validate-uuid-param';
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
  UnsupportedAudioFormatError,
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
import type { TtsProvider } from '../ai/tts/tts-provider';
import { hashOf, type TtsClipCache } from '../ai/tts/clip-cache';
import { createTtsClipBudget, ttsClipsPerMinFromEnv } from '../ai/tts/tts-clip-budget';
import { TTS_BATCH_BODY_SCHEMA } from '../ai/tts/tts-batch';
import { resolveTtsVoice, TTS_VOICE_PRESET_SCHEMA, type ResolvedTtsVoice } from '../ai/tts/resolve-voice';
import type { SettingsRepository } from '../settings/settings';
import { routeParam } from '../shared/route-params';

interface CreateVoiceRecordingBody {
  fileId: string;
  conversationId?: string;
  /**
   * Still required for contract stability (web + mobile send the upload's
   * downloadUrl), but NEVER used: H2 — the transcription audio URL is minted
   * server-side from the tenant-scoped files row named by `fileId`.
   */
  audioUrl: string;
  jobId?: string;
  /**
   * U11 — optional client idempotency key. When present, a replayed create
   * (same tenant+key) returns the ORIGINAL recording instead of minting a
   * duplicate. Bounded to keep it index-friendly; the mobile client mints a
   * UUID today (U12 will make it stable across offline-flush retries).
   */
  idempotencyKey?: string;
}

/** U11 — bound on the client idempotency key length (UUID today; generous headroom). */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // 25 MB
const JOB_ID_SCHEMA = z.guid();
/** H2 review — files.id is uuid: a malformed fileId is a 400, not a Postgres 22P02 → 500. */
const FILE_ID_SCHEMA = z.guid();
/**
 * #1603 — one spoken clip's text; same ceiling as a voice-session turn.
 * S3-1 — `voice` names a tenant voice preset to speak in instead of the
 * tenant's stored choice; vendor voice ids are never accepted.
 */
const TTS_BODY_SCHEMA = z.object({
  text: z.string().trim().min(1).max(2000),
  voice: TTS_VOICE_PRESET_SCHEMA.optional(),
});
/** S3-2 — a clip read may name a preset, as the POST body may. */
const TTS_CLIP_READ_QUERY_SCHEMA = z.object({ voice: TTS_VOICE_PRESET_SCHEMA.optional() });
/** S3-2 — a clip hash is sha256 hex exactly as `hashOf` emits it; anything else is a miss. */
const CLIP_HASH = /^[0-9a-f]{64}$/;

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
  /**
   * #1603 — the unified TtsProvider (the same instance the in-app Assistant
   * speaks through) for POST /tts, which lets the mobile memo screen speak a
   * lookup answer back. Optional: absent → the route answers 501 and the
   * device keeps the answer on screen only.
   */
  tts?: TtsProvider;
  /**
   * S3-1 — the tenant's chosen voice (`tenant_settings.voice_id`, a preset
   * key) for POST /tts. Optional: absent → every clip is spoken in the
   * default preset.
   */
  settingsRepo?: Pick<SettingsRepository, 'findByTenant'>;
  /**
   * S3-1 — clips keyed by (provider voice id, sha256(text)); the onboarding
   * lines are static per trade and voice, so the second owner on a voice
   * pays nothing. Optional: absent → every request synthesizes.
   */
  clipCache?: TtsClipCache;
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

  // #1603 — dedicated per-USER clip budget for POST /tts. Every role holds
  // `ai:run`, and each clip bills the tenant's TTS key, so one account must
  // not be able to turn the route into a free-text TTS proxy under the much
  // looser global per-tenant /api limiter. A memo answer every 3 s is plenty.
  //
  // S3-2 — the budget is charged per clip actually synthesized, never per
  // request: the batch route below draws up to three units from the same
  // per-user budget, a cache hit costs nothing on either route, and a turn
  // that does not fit in what is left is refused whole. express-rate-limit's
  // middleware charges one hit per request, so the cap lives in
  // ai/tts/tts-clip-budget.ts over the same store family instead.
  const ttsClipBudget = createTtsClipBudget({
    max: ttsClipsPerMinFromEnv(process.env),
    store: createRateLimitStore(process.env.REDIS_URL, 'voice-tts:'),
  });

  /**
   * Takes `units` clips out of the caller's budget. On refusal answers the
   * #1603 429 (same body and `Retry-After`) and returns false; the caller
   * then synthesizes nothing.
   */
  async function chargeTtsClips(req: AuthenticatedRequest, res: Response, units: number): Promise<boolean> {
    const charge = await ttsClipBudget.charge(`${req.auth!.tenantId}:${req.auth!.userId}`, units);
    if (charge.ok) return true;
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(charge.retryAfterMs / 1000))));
    res.status(429).json({
      error: 'RATE_LIMITED',
      message: 'Too many spoken answers in a row. The answer is still on screen.',
    });
    return false;
  }

  /**
   * POST /tts — #1603: synthesize one spoken clip for the device.
   *
   * The mobile memo path receives a lookup answer as text (voice-answer
   * contract) and, when the per-device "speak answers" toggle is on, asks
   * here for the audio. Same provider and same `ai:run` gate as the in-app
   * Assistant's session routes, so a technician is authorised exactly like
   * everyone else who reaches the Assistant. Nothing is persisted; the clip
   * is billable, so every success is audited to the actor (chars, provider).
   * Absent provider → 501 (mirrors /transcribe).
   *
   * S3-1 — the clip is spoken in the tenant's chosen voice (or the preset
   * the body names) and cached by (voice, sha256(text)): a hit answers with
   * the stored bytes, no provider call and no audit, since nothing was
   * billed. The response gains `clipHash` and `cached`; `{ audio,
   * contentType }` is unchanged for the mobile consumer.
   *
   * S3-2 — the per-user cap is charged after the cache lookup, one unit per
   * clip synthesized, from the budget the batch route shares.
   */
  router.post(
    '/tts',
    requireAuth,
    requireTenant,
    requirePermission('ai:run'),
    asyncRoute(async (req: Request, res: Response) => {
      // Validate first: a client bug is a 400 even in a keyless environment,
      // not a misleading "not configured".
      const { text, voice: requestedPresetId } = TTS_BODY_SCHEMA.parse(req.body ?? {});
      const tts = opts?.tts;
      if (!tts) {
        res.status(501).json({ error: 'NOT_CONFIGURED', message: 'Speech synthesis is not configured' });
        return;
      }
      const authReq = req as AuthenticatedRequest;
      const tenantId = authReq.auth!.tenantId;
      const voice = await resolveTtsVoice({
        tenantId,
        requestedPresetId,
        settingsRepo: opts?.settingsRepo,
        provider: tts,
      });
      const clipHash = hashOf(text);
      const cached = opts?.clipCache?.get(voice.providerVoiceId, clipHash);
      if (cached) {
        res.json({
          audio: cached.audio.toString('base64'),
          contentType: cached.contentType,
          clipHash,
          cached: true,
        });
        return;
      }
      // S3-2 — one unit for the one clip about to be billed; a hit above
      // and a 400 before it cost nothing.
      if (!(await chargeTtsClips(authReq, res, 1))) return;
      try {
        const result = await synthesizeClip(tts, voice, text, tenantId);
        res.json({
          audio: result.audio.toString('base64'),
          contentType: result.contentType,
          clipHash,
          cached: false,
        });
        await auditSynthesizedClip(authReq, 'POST /api/voice/tts', text, voice, result);
      } catch (err) {
        answerTtsFailed(authReq, res, 'POST /api/voice/tts', err);
      }
    }),
  );

  /**
   * One billable clip: synthesize in the resolved voice and store it. A
   * provider with no catalogue for the presets speaks its own default, so
   * the cache-key placeholder is never passed as a voice name.
   */
  async function synthesizeClip(tts: TtsProvider, voice: ResolvedTtsVoice, text: string, tenantId: string) {
    const result = await tts.synthesize({
      text,
      tenantId,
      ...(tts.voiceForPreset ? { voice: voice.providerVoiceId } : {}),
    });
    opts?.clipCache?.set(voice.providerVoiceId, hashOf(text), {
      audio: result.audio,
      contentType: result.contentType,
    });
    return result;
  }

  /**
   * Cost attribution: who had how many characters spoken by which provider,
   * in which preset (never the vendor voice id). Failure-soft like
   * /transcribe's audit — never blocks the clip, but a broken sink is logged
   * rather than swallowed.
   */
  async function auditSynthesizedClip(
    authReq: AuthenticatedRequest,
    route: string,
    text: string,
    voice: ResolvedTtsVoice,
    result: Awaited<ReturnType<TtsProvider['synthesize']>>,
  ): Promise<void> {
    if (!auditRepo) return;
    try {
      await auditRepo.create(createAuditEvent({
        tenantId: authReq.auth!.tenantId,
        actorId: authReq.auth!.userId,
        actorRole: 'user',
        eventType: 'voice.tts.synthesized',
        entityType: 'voice_tts',
        entityId: `tts-${Date.now()}`,
        metadata: {
          chars: text.length,
          provider: result.provider,
          voice: voice.presetId,
          ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
        },
      }));
    } catch (auditErr) {
      logger?.warn('voice.tts: audit write failed', {
        route,
        tenantId: authReq.auth!.tenantId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
  }

  /**
   * The raw provider text (quota/request ids) is logged, never sent — same
   * posture as /transcribe's honest failures (#1497).
   */
  function answerTtsFailed(authReq: AuthenticatedRequest, res: Response, route: string, err: unknown): void {
    logger?.error('voice.tts: synthesis failed', {
      route,
      tenantId: authReq.auth!.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(502).json({
      error: 'TTS_FAILED',
      message: "Couldn't speak that answer right now — it's still on screen.",
    });
  }

  /**
   * POST /tts/batch — S3-2: one onboarding turn's clips in one request.
   *
   * The v3 shell prefetches the next turn (the question plus two option
   * lines) while the current one plays; three single requests every few
   * seconds would meet the per-user cap for a fast owner, so a turn is one
   * request. The batch is not a way around the cap: it is bounded to one
   * turn (ai/tts/tts-batch.ts — at most three items, 240 characters each,
   * 600 in all, a 400 otherwise before anything is charged or looked up),
   * cache hits are resolved first and cost nothing, the misses are charged
   * in one go from the same per-user budget as POST /tts (a turn that does
   * not fit is a 429 and nothing is synthesized), and each synthesized clip
   * is audited on its own. A provider failure on any clip is a 502 for the
   * whole turn (the client degrades the turn); clips already made stay
   * cached, and the units already taken are not refunded, since the
   * provider may have billed the failed call.
   */
  router.post(
    '/tts/batch',
    requireAuth,
    requireTenant,
    requirePermission('ai:run'),
    asyncRoute(async (req: Request, res: Response) => {
      const { items, voice: requestedPresetId } = TTS_BATCH_BODY_SCHEMA.parse(req.body ?? {});
      const tts = opts?.tts;
      if (!tts) {
        res.status(501).json({ error: 'NOT_CONFIGURED', message: 'Speech synthesis is not configured' });
        return;
      }
      const authReq = req as AuthenticatedRequest;
      const tenantId = authReq.auth!.tenantId;
      const voice = await resolveTtsVoice({
        tenantId,
        requestedPresetId,
        settingsRepo: opts?.settingsRepo,
        provider: tts,
      });

      type Clip = { text: string; clipHash: string; audio: string; contentType: string; cached: boolean };
      const clips: Array<Clip | null> = items.map((text) => {
        const clipHash = hashOf(text);
        const hit = opts?.clipCache?.get(voice.providerVoiceId, clipHash);
        return hit
          ? { text, clipHash, audio: hit.audio.toString('base64'), contentType: hit.contentType, cached: true }
          : null;
      });
      const misses = clips.filter((c) => c === null).length;
      if (!(await chargeTtsClips(authReq, res, misses))) return;

      const spoken: Array<{ text: string; result: Awaited<ReturnType<TtsProvider['synthesize']>> }> = [];
      try {
        for (let i = 0; i < items.length; i += 1) {
          if (clips[i]) continue;
          const text = items[i];
          const result = await synthesizeClip(tts, voice, text, tenantId);
          spoken.push({ text, result });
          clips[i] = {
            text,
            clipHash: hashOf(text),
            audio: result.audio.toString('base64'),
            contentType: result.contentType,
            cached: false,
          };
        }
      } catch (err) {
        answerTtsFailed(authReq, res, 'POST /api/voice/tts/batch', err);
        // What was synthesized before the failure was billed: audit it.
        for (const { text, result } of spoken) {
          await auditSynthesizedClip(authReq, 'POST /api/voice/tts/batch', text, voice, result);
        }
        return;
      }
      res.json({ clips });
      for (const { text, result } of spoken) {
        await auditSynthesizedClip(authReq, 'POST /api/voice/tts/batch', text, voice, result);
      }
    }),
  );

  /**
   * GET /tts/clip/:hash — S3-2: a cached clip by content hash.
   *
   * Replays and reloads of a line the client already heard (it knows the
   * hash from an earlier POST) read the stored bytes straight back: never
   * charged, never synthesized, never audited, since nothing is billed. A
   * miss — an unknown hash, a malformed one, another replica's cache — is a
   * 404 and the client falls back to the charged POST. The voice is the
   * tenant's, or the preset `?voice` names (a 400 otherwise, as on the POST).
   */
  router.get(
    '/tts/clip/:hash',
    requireAuth,
    requireTenant,
    requirePermission('ai:run'),
    asyncRoute(async (req: Request, res: Response) => {
      const hash = routeParam(req, 'hash');
      const requestedPresetId = TTS_CLIP_READ_QUERY_SCHEMA.parse(req.query ?? {}).voice;
      const tts = opts?.tts;
      const cached =
        tts && CLIP_HASH.test(hash)
          ? opts?.clipCache?.get(
              (
                await resolveTtsVoice({
                  tenantId: (req as AuthenticatedRequest).auth!.tenantId,
                  requestedPresetId,
                  settingsRepo: opts?.settingsRepo,
                  provider: tts,
                })
              ).providerVoiceId,
              hash,
            )
          : undefined;
      if (!cached) {
        res.status(404).json({ error: 'NOT_CACHED', message: 'That clip is not cached here' });
        return;
      }
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('ETag', `"${hash}"`);
      res.send(cached.audio);
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

      // #1497 — one failure response for both body shapes. An audio format
      // the transcriber cannot decode is the client's problem (4xx, plain
      // copy); anything else is ours. The raw provider/exception text is
      // logged and audited, never sent to the client.
      async function respondTranscriptionFailure(err: unknown, bodyShape: 'multipart' | 'raw') {
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        logger?.error(`voice.transcribe: failed (${bodyShape})`, {
          tenantId, error: errMsg,
          errorCategory: categorizeError(errMsg),
        });
        await emitAudit('voice.transcription.failed', { error: errMsg });
        if (err instanceof UnsupportedAudioFormatError) {
          res.status(415).json({
            error: 'UNSUPPORTED_AUDIO_FORMAT',
            message: "Sorry, we can't transcribe this audio format. Try recording again, or upload an m4a, mp3, wav or webm file.",
          });
          return;
        }
        res.status(500).json({
          error: 'TRANSCRIPTION_FAILED',
          message: "Sorry, we couldn't transcribe that recording. Please try again.",
        });
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
          await respondTranscriptionFailure(err, 'multipart');
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
          await respondTranscriptionFailure(err, 'raw');
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

      // U11 — optional client idempotency key. Reject a malformed value up
      // front (before any repo/queue work); a missing key stays valid and
      // keeps today's "always mint a new recording" behavior.
      let idempotencyKey: string | undefined;
      if (body.idempotencyKey !== undefined) {
        if (
          typeof body.idempotencyKey !== 'string' ||
          body.idempotencyKey.length === 0 ||
          body.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
        ) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: `idempotencyKey must be a non-empty string of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
          });
          return;
        }
        idempotencyKey = body.idempotencyKey;
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
      if (!FILE_ID_SCHEMA.safeParse(body.fileId).success) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'fileId must be a valid UUID' });
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

      // Enqueue the transcription job under the recording's STABLE create
      // dedupe key. Reused on the replay path below: re-sending with the same
      // key is a no-op if the original job is still queued, but rescues a
      // create-then-crash (row written, request died before enqueue) — the
      // queue's own idempotency makes the re-send safe.
      const enqueueTranscription = (
        recordingId: string,
        audioUrl: string,
        conversationId?: string,
      ) =>
        queue.send(
          'transcription',
          {
            tenantId: req.auth!.tenantId,
            recordingId,
            audioUrl,
            conversationId,
            ...(verifiedJobId ? { jobId: verifiedJobId } : {}),
          },
          `${req.auth!.tenantId}:${recordingId}:transcription:create`,
        );

      // H2 — the transcription audio is server-selected, exactly like the
      // #1248 retry path: enqueueing the client's audioUrl let any caller
      // with files:upload make the worker fetch an arbitrary URL from inside
      // the API process (SSRF, with the HTTP status echoed back through the
      // recording's errorMessage). Resolve the tenant-scoped files row and
      // mint the download URL here; body.audioUrl is never enqueued. Answers
      // the error response itself and returns null when no URL can be minted.
      const serverAudioUrl = async (fileId: string | undefined): Promise<string | null> => {
        if (!opts?.fileRepo || !opts.storage) {
          res.status(503).json({
            error: 'NOT_CONFIGURED',
            message: 'Recording storage is not configured',
          });
          return null;
        }
        const file = fileId ? await opts.fileRepo.findById(req.auth!.tenantId, fileId) : null;
        if (!file) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Recording audio file not found' });
          return null;
        }
        // H2 review M2 — only the caller's own memo upload (what web and
        // mobile request via /api/files/upload-url: entityType
        // 'voice_recording', uploadedBy = this user). The Twilio webhooks
        // write voice_recording files too; re-posting one would launder
        // caller audio into a trusted 'inapp_voice' operator memo and skip
        // the voicemail caller-ID / STIR gate.
        if (file.entityType !== 'voice_recording' || file.uploadedBy !== req.auth!.userId) {
          res.status(403).json({
            error: 'RECORDING_FILE_NOT_OWNED',
            message: 'Recording file must be your own voice memo upload',
          });
          return null;
        }
        if (!isAllowedMimeType(file.contentType)) {
          res.status(409).json({
            error: 'INVALID_RECORDING_AUDIO',
            message: 'Recording file is not audio',
          });
          return null;
        }
        return opts.storage.generateDownloadUrl(file.storageBucket, file.storageKey);
      };

      // U11 — replay guard. A repeated create carrying an idempotency key that
      // already resolves to a recording in this tenant MUST return the ORIGINAL
      // recording (never a duplicate) AND re-issue the queue send: if the first
      // request died between voiceRepo.create and the enqueue, the row would
      // otherwise be stranded in 'pending' forever (the ~90s client poll times
      // out). The re-send is dedupe-safe. Not a fresh create, so nothing new to
      // audit here. The audio comes from the ORIGINAL recording's file — the
      // replayed body is not trusted to name it.
      if (idempotencyKey) {
        const existing = await voiceRepo.findByIdempotencyKey(
          req.auth!.tenantId,
          idempotencyKey,
        );
        if (existing) {
          const audioUrl = await serverAudioUrl(existing.fileId);
          if (audioUrl === null) return;
          const queueMessageId = await enqueueTranscription(
            existing.id,
            audioUrl,
            existing.conversationId,
          );
          res.status(202).json({
            recording: existing,
            queueMessageId,
          });
          return;
        }
      }

      const audioUrl = await serverAudioUrl(body.fileId);
      if (audioUrl === null) return;

      const recording = await voiceRepo.create(
        createVoiceRecording({
          tenantId: req.auth!.tenantId,
          fileId: body.fileId,
          conversationId: body.conversationId,
          createdBy: req.auth!.userId,
          idempotencyKey,
        })
      );

      const queueMessageId = await enqueueTranscription(
        recording.id,
        audioUrl,
        body.conversationId,
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
    notFoundOnMalformedId('Voice recording not found'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const recording = await voiceRepo.findById(req.auth!.tenantId, routeParam(req, 'id'));
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
    notFoundOnMalformedId('Voice recording not found'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const recording = await voiceRepo.findById(req.auth!.tenantId, routeParam(req, 'id'));
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
    notFoundOnMalformedId('Voice recording not found'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const existing = await voiceRepo.findById(req.auth!.tenantId, routeParam(req, 'id'));
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

      // #1248 — retry audio is server-selected. Accepting an audioUrl in the
      // request lets an authenticated caller make the worker fetch an
      // arbitrary URL (SSRF) or substitute different audio under the original
      // recording owner's trust. Resolve the tenant-scoped files row attached
      // to this recording and mint a fresh download URL instead.
      if (!opts?.fileRepo || !opts.storage) {
        res.status(503).json({
          error: 'NOT_CONFIGURED',
          message: 'Recording retry storage is not configured',
        });
        return;
      }
      if (!existing.fileId) {
        res.status(404).json({
          error: 'NOT_FOUND',
          message: 'Recording has no stored audio file',
        });
        return;
      }
      const file = await opts.fileRepo.findById(req.auth!.tenantId, existing.fileId);
      if (!file) {
        res.status(404).json({
          error: 'NOT_FOUND',
          message: 'Recording audio file not found',
        });
        return;
      }
      if (!isAllowedMimeType(file.contentType)) {
        res.status(409).json({
          error: 'INVALID_RECORDING_AUDIO',
          message: 'Recording file is not audio',
        });
        return;
      }
      const audioUrl = await opts.storage.generateDownloadUrl(file.storageBucket, file.storageKey);

      await voiceRepo.updateStatus(req.auth!.tenantId, existing.id, 'pending');
      const queueMessageId = await queue.send(
        'transcription',
        {
          tenantId: req.auth!.tenantId,
          recordingId: existing.id,
          audioUrl,
          conversationId: existing.conversationId,
          // #1231 — deliberately NO voicemail/trust field: the worker derives
          // untrusted status from the recording row. retryRequestedBy is
          // audit attribution only (#1244 review).
          retryRequestedBy: req.auth!.userId,
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
