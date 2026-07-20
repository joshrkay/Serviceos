/**
 * Offline queue flush machine (U12). Runs on the connectivity reconnect edge,
 * app foreground, and manual retry — sequential, approvals before voice.
 *
 * Error taxonomy (per the master blueprint plan):
 *  - 2xx → done (item removed; queued audio deleted after a confirmed flush).
 *  - Any 4xx EXCEPT 401/408/429 → permanent drop with the "resolved elsewhere /
 *    no longer approvable" notice + an inbox re-fetch. This covers both the
 *    409 ConflictError and the 400 VALIDATION_ERROR an *expired* proposal
 *    returns — the expiring schedule types are all capture-class, so the 400
 *    path is the likely stale case, not the corner.
 *  - 401/terminal-auth (tagged TerminalAuthError, or the null-token
 *    AbortError) → park the item behind sign-in and stop the run. The flush
 *    runs on an ApiFetch built WITHOUT `onUnauthenticated`, so a background
 *    flush never toasts or navigates to sign-in.
 *  - 5xx / timeout / 408 / 429 / network → capped backoff (stop the run,
 *    retry later), then poison-park after {@link MAX_FLUSH_ATTEMPTS}.
 *
 * Pure module: no RN/Expo imports; everything effectful is injected.
 */
import type { ApiFetch } from '../lib/apiFetch';
import {
  isVoiceHttpError,
  submitRecording,
  uploadAndVerifyClip,
  type FileUploader,
} from '../voice/uploadAndTranscribe';
import type {
  ApprovalQueuePayload,
  OfflineQueue,
  OfflineQueueItem,
  VoiceQueuePayload,
} from './queue';

/** Attempts before a transient-failing item is poison-parked. */
export const MAX_FLUSH_ATTEMPTS = 8;

const BASE_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

/** Capped exponential backoff for scheduling the next flush after a transient failure. */
export function nextRetryDelayMs(attempts: number): number {
  const exp = Math.min(Math.max(attempts, 1), 10);
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** (exp - 1), MAX_RETRY_DELAY_MS);
}

export type FlushOutcome = 'done' | 'drop' | 'retry' | 'auth';

interface StatusCarrier {
  status: number;
}

function hasStatus(input: unknown): input is StatusCarrier {
  return (
    typeof input === 'object' &&
    input !== null &&
    typeof (input as StatusCarrier).status === 'number'
  );
}

function classifyStatus(status: number): FlushOutcome {
  if (status >= 200 && status < 300) return 'done';
  if (status === 401) return 'auth';
  if (status === 408 || status === 429) return 'retry';
  if (status >= 400 && status < 500) return 'drop';
  return 'retry';
}

/**
 * Classify a flush failure — a non-2xx Response(-like) or a thrown error —
 * into the taxonomy above. Unknown thrown shapes classify as 'retry': the
 * server side is idempotent (U11 voice replay; approve-by-state), so retrying
 * is safe while dropping would lose the owner's action.
 */
export function classifyFlushFailure(input: unknown): FlushOutcome {
  if (hasStatus(input)) return classifyStatus(input.status);
  if (input instanceof Error) {
    // Terminal auth (exhausted 401 retry) and the null-token abort minted by
    // apiFetch when Clerk has no session — both mean "park behind sign-in".
    if (input.name === 'TerminalAuthError' || input.name === 'AbortError') return 'auth';
    if (isVoiceHttpError(input)) return classifyStatus(input.status);
    if (input.name === 'TimeoutError') return 'retry';
    if (/network request failed/i.test(input.message)) return 'retry';
  }
  return 'retry';
}

export interface FlushDeps {
  /** Auth-suppressed client — built WITHOUT `onUnauthenticated`. */
  api: ApiFetch;
  uploadFile: FileUploader;
  /** Delete a queued audio file after its item flushed (idempotent). */
  deleteAudio?: (localUri: string) => Promise<void>;
  /** A 4xx permanently dropped this item — show the notice + re-fetch the inbox. */
  onItemDropped?: (item: OfflineQueueItem) => void;
  onItemFlushed?: (item: OfflineQueueItem) => void;
  now?: () => number;
}

export interface FlushResult {
  flushed: number;
  dropped: number;
  /** Set when the run stopped on a transient failure — retry after this delay. */
  retryAfterMs?: number;
  /** Set when the run stopped on a terminal auth failure (items auth-parked). */
  authParked?: boolean;
}

