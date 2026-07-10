import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveSubscriptionTransition,
  onTrialStarted,
  onPaymentPastDue,
} from './lifecycle';
import { setNurtureEngine, stubNurtureEngine, type NurtureNotification } from './nurture/trigger';

describe('resolveSubscriptionTransition (state machine)', () => {
  it('maps trialing -> active to trial_converted', () => {
    expect(resolveSubscriptionTransition('trialing', 'active')).toBe('trial_converted');
  });

  it('maps any -> past_due to payment_past_due', () => {
    expect(resolveSubscriptionTransition('active', 'past_due')).toBe('payment_past_due');
    expect(resolveSubscriptionTransition('trialing', 'past_due')).toBe('payment_past_due');
  });

  it('maps any -> canceled to canceled', () => {
    expect(resolveSubscriptionTransition('active', 'canceled')).toBe('canceled');
  });

  it('returns null for uninteresting transitions', () => {
    expect(resolveSubscriptionTransition('active', 'active')).toBeNull();
    expect(resolveSubscriptionTransition(undefined, 'trialing')).toBeNull();
  });

  it('does not misfire trial_converted when not coming from trialing', () => {
    expect(resolveSubscriptionTransition('past_due', 'active')).toBeNull();
  });
});

describe('lifecycle event bus -> nurture', () => {
  const received: NurtureNotification[] = [];

  beforeEach(() => {
    received.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    setNurtureEngine({
      notify(n) {
        received.push(n);
      },
    });
  });

  afterEach(() => {
    setNurtureEngine(stubNurtureEngine);
    vi.restoreAllMocks();
  });

  it('forwards trial_started to nurture with context', async () => {
    const event = await onTrialStarted({
      email: 'op@example.com',
      businessName: 'Acme HVAC',
      vertical: 'HVAC',
      plan: 'shop',
    });
    expect(event.type).toBe('trial_started');
    expect(event.at).toBeTruthy();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'trial_started',
      email: 'op@example.com',
      businessName: 'Acme HVAC',
      plan: 'shop',
    });
  });

  it('forwards payment_past_due', async () => {
    await onPaymentPastDue({ email: 'op@example.com', plan: 'pro' });
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('payment_past_due');
  });
});
