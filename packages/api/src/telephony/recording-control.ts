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

const logger = createLogger({
  service: 'telephony.recording-control',
  environment: process.env.NODE_ENV || 'development',
});

export interface RecordingControl {
  /** Pause the active recording. Throws on a non-2xx provider response. */
  pauseRecording(callSid: string): Promise<void>;
}

export class TwilioRecordingControl implements RecordingControl {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async pauseRecording(callSid: string): Promise<void> {
    const url =
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}` +
      `/Calls/${encodeURIComponent(callSid)}/Recordings/Twilio.CURRENT.json`;
    const basic = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Status: 'paused' }).toString(),
    });
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
