/**
 * ITEM 2 — shared payload-money helper.
 *
 * Pins that both call sites (proposal-approval-task and
 * pending-proposal-resolver) agree on shared fixtures, and that the
 * previously-missing `totalAmountCents` key is now covered by both.
 */
import { describe, it, expect } from 'vitest';
import {
  payloadHeadlineCents,
  payloadAmountsCents,
  PAYLOAD_MONEY_KEYS,
} from '../../src/proposals/payload-money';

describe('payloadHeadlineCents', () => {
  it('returns totalCents when present', () => {
    expect(payloadHeadlineCents({ totalCents: 45000 })).toBe(45000);
  });

  it('returns totalAmountCents when totalCents is absent', () => {
    expect(payloadHeadlineCents({ totalAmountCents: 45000 })).toBe(45000);
  });

  it('totalCents takes priority over totalAmountCents', () => {
    expect(payloadHeadlineCents({ totalCents: 100, totalAmountCents: 200 })).toBe(100);
  });

  it('falls back to line-item sum when no scalar field present', () => {
    const payload = {
      lineItems: [
        { description: 'A', total: 20000 },
        { description: 'B', total: 25000 },
      ],
    };
    expect(payloadHeadlineCents(payload)).toBe(45000);
  });

  it('returns null when no money field present', () => {
    expect(payloadHeadlineCents({ customerName: 'Jones' })).toBeNull();
  });
});

describe('payloadAmountsCents', () => {
  it('includes totalAmountCents (previously missing from resolver)', () => {
    const amounts = payloadAmountsCents({ totalAmountCents: 45000 });
    expect(amounts).toContain(45000);
  });

  it('returns all matching scalar keys', () => {
    const amounts = payloadAmountsCents({
      totalCents: 45000,
      amountCents: 45000,
    });
    expect(amounts).toContain(45000);
    expect(amounts.length).toBeGreaterThanOrEqual(2);
  });

  it('includes line-item sum', () => {
    const amounts = payloadAmountsCents({
      lineItems: [{ total: 20000 }, { total: 25000 }],
    });
    expect(amounts).toContain(45000);
  });

  it('returns empty array when no money present', () => {
    expect(payloadAmountsCents({ customerName: 'Smith' })).toEqual([]);
  });
});

describe('call-site parity — readback headline matches amount scorer', () => {
  it('"the 450 dollar invoice" matches a proposal with totalAmountCents=45000', () => {
    // This is the exact drift bug: resolver lacked totalAmountCents so it
    // would not score the amount signal, causing "the 450 dollar invoice"
    // to fail matching a proposal whose readback showed "$450.00".
    const payload = { totalAmountCents: 45000, customerName: 'Henderson' };
    const headline = payloadHeadlineCents(payload);
    const amounts = payloadAmountsCents(payload);
    expect(headline).toBe(45000);
    expect(amounts).toContain(45000);
  });

  it('all PAYLOAD_MONEY_KEYS are checked by both functions', () => {
    for (const key of PAYLOAD_MONEY_KEYS) {
      const payload = { [key]: 10000 };
      const headline = payloadHeadlineCents(payload);
      const amounts = payloadAmountsCents(payload);
      expect(headline).not.toBeNull();
      expect(amounts).toContain(10000);
    }
  });
});
