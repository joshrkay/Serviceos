/**
 * Offline action journal (U12).
 *
 * A single persisted JSON journal that survives relaunch and crashes, holding
 * the offline-captured work that must flush on reconnect: voice recordings and
 * capture-class approvals. Writes are ATOMIC (write a temp file, then move it
 * over the journal) so a kill mid-write never leaves a half-written journal.
 *
 * This module is RN-free: all filesystem + time + id primitives are injected
 * (see `nativeOfflineDeps.ts` for the expo-file-system adapter), so it unit-
 * tests headless without a device — the same pattern as `uploadAndTranscribe.ts`.
 *
 * Durability contract:
 *  - The voice idempotency key is minted ONCE at enqueue and persisted on the
 *    item; every flush attempt reuses it, so a replay is safe server-side (U11).
 *  - Voice audio is moved out of the OS-evictable cache dir into
 *    documentDirectory at enqueue, and the durable copy is deleted ONLY after a
 *    confirmed flush (markDone) or an explicit cancel/permanent-drop.
 *  - A voice item checkpoints `{fileId, audioUrl}` after a successful
 *    upload+verify so a later attempt skips straight to POST /recordings.
 *  - On load, any `inflight` item (a flush that was interrupted) reverts to
 *    `pending` — at-least-once; server idempotency + the permanent-4xx drop make
 *    it effectively-once.
 */

export type QueueItemKind = 'voice' | 'approval';
export type QueueItemStatus = 'pending' | 'inflight' | 'done' | 'parked';

/** Persisted after a successful upload+verify so a retry skips the upload. */
export interface VoiceCheckpoint {
  fileId: string;
  audioUrl: string;
}

export interface VoiceQueuePayload {
  /** Durable audio uri (moved into documentDirectory at enqueue). */
  audioUri: string;
  contentType: string;
  sizeBytes: number;
  jobId?: string;
}

export interface ApprovalQueuePayload {
  proposalId: string;
  /** Capture-class type string — the ONLY lane allowed to queue (see enqueue). */
  proposalType: string;
  summary: string;
}

export type QueueItemPayload = VoiceQueuePayload | ApprovalQueuePayload;

export interface QueueItem {
  id: string;
  kind: QueueItemKind;
  payload: QueueItemPayload;
  status: QueueItemStatus;
  attempts: number;
  enqueuedAt: number;
  /** Voice only — minted once here, reused on every flush attempt. */
  idempotencyKey?: string;
  /** Voice only — set after a successful upload+verify. */
  checkpoint?: VoiceCheckpoint;
}

/** True for a voice item; narrows the payload union. */
export function isVoiceItem(
  item: QueueItem,
): item is QueueItem & { payload: VoiceQueuePayload } {
  return item.kind === 'voice';
}

/** Injected filesystem — the only native surface, adapted in nativeOfflineDeps. */
export interface QueueFs {
  /** Read a text file; resolve `null` if it does not exist. */
  read(uri: string): Promise<string | null>;
  /** Write a text file (overwriting). */
  write(uri: string, data: string): Promise<void>;
  /** Move/rename `from` → `to`, overwriting `to`. Removes `from`. */
  move(from: string, to: string): Promise<void>;
  /** Delete a file; a missing file is not an error (idempotent). */
  remove(uri: string): Promise<void>;
  /** Create a directory (and parents); a pre-existing dir is not an error. */
  ensureDir(uri: string): Promise<void>;
}

export interface OfflineQueueDeps {
  fs: QueueFs;
  now: () => number;
  /** Fresh unique id for an item and for the voice idempotency key. */
  makeId: () => string;
  /** Journal file uri, e.g. `${documentDirectory}offline-queue.json`. */
  journalUri: string;
  /** Durable audio directory (trailing slash), under documentDirectory. */
  audioDir: string;
  /** Fired after every persist with the current waiting count (pending+inflight). */
  onCountChange?: (count: number) => void;
}

export interface EnqueueVoiceInput {
  /** Source (cache) uri produced by expo-audio — moved into audioDir here. */
  sourceUri: string;
  contentType: string;
  sizeBytes: number;
  jobId?: string;
}

