import { describe, expect, it } from 'vitest';
import { createOfflineQueue, isVoiceItem, type QueueFs, type OfflineQueueDeps } from './queue';

/** In-memory QueueFs — records moves/removes so tests can assert on them. */
function memFs() {
  const files = new Map<string, string>();
  const moves: Array<[string, string]> = [];
  const removed: string[] = [];
  const dirs: string[] = [];
  const fs: QueueFs = {
    async read(uri) {
      return files.has(uri) ? files.get(uri)! : null;
    },
    async write(uri, data) {
      files.set(uri, data);
    },
    async move(from, to) {
      moves.push([from, to]);
      files.set(to, files.get(from) ?? '');
      files.delete(from);
    },
    async remove(uri) {
      removed.push(uri);
      files.delete(uri);
    },
    async ensureDir(uri) {
      dirs.push(uri);
    },
  };
  return { fs, files, moves, removed, dirs };
}

const JOURNAL = 'file:///doc/offline-queue.json';
const AUDIO_DIR = 'file:///doc/offline-audio/';

function makeQueue(over: Partial<OfflineQueueDeps> = {}) {
  const m = memFs();
  let clock = 1000;
  let n = 0;
  const counts: number[] = [];
  const q = createOfflineQueue({
    fs: m.fs,
    now: () => clock++,
    makeId: () => `id-${++n}`,
    journalUri: JOURNAL,
    audioDir: AUDIO_DIR,
    onCountChange: (c) => counts.push(c),
    ...over,
  });
  return { q, m, counts };
}

describe('OfflineQueue — persistence + recovery', () => {
  it('round-trips enqueued items through the journal (restore from disk)', async () => {
    const { q, m } = makeQueue();
    await q.load();
    m.files.set('file:///cache/clip.m4a', 'audio-bytes');
    await q.enqueueVoice({ sourceUri: 'file:///cache/clip.m4a', contentType: 'audio/mp4', sizeBytes: 42 });
    await q.enqueueApproval({ proposalId: 'p1', proposalType: 'draft_invoice', summary: 'Invoice' });

    // A fresh queue over the SAME fs must restore both items verbatim.
    const q2 = createOfflineQueue({
      fs: m.fs,
      now: () => 0,
      makeId: () => 'unused',
      journalUri: JOURNAL,
      audioDir: AUDIO_DIR,
    });
    await q2.load();
    const items = q2.snapshot();
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe('voice');
    expect(items[1].kind).toBe('approval');
  });

  it('writes atomically — temp file then move over the journal', async () => {
    const { q, m } = makeQueue();
    await q.load();
    await q.enqueueApproval({ proposalId: 'p1', proposalType: 'draft_invoice', summary: 's' });
    // Every persist moves `${journal}.tmp` → journal.
    expect(m.moves).toContainEqual([`${JOURNAL}.tmp`, JOURNAL]);
    expect(m.files.get(JOURNAL)).toContain('draft_invoice');
  });

  it('recovers an interrupted inflight item to pending on load', async () => {
    const { q, m } = makeQueue();
    await q.load();
    const item = await q.enqueueApproval({ proposalId: 'p1', proposalType: 'add_note', summary: 's' });
    await q.markInflight(item.id);
    expect(q.snapshot()[0].status).toBe('inflight');

    const q2 = createOfflineQueue({
      fs: m.fs,
      now: () => 0,
      makeId: () => 'unused',
      journalUri: JOURNAL,
      audioDir: AUDIO_DIR,
    });
    await q2.load();
    expect(q2.snapshot()[0].status).toBe('pending'); // at-least-once
  });
});

describe('OfflineQueue — ordering', () => {
  it('nextRunnable returns approvals before voice, FIFO within a lane', async () => {
    const { q, m } = makeQueue();
    await q.load();
    m.files.set('file:///cache/a.m4a', 'a');
    await q.enqueueVoice({ sourceUri: 'file:///cache/a.m4a', contentType: 'audio/mp4', sizeBytes: 1 });
    await q.enqueueApproval({ proposalId: 'p1', proposalType: 'add_note', summary: 'first' });
    await q.enqueueApproval({ proposalId: 'p2', proposalType: 'add_note', summary: 'second' });

    // Approval first (even though voice was enqueued earlier), then FIFO by age.
    const first = q.nextRunnable();
    expect(first?.kind).toBe('approval');
    expect((first?.payload as { proposalId: string }).proposalId).toBe('p1');
  });

  it('skips parked items and reports waitingCount as pending+inflight only', async () => {
    const { q } = makeQueue();
    await q.load();
    const a = await q.enqueueApproval({ proposalId: 'p1', proposalType: 'add_note', summary: 's' });
    await q.enqueueApproval({ proposalId: 'p2', proposalType: 'add_note', summary: 's' });
    await q.markParked(a.id);
    expect(q.waitingCount()).toBe(1); // parked excluded
    expect(q.nextRunnable()?.id).not.toBe(a.id);
  });
});

