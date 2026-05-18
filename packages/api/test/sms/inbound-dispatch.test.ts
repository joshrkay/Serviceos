/**
 * P2-034 — Inbound SMS content dispatcher.
 *
 * The Twilio inbound-SMS webhook needs a registry-style routing layer so
 * downstream features (P6-028 tech-status keywords today, others later) can
 * own specific keywords without each one editing the webhook handler. Tests
 * here cover the registry contract directly; route-level wiring (dispatch
 * runs after markProcessed, signature failures short-circuit before
 * dispatch, etc.) is covered in test/webhooks/twilio-sms-dispatch.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  dispatchInboundSms,
  registerKeywordHandler,
  __resetKeywordRegistryForTests,
  type KeywordHandler,
  type InboundSmsContext,
} from '../../src/sms/inbound-dispatch';

const ctxBase: InboundSmsContext = {
  tenantId: 'tenant-1',
  fromE164: '+15551234567',
  body: 'OUT 12:30',
  messageSid: 'SM1',
};

beforeEach(() => {
  __resetKeywordRegistryForTests();
});

describe('P2-034 — inbound SMS keyword dispatcher', () => {
  it('routes a case-insensitive trimmed first-token match to the registered handler', async () => {
    const handle = vi.fn(async () => ({ handled: true, handler: 'tech-status' }));
    const handler: KeywordHandler = { keywords: ['OUT', 'IN'], handle };
    registerKeywordHandler(handler);

    const result = await dispatchInboundSms({
      ...ctxBase,
      body: '  out 12:30  ',
    });

    expect(result.handled).toBe(true);
    expect(result.handler).toBe('tech-status');
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        fromE164: '+15551234567',
        body: '  out 12:30  ',
        messageSid: 'SM1',
      }),
    );
  });

  it('returns {handled:false, reason:"no_matching_handler"} for an unmatched keyword without throwing', async () => {
    const handler: KeywordHandler = {
      keywords: ['OUT'],
      handle: vi.fn(async () => ({ handled: true })),
    };
    registerKeywordHandler(handler);

    const result = await dispatchInboundSms({ ...ctxBase, body: 'STOP' });

    expect(result).toEqual({ handled: false, reason: 'no_matching_handler' });
  });

  it('returns {handled:false, reason:"no_matching_handler"} for an empty/whitespace body', async () => {
    const result = await dispatchInboundSms({ ...ctxBase, body: '   \t\n  ' });
    expect(result).toEqual({ handled: false, reason: 'no_matching_handler' });
  });

  it('catches a thrown handler error and returns {handled:false, reason:"handler_error"} without re-throwing', async () => {
    const boom: KeywordHandler = {
      keywords: ['BOOM'],
      handle: vi.fn(async () => {
        throw new Error('handler exploded');
      }),
    };
    registerKeywordHandler(boom);

    const result = await dispatchInboundSms({ ...ctxBase, body: 'BOOM' });

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('handler_error');
    expect(result.handler).toBe('boom');
  });

  it('throws at registration when two handlers claim the same keyword (case-insensitively)', () => {
    registerKeywordHandler({
      keywords: ['OUT'],
      handle: async () => ({ handled: true }),
    });

    expect(() =>
      registerKeywordHandler({
        keywords: ['out'],
        handle: async () => ({ handled: true }),
      }),
    ).toThrow(/duplicate.*out/i);
  });

  it('passes through only the documented context fields (no leaks of additional data)', async () => {
    const seenCtx: InboundSmsContext[] = [];
    registerKeywordHandler({
      keywords: ['PING'],
      handle: async (ctx) => {
        seenCtx.push(ctx);
        return { handled: true };
      },
    });

    await dispatchInboundSms({
      tenantId: 'tenant-A',
      fromE164: '+15550000001',
      body: 'PING hi',
      messageSid: 'SMabc',
    });

    expect(seenCtx).toHaveLength(1);
    expect(Object.keys(seenCtx[0]).sort()).toEqual(
      ['body', 'fromE164', 'messageSid', 'tenantId'].sort(),
    );
    expect(seenCtx[0].tenantId).toBe('tenant-A');
    expect(seenCtx[0].fromE164).toBe('+15550000001');
  });

  it('respects each handler returning its own handler name in the result', async () => {
    registerKeywordHandler({
      keywords: ['CONFIRM'],
      handle: async () => ({ handled: true, handler: 'p7-confirmation-reply' }),
    });

    const result = await dispatchInboundSms({ ...ctxBase, body: 'CONFIRM yes' });
    expect(result.handled).toBe(true);
    expect(result.handler).toBe('p7-confirmation-reply');
  });
});