export interface EnqueueApprovalInput {
  proposalId: string;
  proposalType: string;
  summary: string;
}

interface Journal {
  version: 1;
  items: QueueItem[];
}

const JOURNAL_VERSION = 1;

function audioExtFor(contentType: string): string {
  if (/mp4|m4a/.test(contentType)) return 'm4a';
  if (/aac/.test(contentType)) return 'aac';
  if (/wav/.test(contentType)) return 'wav';
  return 'audio';
}

/**
 * The offline journal. One instance per app (see `offlineQueue.ts` for the
 * native singleton). All mutations persist atomically before resolving, so a
 * caller that awaits enqueue knows the item is on disk.
 */
export class OfflineQueue {
  private items: QueueItem[] = [];
  private loaded = false;
  private readonly listeners = new Set<(items: QueueItem[]) => void>();

  constructor(private readonly deps: OfflineQueueDeps) {}

  /** Read + validate the journal, reverting interrupted `inflight` items. */
  async load(): Promise<void> {
    const raw = await this.deps.fs.read(this.deps.journalUri);
    this.loaded = true;
    if (!raw) {
      this.items = [];
      this.emit();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt journal is not worth crashing the app over — start clean.
      this.items = [];
      this.emit();
      return;
    }
    const list =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as Journal).items)
        ? (parsed as Journal).items
        : [];
    this.items = list
      .filter(isValidItem)
      // Drop terminal 'done' rows (normally already removed) and recover any
      // 'inflight' item interrupted by a crash/relaunch back to 'pending'.
      .filter((it) => it.status !== 'done')
      .map((it) => (it.status === 'inflight' ? { ...it, status: 'pending' as const } : it));
    this.emit();
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error('OfflineQueue.load() must be awaited before use.');
    }
  }

  /** Snapshot of all items (pending/inflight/parked), FIFO by enqueue order. */
  snapshot(): QueueItem[] {
    return this.items.map((it) => ({ ...it }));
  }

  /** Items actively waiting to flush (pending or inflight) — drives the banner. */
  waitingCount(): number {
    return this.items.filter((it) => it.status === 'pending' || it.status === 'inflight').length;
  }

  /**
   * The next item to flush: approvals before voice, FIFO within each lane. Only
   * `pending` items are runnable (`inflight` is the one in flight, `parked`/
   * `done` are terminal for the drain).
   */
  nextRunnable(): QueueItem | null {
    const pending = this.items.filter((it) => it.status === 'pending');
    const byAge = (a: QueueItem, b: QueueItem) => a.enqueuedAt - b.enqueuedAt;
    const approvals = pending.filter((it) => it.kind === 'approval').sort(byAge);
    if (approvals.length > 0) return { ...approvals[0] };
    const voice = pending.filter((it) => it.kind === 'voice').sort(byAge);
    return voice.length > 0 ? { ...voice[0] } : null;
  }

  async enqueueVoice(input: EnqueueVoiceInput): Promise<QueueItem> {
    this.ensureLoaded();
    const id = this.deps.makeId();
    // Move the clip out of the evictable cache dir into a durable location so a
    // reconnect an hour later still has the audio to upload.
    await this.deps.fs.ensureDir(this.deps.audioDir);
    const durableUri = `${this.deps.audioDir}${id}.${audioExtFor(input.contentType)}`;
    await this.deps.fs.move(input.sourceUri, durableUri);
    const item: QueueItem = {
      id,
      kind: 'voice',
      payload: {
        audioUri: durableUri,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        ...(input.jobId ? { jobId: input.jobId } : {}),
      },
      status: 'pending',
      attempts: 0,
      enqueuedAt: this.deps.now(),
      // Minted ONCE, persisted, reused on every flush attempt.
      idempotencyKey: this.deps.makeId(),
    };
    this.items.push(item);
    await this.persist();
    return { ...item };
  }

  async enqueueApproval(input: EnqueueApprovalInput): Promise<QueueItem> {
    this.ensureLoaded();
    const item: QueueItem = {
      id: this.deps.makeId(),
      kind: 'approval',
      payload: {
        proposalId: input.proposalId,
        proposalType: input.proposalType,
        summary: input.summary,
      },
      status: 'pending',
      attempts: 0,
      enqueuedAt: this.deps.now(),
    };
    this.items.push(item);
    await this.persist();
    return { ...item };
  }

  async markInflight(id: string): Promise<void> {
    await this.patch(id, (it) => {
      it.status = 'inflight';
    });
  }

  /** inflight → pending (auth-park halt, or an interrupted attempt). */
  async revertToPending(id: string): Promise<void> {
    await this.patch(id, (it) => {
      it.status = 'pending';
    });
  }

  async setCheckpoint(id: string, checkpoint: VoiceCheckpoint): Promise<void> {
    await this.patch(id, (it) => {
      it.checkpoint = checkpoint;
    });
  }

  /** Increment the attempt counter and return to pending; returns new attempts. */
  async recordFailure(id: string): Promise<number> {
    let attempts = 0;
    await this.patch(id, (it) => {
      it.attempts += 1;
      it.status = 'pending';
      attempts = it.attempts;
    });
    return attempts;
  }

  /** Poison-park: retries exhausted (5xx/timeout after N). Stays on disk. */
  async markParked(id: string): Promise<void> {
    await this.patch(id, (it) => {
      it.status = 'parked';
    });
  }

  /** Confirmed flush: remove the item and delete its durable audio. */
  async markDone(id: string): Promise<void> {
    await this.removeInternal(id);
  }

  /** Permanent drop (resolved elsewhere / no longer approvable): same as done. */
  async drop(id: string): Promise<void> {
    await this.removeInternal(id);
  }

  /**
   * Cancel a queued item before it flushes. Refuses an `inflight` item (a flush
   * is mid-air). Returns true when removed.
   */
  async cancel(id: string): Promise<boolean> {
    const item = this.items.find((it) => it.id === id);
    if (!item || item.status === 'inflight') return false;
    await this.removeInternal(id);
    return true;
  }

  subscribe(listener: (items: QueueItem[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async removeInternal(id: string): Promise<void> {
    const item = this.items.find((it) => it.id === id);
    if (!item) return;
    this.items = this.items.filter((it) => it.id !== id);
    if (isVoiceItem(item)) {
      // Best-effort — a missing file is not an error (QueueFs.remove is idempotent).
      await this.deps.fs.remove(item.payload.audioUri);
    }
    await this.persist();
  }

  private async patch(id: string, mutate: (item: QueueItem) => void): Promise<void> {
    const item = this.items.find((it) => it.id === id);
    if (!item) return;
    mutate(item);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const journal: Journal = { version: JOURNAL_VERSION, items: this.items };
    const data = JSON.stringify(journal);
    const tmp = `${this.deps.journalUri}.tmp`;
    // Atomic swap: write the temp file fully, then move it over the journal.
    await this.deps.fs.write(tmp, data);
    await this.deps.fs.move(tmp, this.deps.journalUri);
    this.emit();
  }

  private emit(): void {
    this.deps.onCountChange?.(this.waitingCount());
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }
}

function isValidItem(value: unknown): value is QueueItem {
  if (!value || typeof value !== 'object') return false;
  const it = value as Partial<QueueItem>;
  if (typeof it.id !== 'string' || !it.id) return false;
  if (it.kind !== 'voice' && it.kind !== 'approval') return false;
  if (
    it.status !== 'pending' &&
    it.status !== 'inflight' &&
    it.status !== 'done' &&
    it.status !== 'parked'
  ) {
    return false;
  }
  if (typeof it.attempts !== 'number' || typeof it.enqueuedAt !== 'number') return false;
  if (!it.payload || typeof it.payload !== 'object') return false;
  return true;
}

export function createOfflineQueue(deps: OfflineQueueDeps): OfflineQueue {
  return new OfflineQueue(deps);
}