/** Approvals flush before voice; FIFO (journal order) within each kind. */
export function orderForFlush(items: readonly OfflineQueueItem[]): OfflineQueueItem[] {
  const pending = items.filter((i) => i.status === 'pending');
  return [...pending.filter((i) => i.kind === 'approval'), ...pending.filter((i) => i.kind === 'voice')];
}

async function executeApproval(item: OfflineQueueItem, deps: FlushDeps): Promise<FlushOutcome> {
  const payload = item.payload as ApprovalQueuePayload;
  let res: { ok: boolean; status: number };
  try {
    res = await deps.api(`/api/proposals/${payload.proposalId}/approve`, { method: 'POST' });
  } catch (err) {
    return classifyFlushFailure(err);
  }
  return res.ok ? 'done' : classifyStatus(res.status);
}

async function executeVoice(
  item: OfflineQueueItem,
  queue: OfflineQueue,
  deps: FlushDeps,
): Promise<FlushOutcome> {
  const payload = item.payload as VoiceQueuePayload;
  try {
    let checkpoint = item.checkpoint;
    if (!checkpoint) {
      // Phase 1 — upload + verify, then persist the checkpoint so a later
      // attempt skips straight to the create POST instead of re-uploading
      // (and minting orphan file rows). A failure before verify restarts the
      // upload; torn-attempt orphan file rows are accepted.
      checkpoint = await uploadAndVerifyClip(
        { fileUri: payload.localUri, contentType: payload.contentType, sizeBytes: payload.sizeBytes },
        { api: deps.api, uploadFile: deps.uploadFile, makeIdempotencyKey: () => item.idempotencyKey, now: deps.now },
      );
      await queue.setCheckpoint(item.id, checkpoint);
    }
    // Phase 2 — replay-safe create: the SAME journaled key on every attempt
    // (U11 server dedup makes the replay resolve to the original recording).
    await submitRecording(
      { api: deps.api },
      {
        fileId: checkpoint.fileId,
        audioUrl: checkpoint.audioUrl,
        idempotencyKey: item.idempotencyKey,
        ...(payload.jobId ? { jobId: payload.jobId } : {}),
      },
    );
    return 'done';
  } catch (err) {
    return classifyFlushFailure(err);
  }
}

/**
 * Drain the queue sequentially. Stops early on a transient failure (capped
 * backoff — the network is likely still bad) or a terminal auth failure
 * (items park behind sign-in); drops continue to the next item.
 */
export async function flushQueue(queue: OfflineQueue, deps: FlushDeps): Promise<FlushResult> {
  const result: FlushResult = { flushed: 0, dropped: 0 };

  for (const item of orderForFlush(queue.list())) {
    await queue.markInflight(item.id);

    const outcome =
      item.kind === 'approval'
        ? await executeApproval(item, deps)
        : await executeVoice(item, queue, deps);

    if (outcome === 'done') {
      await queue.remove(item.id);
      if (item.kind === 'voice' && deps.deleteAudio) {
        // Delete only after the confirmed flush; failures are non-fatal (the
        // file is orphaned in our own document dir, not re-sent).
        try {
          await deps.deleteAudio((item.payload as VoiceQueuePayload).localUri);
        } catch {
          // ignore — orphaned file, cleaned up by a future enqueue cycle
        }
      }
      result.flushed += 1;
      deps.onItemFlushed?.(item);
      continue;
    }

    if (outcome === 'drop') {
      await queue.remove(item.id);
      if (item.kind === 'voice' && deps.deleteAudio) {
        try {
          await deps.deleteAudio((item.payload as VoiceQueuePayload).localUri);
        } catch {
          // ignore
        }
      }
      result.dropped += 1;
      deps.onItemDropped?.(item);
      continue;
    }

    if (outcome === 'auth') {
      await queue.authPark(item.id);
      result.authParked = true;
      return result;
    }

    // retry — transient. Bump attempts; poison-park past the cap, else back
    // to pending. Either way stop the run: the network is likely still bad.
    const attempts = await queue.bumpAttempts(item.id);
    if (attempts >= MAX_FLUSH_ATTEMPTS) {
      await queue.park(item.id);
    } else {
      await queue.markPending(item.id);
      result.retryAfterMs = nextRetryDelayMs(attempts);
    }
    return result;
  }

  return result;
}
