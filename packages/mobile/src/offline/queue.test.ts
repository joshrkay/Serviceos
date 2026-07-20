import { describe, expect, it } from 'vitest';
import {
  OfflineQueue,
  parseJournal,
  serializeJournal,
  type JournalStore,
  type OfflineQueueItem,
} from './queue';

function memStore(initial: string | null = null): JournalStore & { get(): string | null } {
  let content = initial;
  return {
    read: async () => content,
    write: async (c: string) => {
      content = c;
    },
    get: () => content,
  };
}

function voiceInput(n: number) {
  return {
    id: `voice-${n}`,
    idempotencyKey: `key-${n}`,
    enqueuedAt: `2026-07-20T00:0${n}:00.000Z`,
    payload: { localUri: `file:///doc/offline-voice/voice-${n}.m4a`, contentType: 'audio/mp4', sizeBytes: 100 + n },
  };
}

function approvalInput(proposalId: string) {
  return {
    id: `approval-${proposalId}`,
    idempotencyKey: `approval-${proposalId}`,
    enqueuedAt: '2026-07-20T00:00:00.000Z',
    payload: { proposalId, proposalType: 'add_note', summary: 'Add a note' },
  };
}

describe('offline queue journal', () => {
  it('round-trips items through the store and restores them', async () => {
    const store = memStore();
    const queue = new OfflineQueue(store);
    await queue.restore();
    await queue.enqueueVoice(voiceInput(1));
    await queue.enqueueApproval(approvalInput('p1'));

    const rehydrated = new OfflineQueue(memStore(store.get()));
    const items = await rehydrated.restore();

    expect(items.map((i) => i.id)).toEqual(['voice-1', 'approval-p1']);
    expect(items[0].idempotencyKey).toBe('key-1');
    expect(items[0].status).toBe('pending');
  });

  it('preserves FIFO order within the journal', async () => {
    const queue = new OfflineQueue(memStore());
    await queue.restore();
    await queue.enqueueVoice(voiceInput(1));
    await queue.enqueueVoice(voiceInput(2));
    await queue.enqueueVoice(voiceInput(3));

    expect(queue.list().map((i) => i.id)).toEqual(['voice-1', 'voice-2', 'voice-3']);
  });

  it('reverts crash-orphaned inflight items to pending on restore', async () => {
    const inflight: OfflineQueueItem = {
      id: 'voice-1',
      kind: 'voice',
      payload: { localUri: 'file:///a.m4a', contentType: 'audio/mp4', sizeBytes: 1 },
      status: 'inflight',
      attempts: 2,
      enqueuedAt: '2026-07-20T00:00:00.000Z',
      idempotencyKey: 'key-1',
    };
    const queue = new OfflineQueue(memStore(serializeJournal([inflight])));

    const items = await queue.restore();

    expect(items[0].status).toBe('pending');
    expect(items[0].attempts).toBe(2); // attempts survive the relaunch
  });

  it('degrades a corrupt journal to an empty queue', () => {
    expect(parseJournal('{not json')).toEqual([]);
    expect(parseJournal(JSON.stringify({ v: 99, items: [{}] }))).toEqual([]);
    expect(parseJournal(null)).toEqual([]);
  });

  it('deduplicates queued approvals per proposal', async () => {
    const queue = new OfflineQueue(memStore());
    await queue.restore();
    await queue.enqueueApproval(approvalInput('p1'));
    await queue.enqueueApproval(approvalInput('p1'));

    expect(queue.depth()).toBe(1);
    expect(queue.hasQueuedApproval('p1')).toBe(true);
  });

  it('removes a queued approval on cancel and reports whether it existed', async () => {
    const queue = new OfflineQueue(memStore());
    await queue.restore();
    await queue.enqueueApproval(approvalInput('p1'));

    expect(await queue.removeApproval('p1')).toBe(true);
    expect(await queue.removeApproval('p1')).toBe(false);
    expect(queue.hasQueuedApproval('p1')).toBe(false);
    expect(queue.depth()).toBe(0);
  });

  it('persists checkpoints so retries can resume past the upload phase', async () => {
    const store = memStore();
    const queue = new OfflineQueue(store);
    await queue.restore();
    await queue.enqueueVoice(voiceInput(1));
    await queue.setCheckpoint('voice-1', { fileId: 'file-9', audioUrl: 'https://x/a.m4a' });

    const rehydrated = new OfflineQueue(memStore(store.get()));
    const [item] = await rehydrated.restore();

    expect(item.checkpoint).toEqual({ fileId: 'file-9', audioUrl: 'https://x/a.m4a' });
  });

  it('parks and re-activates items', async () => {
    const queue = new OfflineQueue(memStore());
    await queue.restore();
    await queue.enqueueVoice(voiceInput(1));
    await queue.enqueueApproval(approvalInput('p1'));

    await queue.authPark('voice-1');
    await queue.park('approval-p1');
    expect(queue.list().map((i) => i.status)).toEqual(['auth_parked', 'parked']);

    expect(await queue.reactivateAuthParked()).toBe(1);
    expect(queue.list().find((i) => i.id === 'voice-1')!.status).toBe('pending');

    expect(await queue.reactivateParked()).toBe(1);
    const reparked = queue.list().find((i) => i.id === 'approval-p1')!;
    expect(reparked.status).toBe('pending');
    expect(reparked.attempts).toBe(0);
  });

  it('notifies subscribers on every change with the current snapshot', async () => {
    const queue = new OfflineQueue(memStore());
    const depths: number[] = [];
    queue.subscribe((items) => depths.push(items.length));
    await queue.restore();
    await queue.enqueueVoice(voiceInput(1));
    await queue.remove('voice-1');

    expect(depths[0]).toBe(0); // immediate snapshot
    expect(depths).toContain(1);
    expect(depths[depths.length - 1]).toBe(0);
  });
});
