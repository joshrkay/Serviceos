/**
 * Hygiene/observability fixes for routes/voice.ts:
 *
 *   1. MAX_DURATION_SECONDS was declared but never referenced by either
 *      /transcribe or /recordings — neither request path carries a
 *      client-supplied duration (checked voice-service.ts's
 *      CreateVoiceRecordingBody/IngestVoiceInput and the /transcribe
 *      multipart parser: no duration field exists anywhere upstream).
 *      voice_recordings.duration_seconds IS populated, but only by the
 *      Twilio inbound-call path (recordInboundCall, from Twilio's own
 *      RecordingDuration — a trusted third-party value, not something a
 *      browser/mobile client asserts on these routes). Per project hygiene
 *      rules the dead constant was removed rather than left unenforced or
 *      wired to invented API surface. Server-side duration enforcement
 *      needs a real product decision (client-asserted duration or server
 *      audio decoding) before a limit can come back.
 *   2. POST /transcribe's audit-write failures are now logged at warn
 *      level (with route/tenantId/eventType context) instead of being
 *      swallowed by an empty catch, while remaining non-fatal to the
 *      request — mirroring the same fix on /stream-token (see
 *      voice-stream-token.route.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createVoiceRouter } from '../../src/routes/voice';
import { InMemoryVoiceRepository } from '../../src/voice/voice-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { Queue } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';

const TENANT_A = 'aaaa1111-e5f6-7890-abcd-ef1234567890';

function makeQueue(): Queue {
  return { send: vi.fn(async () => 'queued-1') } as unknown as Queue;
}

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger: any = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

function buildApp(opts: {
  auditRepo?: InMemoryAuditRepository;
  logger?: Logger;
  transcribeAudio?: (buf: Buffer, ct: string) => Promise<{ transcript: string; metadata: Record<string, unknown> }>;
}) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 'sess-1',
      tenantId: TENANT_A,
      role: 'owner',
    } as AuthenticatedRequest['auth'];
    next();
  });
  app.use(
    '/api/voice',
    createVoiceRouter(
      new InMemoryVoiceRepository(),
      makeQueue(),
      opts.transcribeAudio,
      opts.auditRepo,
      opts.logger,
    ),
  );
  return app;
}

describe('POST /api/voice/transcribe — audit-write failure is logged, not swallowed', () => {
  it('still returns the transcript when the audit write throws, and warns with context', async () => {
    const auditRepo = new InMemoryAuditRepository();
    vi.spyOn(auditRepo, 'create').mockRejectedValueOnce(new Error('audit db down'));
    const logger = makeLogger();
    const transcribeAudio = vi.fn(async () => ({
      transcript: 'hello world',
      metadata: { provider: 'test' },
    }));
    const app = buildApp({ auditRepo, logger, transcribeAudio });

    const res = await request(app)
      .post('/api/voice/transcribe')
      .set('Content-Type', 'audio/wav')
      .send(Buffer.from('fake-audio-bytes'));

    // The transcription result is still returned — audit failure is non-fatal.
    expect(res.status).toBe(200);
    expect(res.body.transcript).toBe('hello world');

    // But the swallowed failure is now observable.
    expect(logger.warn).toHaveBeenCalledWith(
      'voice.transcribe: audit write failed',
      expect.objectContaining({
        route: 'POST /api/voice/transcribe',
        tenantId: TENANT_A,
        eventType: 'voice.transcription.completed',
        error: 'audit db down',
      }),
    );
  });
});
