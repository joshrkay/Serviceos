/**
 * S6-3 (U7 "Consent, limits, handoff"; "Pool exhausted") — what the visitor
 * is told for each refusal: the status code and the copy, in plain words.
 * The limiter itself is proven on real Postgres (demo-calls.test.ts); this is
 * the answer each outcome maps to.
 */
import { describe, it, expect } from 'vitest';
import { demoStartHttp } from '../../src/demo/routes';

describe('demo start answers', () => {
  it('the same number twice in a day answers 429 with the friendly copy', () => {
    expect(demoStartHttp({ kind: 'rate_limited' })).toEqual({
      status: 429,
      body: { error: 'DEMO_DAILY_LIMIT', message: "You've already had today's demo. Try again tomorrow." },
    });
  });

  it.each(['pool', 'budget'] as const)('busy (%s) answers 503 DEMO_BUSY with the busy copy', (cause) => {
    expect(demoStartHttp({ kind: 'busy', cause })).toEqual({
      status: 503,
      body: { error: 'DEMO_BUSY', message: 'Every line is busy. Try again in a minute.' },
    });
  });

  it('kill switch on (or the module closed) answers 503 DEMO_DISABLED', () => {
    expect(demoStartHttp({ kind: 'disabled', reason: 'DEMO_CALLS_ENABLED is off' })).toEqual({
      status: 503,
      body: { error: 'DEMO_DISABLED', message: "The demo call isn't available right now." },
    });
  });

  it.each(['malformed', 'non_nanp', 'premium_npa'] as const)('a %s number answers 400', (reason) => {
    expect(demoStartHttp({ kind: 'number_not_allowed', reason })).toEqual({
      status: 400,
      body: { error: 'DEMO_NUMBER_NOT_ALLOWED', message: 'We can only call a US or Canadian phone number.' },
    });
  });

  it('a call that was provably never placed answers 502 and says a retry is fine', () => {
    expect(demoStartHttp({ kind: 'failed', correlationId: 'c1' })).toEqual({
      status: 502,
      body: { error: 'DEMO_CALL_FAILED', message: "We couldn't place the call. Please try again in a few minutes." },
    });
  });

  it.each(['created', 'unconfirmed'] as const)('a %s call answers 202 calling (unconfirmed looks like success)', (outcome) => {
    expect(demoStartHttp({ kind: 'calling', correlationId: 'c1', outcome })).toEqual({
      status: 202,
      body: { correlationId: 'c1', status: 'calling' },
    });
  });

  it('no visitor copy uses a word the product never shows', () => {
    const banned = /\b(AI|agent|dashboard|verify|provisioning|proposal|Stripe|Twilio)\b/i;
    const all = [
      demoStartHttp({ kind: 'rate_limited' }),
      demoStartHttp({ kind: 'busy', cause: 'pool' }),
      demoStartHttp({ kind: 'disabled', reason: 'x' }),
      demoStartHttp({ kind: 'number_not_allowed', reason: 'non_nanp' }),
      demoStartHttp({ kind: 'failed', correlationId: 'c' }),
    ];
    for (const a of all) expect((a.body as { message: string }).message).not.toMatch(banned);
  });
});
