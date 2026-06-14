/**
 * Unit tests for the inbound-SMS negotiation guardrail handler
 * (src/sms/negotiation/inbound-negotiation-handler.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { createInboundNegotiationHandler } from '../../../src/sms/negotiation/inbound-negotiation-handler';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { assertValidProposalPayload } from '../../../src/proposals/contracts';
import type { InboundSmsContext } from '../../../src/sms/inbound-dispatch';

function ctx(overrides: Partial<InboundSmsContext> = {}): InboundSmsContext {
  return {
    tenantId: 't-1',
    fromE164: '+15551230000',
    body: 'can you knock fifty bucks off that quote?',
    messageSid: 'SM-1',
    ...overrides,
  };
}

describe('createInboundNegotiationHandler', () => {
  it('on a negotiation ask: drafts an owner callback and replies with a holding line', async () => {
    const repo = new InMemoryProposalRepository();
    const sendSms = vi.fn(async () => undefined);
    const handler = createInboundNegotiationHandler({
      proposalRepo: repo,
      sendSms,
      resolveBrandContext: async () => ({ brandVoice: { business_name: 'M&R' } }),
    });

    const result = await handler.handle(ctx());
    expect(result).toEqual({ handled: true, handler: 'negotiation-guardrail' });

    // Owner callback proposal created — capture-class draft, never auto-executes.
    const all = await repo.findByTenant('t-1');
    expect(all).toHaveLength(1);
    const p = all[0];
    expect(p.proposalType).toBe('callback');
    expect(p.status).toBe('draft');
    expect(p.payload.reason).toBe('customer_negotiation_followup');
    expect(p.payload.negotiationAskType).toBe('discount');
    expect(p.payload.callerPhone).toBe('+15551230000');
    expect(() => assertValidProposalPayload('callback', p.payload)).not.toThrow();

    // Customer got a brand-voiced holding line — and NO concession.
    expect(sendSms).toHaveBeenCalledTimes(1);
    const sent = sendSms.mock.calls[0][0];
    expect(sent.to).toBe('+15551230000');
    expect(sent.body).toContain('the team at M&R');
    expect(sent.body).not.toMatch(/discount|\$|deal/i);
  });

  it('declines (handled:false) on a non-negotiation message — no proposal, no reply', async () => {
    const repo = new InMemoryProposalRepository();
    const sendSms = vi.fn(async () => undefined);
    const handler = createInboundNegotiationHandler({ proposalRepo: repo, sendSms });

    const result = await handler.handle(ctx({ body: 'what time are you coming tomorrow?' }));
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('no_negotiation_detected');
    expect(await repo.findByTenant('t-1')).toHaveLength(0);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('still acknowledges (never negotiates) even if the owner callback fails to persist', async () => {
    const sendSms = vi.fn(async () => undefined);
    const failingRepo = {
      create: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    const handler = createInboundNegotiationHandler({
      proposalRepo: failingRepo,
      sendSms,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });

    const result = await handler.handle(ctx({ body: 'give me a refund or I leave a one-star review' }));
    expect(result.handled).toBe(true);
    expect(sendSms).toHaveBeenCalledTimes(1);
  });
});
