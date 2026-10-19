/**
 * S3-2 (plan U4) — one onboarding turn's clips in one request, charged per
 * clip, with free reads of cached clips by content hash.
 *
 *   POST /api/voice/tts/batch        the question plus at most two option lines
 *   GET  /api/voice/tts/clip/:hash   a cached clip, never charged, never synthesized
 *
 * The budget is the one #1603 keeps for POST /api/voice/tts (VOICE_TTS_PER_MIN
 * clips per user per minute): the batch resolves cache hits first, charges one
 * unit per miss before any provider call, and a turn that does not fit is
 * refused whole. The single route draws from the same budget, so twenty
 * single clips leave a batch with nothing.
 *
 * Seam: the routes (supertest) through the REAL requireAuth / requireTenant /
 * requirePermission chain, a fake TtsProvider at the vendor boundary and a
 * fake settings repository at the database boundary (the real column is
 * pinned by test/integration/voice-tts-voice-resolution.test.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { createVoiceRouter } from '../../src/routes/voice';
import { InMemoryVoiceRepository } from '../../src/voice/voice-service';
import { InMemoryAuditRepository, type AuditRepository } from '../../src/audit/audit';
import type { Queue } from '../../src/queues/queue';
import type { TtsProvider } from '../../src/ai/tts/tts-provider';
import { TtsClipCache, hashOf } from '../../src/ai/tts/clip-cache';
import type { SettingsRepository, TenantSettings } from '../../src/settings/settings';

const TENANT = 'aaaa5302-e5f6-7890-abcd-ef1234567890';
const ADAM = 'pNInz6obpgDQGcFmaJgB';
const BELLA = 'EXAVITQu4vr4xnSDxMaL';

/** A plumbing greeting turn: the question and its two option lines. */
const TURN = [
  'How should I answer your phone?',
  'Acme Plumbing, how can I help?',
  "Thanks for calling Acme Plumbing. What's going on today?",
];

type Auth = NonNullable<AuthenticatedRequest['auth']>;

function fakeSettings(voiceId: string | null): Pick<SettingsRepository, 'findByTenant'> {
  return { findByTenant: vi.fn(async () => ({ tenantId: TENANT, voiceId } as unknown as TenantSettings)) };
}

function fakeTts(): TtsProvider & { synthesize: ReturnType<typeof vi.fn> } {
  return {
    synthesize: vi.fn(async (input: { text: string; voice?: string }) => ({
      audio: Buffer.from(`mp3:${input.voice ?? 'none'}:${input.text}`),
      contentType: 'audio/mpeg',
      provider: 'fake',
    })),
    voiceForPreset: (preset) => preset.elevenLabsVoiceId,
  };
}

function recordingAudit(): AuditRepository & { create: ReturnType<typeof vi.fn> } {
  return { create: vi.fn(async (e: unknown) => e) } as unknown as AuditRepository & {
    create: ReturnType<typeof vi.fn>;
  };
}

/**
 * `clipsPerMin` stubs VOICE_TTS_PER_MIN before the router is built (the cap
 * is read at creation, as #1603's test relies on).
 */
function buildApp(opts: {
  tts?: TtsProvider;
  voiceId?: string | null;
  clipCache?: TtsClipCache;
  auditRepo?: AuditRepository;
  auth?: Partial<Auth> | null;
  clipsPerMin?: number;
} = {}) {
  if (opts.clipsPerMin !== undefined) vi.stubEnv('VOICE_TTS_PER_MIN', String(opts.clipsPerMin));
  const app = express();
  app.use(express.json());
  if (opts.auth !== null) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-owner-1',
        sessionId: 'sess-1',
        tenantId: TENANT,
        role: 'owner',
        ...opts.auth,
      } as Auth;
      next();
    });
  }
  app.use(
    '/api/voice',
    createVoiceRouter(
      new InMemoryVoiceRepository(),
      { send: vi.fn(async () => 'queued-1') } as unknown as Queue,
      undefined,
      opts.auditRepo ?? new InMemoryAuditRepository(),
      undefined,
      {
        tts: opts.tts ?? fakeTts(),
        settingsRepo: fakeSettings(opts.voiceId === undefined ? 'adam' : opts.voiceId),
        clipCache: opts.clipCache ?? new TtsClipCache(),
      },
    ),
  );
  return app;
}

const single = (app: express.Express, text: string) => request(app).post('/api/voice/tts').send({ text });
const batch = (app: express.Express, items: unknown, voice?: string) =>
  request(app).post('/api/voice/tts/batch').send({ items, ...(voice ? { voice } : {}) });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/voice/tts — charged per synthesized clip, never per request', () => {
  it('a cache hit costs nothing: with a cap of 2, the same text a third time is still a 200', async () => {
    const tts = fakeTts();
    const app = buildApp({ tts, clipsPerMin: 2 });

    expect((await single(app, TURN[0])).status).toBe(200);
    expect((await single(app, TURN[1])).status).toBe(200);
    // Both units are spent; a repeat of either is a hit and is not charged.
    const hit = await single(app, TURN[0]);
    expect(hit.status).toBe(200);
    expect(hit.body.cached).toBe(true);
    // A new text is a miss and the budget is gone.
    const miss = await single(app, TURN[2]);
    expect(miss.status).toBe(429);
    expect(miss.body).toEqual({
      error: 'RATE_LIMITED',
      message: 'Too many spoken answers in a row. The answer is still on screen.',
    });
    expect(Number(miss.headers['retry-after'])).toBeGreaterThan(0);
    expect(tts.synthesize).toHaveBeenCalledTimes(2);
  });

  it('a rejected body (400) and a bad voice are not charged either', async () => {
    const tts = fakeTts();
    const app = buildApp({ tts, clipsPerMin: 1 });

    expect((await single(app, '   ')).status).toBe(400);
    expect((await request(app).post('/api/voice/tts').send({ text: TURN[0], voice: 'santa' })).status).toBe(400);
    expect((await single(app, TURN[0])).status).toBe(200);
    expect(tts.synthesize).toHaveBeenCalledTimes(1);
  });
});
