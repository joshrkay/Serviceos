import { describe, it, expect } from 'vitest';
import { lookupRevenue } from '../../../src/ai/skills/lookup-revenue';
import { lookupCatalog } from '../../../src/ai/skills/lookup-catalog';
import { InMemoryMoneyDashboardRepository } from '../../../src/reports/money-dashboard';
import { InMemoryCatalogItemRepository, createCatalogItem } from '../../../src/catalog/catalog-item';

describe('lookupRevenue skill', () => {
  it('reports the empty/zero case deterministically', async () => {
    const repo = new InMemoryMoneyDashboardRepository();
    const res = await lookupRevenue({ tenantId: 't-1' }, { moneyDashboardRepo: repo });
    expect(res.status).toBe('found');
    // The all-zero case avoids a "$" so it can't trip the customer-balance
    // PII floor in the voice corpus.
    expect(res.summary).not.toContain('$');
    expect(res.summary).toMatch(/haven't brought in any revenue/i);
    expect(res.summary).toMatch(/nothing is outstanding/i);
  });

  it('speaks revenue and outstanding when present', async () => {
    const repo = new InMemoryMoneyDashboardRepository();
    repo.setSummary({
      month: '2026-05',
      revenueCents: 1250000,
      grossRevenueCents: 1250000,
      refundsCents: 0,
      priorMonthRevenueCents: 0,
      revenueTrendCents: 0,
      expensesCents: 0,
      outstandingCents: 45000,
      overdueCents: 0,
    });
    const res = await lookupRevenue({ tenantId: 't-1' }, { moneyDashboardRepo: repo });
    expect(res.summary).toContain('$12500.00');
    expect(res.summary).toContain('$450.00');
  });
});

describe('lookupCatalog skill', () => {
  it('reports an empty catalog', async () => {
    const repo = new InMemoryCatalogItemRepository();
    const res = await lookupCatalog({ tenantId: 't-1' }, { catalogRepo: repo });
    expect(res.status).toBe('none');
    expect(res.summary).toMatch(/empty/i);
  });

  it('lists active catalog items', async () => {
    const repo = new InMemoryCatalogItemRepository();
    await repo.create(
      createCatalogItem({
        tenantId: 't-1',
        name: 'AC Tune-Up',
        description: 'Seasonal maintenance',
        category: 'Labor',
        unit: 'each',
        unitPriceCents: 12900,
      }),
    );
    const res = await lookupCatalog({ tenantId: 't-1' }, { catalogRepo: repo });
    expect(res.status).toBe('found');
    expect(res.data.count).toBe(1);
    expect(res.summary).toContain('AC Tune-Up');
  });
});
