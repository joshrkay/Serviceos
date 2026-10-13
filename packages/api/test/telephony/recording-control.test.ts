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
import { resetSentryClient, setSentryClient } from '../../src/monitoring/sentry';
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

  describe('a pause that fails after the caller already heard "paused" alerts ops (review round 2, N5)', () => {
    let captured: Array<{ tags: Record<string, string>; error: Error }>;
    beforeEach(() => {
      captured = [];
      setSentryClient({
        withScope: (cb: (scope: { setTag(k: string, v: string): void; captureException(e: Error): string }) => unknown) => {
          const tags: Record<string, string> = {};
          return cb({ setTag: (k, v) => { tags[k] = v; }, captureException: (error) => { captured.push({ tags, error }); return 'id'; } });
        },
      } as never);
    });
    afterEach(() => resetSentryClient());

    /** Twilio answers with `status` after `answersAfterMs`. */
    const twilioAnswering = (status: number, answersAfterMs: number) =>
      new TwilioRecordingControl(
        'AC1',
        'tok',
        vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(fakeJson({ message: 'x' }, status)), answersAfterMs))) as unknown as typeof fetch,
      );

    it('a late Twilio rejection is captured with the callSid', async () => {
      const turn = track(twilioAnswering(500, 5_000).pauseRecording('CA-late-fail'));
      await advance(5_000);

      expect(turn.state.status).toBe('rejected');
      expect(captured).toHaveLength(1);
      expect(captured[0].tags).toMatchObject({ call_sid: 'CA-late-fail', alert: 'recording_pause_failed_after_ack' });
    });

    it('a late success, or a failure the turn saw itself, raises no alert', async () => {
      track(twilioAnswering(200, 5_000).pauseRecording('CA-late-ok'));
      track(twilioAnswering(500, 1_000).pauseRecording('CA-fast-fail'));
      await advance(5_000);

      expect(captured).toEqual([]);
    });
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
