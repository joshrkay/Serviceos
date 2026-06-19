/**
 * Offline mutation queue (mobile, field-resilience).
 *
 * Field techs lose connectivity on job sites. This queue durably holds
 * outbound mutations made while offline and replays them, in order, on
 * reconnect. It is deliberately scoped to **naturally-idempotent** operations
 * (status PUT/PATCH, attachment-metadata updates, draft saves): the API has
 * no general client-idempotency-key middleware (only proposal execution has
 * one), so "exactly once" here means last-write-wins on idempotent endpoints
 * plus client-side de-dup — NOT a server guarantee. Non-idempotent creates
 * must not be enqueued.
 *
 * Auth during flush is its OWN concern, separate from `apiFetch`: replays can
 * happen hours later when the cached Clerk token is expired and a refresh
 * needs the network. The sender signals `auth-unavailable` and the queue
 * STOPS the flush and keeps everything — it must never fall through to
 * `apiFetch`'s 401 → `/login` redirect mid-replay.
 *
 * Pure logic with injected ports (persistence, sender, clock) so it is fully
 * unit-tested without Capacitor or a device. The native shell provides a
 * Capacitor-Preferences-backed persistence adapter; on web the queue is
 * dormant (callers gate enqueue on `isNativePlatform()`).
 */

export type QueuedMethod = 'PUT' | 'PATCH' | 'POST' | 'DELETE';

export interface QueuedMutation {
  /** Client-generated row id. */
  id: string;
  method: QueuedMethod;
  /** Request path, e.g. `/api/jobs/<id>/status`. */
  path: string;
  /** JSON string body (already serialized), if any. */
  body?: string;
  /** De-dup key; a second enqueue with the same key is ignored. */
  idempotencyKey: string;
  enqueuedAt: string;
  attempts: number;
  /** Epoch ms before which this item should not be retried (backoff). */
  nextAttemptAt?: number;
}

/** Durable storage port. Native: Capacitor Preferences; tests: in-memory. */
export interface QueuePersistence {
  load(): Promise<QueuedMutation[]>;
  save(items: QueuedMutation[]): Promise<void>;
}

/** Outcome of attempting to replay one mutation. */
export type SendOutcome =
  /** 2xx — delivered; remove from the queue. */
  | { kind: 'ok' }
  /** 4xx (non-auth) — will never succeed; drop and surface. */
  | { kind: 'permanent' }
  /** 5xx / network error — keep and retry with backoff. */
  | { kind: 'retry' }
  /** No auth token obtainable (offline / refresh failed) — stop the flush,
   *  keep everything, retry later. Never redirect to /login here. */
  | { kind: 'auth-unavailable' };

export type MutationSender = (item: QueuedMutation) => Promise<SendOutcome>;

export interface EnqueueInput {
  method: QueuedMethod;
  path: string;
  body?: string;
  /** Optional explicit de-dup key; defaults to a fresh id. */
  idempotencyKey?: string;
}

export interface FlushSummary {
  delivered: number;
  /** Dropped: permanent failures + items past maxAttempts. */
  dropped: number;
  /** Items that failed transiently and remain queued for a later flush. */
  retried: number;
  /** Items still in the queue after this flush (pending + backing off). */
  remaining: number;
}

export interface OfflineQueueOptions {
  persistence: QueuePersistence;
  send: MutationSender;
  /** Drop a transiently-failing item after this many attempts. Default 8. */
  maxAttempts?: number;
  /** Injectable clock (epoch ms) for deterministic backoff tests. */
  now?: () => number;
  /** Injectable id generator (tests). Defaults to crypto.randomUUID(). */
  newId?: () => string;
}

export interface OfflineQueue {
  enqueue(input: EnqueueInput): Promise<QueuedMutation>;
  flush(): Promise<FlushSummary>;
  pendingCount(): number;
  list(): QueuedMutation[];
}

const DEFAULT_MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 5 * 60_000;

/** Exponential backoff capped at 5m. attempts is 1-based after the failure. */
export function backoffMs(attempts: number): number {
  const exp = BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, BACKOFF_CAP_MS);
}

/**
 * Construct an offline queue, hydrating any persisted items first so
 * `pendingCount()` is correct immediately after a restart.
 */
export async function createOfflineQueue(opts: OfflineQueueOptions): Promise<OfflineQueue> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const now = opts.now ?? (() => Date.now());
  const newId = opts.newId ?? (() => crypto.randomUUID());

  let items: QueuedMutation[] = await opts.persistence.load();
  let flushing = false;

  const persist = () => opts.persistence.save(items);
  const remove = (id: string) => {
    items = items.filter((i) => i.id !== id);
  };

  return {
    pendingCount: () => items.length,
    list: () => items.map((i) => ({ ...i })),

    async enqueue(input: EnqueueInput): Promise<QueuedMutation> {
      const idempotencyKey = input.idempotencyKey ?? newId();
      const existing = items.find((i) => i.idempotencyKey === idempotencyKey);
      if (existing) return { ...existing }; // client-side de-dup
      const mutation: QueuedMutation = {
        id: newId(),
        method: input.method,
        path: input.path,
        body: input.body,
        idempotencyKey,
        enqueuedAt: new Date(now()).toISOString(),
        attempts: 0,
      };
      items.push(mutation);
      await persist();
      return { ...mutation };
    },

    async flush(): Promise<FlushSummary> {
      const summary: FlushSummary = { delivered: 0, dropped: 0, retried: 0, remaining: items.length };
      if (flushing) return summary; // single-flight
      flushing = true;
      try {
        const at = now();
        // Iterate a snapshot in FIFO order. Item-specific failures don't
        // head-of-line-block later items; an auth gap stops the whole flush.
        for (const item of [...items]) {
          if (item.nextAttemptAt && item.nextAttemptAt > at) continue; // backing off
          const outcome = await opts.send(item);
          if (outcome.kind === 'auth-unavailable') break;
          if (outcome.kind === 'ok') {
            remove(item.id);
            summary.delivered++;
          } else if (outcome.kind === 'permanent') {
            remove(item.id);
            summary.dropped++;
          } else {
            // retry — find the live row and bump its attempt counter.
            const live = items.find((i) => i.id === item.id);
            if (!live) continue;
            live.attempts++;
            if (live.attempts >= maxAttempts) {
              remove(live.id);
              summary.dropped++;
            } else {
              live.nextAttemptAt = at + backoffMs(live.attempts);
              summary.retried++;
            }
          }
        }
        await persist();
        summary.remaining = items.length;
        return summary;
      } finally {
        flushing = false;
      }
    },
  };
}

/** In-memory persistence — the wired default on web (dormant) and for tests. */
export class InMemoryQueuePersistence implements QueuePersistence {
  constructor(private items: QueuedMutation[] = []) {}
  async load(): Promise<QueuedMutation[]> {
    return this.items.map((i) => ({ ...i }));
  }
  async save(items: QueuedMutation[]): Promise<void> {
    this.items = items.map((i) => ({ ...i }));
  }
  snapshot(): QueuedMutation[] {
    return this.items.map((i) => ({ ...i }));
  }
}
