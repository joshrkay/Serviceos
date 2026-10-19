/**
 * LCR-04 — the voicemail callback redelivery queue (voicemail-redelivery.ts).
 *
 * Seam: the queue's public interface (defer / size / stop) with a stubbed
 * fetch and fake timers. The end-to-end path (a real router answering 200 in
 * an outage, then filing the voicemail once the database is back) is pinned
 * in voicemail-status-route.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVoicemailRedelivery,
  REDELIVERY_HEADER,
} from '../../src/telephony/voicemail-redelivery';

const SIGNED = {
  url: 'https://api.test/api/telephony/voicemail-status?From=%2B15125550100&To=%2B15125550199',
  params: { CallSid: 'CA-1', RecordingSid: 'RE-1', RecordingStatus: 'completed' },
  signature: 'sig-from-twilio',
};

function fetchAnswering(statuses: number[]) {
  const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
  const impl = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, init });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    return { ok: status >= 200 && status < 300, status } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createVoicemailRedelivery', () => {
  it('re-POSTs the exact signed request on a backoff until it is acknowledged', async () => {
    const { impl, calls } = fetchAnswering([500, 503, 200]);
    const q = createVoicemailRedelivery({ fetchImpl: impl, delaysMs: [1_000, 5_000] });
    expect(q.defer(SIGNED)).toBe(true);
    expect(q.size()).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    // Same URL, same body, Twilio's own signature — so it verifies again.
    expect(calls[0].url).toBe(SIGNED.url);
    expect(calls[0].init.headers['X-Twilio-Signature']).toBe('sig-from-twilio');
    expect(calls[0].init.headers[REDELIVERY_HEADER]).toBe('1');
    expect(new URLSearchParams(calls[0].init.body).get('RecordingSid')).toBe('RE-1');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(3);
    expect(q.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(3);
  });

  it('a request that throws (the process is unreachable) is retried too', async () => {
    let n = 0;
    const impl = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const q = createVoicemailRedelivery({ fetchImpl: impl, delaysMs: [100] });
    q.defer(SIGNED);
    await vi.advanceTimersByTimeAsync(100);
    expect(q.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(q.size()).toBe(0);
  });

  it('a refusal (4xx: the signature does not verify) is final, not retried', async () => {
    const { impl, calls } = fetchAnswering([403]);
    const q = createVoicemailRedelivery({ fetchImpl: impl, delaysMs: [100] });
    q.defer(SIGNED);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);
    expect(q.size()).toBe(0);
  });

  it('gives up once the deadline has passed', async () => {
    const { impl, calls } = fetchAnswering([500]);
    const q = createVoicemailRedelivery({ fetchImpl: impl, delaysMs: [1_000], deadlineMs: 3_500 });
    q.defer(SIGNED);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(3);
    expect(q.size()).toBe(0);
  });

  it('folds only an exact duplicate; a different signature for the same RecordingSid is kept apart', () => {
    const { impl } = fetchAnswering([200]);
    const q = createVoicemailRedelivery({ fetchImpl: impl });
    q.defer(SIGNED);
    q.defer({ ...SIGNED });
    expect(q.size()).toBe(1);
    q.defer({ ...SIGNED, signature: 'forged' });
    expect(q.size()).toBe(2);
    q.stop();
  });

  it('refuses past its bound, and after stop()', () => {
    const { impl } = fetchAnswering([200]);
    const q = createVoicemailRedelivery({ fetchImpl: impl, maxEntries: 1 });
    expect(q.defer(SIGNED)).toBe(true);
    expect(q.defer({ ...SIGNED, signature: 'other' })).toBe(false);
    q.stop();
    expect(q.size()).toBe(0);
    expect(q.defer(SIGNED)).toBe(false);
  });
});
