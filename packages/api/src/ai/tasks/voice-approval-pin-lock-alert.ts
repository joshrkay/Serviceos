/**
 * #1238 — durable delivery of the tenant PIN-lock owner alert.
 *
 * The alert is CLAIMED once per lock episode (#1233 review) so a caller can
 * never make the owner's phone buzz at their own pace. Before #1238 a send that
 * failed after the claim won (Twilio error, no owner phone on file) used the
 * claim up for good: the owner never heard about five wrong PINs.
 *
 * Now the claim winner schedules ONE durable retry job BEFORE it sends (so a
 * crash between claim and send is covered too), and stamps the claim `sent_at`
 * on success. The retry worker re-sends only while the claim is unsent, with a
 * bounded backoff; it is driven by the queue, never by inbound calls, so the
 * caller still cannot trigger extra texts.
 */

/** Queue message type consumed by the unified poll loop (app.ts). */
export const PIN_LOCK_ALERT_RETRY_JOB_TYPE = 'voice_approval.pin_lock_alert_retry';

/** Delay before retry attempt N (1-based). The last entry bounds the ladder. */
export const PIN_LOCK_ALERT_RETRY_DELAYS_MS: readonly number[] = [
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
];

export interface PinLockAlertRetryJob {
  tenantId: string;
  /** The lock episode (the claim's key). */
  episodeKey: string;
  strikeCount: number;
  /** 1-based retry attempt this job represents. */
  attempt: number;
}

/** Schedules a durable retry (production: a delayed job on the shared queue). */
export interface PinLockAlertRetryScheduler {
  schedule(job: PinLockAlertRetryJob): Promise<void>;
}

export function pinLockAlertBody(strikeCount: number): string {
  return `Security alert: voice approval of money items is locked on your account after ${strikeCount} incorrect approval codes in 24 hours. Nothing was approved. Approve pending items in the app, and if those calls were not you, change your voice approval PIN.`;
}

/** Idempotency key per (tenant, episode, attempt): a replayed enqueue is a no-op. */
export function pinLockAlertRetryKey(job: PinLockAlertRetryJob): string {
  return `pin_lock_alert_retry:${job.tenantId}:${job.episodeKey}:${job.attempt}`;
}
