/**
 * Offline flush state machine (U12).
 *
 * Drains the offline journal on the connectivity reconnect edge (and on app
 * foreground / manual retry, wired by the React host). Sequential — one item
 * in flight at a time — and APPROVALS BEFORE VOICE, so a queued approval lands
 * before its (possibly larger, slower) voice sibling.
 *
 * Error taxonomy (the load-bearing part; exact per adversarial review):
 *   - 2xx                                   → done (item removed, audio deleted)
 *   - any 4xx EXCEPT 401 / 408 / 429        → PERMANENT DROP + "resolved
 *       elsewhere / no longer approvable" notice + inbox re-fetch. Covers both
 *       the 409 ConflictError AND the 400 VALIDATION_ERROR an *expired*
 *       proposal returns (the expiring schedule types are capture-class, so the
 *       400 is the likely stale case, not a corner).
 *   - 401 / auth (tagged terminal 401 OR null-token AbortError)
 *                                           → PARK behind sign-in: halt the
 *       drain, keep the queue intact, NO navigation side effect.
 *   - 5xx / timeout / 408 / 429 / network   → capped backoff, then poison-park
 *       after N attempts.
 *
 * RN-free: the transport (`ApiFetch`), uploader, clock and sleep are injected,
 * so the machine unit-tests headless. The only import with a native tail is
 * `connectivity` (NetInfo), which the vitest config aliases to a stub and tests
 * drive through `__emitNetInfoForTests` — the same seam the read hooks use.
 */
import { isCurrentlyOnline, onReconnect } from '../lib/connectivity';
import type { ApiFetch } from '../lib/apiFetch';
import { deliverRecording, type FileUploader } from '../voice/uploadAndTranscribe';
import type { OfflineQueue, QueueItem, VoiceQueuePayload } from './queue';

/** How a single flush attempt resolved, per the taxonomy above. */
export type FlushDisposition = 'done' | 'auth' | 'drop' | 'retry';

/** Default poison-park threshold — attempts before a retryable item parks. */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Default backoff base; capped at {@link BACKOFF_CAP_MS}. */
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;

export interface FlushDeps {
  queue: OfflineQueue;
  /**
   * Auth-aware transport WITHOUT an `onUnauthenticated` side effect — a
   * background flush must never toast or navigate to sign-in. A terminal 401
   * surfaces as the tagged `UnauthorizedError`; a null token as an AbortError.
   * Both are park signals.
   */
  api: ApiFetch;
  uploadFile: FileUploader;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Fired for a permanent-drop item (notice + inbox re-fetch live here). */
  onPermanentDrop?: (item: QueueItem) => void;
  /** Fired when the drain halts on an auth failure. MUST NOT navigate. */
  onAuthRequired?: () => void;
  maxAttempts?: number;
  backoffBaseMs?: number;
}

/** True for the two auth-park shapes: tagged terminal 401 and null-token abort. */
function isAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true; // makeUnauthenticatedAbort (null token)
  if (err.name === 'UnauthorizedError') return true; // makeUnauthorizedError (terminal 401)
  return (err as { status?: number }).status === 401;
}

/** Classify a thrown error / status-tagged failure into the flush taxonomy. */
export function classifyFlushError(err: unknown): Exclude<FlushDisposition, 'done'> {
  if (isAuthError(err)) return 'auth';
  const status = err instanceof Error ? (err as { status?: number }).status : undefined;
  if (typeof status === 'number') {
    // 408 (timeout) and 429 (rate limit) are transient — retry with backoff.
    if (status === 408 || status === 429) return 'retry';
    // Every other 4xx is terminal for this action: it will never succeed on
    // replay (409 already-resolved, 400 expired, 404 gone, 403 no longer
    // permitted). Drop it rather than spin.
    if (status >= 400 && status < 500) return 'drop';
    if (status >= 500) return 'retry';
  }
  // No status — timeout / offline / ambiguous transport failure. Retry (then
  // poison-park); never silently drop captured work on an ambiguous error.
  return 'retry';
}

/** Capped exponential backoff for retry attempt `n` (1-based). */
export function backoffMs(n: number, base = DEFAULT_BACKOFF_BASE_MS): number {
  return Math.min(base * 2 ** Math.max(0, n - 1), BACKOFF_CAP_MS);
}

