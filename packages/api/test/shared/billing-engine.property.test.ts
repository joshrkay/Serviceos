/**
 * Property / invariant tests for the shared billing engine (Track B3 — money).
 *
 * The existing billing-engine.test.ts is example-based. This suite asserts the
 * money invariants hold across THOUSANDS of randomized inputs, catching classes
 * of bug that hand-picked examples miss: a float leaking into a money field, a
 * total going negative under a pathological discount, a rounding path that
 * drops the integer-cents guarantee.
 *
 * Dependency-free (no fast-check): a seeded PRNG (mulberry32) makes every run
 * deterministic and reproducible — a failure prints the exact seed+iteration.
 */
import { describe, it, expect } from 'vitest';
import {
  applyBps,
  calculateLineItemTotal,
  calculateDocumentTotals,
  type LineItem,
} from '../../src/shared/billing-engine';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isInt = (n: number) => Number.isInteger(n);

function randLineItems(rand: () => number): LineItem[] {
  const n = Math.floor(rand() * 8); // 0..7 lines (0 exercises the empty path)
  const items: LineItem[] = [];
  for (let i = 0; i < n; i++) {
    // Non-negative integer cents, up to $5,000 per line.
    const totalCents = Math.floor(rand() * 500000);
    items.push({
      id: `li-${i}`,
      description: `item ${i}`,
      quantity: 1,
      unitPriceCents: totalCents,
      totalCents,
      sortOrder: i,
      taxable: rand() < 0.5,
    });
  }
  return items;
}

describe('billing-engine — money invariants (property-based)', () => {
  const SEED = 0x5c0ffee;
  const ITERATIONS = 4000;

  it('calculateDocumentTotals: every money field is an integer, and totals never go negative', () => {
    const rand = mulberry32(SEED);
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const items = randLineItems(rand);
      // Discount can exceed the subtotal (pathological over-discount).
      const subtotal = items.reduce((s, li) => s + li.totalCents, 0);
      const discountCents = Math.floor(rand() * (subtotal * 1.5 + 10000));
      const taxRateBps = Math.floor(rand() * 10001); // 0..100%
      const processingFeeBps = Math.floor(rand() * 2001); // 0..20%

      const t = calculateDocumentTotals(items, discountCents, taxRateBps, processingFeeBps);
      const ctx = `seed=${SEED} iter=${iter} discount=${discountCents} taxBps=${taxRateBps} feeBps=${processingFeeBps}`;

      // Integer-cents invariant on EVERY money field.
      for (const [k, v] of Object.entries(t)) {
        if (k.endsWith('Cents')) {
          expect(isInt(v as number), `${k} must be integer cents — ${ctx}`).toBe(true);
        }
      }
      // Non-negativity of derived amounts.
      expect(t.totalCents, `total >= 0 — ${ctx}`).toBeGreaterThanOrEqual(0);
      expect(t.taxCents, `tax >= 0 — ${ctx}`).toBeGreaterThanOrEqual(0);
      expect(t.processingFeeCents ?? 0, `fee >= 0 — ${ctx}`).toBeGreaterThanOrEqual(0);
      // Subtotal identity: exactly the sum of line totals.
      expect(t.subtotalCents, `subtotal identity — ${ctx}`).toBe(subtotal);
      // Taxable subtotal never exceeds the full subtotal (all totals >= 0).
      expect(t.taxableSubtotalCents).toBeLessThanOrEqual(t.subtotalCents);
      // Tax is computed on the DISCOUNTED taxable base, so it can never exceed
      // tax on the undiscounted taxable base.
      expect(t.taxCents).toBeLessThanOrEqual(applyBps(t.taxableSubtotalCents, taxRateBps));
    }
  });

  it('calculateDocumentTotals: no discount + no fee ⇒ total = subtotal + tax (exact)', () => {
    const rand = mulberry32(SEED ^ 0x1234);
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const items = randLineItems(rand);
      const taxRateBps = Math.floor(rand() * 10001);
      const t = calculateDocumentTotals(items, 0, taxRateBps, 0);
      expect(t.totalCents).toBe(t.subtotalCents + t.taxCents);
    }
  });

  it('applyBps: integer output, 0%→0, 100%→identity, monotonic non-decreasing in bps', () => {
    const rand = mulberry32(SEED ^ 0xabcd);
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const amount = Math.floor(rand() * 100000000); // up to $1M
      const bps = Math.floor(rand() * 10001);
      const out = applyBps(amount, bps);
      expect(isInt(out), `applyBps integer — amount=${amount} bps=${bps}`).toBe(true);
      expect(applyBps(amount, 0)).toBe(0);
      expect(applyBps(amount, 10000)).toBe(amount); // 100% is identity for integer cents
      // Monotonic: a higher rate never yields a smaller amount (non-negative base).
      const higher = Math.min(10000, bps + Math.floor(rand() * 1000));
      expect(applyBps(amount, higher)).toBeGreaterThanOrEqual(out);
    }
  });

  it('calculateLineItemTotal: integer cents even for fractional quantities', () => {
    const rand = mulberry32(SEED ^ 0x9999);
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const quantity = rand() * 100; // fractional (e.g. 2.5 hours labor)
      const unitPriceCents = Math.floor(rand() * 50000);
      const total = calculateLineItemTotal(quantity, unitPriceCents);
      expect(isInt(total), `line total integer — q=${quantity} unit=${unitPriceCents}`).toBe(true);
      expect(total).toBeGreaterThanOrEqual(0);
    }
  });
});
