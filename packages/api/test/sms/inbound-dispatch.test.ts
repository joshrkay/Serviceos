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
  registerFallbackHandler,
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

describe('P2-034 — fallback handler', () => {
  it('runs the fallback when no keyword matches', async () => {
    registerFallbackHandler({
      name: 'proposal-reply',
      handle: async () => ({ handled: true, handler: 'proposal-reply', reason: 'edit_recorded' }),
    });

    const result = await dispatchInboundSms({ ...ctxBase, body: 'make it $200 instead' });
    expect(result).toEqual({ handled: true, handler: 'proposal-reply', reason: 'edit_recorded' });
  });

  it('runs the fallback when the keyword handler declines', async () => {
    registerKeywordHandler({
      keywords: ['OUT'],
      handle: async () => ({ handled: false, handler: 'tech-status', reason: 'unknown_mobile' }),
    });
    registerFallbackHandler({
      name: 'proposal-reply',
      handle: async () => ({ handled: true, handler: 'proposal-reply', reason: 'edit_recorded' }),
    });

    const result = await dispatchInboundSms({ ...ctxBase, body: 'OUT at the curb' });
    expect(result.handler).toBe('proposal-reply');
  });

  it('preserves the keyword result when the fallback also declines', async () => {
    registerKeywordHandler({
      keywords: ['OUT'],
      handle: async () => ({ handled: false, handler: 'tech-status', reason: 'unknown_mobile' }),
    });
    registerFallbackHandler({
      name: 'proposal-reply',
      handle: async () => ({ handled: false, handler: 'proposal-reply', reason: 'not_owner' }),
    });

    const result = await dispatchInboundSms({ ...ctxBase, body: 'OUT 12:30' });
    expect(result).toEqual({ handled: false, handler: 'tech-status', reason: 'unknown_mobile' });
  });

  it('a thrown fallback never propagates', async () => {
    registerFallbackHandler({
      name: 'proposal-reply',
      handle: async () => {
        throw new Error('boom');
      },
    });

    const result = await dispatchInboundSms({ ...ctxBase, body: 'free text' });
    expect(result).toEqual({ handled: false, reason: 'no_matching_handler' });
  });

  it('rejects a second fallback registration without overwrite', () => {
    const fb = { name: 'a', handle: async () => ({ handled: false }) };
    registerFallbackHandler(fb);
    expect(() => registerFallbackHandler({ ...fb, name: 'b' })).toThrow(/duplicate fallback/);
    expect(() => registerFallbackHandler({ ...fb, name: 'b' }, { overwrite: true })).not.toThrow();
  });
});

describe('P2-034 — punctuation-tolerant keyword lookup', () => {
  it.each(['Yes!', 'OK.', '"approve"', '  y. '])(
    'routes %s to the registered bare keyword',
    async (body) => {
      const handle = vi.fn(async () => ({ handled: true, handler: 'proposal-reply' }));
      registerKeywordHandler({ keywords: ['yes', 'ok', 'approve', 'y'], handle });

      const result = await dispatchInboundSms({ ...ctxBase, body });
      expect(result.handled).toBe(true);
      expect(handle).toHaveBeenCalledTimes(1);
    },
  );

  it('a punctuation-only first token does not match any keyword', async () => {
    const handle = vi.fn(async () => ({ handled: true }));
    registerKeywordHandler({ keywords: ['yes'], handle });

    const result = await dispatchInboundSms({ ...ctxBase, body: '!!! yes' });
    expect(result.handled).toBe(false);
    expect(handle).not.toHaveBeenCalled();
  });
});
