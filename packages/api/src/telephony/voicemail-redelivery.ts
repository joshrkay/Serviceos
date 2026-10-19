/**
 * LCR-04 — redelivery of voicemail recording callbacks that arrive while the
 * database is down.
 *
 * Twilio does not retry a recording-status callback that answers 5xx, and its
 * connection-override retries are bounded by a 15 s total budget — shorter
 * than any real brownout. So a voicemail recorded through the outage fallback
 * (or any voicemail whose callback lands during a brownout) was lost: the
 * signature check answered 500 (the dialled number's credential was not
 * cached) or the route did (its tenant lookup failed), and nothing ever asked
 * again.
 *
 * Instead of a 5xx, /voicemail-status hands the callback EXACTLY as Twilio
 * sent it — URL, form body and `X-Twilio-Signature` — to this queue and
 * answers 200. The queue re-POSTs it to that same public URL on a backoff
 * until a delivery is acknowledged (2xx), refused (4xx) or the deadline passes. The URL and
 * body are unchanged, so Twilio's signature still verifies on the receiving
 * process (whichever one the load balancer picks), and nothing is trusted
 * that Twilio did not sign. A redelivery carries {@link REDELIVERY_HEADER} so
 * the receiver answers a failure with 5xx (the queue then retries) instead of
 * queueing it a second time.
 *
 * Process-local by necessity: while the database is down there is no durable
 * store to put it in. A process that exits mid-outage loses what it queued;
 * the deadline log line names each dropped RecordingSid for recovery from
 * the Twilio console.
 */
import { createLogger } from '../logging/logger';
import type { SignedTwilioWebhook } from './twilio-signature';

const logger = createLogger({
  service: 'telephony.voicemail-redelivery',
  environment: process.env.NODE_ENV || 'development',
});

/** Marks a request as this queue's redelivery (lower-case: Node header names). */
export const REDELIVERY_HEADER = 'x-serviceos-redelivery';

/** Wait before each attempt; the last value repeats until the deadline. */
export const VOICEMAIL_REDELIVERY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 300_000];
/** How long a callback is redelivered before it is given up on. */
export const VOICEMAIL_REDELIVERY_DEADLINE_MS = 6 * 60 * 60 * 1000;
/** Bound on queued callbacks (a forged flood during an outage cannot grow memory). */
const VOICEMAIL_REDELIVERY_MAX_ENTRIES = 2_000;
/** Each redelivery request is cut off after this long. */
const VOICEMAIL_REDELIVERY_REQUEST_TIMEOUT_MS = 30_000;

export interface VoicemailRedelivery {
  /** Queue a callback for redelivery. `false` when it cannot be queued (full). */
  defer(request: SignedTwilioWebhook): boolean;
  /** Callbacks still waiting for an acknowledged delivery. */
  size(): number;
  /** Stop every pending timer (shutdown). */
  stop(): void;
}

export interface VoicemailRedeliveryOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  delaysMs?: readonly number[];
  deadlineMs?: number;
  maxEntries?: number;
}

interface Entry {
  key: string;
  request: SignedTwilioWebhook;
  firstDeferredAt: number;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createVoicemailRedelivery(options: VoicemailRedeliveryOptions = {}): VoicemailRedelivery {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const delays = options.delaysMs ?? VOICEMAIL_REDELIVERY_DELAYS_MS;
  const deadlineMs = options.deadlineMs ?? VOICEMAIL_REDELIVERY_DEADLINE_MS;
  const maxEntries = options.maxEntries ?? VOICEMAIL_REDELIVERY_MAX_ENTRIES;
  const entries = new Map<string, Entry>();
  let stopped = false;

  const describe = (entry: Entry) => ({
    recordingSid: entry.request.params.RecordingSid,
    callSid: entry.request.params.CallSid,
    attempts: entry.attempts,
  });

  const schedule = (entry: Entry): void => {
    if (stopped) return;
    const delay = delays[Math.min(entry.attempts, delays.length - 1)] ?? 60_000;
    if (now() + delay - entry.firstDeferredAt > deadlineMs) {
      entries.delete(entry.key);
      logger.error('voicemail-redelivery: deadline passed — callback dropped', describe(entry));
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void attempt(entry);
    }, delay);
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
  };

  const attempt = async (entry: Entry): Promise<void> => {
    entry.attempts += 1;
    let delivered = false;
    let refused = false;
    try {
      const res = await fetchImpl(entry.request.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': entry.request.signature,
          [REDELIVERY_HEADER]: '1',
        },
        body: new URLSearchParams(entry.request.params).toString(),
        signal: AbortSignal.timeout(VOICEMAIL_REDELIVERY_REQUEST_TIMEOUT_MS),
      });
      delivered = res.ok;
      // A 4xx is a refusal (the signature does not verify, the number belongs
      // to another account), not an outage: asking again cannot change it.
      refused = res.status >= 400 && res.status < 500;
      if (refused) {
        logger.error('voicemail-redelivery: refused — callback dropped', { ...describe(entry), status: res.status });
      } else if (!delivered) {
        logger.warn('voicemail-redelivery: not acknowledged yet', { ...describe(entry), status: res.status });
      }
    } catch (err) {
      logger.warn('voicemail-redelivery: request failed', {
        ...describe(entry),
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (delivered || refused) {
      entries.delete(entry.key);
      if (delivered) logger.info('voicemail-redelivery: delivered', describe(entry));
      return;
    }
    schedule(entry);
  };

  return {
    defer(request) {
      if (stopped) return false;
      // Only an exact duplicate (Twilio re-sending the same signed request)
      // is folded: keying on RecordingSid alone would let a forged callback
      // naming a real RecordingSid crowd out the genuine one.
      const key = `${request.url}\n${request.signature}\n${new URLSearchParams(request.params).toString()}`;
      if (entries.has(key)) return true;
      if (entries.size >= maxEntries) {
        logger.error('voicemail-redelivery: queue full — callback not queued', {
          recordingSid: request.params.RecordingSid,
          callSid: request.params.CallSid,
        });
        return false;
      }
      const entry: Entry = { key, request, firstDeferredAt: now(), attempts: 0, timer: null };
      entries.set(key, entry);
      logger.warn('voicemail-redelivery: queued until the database is back', describe(entry));
      schedule(entry);
      return true;
    },
    size: () => entries.size,
    stop() {
      stopped = true;
      for (const entry of entries.values()) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      if (entries.size > 0) {
        logger.error('voicemail-redelivery: stopped with callbacks still queued', {
          recordingSids: [...entries.values()].map((e) => e.request.params.RecordingSid),
        });
      }
      entries.clear();
    },
  };
}
