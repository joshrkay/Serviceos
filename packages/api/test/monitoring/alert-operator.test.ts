/**
 * WS15 — alertOperator channel fan-out + cooldown, and the drain-abandonment
 * emitter. Pins two safety properties:
 *   1. NEVER throws into the caller (sweep / shutdown path) — channel
 *      failures are swallowed and logged.
 *   2. Operator SMS is sent with recipientClass 'owner' so GatedMessageDelivery
 *      can never consent-suppress a page.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createAlertOperator,
  emitDrainAbandonment,
  type OperatorAlert,
} from '../../src/monitoring/alert-operator';
import type { SentryClient } from '../../src/monitoring/sentry';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { metricsRegistry } from '../../src/monitoring/metrics';
import type { Logger } from '../../src/logging/logger';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return this;
  },
};

function fakeSentry(overrides: Partial<SentryClient> = {}): SentryClient & {
  captureMessage: ReturnType<typeof vi.fn>;
} {
  return {
    captureException: vi.fn().mockReturnValue('id'),
    captureMessage: vi.fn().mockReturnValue('id'),
    setTag: vi.fn(),
    setUser: vi.fn(),
    startTransaction: vi.fn().mockReturnValue({ finish: () => {}, setStatus: () => {} }),
    withScope: <T>(cb: (scope: never) => T): T => cb({} as never),
    ...overrides,
  } as SentryClient & { captureMessage: ReturnType<typeof vi.fn> };
}

const alert: OperatorAlert = {
  severity: 'critical',
  rule: 'queue_staleness',
  summary: '3 pending job(s) older than 15min',
  details: { staleCount: 3 },
};

const HOUR = 60 * 60 * 1000;

describe('createAlertOperator — channel fan-out', () => {
  it('always captures an error-level Sentry message', async () => {
    const sentry = fakeSentry();
    const op = createAlertOperator({
      sentry,
      delivery: null,
      cooldownMs: HOUR,
      logger: noopLogger,
    });
    await op(alert);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, level] = sentry.captureMessage.mock.calls[0];
    expect(level).toBe('error');
    expect(message).toContain('queue_staleness');
    expect(message).toContain('[SLO:critical]');
    expect(message).toContain('staleCount=3');
  });

  it('sends an owner-class SMS when ALERT_SMS_TO is set and delivery is wired', async () => {
    const delivery = new InMemoryDeliveryProvider();
    const op = createAlertOperator({
      sentry: fakeSentry(),
      delivery,
      alertSmsTo: '+15551230000',
      cooldownMs: HOUR,
      logger: noopLogger,
    });
    await op(alert);
    expect(delivery.sentSms).toHaveLength(1);
    expect(delivery.sentSms[0].to).toBe('+15551230000');
    // THE pin: 'owner' bypasses the consent+DNC gate — a 'customer'-class
    // page would fail closed (missing_consent_context) and never reach anyone.
    expect(delivery.sentSms[0].recipientClass).toBe('owner');
    expect(delivery.sentSms[0].body).toContain('queue_staleness');
  });

  it('the owner-class page passes through GatedMessageDelivery in block mode un-suppressed', async () => {
    // End-to-end through the REAL consent gate at its strictest setting —
    // proves the operator page can never be consent-suppressed.
    const base = new InMemoryDeliveryProvider();
    const gated = new GatedMessageDelivery({
      base,
      // Owner-class sends must bypass BEFORE consent/DNC are even consulted —
      // a dnc that blocks everything and a throwing audit repo prove it.
      dnc: { isOnDnc: vi.fn().mockResolvedValue(true) } as never,
      auditRepo: {
        record: vi.fn(() => {
          throw new Error('audit should not run for owner sends');
        }),
      } as never,
      enforcement: 'block',
    });
    const op = createAlertOperator({
      sentry: fakeSentry(),
      delivery: gated,
      alertSmsTo: '+15551230000',
      cooldownMs: HOUR,
      logger: noopLogger,
    });
    await op(alert);
    expect(base.sentSms).toHaveLength(1);
    expect(base.sentSms[0].recipientClass).toBe('owner');
  });

  it('skips SMS when ALERT_SMS_TO is unset', async () => {
    const delivery = new InMemoryDeliveryProvider();
    const op = createAlertOperator({
      sentry: fakeSentry(),
      delivery,
      cooldownMs: HOUR,
      logger: noopLogger,
    });
    await op(alert);
    expect(delivery.sentSms).toHaveLength(0);
  });

  it('skips SMS when no delivery provider is wired (Sentry still pages)', async () => {
    const sentry = fakeSentry();
    const op = createAlertOperator({
      sentry,
      delivery: null,
      alertSmsTo: '+15551230000',
      cooldownMs: HOUR,
      logger: noopLogger,
    });
    await op(alert);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('never throws: a throwing Sentry client does not break the sweep and SMS still sends', async () => {
    const sentry = fakeSentry({
      captureMessage: vi.fn(() => {
        throw new Error('sentry transport down');
      }),
    });
    const delivery = new InMemoryDeliveryProvider();
    const op = createAlertOperator({
      sentry,
      delivery,
      alertSmsTo: '+15551230000',
      cooldownMs: HOUR,
      logger: noopLogger,
    });
    await expect(op(alert)).resolves.toBeUndefined();
    expect(delivery.sentSms).toHaveLength(1);
  });

  it('never throws: a rejecting SMS provider is swallowed and logged', async () => {
    const logger = { ...noopLogger, error: vi.fn() };
    const op = createAlertOperator({
      sentry: fakeSentry(),
      delivery: {
        sendSms: vi.fn().mockRejectedValue(new Error('twilio 500')),
        sendEmail: vi.fn(),
      },
      alertSmsTo: '+15551230000',
      cooldownMs: HOUR,
      logger,
    });
    await expect(op(alert)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'SLO alert: SMS channel failed',
      expect.objectContaining({ rule: 'queue_staleness' }),
    );
  });
});

describe('createAlertOperator — cooldown', () => {
  it('suppresses a re-page for the same rule inside the cooldown window', async () => {
    let t = 0;
    const sentry = fakeSentry();
    const delivery = new InMemoryDeliveryProvider();
    const op = createAlertOperator({
      sentry,
      delivery,
      alertSmsTo: '+15551230000',
      cooldownMs: HOUR,
      logger: noopLogger,
      now: () => t,
    });

    await op(alert); // pages
    t += 5 * 60 * 1000; // next 5-min monitor tick, still breaching
    await op(alert); // suppressed
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(delivery.sentSms).toHaveLength(1);

    t += HOUR; // cooldown elapsed
    await op(alert); // re-pages
    expect(sentry.captureMessage).toHaveBeenCalledTimes(2);
    expect(delivery.sentSms).toHaveLength(2);
  });

  it('cooldown is per rule — a different rule pages immediately', async () => {
    let t = 0;
    const sentry = fakeSentry();
    const op = createAlertOperator({
      sentry,
      delivery: null,
      cooldownMs: HOUR,
      logger: noopLogger,
      now: () => t,
    });
    await op(alert);
    t += 1000;
    await op({ ...alert, rule: 'call_completion_rate' });
    expect(sentry.captureMessage).toHaveBeenCalledTimes(2);
  });
});

describe('emitDrainAbandonment', () => {
  async function counterValue(): Promise<number> {
    const metric = metricsRegistry.getSingleMetric('voice_drain_abandoned_calls_total');
    const data = await metric!.get();
    return data.values[0]?.value ?? 0;
  }

  it('increments the counter by the live-call count and captures an error-level Sentry event naming the callSids', async () => {
    const before = await counterValue();
    const sentry = fakeSentry();
    emitDrainAbandonment(2, ['CA111', 'CA222'], { sentry, logger: noopLogger });
    expect(await counterValue()).toBe(before + 2);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, level] = sentry.captureMessage.mock.calls[0];
    expect(level).toBe('error');
    expect(message).toContain('drain_abandonment');
    expect(message).toContain('2 live call(s)');
    expect(message).toContain('CA111');
    expect(message).toContain('CA222');
  });

  it('is synchronous fire-and-forget (returns void, nothing to await)', () => {
    // Shutdown-path contract: no promise that could eat into the 30s
    // force-exit backstop.
    const result = emitDrainAbandonment(1, ['CA1'], {
      sentry: fakeSentry(),
      logger: noopLogger,
    });
    expect(result).toBeUndefined();
  });

  it('never throws, even when the Sentry client throws mid-shutdown', () => {
    const sentry = fakeSentry({
      captureMessage: vi.fn(() => {
        throw new Error('transport gone');
      }),
    });
    expect(() =>
      emitDrainAbandonment(1, ['CA1'], { sentry, logger: noopLogger }),
    ).not.toThrow();
  });
});
