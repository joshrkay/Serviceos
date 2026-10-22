import { describe, expect, it } from 'vitest';
import { HERMETIC_CHECKOUT_400, HERMETIC_PLANS_503, PLANS } from './__fixtures__/after';
import { CHECKOUT_NO_URL, NETWORK_ERROR, planOption, trialErrorCopy } from './trial-copy';

const JARGON = /stripe|tenant|environment|configur|twilio|provision|\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b|\bHTTP\b|\bAI\b/i;

describe('planOption', () => {
  it('names the plan and its price from integer cents, with the users and minutes it includes', () => {
    expect(planOption(PLANS[0])).toEqual({
      key: 'starter',
      label: 'Starter, $79 a month',
      detail: 'Includes 2 users and 60 minutes of answered calls, then $1.25 a minute.',
    });
    expect(planOption(PLANS[1])).toEqual({
      key: 'growth',
      label: 'Growth, $199 a month',
      detail: 'Includes 5 users and 200 minutes of answered calls, then $1.25 a minute.',
    });
  });

  it('keeps the cents when they are not whole dollars, and never marks one plan as the one most shops pick', () => {
    const option = planOption({ ...PLANS[0], amountCents: 7_950 });
    expect(option.label).toBe('Starter, $79.50 a month');
    expect(option).not.toHaveProperty('mostShops');
  });

  it('says one user and one minute in the singular, and other billing periods in words', () => {
    expect(planOption({ ...PLANS[0], includedUsers: 1, includedAiMinutes: 1 }).detail).toBe('Includes 1 user and 1 minute of answered calls, then $1.25 a minute.');
    expect(planOption({ ...PLANS[0], interval: 'year' }).label).toBe('Starter, $79 a year');
  });
});

describe('planOption overage', () => {
  it('says what a minute costs past the included ones, from integer cents', () => {
    expect(planOption({ ...PLANS[0], overageCentsPerAiMinute: 125 }).detail).toContain(', then $1.25 a minute.');
    expect(planOption({ ...PLANS[0], overageCentsPerAiMinute: 100 }).detail).toContain(', then $1 a minute.');
    expect(planOption({ ...PLANS[0], overageCentsPerAiMinute: 90 }).detail).toContain(', then $0.90 a minute.');
  });

  it('leaves the clause out when extra minutes cost nothing, rather than promising "$0 a minute"', () => {
    expect(planOption({ ...PLANS[0], overageCentsPerAiMinute: 0 }).detail).toBe('Includes 2 users and 60 minutes of answered calls.');
  });
});

describe('trialErrorCopy', () => {
  it('turns what the hermetic API really answers into words an owner can act on, without its jargon', () => {
    const plans = trialErrorCopy('plans', 503, HERMETIC_PLANS_503.message);
    expect(plans).toBe("I can't show the plans right now. Try again in a minute, or contact support.");
    const checkout = trialErrorCopy('checkout', 400, HERMETIC_CHECKOUT_400.message);
    expect(checkout).toBe("I couldn't start your trial. Wait a minute and try again, or contact support.");
    for (const text of [plans, checkout]) expect(text).not.toMatch(JARGON);
  });

  it("keeps the API's own message when it is plain prose an owner can act on", () => {
    expect(trialErrorCopy('checkout', 400, 'A checkout was just started. Complete it or wait a moment before trying again.')).toBe(
      'A checkout was just started. Complete it or wait a moment before trying again.',
    );
  });

  it('drops a message that is not plain prose: codes, quotes, brackets, variable names, "tenant", "configured", or long', () => {
    for (const raw of [
      'Stripe checkout session failed (402): card_declined',
      'A subscription is already active for this tenant. Manage it from Settings → Billing.',
      'STRIPE_PRICE_ID is not set',
      'Subscription billing is not configured',
      'x'.repeat(200),
    ]) {
      expect(trialErrorCopy('checkout', 400, raw), raw).toMatch(/^I couldn't start your trial\./);
    }
  });

  it('says a temporary problem is temporary, whatever a 5xx body leaks', () => {
    expect(trialErrorCopy('checkout', 502, 'upstream timeout')).toBe("I can't start the checkout right now. Wait a minute and try again.");
    expect(trialErrorCopy('plans', 500, 'connect ECONNREFUSED 10.0.0.4:5432')).toBe("I can't show the plans right now. Wait a minute and try again.");
  });

  it('tells a teammate that only the owner starts the trial', () => {
    expect(trialErrorCopy('checkout', 403, 'Forbidden')).toBe('Only the owner can start the trial.');
  });

  it('has a plain answer for a 503 with no message, and for any other status', () => {
    expect(trialErrorCopy('checkout', 503)).toBe("I can't start trials right now. Try again in a minute, or contact support.");
    expect(trialErrorCopy('checkout', 409)).toBe("I couldn't start your trial. Try again, or contact support.");
    expect(trialErrorCopy('plans', 404)).toBe("I can't show the plans right now. Try again in a minute, or contact support.");
  });

  it('has fixed lines for a dropped connection and a checkout that gave no page', () => {
    expect(NETWORK_ERROR).toBe("I couldn't reach the checkout. Check your connection and try again.");
    expect(CHECKOUT_NO_URL).toBe("I couldn't open the checkout page. Try again, or contact support.");
    expect(NETWORK_ERROR).not.toMatch(JARGON);
    expect(CHECKOUT_NO_URL).not.toMatch(JARGON);
  });
});
