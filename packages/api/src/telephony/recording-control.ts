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

const logger = createLogger({
  service: 'telephony.recording-control',
  environment: process.env.NODE_ENV || 'development',
});

export interface RecordingControl {
  /** Pause the active recording. Throws on a non-2xx provider response. */
  pauseRecording(callSid: string): Promise<void>;
}

/**
 * The pause is awaited on the live voice turn before the acknowledgement is
 * spoken, so an unanswered Twilio call would leave the caller in dead air.
 */
export const PAUSE_RECORDING_TIMEOUT_MS = 3_000;

export class TwilioRecordingControl implements RecordingControl {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = timedFetch(PAUSE_RECORDING_TIMEOUT_MS, fetchImpl);
  }

  async pauseRecording(callSid: string): Promise<void> {
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
        logger.warn('pauseRecording: provider timed out', {
          callSid,
          timeoutMs: PAUSE_RECORDING_TIMEOUT_MS,
        });
        throw new Error('pauseRecording failed: timeout');
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
      });
      throw new Error(`pauseRecording failed: ${res.status}`);
    }
    logger.info('pauseRecording: recording paused', { callSid });
  }
}
