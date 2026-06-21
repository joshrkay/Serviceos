import { describe, expect, it, vi } from 'vitest';
import {
  uploadAndTranscribe,
  type AudioClip,
  type UploadAndTranscribeDeps,
} from './uploadAndTranscribe';

const clip: AudioClip = { fileUri: 'file:///clip.m4a', contentType: 'audio/mp4', sizeBytes: 1234 };

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fixed-clock deps bundle; `routes` maps `${METHOD} ${path}` → Response. */
function makeDeps(
  routes: Record<string, () => Response>,
  over: Partial<UploadAndTranscribeDeps> = {},
): UploadAndTranscribeDeps {
  let clock = 0;
  const api = vi.fn(async (path: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${path}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return handler();
  });
  return {
    api,
    uploadFile: vi.fn(async () => ({ ok: true, status: 200 })),
    makeIdempotencyKey: () => 'idem-1',
    now: () => clock,
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    intervalMs: 1,
    timeoutMs: 10,
    ...over,
  };
}

const HAPPY_ROUTES = {
  'POST /api/files/upload-url': () =>
    jsonRes({ fileId: 'f1', uploadUrl: 'https://s3/put?sig=x', downloadUrl: 'https://cdn/f1.m4a' }),
  'POST /api/files/f1/verify': () => jsonRes({ ok: true }),
  'POST /api/voice/recordings': () => jsonRes({ recording: { id: 'r1' } }, 202),
  'GET /api/voice/recordings/r1': () => jsonRes({ status: 'completed', transcript: '  bill Rodriguez  ' }),
};

describe('uploadAndTranscribe', () => {
  it('runs upload-url → PUT → verify → recordings → poll and returns the trimmed transcript', async () => {
    const deps = makeDeps(HAPPY_ROUTES);
    const text = await uploadAndTranscribe(clip, deps);

    expect(text).toBe('bill Rodriguez');
    expect(deps.uploadFile).toHaveBeenCalledWith('https://s3/put?sig=x', clip.fileUri, 'audio/mp4');
    // idempotencyKey is sent on POST /recordings
    const recCall = (deps.api as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === '/api/voice/recordings',
    );
    expect(JSON.parse((recCall![1] as RequestInit).body as string)).toMatchObject({
      fileId: 'f1',
      idempotencyKey: 'idem-1',
    });
  });

  it('falls back to /api/files/upload when upload-url is not ok', async () => {
    const deps = makeDeps({
      'POST /api/files/upload-url': () => jsonRes({}, 500),
      'POST /api/files/upload': () =>
        jsonRes({ fileId: 'f1', uploadUrl: 'https://s3/put?sig=x', downloadUrl: 'https://cdn/f1.m4a' }),
      'POST /api/files/f1/verify': () => jsonRes({ ok: true }),
      'POST /api/voice/recordings': () => jsonRes({ recording: { id: 'r1' } }, 202),
      'GET /api/voice/recordings/r1': () => jsonRes({ status: 'completed', transcript: 'ok' }),
    });
    await expect(uploadAndTranscribe(clip, deps)).resolves.toBe('ok');
  });

  it('throws when the upload PUT fails', async () => {
    const deps = makeDeps(HAPPY_ROUTES, {
      uploadFile: vi.fn(async () => ({ ok: false, status: 500 })),
    });
    await expect(uploadAndTranscribe(clip, deps)).rejects.toThrow(/Audio upload failed/);
  });

  it('throws when verify fails', async () => {
    const deps = makeDeps({ ...HAPPY_ROUTES, 'POST /api/files/f1/verify': () => jsonRes({}, 413) });
    await expect(uploadAndTranscribe(clip, deps)).rejects.toThrow(/Upload verification failed/);
  });

  it('throws when the recording id is missing', async () => {
    const deps = makeDeps({ ...HAPPY_ROUTES, 'POST /api/voice/recordings': () => jsonRes({ recording: {} }, 202) });
    await expect(uploadAndTranscribe(clip, deps)).rejects.toThrow(/Missing recording id/);
  });

  it('surfaces a failed transcription with its error message', async () => {
    const deps = makeDeps({
      ...HAPPY_ROUTES,
      'GET /api/voice/recordings/r1': () => jsonRes({ status: 'failed', errorMessage: 'bad audio' }),
    });
    await expect(uploadAndTranscribe(clip, deps)).rejects.toThrow(/bad audio/);
  });

  it('times out when the recording never completes', async () => {
    const deps = makeDeps({
      ...HAPPY_ROUTES,
      'GET /api/voice/recordings/r1': () => jsonRes({ status: 'processing' }),
    });
    await expect(uploadAndTranscribe(clip, deps)).rejects.toThrow(/timed out/);
  });
});
