import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __emitNetInfoForTests,
  __resetConnectivityForTests,
} from '../lib/connectivity';
import { makeUnauthenticatedAbort, makeUnauthorizedError, type ApiFetch } from '../lib/apiFetch';
import type { FileUploader } from '../voice/uploadAndTranscribe';
import { createFlushController, classifyFlushError, backoffMs } from './flush';
import { createOfflineQueue, OfflineQueue, type QueueFs, type QueueItem } from './queue';

const JOURNAL = 'file:///doc/offline-queue.json';
const AUDIO_DIR = 'file:///doc/offline-audio/';

function memFs() {
  const files = new Map<string, string>();
  const fs: QueueFs = {
    async read(uri) {
      return files.has(uri) ? files.get(uri)! : null;
    },
    async write(uri, data) {
      files.set(uri, data);
    },
    async move(from, to) {
      files.set(to, files.get(from) ?? '');
      files.delete(from);
    },
    async remove(uri) {
      files.delete(uri);
    },
    async ensureDir() {},
  };
  return { fs, files };
}

async function makeLoadedQueue(fs: QueueFs): Promise<OfflineQueue> {
  let n = 0;
  let clock = 1000;
  const q = createOfflineQueue({
    fs,
    now: () => clock++,
    makeId: () => `id-${++n}`,
    journalUri: JOURNAL,
    audioDir: AUDIO_DIR,
  });
  await q.load();
  return q;
}

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Handler = () => Response | Promise<Response>;

