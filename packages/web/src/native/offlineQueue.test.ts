import { describe, it, expect } from 'vitest';
import {
  createOfflineQueue,
  InMemoryQueuePersistence,
  backoffMs,
  type MutationSender,
} from './offlineQueue';

function idGen() {
  let n = 0;
  return () => `id-${++n}`;
}

describe('backoffMs', () => {
  it('grows exponentially and caps at 5m', () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(100)).toBe(5 * 60_000);
  });
});

describe('offlineQueue', () => {
  it('enqueues and persists; de-dups by idempotencyKey', async () => {
    const persistence = new InMemoryQueuePersistence();
    const q = await createOfflineQueue({ persistence, send: async () => ({ kind: 'ok' }), newId: idGen() });
    await q.enqueue({ method: 'PUT', path: '/api/jobs/1/status', body: '{"s":"done"}', idempotencyKey: 'k1' });
    await q.enqueue({ method: 'PUT', path: '/api/jobs/1/status', body: '{"s":"done"}', idempotencyKey: 'k1' });
    expect(q.pendingCount()).toBe(1);
    expect(persistence.snapshot()).toHaveLength(1);
  });

  it('delivers queued mutations in FIFO order and removes them', async () => {
    const persistence = new InMemoryQueuePersistence();
    const sent: string[] = [];
    const send: MutationSender = async (i) => {
      sent.push(i.idempotencyKey);
      return { kind: 'ok' };
    };
    const q = await createOfflineQueue({ persistence, send, newId: idGen() });
    await q.enqueue({ method: 'PUT', path: '/a', idempotencyKey: 'k1' });
    await q.enqueue({ method: 'PATCH', path: '/b', idempotencyKey: 'k2' });
    const summary = await q.flush();
    expect(sent).toEqual(['k1', 'k2']);
    expect(summary.delivered).toBe(2);
    expect(q.pendingCount()).toBe(0);
  });

  it('drops permanent (4xx) failures without blocking later items', async () => {
    const persistence = new InMemoryQueuePersistence();
    const send: MutationSender = async (i) =>
      i.idempotencyKey === 'bad' ? { kind: 'permanent' } : { kind: 'ok' };
    const q = await createOfflineQueue({ persistence, send, newId: idGen() });
    await q.enqueue({ method: 'POST', path: '/bad', idempotencyKey: 'bad' });
    await q.enqueue({ method: 'PUT', path: '/good', idempotencyKey: 'good' });
    const summary = await q.flush();
    expect(summary).toMatchObject({ delivered: 1, dropped: 1 });
    expect(q.pendingCount()).toBe(0);
  });

  it('retries transient failures with backoff and does not retry until due', async () => {
    const persistence = new InMemoryQueuePersistence();
    let attempt = 0;
    const send: MutationSender = async () => {
      attempt++;
      return attempt < 3 ? { kind: 'retry' } : { kind: 'ok' };
    };
    let clock = 10_000;
    const q = await createOfflineQueue({ persistence, send, newId: idGen(), now: () => clock });
    await q.enqueue({ method: 'PUT', path: '/a', idempotencyKey: 'k1' });

    let s = await q.flush(); // attempt 1 → retry (backoff 1000)
    expect(s.retried).toBe(1);
    expect(q.pendingCount()).toBe(1);

    s = await q.flush(); // still within backoff window → skipped, send not called
    expect(attempt).toBe(1);
    expect(s.delivered).toBe(0);

    clock += 1_000;
    s = await q.flush(); // attempt 2 → retry (backoff 2000)
    expect(attempt).toBe(2);

    clock += 2_000;
    s = await q.flush(); // attempt 3 → ok
    expect(attempt).toBe(3);
    expect(s.delivered).toBe(1);
    expect(q.pendingCount()).toBe(0);
  });

  it('drops an item after maxAttempts', async () => {
    const persistence = new InMemoryQueuePersistence();
    const send: MutationSender = async () => ({ kind: 'retry' });
    let clock = 0;
    const q = await createOfflineQueue({ persistence, send, newId: idGen(), now: () => clock, maxAttempts: 3 });
    await q.enqueue({ method: 'PUT', path: '/a', idempotencyKey: 'k1' });
    await q.flush();
    clock += backoffMs(1);
    await q.flush();
    clock += backoffMs(2);
    const s = await q.flush();
    expect(q.pendingCount()).toBe(0);
    expect(s.dropped).toBe(1);
  });

  it('stops the flush on auth-unavailable and keeps everything (no /login bounce)', async () => {
    const persistence = new InMemoryQueuePersistence();
    const calls: string[] = [];
    const send: MutationSender = async (i) => {
      calls.push(i.idempotencyKey);
      return { kind: 'auth-unavailable' };
    };
    const q = await createOfflineQueue({ persistence, send, newId: idGen() });
    await q.enqueue({ method: 'PUT', path: '/a', idempotencyKey: 'k1' });
    await q.enqueue({ method: 'PUT', path: '/b', idempotencyKey: 'k2' });
    const s = await q.flush();
    expect(calls).toEqual(['k1']); // stopped after the first; did not attempt k2
    expect(s).toMatchObject({ delivered: 0, dropped: 0, remaining: 2 });
    expect(q.pendingCount()).toBe(2);
  });

  it('persists across restarts (durability)', async () => {
    const persistence = new InMemoryQueuePersistence();
    const q1 = await createOfflineQueue({
      persistence,
      send: async () => ({ kind: 'auth-unavailable' }),
      newId: idGen(),
    });
    await q1.enqueue({ method: 'PUT', path: '/a', idempotencyKey: 'k1' });
    await q1.enqueue({ method: 'PUT', path: '/b', idempotencyKey: 'k2' });

    // New instance from the same persistence — app restart while offline.
    const q2 = await createOfflineQueue({ persistence, send: async () => ({ kind: 'ok' }), newId: idGen() });
    expect(q2.pendingCount()).toBe(2);
    const s = await q2.flush();
    expect(s.delivered).toBe(2);
  });

  it('does not run a second flush concurrently', async () => {
    const persistence = new InMemoryQueuePersistence();
    let active = 0;
    let maxActive = 0;
    const send: MutationSender = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { kind: 'ok' };
    };
    const q = await createOfflineQueue({ persistence, send, newId: idGen() });
    await q.enqueue({ method: 'PUT', path: '/a', idempotencyKey: 'k1' });
    await q.enqueue({ method: 'PUT', path: '/b', idempotencyKey: 'k2' });
    const [s1, s2] = await Promise.all([q.flush(), q.flush()]);
    expect(maxActive).toBe(1);
    expect(s1.delivered + s2.delivered).toBe(2);
  });
});
