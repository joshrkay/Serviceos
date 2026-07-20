import { describe, expect, it, vi } from 'vitest';
import type { VoiceLookupAnswer } from '@ai-service-os/shared';
import {
  uploadAndTranscribe,
  type AudioClip,
  type UploadAndTranscribeDeps,
} from './uploadAndTranscribe';

const clip: AudioClip = { fileUri: 'file:///clip.m4a', contentType: 'audio/mp4', sizeBytes: 1234 };

const ANSWER: VoiceLookupAnswer = {
  version: 1,
  intent: 'lookup_balance',
  result: 'found',
  summary: 'Your current balance is $123.00.',
  rows: [{ kind: 'money', label: 'Outstanding balance', amountCents: 12300 }],
  entityRef: { kind: 'customer', id: '3b6cbf1a-bd8a-45f7-8b84-ce6b43a231d1' },
};

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
    const { transcript: text, outcome } = await uploadAndTranscribe(clip, deps);

    expect(text).toBe('bill Rodriguez');
    // No answerStatus on the completed payload (older server / non-memo
    // surface) → no second poll, outcome degrades to 'skipped'.
    expect(outcome).toEqual({ kind: 'skipped' });
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

  it('adds the verified job id only when the caller supplies one', async () => {
    const deps = makeDeps(HAPPY_ROUTES);
    const jobId = '3b6cbf1a-bd8a-45f7-8b84-ce6b43a231d1';

    await uploadAndTranscribe(clip, deps, jobId);

    const recCall = (deps.api as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === '/api/voice/recordings',
    );
    expect(JSON.parse((recCall![1] as RequestInit).body as string)).toEqual({
      fileId: 'f1',
      audioUrl: 'https://cdn/f1.m4a',
      idempotencyKey: 'idem-1',
      jobId,
    });
  });

  it('preserves the existing recording request body when job id is absent', async () => {
    const deps = makeDeps(HAPPY_ROUTES);

    await uploadAndTranscribe(clip, deps);

    const recCall = (deps.api as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === '/api/voice/recordings',
    );
    expect(JSON.parse((recCall![1] as RequestInit).body as string)).toEqual({
      fileId: 'f1',
      audioUrl: 'https://cdn/f1.m4a',
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
    await expect(uploadAndTranscribe(clip, deps)).resolves.toMatchObject({ transcript: 'ok' });
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

// U3 — the bounded second poll phase: after `status='completed'` the router
// outcome (`answerStatus`) is still landing, so the client keeps polling the
// same route under a small separate budget.
describe('uploadAndTranscribe second poll phase (routed outcome)', () => {
  /** Sequence the GET responses: first `completed` payload, then outcome polls. */
  function sequencedDeps(bodies: unknown[], over: Partial<UploadAndTranscribeDeps> = {}) {
    let i = 0;
    return makeDeps(
      {
        ...HAPPY_ROUTES,
        'GET /api/voice/recordings/r1': () =>
          jsonRes(bodies[Math.min(i++, bodies.length - 1)]),
      },
      { answerTimeoutMs: 10, ...over },
    );
  }

  it('polls past pending and renders the answered outcome with its parsed answer', async () => {
    const deps = sequencedDeps([
      { status: 'completed', transcript: 'what is my balance', answerStatus: 'pending' },
      { status: 'completed', answerStatus: 'pending' },
      { status: 'completed', answerStatus: 'answered', answer: ANSWER },
    ]);
    const { outcome } = await uploadAndTranscribe(clip, deps);
    expect(outcome).toEqual({ kind: 'answered', answer: ANSWER });
  });

  it('maps proposal / clarification / failed terminal statuses onto the outcome', async () => {
    for (const [answerStatus, kind] of [
      ['proposal', 'proposal'],
      ['clarification', 'clarification'],
      ['failed', 'failed'],
      ['skipped', 'skipped'],
    ] as const) {
      const deps = sequencedDeps([
        { status: 'completed', transcript: 't', answerStatus: 'pending' },
        { status: 'completed', answerStatus },
      ]);
      const { outcome } = await uploadAndTranscribe(clip, deps);
      expect(outcome).toEqual({ kind });
    }
  });

  it('resolves immediately (no second poll) when the completed payload is already terminal', async () => {
    const deps = sequencedDeps([
      { status: 'completed', transcript: 't', answerStatus: 'proposal' },
    ]);
    const { outcome } = await uploadAndTranscribe(clip, deps);
    expect(outcome).toEqual({ kind: 'proposal' });
    // one GET for phase 1, zero for phase 2
    const gets = (deps.api as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === '/api/voice/recordings/r1',
    );
    expect(gets).toHaveLength(1);
  });

  it('gives up after the bounded answer budget and degrades to timeout (today\'s behavior)', async () => {
    const deps = sequencedDeps(
      [{ status: 'completed', transcript: 't', answerStatus: 'pending' }],
      { answerTimeoutMs: 5, intervalMs: 1 },
    );
    const { transcript, outcome } = await uploadAndTranscribe(clip, deps);
    expect(transcript).toBe('t');
    expect(outcome).toEqual({ kind: 'timeout' });
  });

  it('degrades a malformed answered payload to skipped instead of crashing', async () => {
    const deps = sequencedDeps([
      { status: 'completed', transcript: 't', answerStatus: 'pending' },
      { status: 'completed', answerStatus: 'answered', answer: { bogus: true } },
    ]);
    const { outcome } = await uploadAndTranscribe(clip, deps);
    expect(outcome).toEqual({ kind: 'skipped' });
  });

  it('degrades a second-phase poll error to timeout — the transcript is already safe', async () => {
    let calls = 0;
    const deps = makeDeps(
      {
        ...HAPPY_ROUTES,
        'GET /api/voice/recordings/r1': () => {
          calls++;
          if (calls === 1) {
            return jsonRes({ status: 'completed', transcript: 't', answerStatus: 'pending' });
          }
          return jsonRes({}, 500);
        },
      },
      { answerTimeoutMs: 10 },
    );
    const { transcript, outcome } = await uploadAndTranscribe(clip, deps);
    expect(transcript).toBe('t');
    expect(outcome).toEqual({ kind: 'timeout' });
  });
});
