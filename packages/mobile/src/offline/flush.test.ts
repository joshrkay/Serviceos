import { describe, expect, it, vi } from 'vitest';
import { makeTerminalAuthError, makeUnauthenticatedAbort, type ApiFetch } from '../lib/apiFetch';
import type { FileUploader } from '../voice/uploadAndTranscribe';
import {
  MAX_FLUSH_ATTEMPTS,
  classifyFlushFailure,
  flushQueue,
  nextRetryDelayMs,
  orderForFlush,
} from './flush';
import { OfflineQueue, serializeJournal, type JournalStore, type OfflineQueueItem } from './queue';

function memStore(initial: string | null = null): JournalStore {
  let content = initial;
  return {
    read: async () => content,
    write: async (c: string) => {
      content = c;
    },
  };
}

function res(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const okUpload: FileUploader = async () => ({ ok: true, status: 200 });

function voiceItem(n: number, extra: Partial<OfflineQueueItem> = {}): OfflineQueueItem {
  return {
    id: `voice-${n}`,
    kind: 'voice',
    payload: { localUri: `file:///doc/offline-voice/voice-${n}.m4a`, contentType: 'audio/mp4', sizeBytes: 10 },
    status: 'pending',
    attempts: 0,
    enqueuedAt: `2026-07-20T00:0${n}:00.000Z`,
    idempotencyKey: `voice-key-${n}`,
    ...extra,
  };
}

function approvalItem(proposalId: string, extra: Partial<OfflineQueueItem> = {}): OfflineQueueItem {
  return {
    id: `approval-${proposalId}`,
    kind: 'approval',
    payload: { proposalId, proposalType: 'add_note' },
    status: 'pending',
    attempts: 0,
    enqueuedAt: '2026-07-20T00:00:00.000Z',
    idempotencyKey: `approval-${proposalId}`,
    ...extra,
  };
}

async function queueOf(...items: OfflineQueueItem[]): Promise<OfflineQueue> {
  const queue = new OfflineQueue(memStore(serializeJournal(items)));
  await queue.restore();
  return queue;
}

/** Scripted ApiFetch keyed by path prefix; records every call. */
function scriptedApi(
  script: (path: string, init?: RequestInit) => Response | Error,
): { api: ApiFetch; calls: Array<{ path: string; body?: unknown }> } {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const api: ApiFetch = async (path, init) => {
    calls.push({
      path,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const out = script(path, init);
    if (out instanceof Error) throw out;
    return out;
  };
  return { api, calls };
}

describe('classifyFlushFailure', () => {
  it('maps statuses per the taxonomy', () => {
    expect(classifyFlushFailure(res(409))).toBe('drop'); // ConflictError
    expect(classifyFlushFailure(res(400))).toBe('drop'); // expired proposal VALIDATION_ERROR
    expect(classifyFlushFailure(res(404))).toBe('drop');
    expect(classifyFlushFailure(res(401))).toBe('auth');
    expect(classifyFlushFailure(res(408))).toBe('retry');
    expect(classifyFlushFailure(res(429))).toBe('retry');
    expect(classifyFlushFailure(res(500))).toBe('retry');
  });

  it('classifies both auth-failure error shapes as park signals', () => {
    expect(classifyFlushFailure(makeTerminalAuthError())).toBe('auth');
    expect(classifyFlushFailure(makeUnauthenticatedAbort())).toBe('auth');
  });

  it('classifies transport failures as retry', () => {
    const timeout = new Error('Request timed out');
    timeout.name = 'TimeoutError';
    expect(classifyFlushFailure(timeout)).toBe('retry');
    expect(classifyFlushFailure(new Error('Network request failed'))).toBe('retry');
    expect(classifyFlushFailure(new Error('who knows'))).toBe('retry');
  });
});

describe('orderForFlush', () => {
  it('runs approvals before voice, FIFO within each kind, pending only', () => {
    const items = [
      voiceItem(1),
      approvalItem('p1'),
      voiceItem(2, { status: 'parked' }),
      approvalItem('p2'),
      voiceItem(3),
    ];
    expect(orderForFlush(items).map((i) => i.id)).toEqual([
      'approval-p1',
      'approval-p2',
      'voice-1',
      'voice-3',
    ]);
  });
});

describe('flushQueue', () => {
  it('flushes an approval then a voice item, replaying the journaled idempotency key', async () => {
    const queue = await queueOf(voiceItem(1), approvalItem('p1'));
    const { api, calls } = scriptedApi((path) => {
      if (path.endsWith('/approve')) return res(200, { id: 'p1', status: 'approved' });
      if (path === '/api/files/upload-url')
        return res(200, { fileId: 'file-1', uploadUrl: 'https://s3/put?sig=1', downloadUrl: 'https://s3/a.m4a' });
      if (path === '/api/files/file-1/verify') return res(200, {});
      if (path === '/api/voice/recordings') return res(202, { recording: { id: 'rec-1' } });
      throw new Error(`unexpected ${path}`);
    });
    const deleteAudio = vi.fn(async () => {});

    const result = await flushQueue(queue, { api, uploadFile: okUpload, deleteAudio });

    expect(result).toMatchObject({ flushed: 2, dropped: 0 });
    expect(queue.depth()).toBe(0);
    // Approval flushed first.
    expect(calls[0].path).toBe('/api/proposals/p1/approve');
    // The create POST replayed the journaled key — never a fresh one.
    const createCall = calls.find((c) => c.path === '/api/voice/recordings');
    expect(createCall?.body).toMatchObject({ idempotencyKey: 'voice-key-1', fileId: 'file-1' });
    // Queued audio deleted only after the confirmed flush.
    expect(deleteAudio).toHaveBeenCalledWith('file:///doc/offline-voice/voice-1.m4a');
  });

  it('sends the identical idempotency key on two flush attempts of one voice item', async () => {
    const queue = await queueOf(voiceItem(1));
    let createTries = 0;
    const { api, calls } = scriptedApi((path) => {
      if (path === '/api/files/upload-url')
        return res(200, { fileId: 'file-1', uploadUrl: 'https://s3/put', downloadUrl: 'https://s3/a.m4a' });
      if (path === '/api/files/file-1/verify') return res(200, {});
      if (path === '/api/voice/recordings') {
        createTries += 1;
        return createTries === 1 ? res(500) : res(202, { recording: { id: 'rec-1' } });
      }
      throw new Error(`unexpected ${path}`);
    });

    const first = await flushQueue(queue, { api, uploadFile: okUpload });
    expect(first.retryAfterMs).toBeGreaterThan(0);
    const second = await flushQueue(queue, { api, uploadFile: okUpload });
    expect(second.flushed).toBe(1);

    const createBodies = calls
      .filter((c) => c.path === '/api/voice/recordings')
      .map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(createBodies).toEqual(['voice-key-1', 'voice-key-1']);
  });

  it('resumes from the checkpoint without re-uploading', async () => {
    const queue = await queueOf(
      voiceItem(1, { checkpoint: { fileId: 'file-1', audioUrl: 'https://s3/a.m4a' } }),
    );
    const uploadFile = vi.fn(okUpload);
    const { api, calls } = scriptedApi((path) => {
      if (path === '/api/voice/recordings') return res(202, { recording: { id: 'rec-1' } });
      throw new Error(`unexpected ${path}`);
    });

    const result = await flushQueue(queue, { api, uploadFile });

    expect(result.flushed).toBe(1);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(calls.map((c) => c.path)).toEqual(['/api/voice/recordings']);
  });

  it('persists the checkpoint after upload+verify even when the create fails', async () => {
    const queue = await queueOf(voiceItem(1));
    const { api } = scriptedApi((path) => {
      if (path === '/api/files/upload-url')
        return res(200, { fileId: 'file-1', uploadUrl: 'https://s3/put', downloadUrl: 'https://s3/a.m4a' });
      if (path === '/api/files/file-1/verify') return res(200, {});
      if (path === '/api/voice/recordings') return res(500);
      throw new Error(`unexpected ${path}`);
    });

    await flushQueue(queue, { api, uploadFile: okUpload });

    const [item] = queue.list();
    expect(item.status).toBe('pending');
    expect(item.checkpoint).toEqual({ fileId: 'file-1', audioUrl: 'https://s3/a.m4a' });
  });

  it('drops a stale approval on 409 AND on the expired-proposal 400, with the notice', async () => {
    const queue = await queueOf(approvalItem('conflicted'), approvalItem('expired'), voiceItem(1, { checkpoint: { fileId: 'f', audioUrl: 'https://s3/a' } }));
    const dropped: string[] = [];
    const { api } = scriptedApi((path) => {
      if (path === '/api/proposals/conflicted/approve') return res(409, { error: 'CONFLICT' });
      if (path === '/api/proposals/expired/approve') return res(400, { error: 'VALIDATION_ERROR' });
      if (path === '/api/voice/recordings') return res(202, { recording: { id: 'rec-1' } });
      throw new Error(`unexpected ${path}`);
    });

    const result = await flushQueue(queue, {
      api,
      uploadFile: okUpload,
      onItemDropped: (item) => dropped.push(item.id),
    });

    // Drops don't stop the run — the voice item still flushed.
    expect(result).toMatchObject({ flushed: 1, dropped: 2 });
    expect(dropped).toEqual(['approval-conflicted', 'approval-expired']);
    expect(queue.depth()).toBe(0);
  });

  it('auth-parks and stops on the tagged terminal 401 without any navigation side effect', async () => {
    const queue = await queueOf(approvalItem('p1'), approvalItem('p2'));
    const { api, calls } = scriptedApi(() => makeTerminalAuthError());

    const result = await flushQueue(queue, { api, uploadFile: okUpload });

    expect(result.authParked).toBe(true);
    expect(calls).toHaveLength(1); // run stopped after the first auth failure
    const statuses = queue.list().map((i) => i.status);
    expect(statuses).toEqual(['auth_parked', 'pending']);
  });

  it('auth-parks on the null-token abort shape too', async () => {
    const queue = await queueOf(voiceItem(1, { checkpoint: { fileId: 'f', audioUrl: 'https://s3/a' } }));
    const { api } = scriptedApi(() => makeUnauthenticatedAbort());

    const result = await flushQueue(queue, { api, uploadFile: okUpload });

    expect(result.authParked).toBe(true);
    expect(queue.list()[0].status).toBe('auth_parked');
  });

  it('stops on a transient failure with backoff and leaves later items untouched', async () => {
    const queue = await queueOf(approvalItem('p1'), approvalItem('p2'));
    const { api, calls } = scriptedApi(() => res(500));

    const result = await flushQueue(queue, { api, uploadFile: okUpload });

    expect(calls).toHaveLength(1);
    expect(result.retryAfterMs).toBe(nextRetryDelayMs(1));
    const [first, second] = queue.list();
    expect(first).toMatchObject({ status: 'pending', attempts: 1 });
    expect(second).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('poison-parks after MAX_FLUSH_ATTEMPTS transient failures', async () => {
    const queue = await queueOf(approvalItem('p1', { attempts: MAX_FLUSH_ATTEMPTS - 1 }));
    const { api } = scriptedApi(() => res(503));

    const result = await flushQueue(queue, { api, uploadFile: okUpload });

    expect(result.retryAfterMs).toBeUndefined();
    expect(queue.list()[0].status).toBe('parked');
  });

  it('grows the retry delay exponentially with a cap', () => {
    expect(nextRetryDelayMs(1)).toBe(5_000);
    expect(nextRetryDelayMs(2)).toBe(10_000);
    expect(nextRetryDelayMs(3)).toBe(20_000);
    expect(nextRetryDelayMs(100)).toBe(300_000);
  });
});
