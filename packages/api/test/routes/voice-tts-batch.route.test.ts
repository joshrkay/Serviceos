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

  it('at the default cap of 20: twenty clips spent, the 21st request for a cached text is still a 200', async () => {
    vi.stubEnv('VOICE_TTS_PER_MIN', '');
    const tts = fakeTts();
    const app = buildApp({ tts });

    for (let i = 0; i < 20; i += 1) {
      expect((await single(app, `Spoken line number ${i}.`)).status).toBe(200);
    }
    const hit = await single(app, 'Spoken line number 7.');
    expect(hit.status).toBe(200);
    expect(hit.body.cached).toBe(true);
    expect((await single(app, 'A brand new line.')).status).toBe(429);
    expect(tts.synthesize).toHaveBeenCalledTimes(20);
  });
});

describe('POST /api/voice/tts/batch — bounded to one turn (the provider-spend guard)', () => {
  it('an item over 240 characters is a 400: nothing charged, nothing synthesized', async () => {
    const tts = fakeTts();
    const app = buildApp({ tts, clipsPerMin: 1 });

    const res = await batch(app, [TURN[0], 'x'.repeat(241)]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.details.fields)).toContain('items');
    expect(tts.synthesize).not.toHaveBeenCalled();
    // Nothing was charged: the one unit is still there.
    expect((await single(app, TURN[0])).status).toBe(200);
  });

  it('four items is a 400', async () => {
    const tts = fakeTts();
    const res = await batch(buildApp({ tts }), [...TURN, 'One more line.']);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(tts.synthesize).not.toHaveBeenCalled();
  });

  it('three items under 240 each but over 600 in total is a 400', async () => {
    const tts = fakeTts();
    const res = await batch(buildApp({ tts }), ['a'.repeat(200), 'b'.repeat(200), 'c'.repeat(201)]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.details.fields)).toContain('items');
    expect(tts.synthesize).not.toHaveBeenCalled();
  });

  it('an empty or whitespace-only item, or no items at all, is a 400', async () => {
    const tts = fakeTts();
    const app = buildApp({ tts });

    expect((await batch(app, [TURN[0], ''])).status).toBe(400);
    expect((await batch(app, [TURN[0], '   '])).status).toBe(400);
    expect((await batch(app, [])).status).toBe(400);
    expect((await request(app).post('/api/voice/tts/batch').send({})).status).toBe(400);
    expect(tts.synthesize).not.toHaveBeenCalled();
  });

  it('a three-item turn exactly at the caps is a 200, in order, in the tenant voice', async () => {
    const tts = fakeTts();
    const items = ['q'.repeat(240), 'a'.repeat(240), 'b'.repeat(120)];

    const res = await batch(buildApp({ tts }), items);

    expect(res.status).toBe(200);
    expect(res.body.clips).toHaveLength(3);
    expect(res.body.clips.map((c: { text: string }) => c.text)).toEqual(items);
    for (const [i, clip] of (res.body.clips as Array<Record<string, unknown>>).entries()) {
      expect(clip).toMatchObject({
        clipHash: hashOf(items[i]),
        contentType: 'audio/mpeg',
        cached: false,
        audio: Buffer.from(`mp3:${ADAM}:${items[i]}`).toString('base64'),
      });
    }
    expect(tts.synthesize).toHaveBeenCalledTimes(3);
    expect(tts.synthesize).toHaveBeenCalledWith(expect.objectContaining({ text: items[0], voice: ADAM, tenantId: TENANT }));
  });

  it('refuses an unauthenticated request with 401', async () => {
    expect((await batch(buildApp({ auth: null }), TURN)).status).toBe(401);
  });

  it("body voice: 'bella' overrides the tenant voice; 'santa' is a 400 naming `voice`", async () => {
    const tts = fakeTts();
    const app = buildApp({ tts });

    const bella = await batch(app, [TURN[0]], 'bella');
    expect(bella.status).toBe(200);
    expect(tts.synthesize).toHaveBeenLastCalledWith(expect.objectContaining({ voice: BELLA }));

    const santa = await batch(app, [TURN[0]], 'santa');
    expect(santa.status).toBe(400);
    expect(Object.keys(santa.body.details.fields)).toContain('voice');
    expect(tts.synthesize).toHaveBeenCalledTimes(1);
  });

  it('answers 501 NOT_CONFIGURED when no TTS provider is wired', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: 'u', sessionId: 's', tenantId: TENANT, role: 'owner' } as Auth;
      next();
    });
    app.use(
      '/api/voice',
      createVoiceRouter(
        new InMemoryVoiceRepository(),
        { send: vi.fn(async () => 'queued-1') } as unknown as Queue,
        undefined,
        new InMemoryAuditRepository(),
        undefined,
        {},
      ),
    );
    const res = await batch(app, TURN);
    expect(res.status).toBe(501);
    expect(res.body.error).toBe('NOT_CONFIGURED');
  });
});

