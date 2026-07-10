import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeDueEmails, LiveNurtureEngine, type ContactState } from './engine';
import { resendTransport, previewTransport } from './transport';
import { clearMailbox, getMailbox } from './mailbox';

const DAY_MS = 24 * 60 * 60 * 1000;

function baseState(overrides: Partial<ContactState> = {}): ContactState {
  return {
    email: 'test+rivet@example.com',
    sentEmailIds: [],
    data: {},
    ...overrides,
  };
}

describe('computeDueEmails (pure function, trial_started drip windows)', () => {
  const t0 = new Date('2026-01-01T00:00:00.000Z');

  it('only welcome is due at day 0', () => {
    const state = baseState({ trialStartedAt: t0.toISOString() });
    const due = computeDueEmails(state, t0);
    expect(due.map((e) => e.id)).toEqual(['welcome']);
  });

  it('activation-nudge becomes due at day 1 (welcome already sent)', () => {
    const state = baseState({
      trialStartedAt: t0.toISOString(),
      sentEmailIds: ['welcome'],
    });
    const now = new Date(t0.getTime() + 1 * DAY_MS);
    const due = computeDueEmails(state, now);
    expect(due.map((e) => e.id)).toEqual(['activation-nudge']);
  });

  it('mid-trial-value becomes due at day 5', () => {
    const state = baseState({
      trialStartedAt: t0.toISOString(),
      sentEmailIds: ['welcome', 'activation-nudge'],
    });
    const now = new Date(t0.getTime() + 5 * DAY_MS);
    const due = computeDueEmails(state, now);
    expect(due.map((e) => e.id)).toEqual(['mid-trial-value']);
  });

  it('honesty becomes due at day 8', () => {
    const state = baseState({
      trialStartedAt: t0.toISOString(),
      sentEmailIds: ['welcome', 'activation-nudge', 'mid-trial-value'],
    });
    const now = new Date(t0.getTime() + 8 * DAY_MS);
    const due = computeDueEmails(state, now);
    expect(due.map((e) => e.id)).toEqual(['honesty']);
  });

  it('trial-ending becomes due at day 11', () => {
    const state = baseState({
      trialStartedAt: t0.toISOString(),
      sentEmailIds: ['welcome', 'activation-nudge', 'mid-trial-value', 'honesty'],
    });
    const now = new Date(t0.getTime() + 11 * DAY_MS);
    const due = computeDueEmails(state, now);
    expect(due.map((e) => e.id)).toEqual(['trial-ending']);
  });

  it('convert-last-day becomes due at day 13', () => {
    const state = baseState({
      trialStartedAt: t0.toISOString(),
      sentEmailIds: ['welcome', 'activation-nudge', 'mid-trial-value', 'honesty', 'trial-ending'],
    });
    const now = new Date(t0.getTime() + 13 * DAY_MS);
    const due = computeDueEmails(state, now);
    expect(due.map((e) => e.id)).toEqual(['convert-last-day']);
  });

  it('a cron catching up late returns every unsent, un-suppressed email whose window has passed', () => {
    const state = baseState({ trialStartedAt: t0.toISOString() });
    const now = new Date(t0.getTime() + 13 * DAY_MS);
    const due = computeDueEmails(state, now);
    expect(due.map((e) => e.id)).toEqual([
      'welcome',
      'activation-nudge',
      'mid-trial-value',
      'honesty',
      'trial-ending',
      'convert-last-day',
    ]);
  });

  it('never re-selects an already-sent email', () => {
    const state = baseState({
      trialStartedAt: t0.toISOString(),
      sentEmailIds: ['welcome'],
    });
    const due = computeDueEmails(state, t0);
    expect(due.map((e) => e.id)).not.toContain('welcome');
  });
});

