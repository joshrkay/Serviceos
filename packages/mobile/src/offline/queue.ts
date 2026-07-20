/**
 * Offline action queue (U12) — a single JSON journal of voice recordings and
 * capture-class approvals captured while offline, flushed on reconnect.
 *
 * Design (per the master blueprint plan):
 *  - One journal file in `FileSystem.documentDirectory` (not the OS-evictable
 *    cache), written atomically (temp → move) by the injected {@link JournalStore}.
 *  - The voice `idempotencyKey` is minted ONCE at enqueue and persisted in the
 *    item; every flush attempt replays the same key (U11 server dedup), never
 *    a fresh one per attempt.
 *  - Voice items checkpoint per phase: after a successful upload+verify the
 *    `{fileId, audioUrl}` pair is persisted so later attempts skip straight to
 *    `POST /api/voice/recordings` instead of re-uploading the audio.
 *  - `inflight` reverts to `pending` on relaunch (at-least-once delivery;
 *    server idempotency + the flush 4xx-drop taxonomy give effectively-once).
 *
 * This module is pure (no RN/Expo imports) and unit-tested under vitest; the
 * native journal store + audio relocation live in `nativeOfflineDeps.ts`.
 */

export type OfflineItemKind = 'voice' | 'approval';

/**
 * - pending      — waiting for the next flush run
 * - inflight     — a flush attempt is executing it right now
 * - parked       — poison: exhausted {@link MAX_FLUSH_ATTEMPTS}; kept visible,
 *                  only a manual retry re-activates it
 * - auth_parked  — terminal auth failure mid-flush; parked behind sign-in and
 *                  re-activated by {@link OfflineQueue.reactivateAuthParked}
 */
export type OfflineItemStatus = 'pending' | 'inflight' | 'parked' | 'auth_parked';

export interface VoiceQueuePayload {
  /** Relocated audio URI under documentDirectory (never the evictable cache). */
  localUri: string;
  contentType: string;
  sizeBytes: number;
  jobId?: string;
}

export interface ApprovalQueuePayload {
  proposalId: string;
  proposalType: string;
  /** For user-facing queue copy ("Approve: …"). */
  summary?: string;
}

/** Persisted after a successful upload+verify so retries skip the upload. */
export interface VoiceCheckpoint {
  fileId: string;
  audioUrl: string;
}

export interface OfflineQueueItem {
  id: string;
  kind: OfflineItemKind;
  payload: VoiceQueuePayload | ApprovalQueuePayload;
  status: OfflineItemStatus;
  attempts: number;
  enqueuedAt: string;
  /** Voice: the U11 server replay key. Approvals: reserved (approve POSTs are
   *  server-idempotent by proposal state, not by key). */
  idempotencyKey: string;
  checkpoint?: VoiceCheckpoint;
}

/** Atomic string persistence for the journal (native impl: temp → move). */
export interface JournalStore {
  read(): Promise<string | null>;
  write(content: string): Promise<void>;
}

interface JournalShape {
  v: 1;
  items: OfflineQueueItem[];
}

const JOURNAL_VERSION = 1 as const;

function isItem(value: unknown): value is OfflineQueueItem {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    (v.kind === 'voice' || v.kind === 'approval') &&
    typeof v.idempotencyKey === 'string' &&
    typeof v.enqueuedAt === 'string' &&
    typeof v.attempts === 'number' &&
    (v.status === 'pending' || v.status === 'inflight' || v.status === 'parked' || v.status === 'auth_parked') &&
    typeof v.payload === 'object' &&
    v.payload !== null
  );
}

/** Parse a journal string defensively — corruption degrades to an empty queue. */
export function parseJournal(content: string | null): OfflineQueueItem[] {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as Partial<JournalShape>;
    if (!parsed || parsed.v !== JOURNAL_VERSION || !Array.isArray(parsed.items)) return [];
    return parsed.items.filter(isItem);
  } catch {
    return [];
  }
}

export function serializeJournal(items: OfflineQueueItem[]): string {
  return JSON.stringify({ v: JOURNAL_VERSION, items } satisfies JournalShape);
}

export interface EnqueueVoiceInput {
  id: string;
  idempotencyKey: string;
  enqueuedAt: string;
  payload: VoiceQueuePayload;
}

export interface EnqueueApprovalInput {
  id: string;
  idempotencyKey: string;
  enqueuedAt: string;
  payload: ApprovalQueuePayload;
}

export type QueueListener = (items: readonly OfflineQueueItem[]) => void;

/**
 * The journaled queue. Every mutation is serialized through an internal
 * promise chain and persisted before it resolves, so concurrent enqueues /
 * flush transitions can't interleave partial journal writes.
 */
export class OfflineQueue {
  private items: OfflineQueueItem[] = [];
  private restored = false;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<QueueListener>();

  constructor(private readonly store: JournalStore) {}

