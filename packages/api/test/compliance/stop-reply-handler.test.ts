import { describe, expect, it } from 'vitest';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { InMemoryConsentEventRepository } from '../../src/compliance/consent-events';
import {
  buildStopKeywordHandler,
  buildStartKeywordHandler,
} from '../../src/compliance/stop-reply';
import {
  __resetKeywordRegistryForTests,
  registerKeywordHandler,
  dispatchInboundSms,
} from '../../src/sms/inbound-dispatch';

/** Minimal phone->customer stub for the consent rollup path. */
function customerRepoStub(id: string | null) {
  return {
    async findByPhoneNormalized() {
      return id ? [{ id } as never] : [];
    },
  };
}

function ctx(overrides: Partial<{ tenantId: string; fromE164: string; body: string; messageSid: string }> = {}) {
  return {
    tenantId: 'tenant-1',
    fromE164: '+15551234567',
    body: 'STOP',
    messageSid: 'SM-test',
    ...overrides,
  };
}

describe('STOP keyword handler', () => {
  it('adds the sender phone to DNC on STOP and reports handled', async () => {
    __resetKeywordRegistryForTests();
    const dnc = new InMemoryDncRepository();
    registerKeywordHandler(buildStopKeywordHandler({ dncRepo: dnc }));

    const result = await dispatchInboundSms(ctx({ body: 'STOP' }));

    expect(result.handled).toBe(true);
    expect(result.handler).toBe('stop-reply');
    expect(await dnc.isOnDnc('tenant-1', normalizePhone('+15551234567'))).toBe(true);
  });

  it('registers every STOP_KEYWORD as a handler trigger (lowercase tokens match)', async () => {
    __resetKeywordRegistryForTests();
    const dnc = new InMemoryDncRepository();
    registerKeywordHandler(buildStopKeywordHandler({ dncRepo: dnc }));

    for (const variant of ['stop', 'unsubscribe', 'cancel', 'end', 'quit', 'stopall']) {
      __resetKeywordRegistryForTests();
      registerKeywordHandler(buildStopKeywordHandler({ dncRepo: dnc }));
      const r = await dispatchInboundSms(ctx({ body: variant, fromE164: `+1555000${variant.length.toString().padStart(4, '0')}` }));
      expect(r.handled, `variant: ${variant}`).toBe(true);
    }
  });
});

describe('STOP/START consent unification (Story 10.6)', () => {
  it('appends a revoked sms consent event on STOP with the matched customer', async () => {
    __resetKeywordRegistryForTests();
    const dnc = new InMemoryDncRepository();
    const consent = new InMemoryConsentEventRepository();
    registerKeywordHandler(
      buildStopKeywordHandler({
        dncRepo: dnc,
        consentRepo: consent,
        customerRepo: customerRepoStub('cust-1'),
      }),
    );

    await dispatchInboundSms(ctx({ body: 'STOP' }));

    const events = await consent.listByPhone('tenant-1', '+15551234567');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('sms');
    expect(events[0].state).toBe('revoked');
    expect(events[0].source).toBe('sms');
    expect(events[0].customerId).toBe('cust-1');
    expect(await dnc.isOnDnc('tenant-1', normalizePhone('+15551234567'))).toBe(true);
  });

  it('appends a granted sms consent event on START', async () => {
    __resetKeywordRegistryForTests();
    const dnc = new InMemoryDncRepository();
    dnc.add('tenant-1', normalizePhone('+15551234567'));
    const consent = new InMemoryConsentEventRepository();
    registerKeywordHandler(
      buildStartKeywordHandler({
        dncRepo: dnc,
        consentRepo: consent,
        customerRepo: customerRepoStub('cust-1'),
      }),
    );

    await dispatchInboundSms(ctx({ body: 'START' }));

    const events = await consent.listByPhone('tenant-1', '+15551234567');
    expect(events[0].state).toBe('granted');
    expect(await dnc.isOnDnc('tenant-1', normalizePhone('+15551234567'))).toBe(false);
  });

  it('still adds to DNC when no consent repo is wired (degraded mode)', async () => {
    __resetKeywordRegistryForTests();
    const dnc = new InMemoryDncRepository();
    registerKeywordHandler(buildStopKeywordHandler({ dncRepo: dnc }));

    const result = await dispatchInboundSms(ctx({ body: 'STOP' }));
    expect(result.handled).toBe(true);
    expect(await dnc.isOnDnc('tenant-1', normalizePhone('+15551234567'))).toBe(true);
  });
});

describe('START keyword handler', () => {
  it('removes the sender phone from DNC on START and reports handled', async () => {
    __resetKeywordRegistryForTests();
    const dnc = new InMemoryDncRepository();
    dnc.add('tenant-1', normalizePhone('+15551234567'));
    registerKeywordHandler(buildStartKeywordHandler({ dncRepo: dnc }));

    const result = await dispatchInboundSms(ctx({ body: 'START' }));

    expect(result.handled).toBe(true);
    expect(result.handler).toBe('start-reply');
    expect(await dnc.isOnDnc('tenant-1', normalizePhone('+15551234567'))).toBe(false);
  });
});