describe('computeDueEmails suppression', () => {
  const t0 = new Date('2026-01-01T00:00:00.000Z');

  it('trial_converted halts the trial-ending email (day 11)', () => {
    const state = baseState({
      trialStartedAt: t0.toISOString(),
      trialConvertedAt: new Date(t0.getTime() + 4 * DAY_MS).toISOString(),
      sentEmailIds: ['welcome', 'activation-nudge', 'mid-trial-value', 'honesty'],
    });
    const now = new Date(t0.getTime() + 11 * DAY_MS);
    const due = computeDueEmails(state, now);
    expect(due.map((e) => e.id)).not.toContain('trial-ending');
    expect(due.map((e) => e.id)).not.toContain('convert-last-day');
  });

  it('trial_converted also suppresses activation-nudge if still pending', () => {
    const state = baseState({
      trialStartedAt: t0.toISOString(),
      trialConvertedAt: t0.toISOString(),
      sentEmailIds: ['welcome'],
    });
    const now = new Date(t0.getTime() + 1 * DAY_MS);
    const due = computeDueEmails(state, now);
    expect(due.map((e) => e.id)).not.toContain('activation-nudge');
  });

  it('canceled halts the entire remaining drip', () => {
    const state = baseState({
      trialStartedAt: t0.toISOString(),
      canceledAt: new Date(t0.getTime() + 2 * DAY_MS).toISOString(),
      sentEmailIds: ['welcome', 'activation-nudge'],
    });
    const now = new Date(t0.getTime() + 13 * DAY_MS);
    const due = computeDueEmails(state, now);
    expect(due.map((e) => e.id)).not.toEqual(
      expect.arrayContaining(['mid-trial-value', 'honesty', 'trial-ending', 'convert-last-day']),
    );
  });

  it('activation-nudge is suppressed once first_real_call is recorded', () => {
    const state = baseState({
      trialStartedAt: t0.toISOString(),
      firstRealCallAt: t0.toISOString(),
      sentEmailIds: ['welcome'],
    });
    const now = new Date(t0.getTime() + 1 * DAY_MS);
    const due = computeDueEmails(state, now);
    expect(due.map((e) => e.id)).not.toContain('activation-nudge');
  });

  it('win-back fires 7 days after canceled, once', () => {
    const canceledAt = new Date(t0.getTime() + 3 * DAY_MS);
    const state = baseState({ trialStartedAt: t0.toISOString(), canceledAt: canceledAt.toISOString() });
    const tooEarly = computeDueEmails(state, new Date(canceledAt.getTime() + 6 * DAY_MS));
    expect(tooEarly.map((e) => e.id)).not.toContain('win-back');

    const due = computeDueEmails(state, new Date(canceledAt.getTime() + 7 * DAY_MS));
    expect(due.map((e) => e.id)).toContain('win-back');
  });

  it('win-back never fires if trial_converted happened', () => {
    const canceledAt = new Date(t0.getTime() + 3 * DAY_MS);
    const state = baseState({
      trialStartedAt: t0.toISOString(),
      canceledAt: canceledAt.toISOString(),
      trialConvertedAt: new Date(canceledAt.getTime() + 1 * DAY_MS).toISOString(),
    });
    const due = computeDueEmails(state, new Date(canceledAt.getTime() + 30 * DAY_MS));
    expect(due.map((e) => e.id)).not.toContain('win-back');
  });

  it('win-back derives from trial-expiry (14d, no convert, no cancel) when no explicit cancel fired', () => {
    const state = baseState({ trialStartedAt: t0.toISOString() });
    const beforeExpiry = computeDueEmails(state, new Date(t0.getTime() + 20 * DAY_MS));
    expect(beforeExpiry.map((e) => e.id)).not.toContain('win-back');

    const afterExpiryAndDelay = computeDueEmails(state, new Date(t0.getTime() + 21 * DAY_MS));
    expect(afterExpiryAndDelay.map((e) => e.id)).toContain('win-back');
  });

  it('payment-failed does not re-send for the same failure it already answered', () => {
    const failedAt = new Date(t0.getTime() + 2 * DAY_MS);
    const state = baseState({
      paymentFailedAt: failedAt.toISOString(),
      paymentFailedSentForAt: failedAt.toISOString(),
    });
    const dueSoonAfter = computeDueEmails(state, new Date(failedAt.getTime() + 1 * 60 * 60 * 1000));
    expect(dueSoonAfter.map((e) => e.id)).not.toContain('payment-failed');
  });

  it('payment-failed de-dupes a retry within 24h of the last send, even though it is a distinct event timestamp', () => {
    const firstFailure = new Date(t0.getTime() + 2 * DAY_MS);
    const retryWithin24h = new Date(firstFailure.getTime() + 6 * 60 * 60 * 1000); // +6h retry
    const state = baseState({
      paymentFailedAt: retryWithin24h.toISOString(), // a NEW event timestamp (the retry)
      paymentFailedSentForAt: firstFailure.toISOString(), // but we already sent for the first failure
    });
    const due = computeDueEmails(state, retryWithin24h);
    expect(due.map((e) => e.id)).not.toContain('payment-failed');
  });

  it('payment-failed allows a new send once 24h have passed since the last send', () => {
    const firstFailure = new Date(t0.getTime() + 2 * DAY_MS);
    const laterFailure = new Date(firstFailure.getTime() + 25 * 60 * 60 * 1000); // +25h
    const state = baseState({
      paymentFailedAt: laterFailure.toISOString(),
      paymentFailedSentForAt: firstFailure.toISOString(),
    });
    const due = computeDueEmails(state, laterFailure);
    expect(due.map((e) => e.id)).toContain('payment-failed');
  });

  it('payment-failed fires for a new failure event even if one was already sent long ago', () => {
    const firstFailure = new Date(t0.getTime());
    const secondFailure = new Date(t0.getTime() + 30 * DAY_MS);
    const state = baseState({
      paymentFailedAt: secondFailure.toISOString(),
      paymentFailedSentForAt: firstFailure.toISOString(),
    });
    const due = computeDueEmails(state, secondFailure);
    expect(due.map((e) => e.id)).toContain('payment-failed');
  });
});

describe('LiveNurtureEngine send-path gate', () => {
  beforeEach(() => {
    clearMailbox();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RESEND_API_KEY;
  });

  it('blocks a real-looking address even with a transport key configured, and never calls a transport', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const resendSpy = vi.spyOn(resendTransport, 'send');
    const previewSpy = vi.spyOn(previewTransport, 'send');

    const engine = new LiveNurtureEngine();
    await engine.notify({
      type: 'trial_started',
      email: 'real.customer@acmehvac.com',
      businessName: 'Acme HVAC',
      data: {},
    });

    expect(resendSpy).not.toHaveBeenCalled();
    expect(previewSpy).not.toHaveBeenCalled();
    expect(getMailbox()).toHaveLength(0);
  });

  it('sends the welcome email for an allowlisted test contact via the preview transport (no key set)', async () => {
    const engine = new LiveNurtureEngine();
    await engine.notify({
      type: 'trial_started',
      email: 'test+jenna@example.com',
      businessName: 'Jenna Plumbing',
      data: {},
    });

    const mailbox = getMailbox();
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0]).toMatchObject({ to: 'test+jenna@example.com', emailId: 'welcome', transport: 'preview' });
  });
});
