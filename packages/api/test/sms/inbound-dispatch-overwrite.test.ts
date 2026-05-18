import { describe, expect, it, beforeEach } from 'vitest';
import {
  __resetKeywordRegistryForTests,
  registerKeywordHandler,
  dispatchInboundSms,
} from '../../src/sms/inbound-dispatch';

beforeEach(() => {
  __resetKeywordRegistryForTests();
});

describe('registerKeywordHandler overwrite option', () => {
  it('throws on duplicate registration by default', () => {
    registerKeywordHandler({
      keywords: ['hello'],
      handle: async () => ({ handled: true }),
    });
    expect(() =>
      registerKeywordHandler({
        keywords: ['hello'],
        handle: async () => ({ handled: true }),
      }),
    ).toThrow(/duplicate keyword registration/);
  });

  it('replaces the registration when overwrite=true', async () => {
    let first = 0;
    let second = 0;
    registerKeywordHandler({
      keywords: ['hello'],
      handle: async () => {
        first += 1;
        return { handled: true, handler: 'first' };
      },
    });
    registerKeywordHandler(
      {
        keywords: ['hello'],
        handle: async () => {
          second += 1;
          return { handled: true, handler: 'second' };
        },
      },
      { overwrite: true },
    );

    const r = await dispatchInboundSms({
      tenantId: 't1',
      fromE164: '+15550000000',
      body: 'hello',
      messageSid: 'SM-1',
    });
    expect(r.handler).toBe('second');
    expect(first).toBe(0);
    expect(second).toBe(1);
  });
});
