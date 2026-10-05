/**
 * #1603 — POST /api/voice/tts: the device speaks a memo answer back.
 *
 * The mobile memo path renders a lookup answer as text; to speak it the
 * client asks the SAME server TTS the in-app Assistant already uses (the
 * unified TtsProvider) for one clip. Technicians hold `ai:run` (owner
 * decision 2026-07-27, auth/rbac.ts), so a technician is authorised here
 * exactly like the voice-session routes.
 *
 * Seam: the route (supertest) through the REAL requireAuth / requireTenant /
 * requirePermission chain, with a fake TtsProvider at the provider boundary.
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

const TENANT = 'aaaa1603-e5f6-7890-abcd-ef1234567890';

type Auth = NonNullable<AuthenticatedRequest['auth']>;

function buildApp(opts: { auth: Partial<Auth> | null; tts?: TtsProvider; auditRepo?: AuditRepository }) {
  const app = express();
  app.use(express.json());
  if (opts.auth !== null) {
    const auth = opts.auth;
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-tech-1',
        sessionId: 'sess-1',
        tenantId: TENANT,
        role: 'technician',
        ...auth,
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
      opts.tts ? { tts: opts.tts } : {},
    ),
  );
  return app;
}

/** Audit boundary: records what the route writes, so cost attribution is observable. */
function recordingAudit(): AuditRepository & { create: ReturnType<typeof vi.fn> } {
  return {
    create: vi.fn(async (e: unknown) => e),
  } as unknown as AuditRepository & { create: ReturnType<typeof vi.fn> };
}

/** Provider boundary: a TtsProvider that returns fixed bytes and records its input. */
function fakeTts(): TtsProvider & { synthesize: ReturnType<typeof vi.fn> } {
  return {
    synthesize: vi.fn(async () => ({
      audio: Buffer.from('mp3-bytes-1603'),
      contentType: 'audio/mpeg',
      provider: 'fake',
    })),
  };
}

describe('POST /api/voice/tts — speak a memo answer back (#1603)', () => {
  it('refuses an unauthenticated request with 401', async () => {
    const res = await request(buildApp({ auth: null }))
      .post('/api/voice/tts')
      .send({ text: 'You have nothing on the schedule today.' });

    expect(res.status).toBe(401);
  });

  it('a technician is authorised: the answer text comes back as a base64 clip', async () => {
    const tts = fakeTts();
    const res = await request(buildApp({ auth: { role: 'technician' }, tts }))
      .post('/api/voice/tts')
      .send({ text: 'You have nothing on the schedule today.' });

    expect(res.status).toBe(200);
    // base64 of the provider's bytes ('mp3-bytes-1603'), plus its MIME type.
    expect(res.body).toEqual({ audio: 'bXAzLWJ5dGVzLTE2MDM=', contentType: 'audio/mpeg' });
    expect(tts.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'You have nothing on the schedule today.', tenantId: TENANT }),
    );
  });

  it('rejects an empty text with 400 and never calls the provider', async () => {
    const tts = fakeTts();
    const res = await request(buildApp({ auth: { role: 'technician' }, tts }))
      .post('/api/voice/tts')
      .send({ text: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(tts.synthesize).not.toHaveBeenCalled();
  });

  it('a provider failure is an honest 502 that never leaks the provider text', async () => {
    const tts = fakeTts();
    tts.synthesize.mockRejectedValue(new Error('ElevenLabs 429 quota_exceeded req_9f8e'));
    const res = await request(buildApp({ auth: { role: 'technician' }, tts }))
      .post('/api/voice/tts')
      .send({ text: 'You have nothing on the schedule today.' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('TTS_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('quota_exceeded');
    expect(JSON.stringify(res.body)).not.toContain('req_9f8e');
  });

  it('validates the body BEFORE the provider check, so a client bug is a 400 even in a keyless environment', async () => {
    const res = await request(buildApp({ auth: { role: 'technician' } }))
      .post('/api/voice/tts')
      .send({ text: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('has its own per-user limiter: beyond VOICE_TTS_PER_MIN clips in a minute the route answers 429 and the provider is not called', async () => {
    vi.stubEnv('VOICE_TTS_PER_MIN', '2');
    try {
      const tts = fakeTts();
      const app = buildApp({ auth: { role: 'technician' }, tts });
      const body = { text: 'You have nothing on the schedule today.' };
      expect((await request(app).post('/api/voice/tts').send(body)).status).toBe(200);
      expect((await request(app).post('/api/voice/tts').send(body)).status).toBe(200);
      const third = await request(app).post('/api/voice/tts').send(body);
      expect(third.status).toBe(429);
      expect(third.body.error).toBe('RATE_LIMITED');
      expect(tts.synthesize).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('audits every billable clip to the actor (chars + provider), like /transcribe does', async () => {
    const audit = recordingAudit();
    const res = await request(buildApp({ auth: { role: 'technician' }, tts: fakeTts(), auditRepo: audit }))
      .post('/api/voice/tts')
      .send({ text: 'You have nothing on the schedule today.' });

    expect(res.status).toBe(200);
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        actorId: 'user-tech-1',
        eventType: 'voice.tts.synthesized',
        // 39 characters in the sentence above; the provider the clip came from.
        metadata: expect.objectContaining({ chars: 39, provider: 'fake' }),
      }),
    );
  });

  it('answers 501 NOT_CONFIGURED when no TTS provider is wired (the device keeps the answer on screen)', async () => {
    const res = await request(buildApp({ auth: { role: 'technician' } }))
      .post('/api/voice/tts')
      .send({ text: 'You have nothing on the schedule today.' });

    expect(res.status).toBe(501);
    expect(res.body.error).toBe('NOT_CONFIGURED');
  });
});
