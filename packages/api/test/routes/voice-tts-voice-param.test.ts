/**
 * S3-1 (plan U4) — POST /api/voice/tts speaks in the tenant's chosen voice
 * and serves repeated lines from the clip cache.
 *
 * The onboarding shell says "you've been hearing me in this voice", so the
 * route resolves `tenant_settings.voice_id` (a preset key) to the provider's
 * voice id, lets the body name a preset to override it, and caches each clip
 * by (voice, sha256(text)) so the second owner on a voice pays nothing.
 *
 * Seam: the route (supertest) through the REAL requireAuth / requireTenant /
 * requirePermission chain, with a fake TtsProvider at the provider boundary
 * and a fake settings repository at the database boundary (the real column
 * is pinned by test/integration/voice-tts-voice-resolution.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
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

const TENANT = 'aaaa5301-e5f6-7890-abcd-ef1234567890';
const ADAM = 'pNInz6obpgDQGcFmaJgB';
const RACHEL = '21m00Tcm4TlvDq8ikWAM';
const BELLA = 'EXAVITQu4vr4xnSDxMaL';
const LINE = 'Tap one to hear it.';

type Auth = NonNullable<AuthenticatedRequest['auth']>;

/** Database boundary: only `voice_id` matters to this route. */
function fakeSettings(voiceId: string | null | undefined): Pick<SettingsRepository, 'findByTenant'> {
  return {
    findByTenant: vi.fn(async () =>
      voiceId === undefined ? null : ({ tenantId: TENANT, voiceId } as unknown as TenantSettings),
    ),
  };
}

/** Provider boundary: an ElevenLabs-shaped provider that records its input. */
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

function buildApp(opts: {
  tts?: TtsProvider;
  settingsRepo?: Pick<SettingsRepository, 'findByTenant'>;
  clipCache?: TtsClipCache;
  auditRepo?: AuditRepository;
  auth?: Partial<Auth>;
}) {
  const app = express();
  app.use(express.json());
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
  app.use(
    '/api/voice',
    createVoiceRouter(
      new InMemoryVoiceRepository(),
      { send: vi.fn(async () => 'queued-1') } as unknown as Queue,
      undefined,
      opts.auditRepo ?? new InMemoryAuditRepository(),
      undefined,
      {
        ...(opts.tts ? { tts: opts.tts } : {}),
        ...(opts.settingsRepo ? { settingsRepo: opts.settingsRepo } : {}),
        ...(opts.clipCache ? { clipCache: opts.clipCache } : {}),
      },
    ),
  );
  return app;
}

