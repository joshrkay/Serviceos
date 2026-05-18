import { describe, expect, it } from 'vitest';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';
import {
  buildStopKeywordHandler,
  buildStartKeywordHandler,
} from '../../src/compliance/stop-reply';
import {
  __resetKeywordRegistryForTests,
  registerKeywordHandler,
  dispatchInboundSms,
} from '../../src/sms/inbound-dispatch';

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
