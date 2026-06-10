/**
 * Feature 4 — Estimate generation (launch-readiness pass).
 *
 * Loads the 4 golden estimate fixtures (transcript-derived line items), builds
 * each into a draft Estimate via the shared billing engine, and asserts:
 *  - the document subtotal equals the sum of the line-item totals;
 *  - each line-item total equals quantity * unit price (engine rounding);
 *  - the assembled draft estimate (status=draft + sendable view token) validates
 *    against the shared estimateSchema.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  LineItem,
  calculateLineItemTotal,
  calculateDocumentTotals,
} from '../../src/shared/billing-engine';
import { estimateSchema } from '@ai-service-os/shared';

const GOLDEN_DIR = path.join(
  __dirname, '..', '..', '..', '..', 'fixtures', 'ai', 'golden-proposals',
);

interface FixtureLineItem {
  description: string;
  category: 'labor' | 'material' | 'equipment' | 'other';
  quantity: number;
  unit_price_cents: number;
  taxable: boolean;
}

interface GoldenEstimateFixture {
  id: string;
  expected_output: { proposal_type: string; line_items: FixtureLineItem[] };
}

function loadGoldenFixtures(): GoldenEstimateFixture[] {
  return fs
    .readdirSync(GOLDEN_DIR)
    .filter((f) => f.startsWith('estimate-') && f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, f), 'utf-8')) as GoldenEstimateFixture);
}

function toLineItems(fixture: GoldenEstimateFixture): LineItem[] {
  return fixture.expected_output.line_items.map((li, i) => ({
    id: randomUUID(),
    description: li.description,
    category: li.category,
    quantity: li.quantity,
    unitPriceCents: li.unit_price_cents,
    totalCents: calculateLineItemTotal(li.quantity, li.unit_price_cents),
    sortOrder: i,
    taxable: li.taxable,
  }));
}

describe('Feature 4 — Estimate generation', () => {
  const fixtures = loadGoldenFixtures();

  it('loads at least 4 transcript-derived estimate fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
  });

  for (const fixture of fixtures) {
    describe(`fixture ${fixture.id}`, () => {
      const lineItems = toLineItems(fixture);
      const discountCents = 0;
      const taxRateBps = 875; // 8.75%
      const totals = calculateDocumentTotals(lineItems, discountCents, taxRateBps);

      it('subtotal equals the sum of the line-item totals', () => {
        const sum = lineItems.reduce((acc, li) => acc + li.totalCents, 0);
        expect(totals.subtotalCents).toBe(sum);
        // Each line total is quantity * unit price under the engine's rounding.
        for (const li of lineItems) {
          expect(li.totalCents).toBe(Math.round(li.quantity * li.unitPriceCents));
        }
      });

      it('total = subtotal - discount + tax', () => {
        const taxableSubtotal = lineItems
          .filter((li) => li.taxable)
          .reduce((acc, li) => acc + li.totalCents, 0);
        const expectedTax = Math.round((Math.max(0, taxableSubtotal - discountCents) * taxRateBps) / 10000);
        expect(totals.taxCents).toBe(expectedTax);
        expect(totals.totalCents).toBe(totals.subtotalCents - discountCents + expectedTax);
      });

      it('assembles a schema-valid draft estimate with a sendable view token', () => {
        const nowIso = new Date().toISOString();
        const estimate = {
          id: randomUUID(),
          tenantId: randomUUID(),
          jobId: randomUUID(),
          estimateNumber: `EST-${fixture.id}`,
          status: 'draft' as const,
          lineItems,
          totals,
          viewToken: randomUUID(),
          viewTokenExpiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
          version: 1,
          createdBy: 'user-1',
          createdAt: nowIso,
          updatedAt: nowIso,
        };

        const parsed = estimateSchema.safeParse(estimate);
        expect(parsed.success).toBe(true);
        expect(estimate.status).toBe('draft');
        expect(estimate.viewToken).toBeTruthy();
      });
    });
  }
});