  /** Serialize an operation behind all previously scheduled ones. */
  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op);
    // Keep the chain alive through failures without swallowing them for callers.
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async persist(): Promise<void> {
    await this.store.write(serializeJournal(this.items));
    this.notify();
  }

  private notify(): void {
    const snapshot = this.list();
    for (const l of this.listeners) l(snapshot);
  }

  /** Subscribe to item changes; fires immediately with the current snapshot. */
  subscribe(listener: QueueListener): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Current items (copies — mutations go through the queue API). */
  list(): OfflineQueueItem[] {
    return this.items.map((i) => ({ ...i, payload: { ...i.payload } }));
  }

  /** Count of items awaiting delivery (everything still journaled). */
  depth(): number {
    return this.items.length;
  }

  /**
   * Load the journal (once) and revert crash-orphaned `inflight` items to
   * `pending` — at-least-once semantics; the server side is idempotent.
   */
  restore(): Promise<OfflineQueueItem[]> {
    return this.run(async () => {
      if (!this.restored) {
        this.restored = true;
        this.items = parseJournal(await this.store.read());
        let mutated = false;
        for (const item of this.items) {
          if (item.status === 'inflight') {
            item.status = 'pending';
            mutated = true;
          }
        }
        if (mutated) await this.persist();
        else this.notify();
      }
      return this.list();
    });
  }

  enqueueVoice(input: EnqueueVoiceInput): Promise<OfflineQueueItem> {
    return this.run(async () => {
      const item: OfflineQueueItem = {
        id: input.id,
        kind: 'voice',
        payload: { ...input.payload },
        status: 'pending',
        attempts: 0,
        enqueuedAt: input.enqueuedAt,
        idempotencyKey: input.idempotencyKey,
      };
      this.items.push(item);
      await this.persist();
      return { ...item };
    });
  }

  /** Enqueue an approval; a second enqueue for the same proposal is a no-op. */
  enqueueApproval(input: EnqueueApprovalInput): Promise<OfflineQueueItem> {
    return this.run(async () => {
      const existing = this.items.find(
        (i) =>
          i.kind === 'approval' &&
          (i.payload as ApprovalQueuePayload).proposalId === input.payload.proposalId,
      );
      if (existing) return { ...existing };
      const item: OfflineQueueItem = {
        id: input.id,
        kind: 'approval',
        payload: { ...input.payload },
        status: 'pending',
        attempts: 0,
        enqueuedAt: input.enqueuedAt,
        idempotencyKey: input.idempotencyKey,
      };
      this.items.push(item);
      await this.persist();
      return { ...item };
    });
  }

  /** True when an approval for this proposal is still journaled. */
  hasQueuedApproval(proposalId: string): boolean {
    return this.items.some(
      (i) => i.kind === 'approval' && (i.payload as ApprovalQueuePayload).proposalId === proposalId,
    );
  }

  /** Cancel a queued approval before it flushes (the review screen's Cancel). */
  removeApproval(proposalId: string): Promise<boolean> {
    return this.run(async () => {
      const before = this.items.length;
      this.items = this.items.filter(
        (i) =>
          !(i.kind === 'approval' && (i.payload as ApprovalQueuePayload).proposalId === proposalId),
      );
      if (this.items.length === before) return false;
      await this.persist();
      return true;
    });
  }

  remove(id: string): Promise<void> {
    return this.run(async () => {
      const before = this.items.length;
      this.items = this.items.filter((i) => i.id !== id);
      if (this.items.length !== before) await this.persist();
    });
  }

  private setStatus(id: string, status: OfflineItemStatus): Promise<void> {
    return this.run(async () => {
      const item = this.items.find((i) => i.id === id);
      if (!item || item.status === status) return;
      item.status = status;
      await this.persist();
    });
  }

  markInflight(id: string): Promise<void> {
    return this.setStatus(id, 'inflight');
  }

  markPending(id: string): Promise<void> {
    return this.setStatus(id, 'pending');
  }

  /** Poison-park after exhausted retries. */
  park(id: string): Promise<void> {
    return this.setStatus(id, 'parked');
  }

  /** Park behind sign-in after a terminal auth failure. */
  authPark(id: string): Promise<void> {
    return this.setStatus(id, 'auth_parked');
  }

  bumpAttempts(id: string): Promise<number> {
    return this.run(async () => {
      const item = this.items.find((i) => i.id === id);
      if (!item) return 0;
      item.attempts += 1;
      await this.persist();
      return item.attempts;
    });
  }

  setCheckpoint(id: string, checkpoint: VoiceCheckpoint): Promise<void> {
    return this.run(async () => {
      const item = this.items.find((i) => i.id === id);
      if (!item) return;
      item.checkpoint = { ...checkpoint };
      await this.persist();
    });
  }

  /** Re-activate auth-parked items after a successful sign-in. */
  reactivateAuthParked(): Promise<number> {
    return this.run(async () => {
      let n = 0;
      for (const item of this.items) {
        if (item.status === 'auth_parked') {
          item.status = 'pending';
          n += 1;
        }
      }
      if (n > 0) await this.persist();
      return n;
    });
  }

  /** Manual retry: give poison-parked items another round of attempts. */
  reactivateParked(): Promise<number> {
    return this.run(async () => {
      let n = 0;
      for (const item of this.items) {
        if (item.status === 'parked') {
          item.status = 'pending';
          item.attempts = 0;
          n += 1;
        }
      }
      if (n > 0) await this.persist();
      return n;
    });
  }
}