describe('OfflineQueue — voice idempotency key + audio relocation', () => {
  it('mints the idempotency key ONCE at enqueue and persists it', async () => {
    const { q, m } = makeQueue();
    await q.load();
    m.files.set('file:///cache/clip.m4a', 'bytes');
    const item = await q.enqueueVoice({
      sourceUri: 'file:///cache/clip.m4a',
      contentType: 'audio/mp4',
      sizeBytes: 42,
    });
    expect(item.idempotencyKey).toBeTruthy();
    // Reload from disk — the key is stable (never re-minted).
    const q2 = createOfflineQueue({
      fs: m.fs,
      now: () => 0,
      makeId: () => 'DIFFERENT',
      journalUri: JOURNAL,
      audioDir: AUDIO_DIR,
    });
    await q2.load();
    expect(q2.snapshot()[0].idempotencyKey).toBe(item.idempotencyKey);
  });

  it('moves the clip out of the cache dir into documentDirectory at enqueue', async () => {
    const { q, m } = makeQueue();
    await q.load();
    m.files.set('file:///cache/clip.m4a', 'bytes');
    const item = await q.enqueueVoice({
      sourceUri: 'file:///cache/clip.m4a',
      contentType: 'audio/mp4',
      sizeBytes: 42,
    });
    expect(isVoiceItem(item)).toBe(true);
    if (!isVoiceItem(item)) throw new Error('unreachable');
    expect(item.payload.audioUri.startsWith(AUDIO_DIR)).toBe(true);
    // The cache source was moved (removed); the durable copy exists.
    expect(m.moves).toContainEqual(['file:///cache/clip.m4a', item.payload.audioUri]);
    expect(m.files.has('file:///cache/clip.m4a')).toBe(false);
    expect(m.files.has(item.payload.audioUri)).toBe(true);
  });

  it('deletes the durable audio ONLY on a confirmed flush (markDone)', async () => {
    const { q, m } = makeQueue();
    await q.load();
    m.files.set('file:///cache/clip.m4a', 'bytes');
    const item = await q.enqueueVoice({
      sourceUri: 'file:///cache/clip.m4a',
      contentType: 'audio/mp4',
      sizeBytes: 42,
    });
    if (!isVoiceItem(item)) throw new Error('unreachable');
    const durable = item.payload.audioUri;
    // Mid-flight (inflight, checkpoint set) the durable file is untouched.
    await q.markInflight(item.id);
    await q.setCheckpoint(item.id, { fileId: 'f1', audioUrl: 'https://cdn/f1' });
    expect(m.removed).not.toContain(durable);
    // Only markDone removes it.
    await q.markDone(item.id);
    expect(m.removed).toContain(durable);
    expect(q.snapshot()).toHaveLength(0);
  });
});

describe('OfflineQueue — failures + cancel', () => {
  it('recordFailure increments attempts and returns to pending', async () => {
    const { q } = makeQueue();
    await q.load();
    const a = await q.enqueueApproval({ proposalId: 'p1', proposalType: 'add_note', summary: 's' });
    await q.markInflight(a.id);
    expect(await q.recordFailure(a.id)).toBe(1);
    expect(await q.recordFailure(a.id)).toBe(2);
    expect(q.snapshot()[0].status).toBe('pending');
    expect(q.snapshot()[0].attempts).toBe(2);
  });

  it('reactivateParked flips parked → pending with a fresh attempt budget', async () => {
    const { q } = makeQueue();
    await q.load();
    const a = await q.enqueueApproval({ proposalId: 'p1', proposalType: 'add_note', summary: 's' });
    const b = await q.enqueueApproval({ proposalId: 'p2', proposalType: 'add_note', summary: 's' });
    // a exhausts its retries and parks; b stays pending.
    await q.markInflight(a.id);
    await q.recordFailure(a.id);
    await q.recordFailure(a.id);
    await q.markParked(a.id);
    expect(q.waitingCount()).toBe(1); // a is parked → invisible

    const reactivated = await q.reactivateParked();
    expect(reactivated).toBe(1);
    const aAfter = q.snapshot().find((it) => it.id === a.id)!;
    expect(aAfter.status).toBe('pending');
    expect(aAfter.attempts).toBe(0); // fresh budget
    expect(q.waitingCount()).toBe(2); // now visible again
    // b (already pending) is untouched.
    expect(q.snapshot().find((it) => it.id === b.id)!.status).toBe('pending');
  });

  it('reactivateParked is a no-op (no persist) when nothing is parked', async () => {
    const { q, m } = makeQueue();
    await q.load();
    await q.enqueueApproval({ proposalId: 'p1', proposalType: 'add_note', summary: 's' });
    const movesBefore = m.moves.length;
    expect(await q.reactivateParked()).toBe(0);
    // persist() ends with a tmp→journal move; the no-op path must not persist.
    expect(m.moves.length).toBe(movesBefore);
  });

  it('cancel removes a pending item + its audio, but refuses an inflight one', async () => {
    const { q, m } = makeQueue();
    await q.load();
    m.files.set('file:///cache/clip.m4a', 'bytes');
    const v = await q.enqueueVoice({ sourceUri: 'file:///cache/clip.m4a', contentType: 'audio/mp4', sizeBytes: 1 });
    if (!isVoiceItem(v)) throw new Error('unreachable');
    await q.markInflight(v.id);
    expect(await q.cancel(v.id)).toBe(false); // inflight — refuse

    await q.revertToPending(v.id);
    expect(await q.cancel(v.id)).toBe(true);
    expect(m.removed).toContain(v.payload.audioUri);
    expect(q.snapshot()).toHaveLength(0);
  });
});
