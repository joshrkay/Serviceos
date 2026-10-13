/**
 * Reliability #4 — "stop recording" pauses the Twilio recording on the live
 * voice turn, BEFORE the acknowledgement is spoken. A Twilio call that never
 * answers must not leave the caller in dead air: the pause gives up at 3 s and
 * fails the same way a rejected (non-2xx) pause does — a thrown
 * "pauseRecording failed: …" error the objection handler already catches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwilioRecordingControl } from '../../src/telephony/recording-control';
import { fakeJson, hangingFetch, settleWithin, useProviderClock } from '../helpers/hanging-fetch';

describe('TwilioRecordingControl.pauseRecording', () => {
  beforeEach(() => useProviderClock());
  afterEach(() => vi.useRealTimers());

  it('a Twilio pause that never answers fails at 3 s like a rejected pause', async () => {
    const control = new TwilioRecordingControl('AC1', 'tok', hangingFetch() as unknown as typeof fetch);

    const outcome = await settleWithin(control.pauseRecording('CA1'), 3_000);

    expect(outcome.status).toBe('rejected');
    expect((outcome as { reason: Error }).reason.message).toBe('pauseRecording failed: timeout');
  });

  it('a rejected pause keeps failing with its status', async () => {
    const control = new TwilioRecordingControl(
      'AC1',
      'tok',
      hangingFetch(() => false, () => fakeJson({ message: 'no recording' }, 404)) as unknown as typeof fetch,
    );

    await expect(control.pauseRecording('CA1')).rejects.toThrow('pauseRecording failed: 404');
  });
});