/** An Error carrying the HTTP status of a non-2xx response, for classification. */
function statusError(status: number, message: string): Error {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

export interface FlushController {
  /** Drain the queue once (no-op if already draining or offline). */
  flush(): Promise<void>;
  /**
   * Reactivate any poison-parked items (fresh retry budget), then drain. This
   * is the recovery path for work that exhausted its automatic retries; use it
   * where conditions have plausibly changed — the reconnect edge and an
   * explicit user retry (pull-to-refresh). Plain {@link flush} (e.g. app
   * foreground, which fires often) intentionally does NOT reactivate.
   */
  retry(): Promise<void>;
  /** Subscribe to reconnect edges; returns an unsubscribe. */
  start(): () => void;
}

export function createFlushController(deps: FlushDeps): FlushController {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffBase = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  let flushing = false;

  async function runItem(item: QueueItem): Promise<void> {
    if (item.kind === 'approval') {
      const payload = item.payload as { proposalId: string };
      const res = await deps.api(`/api/proposals/${payload.proposalId}/approve`, {
        method: 'POST',
      });
      if (res.ok) return;
      throw statusError(res.status, `Approve failed (${res.status}).`);
    }
    // voice — deliver through the shared pipeline (upload+verify → POST
    // /recordings), reusing the persisted checkpoint and the SAME idempotency
    // key on every attempt. We stop at POST /recordings: once the recording is
    // created + enqueued server-side the offline job is delivered (U11 makes a
    // replay safe); polling to transcript is a foreground concern.
    const payload = item.payload as VoiceQueuePayload;
    await deliverRecording(
      {
        fileUri: payload.audioUri,
        contentType: payload.contentType,
        sizeBytes: payload.sizeBytes,
      },
      {
        api: deps.api,
        uploadFile: deps.uploadFile,
        makeIdempotencyKey: () => item.idempotencyKey ?? '',
        now: deps.now,
        checkpoint: item.checkpoint,
        // Persist the checkpoint BEFORE POST /recordings so a crash between
        // verify and create resumes past the upload next time.
        onCheckpoint: (cp) => deps.queue.setCheckpoint(item.id, cp),
      },
      payload.jobId,
    );
  }

  async function drain(): Promise<void> {
    for (;;) {
      const item = deps.queue.nextRunnable();
      if (!item) return;
      await deps.queue.markInflight(item.id);

      let disposition: FlushDisposition;
      try {
        await runItem(item);
        disposition = 'done';
      } catch (err) {
        disposition = classifyFlushError(err);
      }

      if (disposition === 'done') {
        await deps.queue.markDone(item.id);
        continue;
      }
      if (disposition === 'auth') {
        // Park behind sign-in: keep the item, halt the drain, no navigation.
        await deps.queue.revertToPending(item.id);
        deps.onAuthRequired?.();
        return;
      }
      if (disposition === 'drop') {
        await deps.queue.drop(item.id);
        deps.onPermanentDrop?.(item);
        continue;
      }
      // retry — count the attempt; poison-park once exhausted, else backoff.
      const attempts = await deps.queue.recordFailure(item.id);
      if (attempts >= maxAttempts) {
        await deps.queue.markParked(item.id);
        continue;
      }
      await deps.sleep(backoffMs(attempts, backoffBase));
    }
  }

  // Single critical section for both plain and reactivating drains. Holding the
  // `flushing` guard across reactivateParked() AND the drain is load-bearing:
  // if reactivation ran outside the guard, two concurrent retries (manual
  // signal + reconnect/fresh-launch) could interleave so one persists a
  // reactivated `pending` snapshot while the other has already `markDone`d the
  // item — the stale persist lands last and resurrects a delivered approval.
  async function runGuarded(reactivate: boolean): Promise<void> {
    if (flushing) return;
    if (!isCurrentlyOnline()) return;
    flushing = true;
    try {
      // reactivateParked is a no-op (no persist) when nothing is parked, so a
      // reactivating drain is as cheap as a plain one on the common path.
      if (reactivate) await deps.queue.reactivateParked();
      await drain();
    } finally {
      flushing = false;
    }
  }

  async function flush(): Promise<void> {
    await runGuarded(false);
  }

  async function retry(): Promise<void> {
    await runGuarded(true);
  }

  function start(): () => void {
    // Network just came back — retry EVERYTHING, including items that
    // poison-parked on the failures that preceded the outage.
    return onReconnect(() => {
      void retry();
    });
  }

  return { flush, retry, start };
}
