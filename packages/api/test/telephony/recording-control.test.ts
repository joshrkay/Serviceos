/**
 * Reliability #4 / review of #1677 (M2) — "stop recording" pauses the Twilio
 * recording on the live voice turn, BEFORE the acknowledgement is spoken.
 *
 * Two separate bounds:
 *   - the TURN waits at most 3 s for Twilio's answer, so a slow Twilio never
 *     leaves the caller in dead air (an unconfirmed pause fails the same way a
 *     rejected one does — a thrown error the objection handler catches);
 *   - the PAUSE REQUEST itself is not cut off at 3 s: it keeps going (bounded
 *     at 30 s), so a slow Twilio still applies the pause the caller asked for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwilioRecordingControl } from '../../src/telephony/recording-control';
import { advance, fakeJson, hangingFetch, settleWithin, track, useProviderClock } from '../helpers/hanging-fetch';

/** Twilio applies the pause when it answers, unless the request was aborted first. */
function slowTwilio(answersAfterMs: number) {
  const twilio = { paused: false, aborted: false };
  const fetchImpl = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        const answer = Number.isFinite(answersAfterMs)
          ? setTimeout(() => {
              twilio.paused = true;
              resolve(fakeJson({ status: 'paused' }));
            }, answersAfterMs)
          : undefined;
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(answer);
            twilio.aborted = true;
            reject(init.signal!.reason);
          },
          { once: true },
        );
      }),
  );
  return { twilio, control: new TwilioRecordingControl('AC1', 'tok', fetchImpl as unknown as typeof fetch) };
}

describe('TwilioRecordingControl.pauseRecording', () => {
  beforeEach(() => useProviderClock());
  afterEach(() => vi.useRealTimers());

  it('a pause Twilio confirms within 3 s resolves', async () => {
    const { twilio, control } = slowTwilio(1_000);

    const outcome = await settleWithin(control.pauseRecording('CA1'), 3_000);

    expect(outcome.status).toBe('fulfilled');
    expect(twilio.paused).toBe(true);
  });

  it('a slow pause: the turn moves on at 3 s, and Twilio still applies the pause when it answers', async () => {
    const { twilio, control } = slowTwilio(5_000);

    const turn = track(control.pauseRecording('CA1'));
    await advance(3_000);
    expect(turn.state.status).toBe('rejected'); // the acknowledgement is not held up

    await advance(2_000);
    expect(twilio.aborted).toBe(false);
    expect(twilio.paused).toBe(true);
    expect((turn.state as { reason: Error }).reason.message).toMatch(/^pauseRecording unconfirmed/);
  });

  it('a pause that never answers is given up at 30 s, not 3 s', async () => {
    const { twilio, control } = slowTwilio(Infinity);
    const turn = track(control.pauseRecording('CA1'));

    await advance(29_000);
    expect(turn.state.status).toBe('rejected'); // the turn moved on long ago
    expect(twilio.aborted).toBe(false);
    await advance(1_000);
    expect(twilio.aborted).toBe(true);
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