function makeApi(routes: Record<string, Handler>) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api: ApiFetch = async (path, init) => {
    calls.push({ path, init });
    const key = `${init?.method ?? 'GET'} ${path}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return handler();
  };
  return { api, calls };
}

const okUpload: FileUploader = async () => ({ ok: true, status: 200 });

/** Routes for a successful voice delivery (upload → verify → POST recordings). */
function voiceRoutes(recordingsHandler: Handler): Record<string, Handler> {
  return {
    'POST /api/files/upload-url': () =>
      jsonRes({ fileId: 'f1', uploadUrl: 'https://s3/put?sig=x', downloadUrl: 'https://cdn/f1.m4a' }),
    'POST /api/files/f1/verify': () => jsonRes({ ok: true }),
    'POST /api/voice/recordings': recordingsHandler,
  };
}

function baseDeps(queue: OfflineQueue, api: ApiFetch, over = {}) {
  return {
    queue,
    api,
    uploadFile: okUpload,
    now: () => 0,
    sleep: vi.fn(async () => {}),
    maxAttempts: 3,
    ...over,
  };
}

beforeEach(() => __resetConnectivityForTests());
afterEach(() => {
  vi.clearAllMocks();
  __resetConnectivityForTests();
});

describe('classifyFlushError', () => {
  it('maps the taxonomy exactly', () => {
    // 4xx except 401/408/429 → drop
    expect(classifyFlushError(Object.assign(new Error(), { status: 409 }))).toBe('drop');
    expect(classifyFlushError(Object.assign(new Error(), { status: 400 }))).toBe('drop');
    expect(classifyFlushError(Object.assign(new Error(), { status: 403 }))).toBe('drop');
    expect(classifyFlushError(Object.assign(new Error(), { status: 404 }))).toBe('drop');
    // 401 / auth shapes → auth
    expect(classifyFlushError(makeUnauthorizedError())).toBe('auth');
    expect(classifyFlushError(makeUnauthenticatedAbort())).toBe('auth');
    expect(classifyFlushError(Object.assign(new Error(), { status: 401 }))).toBe('auth');
    // transient → retry
    expect(classifyFlushError(Object.assign(new Error(), { status: 408 }))).toBe('retry');
    expect(classifyFlushError(Object.assign(new Error(), { status: 429 }))).toBe('retry');
    expect(classifyFlushError(Object.assign(new Error(), { status: 500 }))).toBe('retry');
    // no status (timeout / network / ambiguous) → retry
    expect(classifyFlushError(new Error('Network request failed'))).toBe('retry');
  });

  it('backoff grows and caps', () => {
    expect(backoffMs(1, 1000)).toBe(1000);
    expect(backoffMs(2, 1000)).toBe(2000);
    expect(backoffMs(100, 1000)).toBe(30000);
  });
});

describe('flush — ordering + success', () => {
  it('flushes approvals BEFORE voice', async () => {
    const { fs, files } = memFs();
    const q = await makeLoadedQueue(fs);
    files.set('file:///cache/c.m4a', 'a');
    await q.enqueueVoice({ sourceUri: 'file:///cache/c.m4a', contentType: 'audio/mp4', sizeBytes: 1 });
    await q.enqueueApproval({ proposalId: 'p1', proposalType: 'add_note', summary: 's' });

    const { api, calls } = makeApi({
      'POST /api/proposals/p1/approve': () => jsonRes({ id: 'p1', status: 'approved' }),
      ...voiceRoutes(() => jsonRes({ recording: { id: 'r1' } }, 202)),
    });
    const controller = createFlushController(baseDeps(q, api));
    await controller.flush();

    const approveIdx = calls.findIndex((c) => c.path === '/api/proposals/p1/approve');
    const voiceIdx = calls.findIndex((c) => c.path === '/api/voice/recordings');
    expect(approveIdx).toBeGreaterThanOrEqual(0);
    expect(voiceIdx).toBeGreaterThan(approveIdx); // approval ran first
    expect(q.snapshot()).toHaveLength(0); // both drained
  });
});

describe('flush — reconnect trigger', () => {
  it('drains on the offline→online reconnect edge', async () => {
    const { fs } = memFs();
    const q = await makeLoadedQueue(fs);
    await q.enqueueApproval({ proposalId: 'p1', proposalType: 'add_note', summary: 's' });

    const { api, calls } = makeApi({
      'POST /api/proposals/p1/approve': () => jsonRes({ id: 'p1', status: 'approved' }),
    });
    const controller = createFlushController(baseDeps(q, api));
    const stop = controller.start();

    __emitNetInfoForTests({ isConnected: false, isInternetReachable: false });
    __emitNetInfoForTests({ isConnected: true, isInternetReachable: true });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    stop();

    expect(calls.some((c) => c.path === '/api/proposals/p1/approve')).toBe(true);
    expect(q.snapshot()).toHaveLength(0);
  });
});

describe('flush — permanent drop (4xx)', () => {
  async function expectDrop(status: number, body: unknown) {
    const { fs } = memFs();
    const q = await makeLoadedQueue(fs);
    const item = await q.enqueueApproval({
      proposalId: 'p1',
      proposalType: 'create_invoice_schedule',
      summary: 's',
    });
    const dropped: QueueItem[] = [];
    const { api } = makeApi({
      'POST /api/proposals/p1/approve': () => jsonRes(body, status),
    });
    const controller = createFlushController(
      baseDeps(q, api, { onPermanentDrop: (it: QueueItem) => dropped.push(it) }),
    );
    await controller.flush();
    expect(dropped.map((d) => d.id)).toEqual([item.id]);
    expect(q.snapshot()).toHaveLength(0); // removed, not parked
  }

  it('drops a 409 ConflictError with the notice callback', async () => {
    await expectDrop(409, { error: 'CONFLICT', message: 'Already approved' });
  });

  it('drops a 400 VALIDATION_ERROR from an EXPIRED proposal with the notice', async () => {
    await expectDrop(400, { error: 'VALIDATION_ERROR', message: 'Proposal has expired' });
  });
});

describe('flush — 401 park (both shapes, no navigation)', () => {
  async function expectPark(makeErr: () => Error) {
    const { fs } = memFs();
    const q = await makeLoadedQueue(fs);
    const item = await q.enqueueApproval({ proposalId: 'p1', proposalType: 'add_note', summary: 's' });
    let authCount = 0;
    const { api } = makeApi({
      'POST /api/proposals/p1/approve': () => {
        throw makeErr();
      },
    });
    const controller = createFlushController(
      baseDeps(q, api, { onAuthRequired: () => authCount++ }),
    );
    await controller.flush();
    expect(authCount).toBe(1);
    // Item preserved as pending; drain halted. No navigation side effect exists
    // in the controller — onAuthRequired is the only signal.
    const snap = q.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].id).toBe(item.id);
    expect(snap[0].status).toBe('pending');
  }

  it('parks on the tagged terminal 401 (UnauthorizedError)', async () => {
    await expectPark(makeUnauthorizedError);
  });

  it('parks on the null-token AbortError', async () => {
    await expectPark(makeUnauthenticatedAbort);
  });
});

describe('flush — partial-flush persistence', () => {
  it('keeps later items when the drain halts on auth mid-queue', async () => {
    const { fs, files } = memFs();
    const q = await makeLoadedQueue(fs);
    await q.enqueueApproval({ proposalId: 'p1', proposalType: 'add_note', summary: 'ok' });
    const parked = await q.enqueueApproval({ proposalId: 'p2', proposalType: 'add_note', summary: 'auth' });

    const { api } = makeApi({
      'POST /api/proposals/p1/approve': () => jsonRes({ id: 'p1', status: 'approved' }),
      'POST /api/proposals/p2/approve': () => {
        throw makeUnauthorizedError();
      },
    });
    const controller = createFlushController(baseDeps(q, api, { onAuthRequired: () => {} }));
    await controller.flush();

    // p1 done (removed), p2 preserved pending — and persisted to disk.
    const snap = q.snapshot();
    expect(snap.map((s) => s.id)).toEqual([parked.id]);
    const journal = JSON.parse(files.get(JOURNAL)!) as { items: QueueItem[] };
    expect(journal.items.map((i) => (i.payload as { proposalId: string }).proposalId)).toEqual(['p2']);
  });
});

describe('flush — backoff + poison-park', () => {
  it('backs off then poison-parks a persistently-failing item after N attempts', async () => {
    const { fs } = memFs();
    const q = await makeLoadedQueue(fs);
    const item = await q.enqueueApproval({ proposalId: 'p1', proposalType: 'add_note', summary: 's' });

    const sleep = vi.fn(async () => {});
    const { api, calls } = makeApi({
      'POST /api/proposals/p1/approve': () => jsonRes({ error: 'INTERNAL_ERROR' }, 500),
    });
    const controller = createFlushController(baseDeps(q, api, { sleep, maxAttempts: 3 }));
    await controller.flush();

    // 3 attempts, backoff sleeps after attempts 1 and 2, then parked on 3.
    expect(calls.filter((c) => c.path === '/api/proposals/p1/approve')).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
    const snap = q.snapshot();
    expect(snap[0].id).toBe(item.id);
    expect(snap[0].status).toBe('parked');
  });
});

describe('flush — poison-park recovery (retry + reconnect)', () => {
  it('retry() reactivates a poison-parked item and drains it once conditions recover', async () => {
    const { fs } = memFs();
    const q = await makeLoadedQueue(fs);
    await q.enqueueApproval({ proposalId: 'p1', proposalType: 'add_note', summary: 's' });

    // First: a persistent 5xx storm parks the item.
    let down = true;
    const sleep = vi.fn(async () => {});
    const { api, calls } = makeApi({
      'POST /api/proposals/p1/approve': () =>
        down ? jsonRes({ error: 'INTERNAL_ERROR' }, 500) : jsonRes({ id: 'p1', status: 'approved' }),
    });
    const controller = createFlushController(baseDeps(q, api, { sleep, maxAttempts: 3 }));
    await controller.flush();
    expect(q.snapshot()[0].status).toBe('parked');

    // A plain flush must NOT rescue a parked item (nextRunnable skips it).
    const callsAfterPark = calls.length;
    await controller.flush();
    expect(calls.length).toBe(callsAfterPark);

    // Server recovers; the user pulls to refresh → retry() reactivates + drains.
    down = false;
    await controller.retry();
    expect(calls.filter((c) => c.path === '/api/proposals/p1/approve').length).toBeGreaterThan(
      callsAfterPark,
    );
    expect(q.snapshot()).toHaveLength(0); // delivered, removed from the journal
  });

  it('reconnect edge reactivates a poison-parked item (network-caused park)', async () => {
    const { fs } = memFs();
    const q = await makeLoadedQueue(fs);
    await q.enqueueApproval({ proposalId: 'p1', proposalType: 'add_note', summary: 's' });

    let online = false;
    const sleep = vi.fn(async () => {});
    const { api } = makeApi({
      'POST /api/proposals/p1/approve': () =>
        online ? jsonRes({ id: 'p1', status: 'approved' }) : jsonRes({ error: 'NETWORK' }, 503),
    });
    const controller = createFlushController(baseDeps(q, api, { sleep, maxAttempts: 3 }));
    await controller.flush(); // fails 3x → parked
    expect(q.snapshot()[0].status).toBe('parked');

    // Network returns: the reconnect edge must retry (reactivate + drain).
    online = true;
    const stop = controller.start();
    __emitNetInfoForTests({ isConnected: false, isInternetReachable: false });
    __emitNetInfoForTests({ isConnected: true, isInternetReachable: true });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    stop();

    expect(q.snapshot()).toHaveLength(0); // recovered and delivered
  });
});

describe('flush — voice idempotency + checkpoint resume', () => {
  it('sends the IDENTICAL idempotency key on two flush attempts of one voice item', async () => {
    const { fs, files } = memFs();
    const q = await makeLoadedQueue(fs);
    files.set('file:///cache/c.m4a', 'audio');
    const item = await q.enqueueVoice({
      sourceUri: 'file:///cache/c.m4a',
      contentType: 'audio/mp4',
      sizeBytes: 10,
    });

    let recCall = 0;
    const bodies: string[] = [];
    const { api, calls } = makeApi(
      voiceRoutes(() => {
        recCall++;
        return recCall === 1
          ? jsonRes({ error: 'INTERNAL_ERROR' }, 500) // first attempt fails (retryable)
          : jsonRes({ recording: { id: 'r1' } }, 202); // second succeeds
      }),
    );
    // Capture the idempotencyKey each POST /recordings carried.
    const wrapped: ApiFetch = async (path, init) => {
      if (path === '/api/voice/recordings') bodies.push(String(init?.body));
      return api(path, init);
    };
    const controller = createFlushController(baseDeps(q, wrapped, { maxAttempts: 5 }));
    await controller.flush();

    expect(bodies).toHaveLength(2);
    const key0 = JSON.parse(bodies[0]).idempotencyKey;
    const key1 = JSON.parse(bodies[1]).idempotencyKey;
    expect(key0).toBe(item.idempotencyKey);
    expect(key1).toBe(item.idempotencyKey); // identical across attempts
    // The upload phase ran ONCE — the second attempt resumed from checkpoint.
    expect(calls.filter((c) => c.path === '/api/files/upload-url')).toHaveLength(1);
    expect(q.snapshot()).toHaveLength(0);
  });

  it('resumes straight to POST /recordings when a checkpoint is already persisted', async () => {
    const { fs, files } = memFs();
    const q = await makeLoadedQueue(fs);
    files.set('file:///cache/c.m4a', 'audio');
    const item = await q.enqueueVoice({
      sourceUri: 'file:///cache/c.m4a',
      contentType: 'audio/mp4',
      sizeBytes: 10,
    });
    await q.setCheckpoint(item.id, { fileId: 'f1', audioUrl: 'https://cdn/f1.m4a' });

    const { api, calls } = makeApi({
      'POST /api/voice/recordings': () => jsonRes({ recording: { id: 'r1' } }, 202),
    });
    const controller = createFlushController(baseDeps(q, api));
    await controller.flush();

    // No upload/verify calls — jumped straight to POST /recordings.
    expect(calls.some((c) => c.path === '/api/files/upload-url')).toBe(false);
    expect(calls.some((c) => c.path === '/api/files/f1/verify')).toBe(false);
    expect(calls.filter((c) => c.path === '/api/voice/recordings')).toHaveLength(1);
    expect(q.snapshot()).toHaveLength(0);
  });
});
