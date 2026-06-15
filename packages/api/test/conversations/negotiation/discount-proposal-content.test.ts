/**
 * U5b (P2-036 V2) — unit tests for the discount-branch proposal-content builders
 * (src/conversations/negotiation/discount-proposal-content.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  buildAllowDiscountCallbackContent,
  buildDiscountClarificationPayload,
  discountAuditMetadata,
} from '../../../src/conversations/negotiation/discount-proposal-content';
import type { CurrentQuote } from '../../../src/conversations/negotiation/current-quote-resolver';

const quote: CurrentQuote = { estimateId: 'est-1', quotedCents: 25000, catalogGrounded: true };

describe('buildAllowDiscountCallbackContent', () => {
  it('is confidence-capped to low so it can never auto-approve', () => {
    const content = buildAllowDiscountCallbackContent({
      decision: {
        kind: 'ALLOW',
        approvedDiscountBps: 800,
        discountedPriceCents: 23000,
        floorCents: 15000,
      },
      quote,
      askText: 'can you do $230?',
      customerName: 'Dana',
    });
    const meta = content.payload._meta as { overallConfidence: string };
    expect(meta.overallConfidence).toBe('low'); // the safety mechanism
    expect(content.payload.reason).toBe('customer_negotiation_followup');
    expect(content.payload.approvedDiscountBps).toBe(800);
    expect(content.payload.discountedPriceCents).toBe(23000);
    expect(content.payload.estimateId).toBe('est-1');
    // $25,000 - $23,000 = $20 off, 8%.
    expect(String(content.payload.recommendation)).toContain('$20');
    expect(String(content.payload.recommendation)).toContain('8%');
    expect(String(content.payload.recommendation)).toContain('est-1');
    expect(content.summary).toMatch(/within policy/i);
  });
});

describe('buildDiscountClarificationPayload', () => {
  it('uses the ambiguous_discount_target reason and carries the transcript', () => {
    const p = buildDiscountClarificationPayload({ transcript: 'gimme a deal', conversationId: 'c1' });
    expect(p.reason).toBe('ambiguous_discount_target');
    expect(p.transcript).toBe('gimme a deal');
    expect(p.conversationId).toBe('c1');
  });
});

describe('discountAuditMetadata', () => {
  it('flattens each decision kind with the quoted base', () => {
    expect(
      discountAuditMetadata(
        { kind: 'ALLOW', approvedDiscountBps: 800, discountedPriceCents: 23000, floorCents: 15000 },
        25000,
      ),
    ).toMatchObject({ decisionKind: 'ALLOW', quotedCents: 25000, approvedDiscountBps: 800 });
    expect(
      discountAuditMetadata(
        { kind: 'NEEDS_APPROVAL', requestedTargetCents: 22000, requestedDiscountBps: 1200 },
        25000,
      ),
    ).toMatchObject({ decisionKind: 'NEEDS_APPROVAL', requestedTargetCents: 22000 });
    expect(
      discountAuditMetadata({ kind: 'REJECT_WITH_COUNTER', counterCents: 15000, floorCents: 15000 }, 25000),
    ).toMatchObject({ decisionKind: 'REJECT_WITH_COUNTER', counterCents: 15000 });
    expect(
      discountAuditMetadata({ kind: 'CLARIFY', reason: 'ambiguous_discount_target' }, 25000),
    ).toMatchObject({ decisionKind: 'CLARIFY', reason: 'ambiguous_discount_target' });
  });
});
