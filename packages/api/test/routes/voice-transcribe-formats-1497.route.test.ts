/**
 * #1497 (3) — memo transcription for iOS audio, and honest failures.
 *
 * LLM QA 2026-09-29: an `audio/mp4` memo (iOS Safari MediaRecorder) was sent
 * to Whisper named `audio.webm`, Whisper refused the file, and the route
 * answered 500 TRANSCRIPTION_FAILED carrying Whisper's raw error text. A WAV
 * memo from the same session transcribed fine.
 *
 * Seam: POST /api/voice/transcribe (supertest) wired with the REAL
 * `createTranscribeAudioFn`, whose provider call (`fetch` to the Whisper
 * endpoint) is stubbed. The stub behaves like Whisper: it decodes by the
 * uploaded file NAME's extension, so a file whose name does not match its
 * container is rejected with Whisper's raw 400 text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createVoiceRouter } from '../../src/routes/voice';
import { InMemoryVoiceRepository, createTranscribeAudioFn } from '../../src/voice/voice-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { Queue } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';

const TENANT = 'bbbb1497-e5f6-7890-abcd-ef1234567890';
const WHISPER_RAW_FORMAT_ERROR =
  '{"error":{"message":"Invalid file format. Supported formats: [\'flac\', \'m4a\', \'mp3\', \'mp4\', \'mpeg\', \'mpga\', \'oga\', \'ogg\', \'wav\', \'webm\']","type":"invalid_request_error"}}';

/** Which uploaded-file extensions Whisper can decode a given container as. */
const DECODABLE_EXTENSIONS: Record<string, string[]> = {
  'audio/mp4': ['mp4', 'm4a'],
  'audio/x-m4a': ['m4a', 'mp4'],
  'audio/m4a': ['m4a', 'mp4'],
  'audio/wav': ['wav'],
};

type WhisperBehaviour = 'decode-by-name' | 'server-error';

function stubWhisper(behaviour: WhisperBehaviour) {
  return vi.fn(async (_url: string, init: { body: FormData }) => {
    if (behaviour === 'server-error') {
      return new globalThis.Response('{"error":{"message":"The server had an error while processing your request. req_abc123"}}', {
        status: 500,
      });
    }
    const file = init.body.get('file') as File;
    const ext = file.name.split('.').pop() ?? '';
    const container = file.type.split(';')[0]!.trim().toLowerCase();
    if (!(DECODABLE_EXTENSIONS[container] ?? []).includes(ext)) {
      return new globalThis.Response(WHISPER_RAW_FORMAT_ERROR, { status: 400 });
    }
    return globalThis.Response.json({ text: 'Check the condenser on the Patel unit' });
  });
}

function makeLogger(): Logger & { error: ReturnType<typeof vi.fn> } {
  const logger: any = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

function buildApp(logger: Logger = makeLogger()) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 'sess-1',
      tenantId: TENANT,
      role: 'owner',
    } as AuthenticatedRequest['auth'];
    next();
  });
  app.use(
    '/api/voice',
    createVoiceRouter(
      new InMemoryVoiceRepository(),
      { send: vi.fn(async () => 'queued-1') } as unknown as Queue,
      createTranscribeAudioFn('test-whisper-key'),
      new InMemoryAuditRepository(),
      logger,
    ),
  );
  return app;
}

describe('POST /api/voice/transcribe — memo formats and honest failures (#1497)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['audio/mp4', 'audio/x-m4a', 'audio/mp4;codecs=mp4a.40.2'])(
    'an iOS %s memo is transcribed',
    async (contentType) => {
      vi.stubGlobal('fetch', stubWhisper('decode-by-name'));

      const res = await request(buildApp())
        .post('/api/voice/transcribe')
        .set('Content-Type', contentType)
        .send(Buffer.from('fake-m4a-bytes'));

      expect(res.status).toBe(200);
      expect(res.body.transcript).toBe('Check the condenser on the Patel unit');
    },
  );

  it('a format the transcriber cannot decode is a 415 UNSUPPORTED_AUDIO_FORMAT in plain words — never a 500 with provider text', async () => {
    const whisper = stubWhisper('decode-by-name');
    vi.stubGlobal('fetch', whisper);

    const res = await request(buildApp())
      .post('/api/voice/transcribe')
      .set('Content-Type', 'audio/aac')
      .send(Buffer.from('fake-adts-bytes'));

    expect(res.status).toBe(415);
    expect(res.body.error).toBe('UNSUPPORTED_AUDIO_FORMAT');
    expect(res.body.message).toMatch(/can't transcribe this audio format/i);
    expect(JSON.stringify(res.body)).not.toMatch(/whisper|invalid_request_error|Supported formats/i);
  });

  it('a file the provider itself refuses as an invalid format is the same plain 415', async () => {
    // The stub decodes only the containers in DECODABLE_EXTENSIONS, so this
    // flac upload plays the part of a file Whisper cannot read.
    vi.stubGlobal('fetch', stubWhisper('decode-by-name'));

    const res = await request(buildApp())
      .post('/api/voice/transcribe')
      .set('Content-Type', 'audio/flac')
      .send(Buffer.from('not-really-flac'));

    expect(res.status).toBe(415);
    expect(res.body.error).toBe('UNSUPPORTED_AUDIO_FORMAT');
    expect(JSON.stringify(res.body)).not.toMatch(/whisper|invalid_request_error|Supported formats/i);
  });

  it('a provider failure answers TRANSCRIPTION_FAILED with a generic message; the raw provider text is only logged', async () => {
    vi.stubGlobal('fetch', stubWhisper('server-error'));
    const logger = makeLogger();

    const res = await request(buildApp(logger))
      .post('/api/voice/transcribe')
      .set('Content-Type', 'audio/wav')
      .send(Buffer.from('fake-wav-bytes'));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'TRANSCRIPTION_FAILED',
      message: "Sorry, we couldn't transcribe that recording. Please try again.",
    });
    expect(logger.error).toHaveBeenCalledWith(
      'voice.transcribe: failed (raw)',
      expect.objectContaining({ error: expect.stringContaining('req_abc123') }),
    );
  });
});
