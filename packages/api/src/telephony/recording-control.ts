/**
 * RV-130 — call-recording control seam.
 *
 * `pauseRecording(callSid)` pauses the ACTIVE recording on a live call.
 * The interface is the seam the adapter's objection path consumes; tests
 * pass a stub. The Twilio implementation uses the documented
 * `Twilio.CURRENT` recording-sid alias so we never have to track the
 * RecordingSid from the recording-status webhook:
 *
 *   POST /2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}/Recordings/Twilio.CURRENT.json
 *   Status=paused
 *
 * Logging discipline mirrors recording-webhook.ts: never log the auth token
 * or any header derived from it.
 */
import { createLogger } from '../logging/logger';
import { timedFetch } from '../shared/timed-fetch';
import { getSentryClient } from '../monitoring/sentry';

const logger = createLogger({
  service: 'telephony.recording-control',
  environment: process.env.NODE_ENV || 'development',
});

export interface RecordingControl {
  /** Pause the active recording. Throws on a non-2xx provider response, or
   *  when the provider has not confirmed within the turn's wait (the pause is
   *  then still being delivered in the background). */
  pauseRecording(callSid: string): Promise<void>;
}

/**
 * The pause is awaited on the live voice turn before the acknowledgement is
 * spoken, so the TURN waits at most PAUSE_ACK_WAIT_MS for Twilio's answer —
 * an unanswered Twilio call must not leave the caller in dead air.
 *
 * The pause REQUEST is not cut off at that point: aborting it could cancel
 * the pause the caller asked for (a slow connect/TLS never sends it) and the
 * recording would keep running. It keeps going, bounded at
 * PAUSE_REQUEST_TIMEOUT_MS, and its real outcome is logged.
 */
export const PAUSE_ACK_WAIT_MS = 3_000;
export const PAUSE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The caller already heard the acknowledgement, yet the pause failed: the
 * recording may still be running after a consent revocation. Alert-level so
 * ops can act on the call (error log + Sentry when configured); the spoken
 * line is unchanged.
 */
function alertPauseFailedAfterAck(callSid: string, reason: string): void {
  logger.error('ALERT: recording pause failed after the caller was told it was paused', {
    alert: 'recording_pause_failed_after_ack',
    callSid,
    reason,
  });
  try {
    getSentryClient().withScope((scope) => {
      scope.setTag('alert', 'recording_pause_failed_after_ack');
      scope.setTag('call_sid', callSid);
      scope.captureException(new Error(`recording pause failed after acknowledgement: ${reason}`));
    });
  } catch {
    /* monitoring must never break the voice path */
  }
}

export class TwilioRecordingControl implements RecordingControl {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = timedFetch(PAUSE_REQUEST_TIMEOUT_MS, fetchImpl);
  }

  async pauseRecording(callSid: string): Promise<void> {
    const startedAt = Date.now();
    let turnMovedOn = false;
    const delivery = this.sendPause(callSid, () => turnMovedOn, startedAt);

    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    const ackWait = new Promise<'unconfirmed'>((resolve) => {
      ackTimer = setTimeout(() => resolve('unconfirmed'), PAUSE_ACK_WAIT_MS);
    });
    try {
      const first = await Promise.race([delivery.then(() => 'confirmed' as const), ackWait]);
      if (first === 'unconfirmed') {
        turnMovedOn = true;
        // The late outcome is logged by sendPause; nothing awaits it now.
        delivery.catch(() => undefined);
        logger.warn('pauseRecording: no Twilio answer yet; the turn moves on, the pause is still being sent', {
          callSid,
          waitedMs: PAUSE_ACK_WAIT_MS,
        });
        throw new Error(
          `pauseRecording unconfirmed: no Twilio answer within ${PAUSE_ACK_WAIT_MS}ms (still sending)`,
        );
      }
    } finally {
      clearTimeout(ackTimer);
    }
  }

  /** Send the pause and log its real outcome (also when it lands after the turn moved on). */
  private async sendPause(callSid: string, turnMovedOn: () => boolean, startedAt: number): Promise<void> {
    const url =
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}` +
      `/Calls/${encodeURIComponent(callSid)}/Recordings/Twilio.CURRENT.json`;
    const basic = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ Status: 'paused' }).toString(),
      });
    } catch (err) {
      // Same failure semantics as a rejected pause: log and throw. Other
      // transport errors propagate unchanged, as before.
      if (err instanceof Error && err.name === 'TimeoutError') {
        logger.error('pauseRecording: provider never answered; recording may NOT be paused', {
          callSid,
          timeoutMs: PAUSE_REQUEST_TIMEOUT_MS,
          afterTurnMovedOn: turnMovedOn(),
        });
        if (turnMovedOn()) alertPauseFailedAfterAck(callSid, `no answer within ${PAUSE_REQUEST_TIMEOUT_MS}ms`);
        throw new Error('pauseRecording failed: timeout');
      }
      if (turnMovedOn()) {
        alertPauseFailedAfterAck(callSid, err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      logger.warn('pauseRecording: provider rejected', {
        callSid,
        status: res.status,
        // Body is provider error JSON — safe to truncate-log, carries no creds.
        body: bodyText.slice(0, 200),
        afterTurnMovedOn: turnMovedOn(),
      });
      if (turnMovedOn()) alertPauseFailedAfterAck(callSid, `Twilio answered ${res.status}`);
      throw new Error(`pauseRecording failed: ${res.status}`);
    }
    logger.info('pauseRecording: recording paused', {
      callSid,
      elapsedMs: Date.now() - startedAt,
      afterTurnMovedOn: turnMovedOn(),
    });
  }
}