describe('POST /api/voice/tts/batch — charged per clip from the one per-user budget', () => {
  it('three uncached items charge three units: with a cap of 4, one single clip still fits and the next does not', async () => {
    const tts = fakeTts();
    const app = buildApp({ tts, clipsPerMin: 4 });

    const res = await batch(app, TURN);
    expect(res.status).toBe(200);
    expect(res.body.clips.map((c: { cached: boolean }) => c.cached)).toEqual([false, false, false]);
    expect(tts.synthesize).toHaveBeenCalledTimes(3);

    expect((await single(app, 'A fourth line.')).status).toBe(200);
    expect((await single(app, 'A fifth line.')).status).toBe(429);
    expect(tts.synthesize).toHaveBeenCalledTimes(4);
  });

  it('at the default cap of 20: three uncached items leave 17 — seventeen more single clips fit, the eighteenth does not', async () => {
    vi.stubEnv('VOICE_TTS_PER_MIN', '');
    const tts = fakeTts();
    const app = buildApp({ tts });

    expect((await batch(app, TURN)).status).toBe(200);
    for (let i = 0; i < 17; i += 1) {
      expect((await single(app, `Spoken line number ${i}.`)).status).toBe(200);
    }
    expect((await single(app, 'One line too many.')).status).toBe(429);
    expect(tts.synthesize).toHaveBeenCalledTimes(20);
  });

  it('the same line twice in one turn is spoken and charged once: the repeat is served the clip just made', async () => {
    const tts = fakeTts();
    const audit = recordingAudit();
    const app = buildApp({ tts, auditRepo: audit, clipsPerMin: 2 });

    const res = await batch(app, [TURN[0], TURN[0]]);
    expect(res.status).toBe(200);
    expect(res.body.clips.map((c: { text: string }) => c.text)).toEqual([TURN[0], TURN[0]]);
    expect(res.body.clips[1].audio).toBe(res.body.clips[0].audio);
    expect(tts.synthesize).toHaveBeenCalledTimes(1);
    expect(audit.create).toHaveBeenCalledTimes(1);
    // One unit spent of two: one more new line still fits.
    expect((await single(app, TURN[1])).status).toBe(200);
    expect((await single(app, TURN[2])).status).toBe(429);
  });

  it('the same turn again charges zero: every clip a cache hit, no provider call, even with the budget spent', async () => {
    const tts = fakeTts();
    const app = buildApp({ tts, clipsPerMin: 3 });

    expect((await batch(app, TURN)).status).toBe(200);
    const again = await batch(app, TURN);

    expect(again.status).toBe(200);
    expect(again.body.clips.map((c: { cached: boolean }) => c.cached)).toEqual([true, true, true]);
    expect(again.body.clips.map((c: { clipHash: string }) => c.clipHash)).toEqual(TURN.map(hashOf));
    expect(tts.synthesize).toHaveBeenCalledTimes(3);
  });

  it('one cached and two uncached items charge two', async () => {
    const tts = fakeTts();
    const app = buildApp({ tts, clipsPerMin: 3 });

    expect((await single(app, TURN[0])).status).toBe(200); // 1 of 3 spent
    const res = await batch(app, TURN); // two misses: 3 of 3 spent

    expect(res.status).toBe(200);
    expect(res.body.clips.map((c: { cached: boolean }) => c.cached)).toEqual([true, false, false]);
    expect(tts.synthesize).toHaveBeenCalledTimes(3);
    expect((await single(app, 'A fourth line.')).status).toBe(429);
  });

  it('a turn whose misses exceed the remaining budget is a 429 with no provider call and no partial charge', async () => {
    const tts = fakeTts();
    const app = buildApp({ tts, clipsPerMin: 3 });

    expect((await single(app, 'Already spoken.')).status).toBe(200); // 2 left
    const res = await batch(app, TURN); // 3 misses

    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      error: 'RATE_LIMITED',
      message: 'Too many spoken answers in a row. The answer is still on screen.',
    });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(tts.synthesize).toHaveBeenCalledTimes(1);
    // The two remaining units are still there: a two-miss turn fits.
    const smaller = await batch(app, [TURN[0], TURN[1]]);
    expect(smaller.status).toBe(200);
    expect(tts.synthesize).toHaveBeenCalledTimes(3);
  });

  it('the single route and the batch draw from one budget: twenty single clips leave a batch with nothing', async () => {
    const tts = fakeTts();
    const app = buildApp({ tts, clipsPerMin: 20 });

    for (let i = 0; i < 20; i += 1) {
      expect((await single(app, `Spoken line number ${i}.`)).status).toBe(200);
    }
    const res = await batch(app, [TURN[0]]);

    expect(res.status).toBe(429);
    expect(tts.synthesize).toHaveBeenCalledTimes(20);
  });

  it('audits every synthesized clip on its own (chars per clip, the preset, never the vendor id) and no cache hit', async () => {
    const audit = recordingAudit();
    const app = buildApp({ auditRepo: audit, clipsPerMin: 5 });

    expect((await single(app, TURN[0])).status).toBe(200);
    audit.create.mockClear();
    expect((await batch(app, TURN)).status).toBe(200);

    expect(audit.create).toHaveBeenCalledTimes(2);
    const metas = audit.create.mock.calls.map((c) => (c[0] as { metadata: Record<string, unknown> }).metadata);
    expect(metas).toEqual([
      expect.objectContaining({ chars: TURN[1].length, provider: 'fake', voice: 'adam' }),
      expect.objectContaining({ chars: TURN[2].length, provider: 'fake', voice: 'adam' }),
    ]);
    for (const call of audit.create.mock.calls) {
      expect(call[0]).toMatchObject({ tenantId: TENANT, actorId: 'user-owner-1', eventType: 'voice.tts.synthesized' });
      expect(JSON.stringify(call[0])).not.toContain(ADAM);
    }
  });

  it('a provider failure on one clip is a 502 TTS_FAILED for the whole turn that leaks nothing; clips already made stay cached', async () => {
    const tts = fakeTts();
    tts.synthesize
      .mockImplementationOnce(async (input: { text: string; voice?: string }) => ({
        audio: Buffer.from(`mp3:${input.voice}:${input.text}`),
        contentType: 'audio/mpeg',
        provider: 'fake',
      }))
      .mockRejectedValueOnce(new Error('ElevenLabs 429 quota_exceeded req_9f8e'));
    const app = buildApp({ tts });

    const res = await batch(app, TURN);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('TTS_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('quota_exceeded');
    expect(JSON.stringify(res.body)).not.toContain('req_9f8e');
    expect(tts.synthesize).toHaveBeenCalledTimes(2);

    // The first clip was stored before the failure.
    const first = await single(app, TURN[0]);
    expect(first.body.cached).toBe(true);
    expect(tts.synthesize).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/voice/tts/clip/:hash — a cached clip by content hash, never charged, never synthesized', () => {
  it('serves a cached clip as raw bytes with its content type, a private cache header and the hash as ETag', async () => {
    const tts = fakeTts();
    const app = buildApp({ tts, clipsPerMin: 1 });
    const made = await single(app, TURN[0]); // the one unit is spent
    expect(made.status).toBe(200);

    const res = await request(app).get(`/api/voice/tts/clip/${made.body.clipHash}`).buffer(true).parse(binaryParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^audio\/mpeg/);
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    expect(res.headers['etag']).toBe(`"${made.body.clipHash}"`);
    expect((res.body as Buffer).toString()).toBe(`mp3:${ADAM}:${TURN[0]}`);
    expect(tts.synthesize).toHaveBeenCalledTimes(1);
    // Nothing was charged: the budget is still spent, not over-spent, and a read never refuses.
    expect((await request(app).get(`/api/voice/tts/clip/${made.body.clipHash}`)).status).toBe(200);
  });

  it('an unknown hash is a 404 NOT_CACHED with no provider call (the client falls back to the charged POST)', async () => {
    const tts = fakeTts();
    const res = await request(buildApp({ tts })).get(`/api/voice/tts/clip/${hashOf('never spoken')}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_CACHED');
    expect(tts.synthesize).not.toHaveBeenCalled();
  });

  it('a malformed hash is a 404 too', async () => {
    const tts = fakeTts();
    const app = buildApp({ tts });

    expect((await request(app).get('/api/voice/tts/clip/not-a-hash')).status).toBe(404);
    expect((await request(app).get(`/api/voice/tts/clip/${'A'.repeat(64)}`)).status).toBe(404);
    expect((await request(app).get(`/api/voice/tts/clip/${'a'.repeat(63)}`)).status).toBe(404);
    expect(tts.synthesize).not.toHaveBeenCalled();
  });

  it('reads in the tenant voice: a clip made in another voice is a miss unless ?voice names it; a bad ?voice is a 400', async () => {
    const tts = fakeTts();
    const app = buildApp({ tts });
    const bella = await batch(app, [TURN[1]], 'bella');
    const hash = bella.body.clips[0].clipHash as string;

    expect((await request(app).get(`/api/voice/tts/clip/${hash}`)).status).toBe(404);
    const res = await request(app).get(`/api/voice/tts/clip/${hash}?voice=bella`).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe(`mp3:${BELLA}:${TURN[1]}`);
    expect((await request(app).get(`/api/voice/tts/clip/${hash}?voice=santa`)).status).toBe(400);
    expect(tts.synthesize).toHaveBeenCalledTimes(1);
  });

  it('refuses an unauthenticated request with 401', async () => {
    expect((await request(buildApp({ auth: null })).get(`/api/voice/tts/clip/${hashOf(TURN[0])}`)).status).toBe(401);
  });
});

/** supertest parses only text/JSON by default; audio bytes need a buffer parser. */
function binaryParser(res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
