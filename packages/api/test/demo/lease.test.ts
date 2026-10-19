/**
 * S6-3 (U7 "One live call per tenant") — the lease's timing constants by
 * value, and the `$live` table: only `ringing` and `in-progress` prove the
 * call has left Twilio's queue, so only they may renew the lease (S6-6).
 */
import { describe, it, expect } from 'vitest';
import {
  CALLS_REQUEST_TIMEOUT_MS,
  RING_TIMEOUT_S,
  TIME_LIMIT_S,
  GRACE_S,
  PRE_LIVE_WINDOW_S,
  LIVE_LEASE_S,
  isLiveStatus,
} from '../../src/demo/lease';

describe('lease constants', () => {
  it('are the plan values', () => {
    expect(CALLS_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(RING_TIMEOUT_S).toBe(30);
    expect(TIME_LIMIT_S).toBe(90);
    expect(GRACE_S).toBe(30);
    expect(PRE_LIVE_WINDOW_S).toBe(70);
    expect(LIVE_LEASE_S).toBe(150);
  });

  it('the pre-live window is the request bound plus the ring timeout plus grace; the live lease is ring + limit + grace', () => {
    expect(CALLS_REQUEST_TIMEOUT_MS / 1000 + RING_TIMEOUT_S + GRACE_S).toBe(70);
    expect(RING_TIMEOUT_S + TIME_LIMIT_S + GRACE_S).toBe(150);
  });
});

describe('isLiveStatus', () => {
  it.each(['ringing', 'in-progress'])('%s is live', (s) => {
    expect(isLiveStatus(s)).toBe(true);
  });
  it.each([
    'queued',
    'initiated',
    'completed',
    'busy',
    'failed',
    'no-answer',
    'canceled',
    'calls_response',
    'RINGING',
    '',
    'answered',
    undefined,
    null,
  ])('%s is not live', (s) => {
    expect(isLiveStatus(s as string | undefined)).toBe(false);
  });
});