describe('POST /api/voice/tts — the tenant voice and the clip cache (S3-1)', () => {
  it("a tenant with voice_id='adam' is spoken with Adam's provider voice id, once", async () => {
    const tts = fakeTts();
    const app = buildApp({ tts, settingsRepo: fakeSettings('adam'), clipCache: new TtsClipCache() });

    const res = await request(app).post('/api/voice/tts').send({ text: LINE });

    expect(res.status).toBe(200);
    expect(tts.synthesize).toHaveBeenCalledTimes(1);
    expect(tts.synthesize).toHaveBeenCalledWith(expect.objectContaining({ text: LINE, voice: ADAM, tenantId: TENANT }));
    expect(res.body).toMatchObject({
      contentType: 'audio/mpeg',
      cached: false,
      clipHash: hashOf(LINE),
      audio: Buffer.from(`mp3:${ADAM}:${LINE}`).toString('base64'),
    });
  });

  it('the same text again is served from the cache: provider not called, cached: true, same clipHash', async () => {
    const tts = fakeTts();
    const app = buildApp({ tts, settingsRepo: fakeSettings('adam'), clipCache: new TtsClipCache() });

    const first = await request(app).post('/api/voice/tts').send({ text: LINE });
    const second = await request(app).post('/api/voice/tts').send({ text: `  ${LINE}  ` });

    expect(second.status).toBe(200);
    expect(tts.synthesize).toHaveBeenCalledTimes(1);
    expect(second.body.cached).toBe(true);
    expect(second.body.clipHash).toBe(first.body.clipHash);
    expect(second.body.audio).toBe(first.body.audio);
    expect(second.body.contentType).toBe('audio/mpeg');
  });

  it("body voice: 'bella' overrides the tenant voice, and is cached apart from it", async () => {
    const tts = fakeTts();
    const app = buildApp({ tts, settingsRepo: fakeSettings('adam'), clipCache: new TtsClipCache() });

    await request(app).post('/api/voice/tts').send({ text: LINE });
    const bella = await request(app).post('/api/voice/tts').send({ text: LINE, voice: 'bella' });

    expect(bella.status).toBe(200);
    expect(bella.body.cached).toBe(false);
    expect(tts.synthesize).toHaveBeenCalledTimes(2);
    expect(tts.synthesize).toHaveBeenLastCalledWith(expect.objectContaining({ voice: BELLA }));
  });

  it("body voice: 'santa' is a 400 naming `voice`; the provider is not called", async () => {
    const tts = fakeTts();
    const settingsRepo = fakeSettings('adam');
    const app = buildApp({ tts, settingsRepo, clipCache: new TtsClipCache() });

    const res = await request(app).post('/api/voice/tts').send({ text: LINE, voice: 'santa' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.details.fields)).toContain('voice');
    expect(tts.synthesize).not.toHaveBeenCalled();
    expect(settingsRepo.findByTenant).not.toHaveBeenCalled();
  });

  it('a tenant with voice_id null, or no settings row, hears the default preset', async () => {
    for (const stored of [null, undefined]) {
      const tts = fakeTts();
      const app = buildApp({ tts, settingsRepo: fakeSettings(stored), clipCache: new TtsClipCache() });

      const res = await request(app).post('/api/voice/tts').send({ text: LINE });

      expect(res.status).toBe(200);
      expect(tts.synthesize).toHaveBeenCalledWith(expect.objectContaining({ voice: RACHEL }));
    }
  });

  it('without a settings repository the route still speaks, in the default preset', async () => {
    const tts = fakeTts();
    const res = await request(buildApp({ tts })).post('/api/voice/tts').send({ text: LINE });

    expect(res.status).toBe(200);
    expect(tts.synthesize).toHaveBeenCalledWith(expect.objectContaining({ voice: RACHEL }));
  });

  it('a provider with no voice catalogue is called without `voice` and still caches under one voice', async () => {
    const tts = fakeTts();
    delete tts.voiceForPreset;
    const app = buildApp({ tts, settingsRepo: fakeSettings('adam'), clipCache: new TtsClipCache() });

    const first = await request(app).post('/api/voice/tts').send({ text: LINE });
    const second = await request(app).post('/api/voice/tts').send({ text: LINE });

    expect(first.status).toBe(200);
    expect(tts.synthesize).toHaveBeenCalledTimes(1);
    expect(tts.synthesize.mock.calls[0][0]).not.toHaveProperty('voice');
    expect(second.body.cached).toBe(true);
  });

  it("the audit row carries voice: 'adam' (the preset) and never the provider's voice id; a cache hit is not audited", async () => {
    const audit = recordingAudit();
    const app = buildApp({
      tts: fakeTts(),
      settingsRepo: fakeSettings('adam'),
      clipCache: new TtsClipCache(),
      auditRepo: audit,
    });

    await request(app).post('/api/voice/tts').send({ text: LINE });
    await request(app).post('/api/voice/tts').send({ text: LINE });

    expect(audit.create).toHaveBeenCalledTimes(1);
    const event = audit.create.mock.calls[0][0] as { eventType: string; metadata: Record<string, unknown> };
    expect(event.eventType).toBe('voice.tts.synthesized');
    expect(event.metadata).toMatchObject({ chars: LINE.length, provider: 'fake', voice: 'adam' });
    expect(JSON.stringify(event)).not.toContain(ADAM);
  });

  it('a provider failure stores nothing, so the next request tries the provider again', async () => {
    const tts = fakeTts();
    tts.synthesize.mockRejectedValueOnce(new Error('ElevenLabs 500'));
    const app = buildApp({ tts, settingsRepo: fakeSettings('adam'), clipCache: new TtsClipCache() });

    const failed = await request(app).post('/api/voice/tts').send({ text: LINE });
    const retried = await request(app).post('/api/voice/tts').send({ text: LINE });

    expect(failed.status).toBe(502);
    expect(retried.status).toBe(200);
    expect(retried.body.cached).toBe(false);
    expect(tts.synthesize).toHaveBeenCalledTimes(2);
  });

  it('the 1603 contract still holds: `audio` is the base64 clip and `contentType` its MIME type', async () => {
    const res = await request(buildApp({ tts: fakeTts(), settingsRepo: fakeSettings('adam') }))
      .post('/api/voice/tts')
      .send({ text: LINE });

    expect(res.status).toBe(200);
    expect(Buffer.from(res.body.audio, 'base64').toString()).toBe(`mp3:${ADAM}:${LINE}`);
    expect(res.body.contentType).toBe('audio/mpeg');
  });
});
