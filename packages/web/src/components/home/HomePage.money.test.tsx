import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { HomePage } from './HomePage';
import { listQueryResult } from '../../test-utils/list-query-result';
import { apiInvoice } from '../../test-utils/money-fixtures';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useTenantTimezone', () => ({ useTenantTimezone: vi.fn(() => 'UTC') }));
vi.mock('./MoneyLoopHomeCard', () => ({ MoneyLoopHomeCard: () => <div /> }));
vi.mock('../../api/conversations', () => ({ listInboxThreads: vi.fn().mockResolvedValue([]) }));

import { useListQuery } from '../../hooks/useListQuery';

// #1400 — the dashboard reads the real GET /api/invoices?status=open shape
// (shared invoiceResponseSchema): money lives in `amountDueCents` and
// `totals.totalCents`, never a top-level `totalCents`.
const overdue = apiInvoice({
  invoiceNumber: 'INV-0026',
  dueDate: '2026-01-15T02:23:19.595Z',
  customer: { id: '00000000-0000-4000-8000-0000000000c1', displayName: 'Bob Jones' },
  amountPaidCents: 0,
  amountDueCents: 9342,
});
const partiallyPaid = apiInvoice({
  invoiceNumber: 'INV-0027',
  dueDate: '2099-12-01T00:00:00.000Z',
  totals: { subtotalCents: 200000, taxableSubtotalCents: 200000, discountCents: 0, taxRateBps: 0, taxCents: 0, totalCents: 200000 },
  amountPaidCents: 50000,
  amountDueCents: 150000,
});

function mockLists(invoices: unknown[]) {
  vi.mocked(useListQuery).mockImplementation(((path: string) => {
    if (path === '/api/invoices') return listQueryResult(invoices);
    return listQueryResult([]);
  }) as typeof useListQuery);
}

function renderPage() {
  return render(<MemoryRouter><HomePage /></MemoryRouter>);
}

describe('HomePage money display (#1400)', () => {
  beforeEach(() => mockLists([overdue, partiallyPaid]));

  it('Outstanding totals the API amountDueCents of every open invoice', () => {
    renderPage();
    // 9342 + 150000 = 159342 cents
    expect(screen.getAllByText('$1,593.42').length).toBeGreaterThan(0);
  });

  it('the Outstanding invoices section header shows the same API amount due', () => {
    renderPage();
    const heading = screen.getByText('Outstanding invoices');
    const section = heading.closest('section');
    expect(section).not.toBeNull();
    // Regression: a merge re-introduced a dollars-float `totalOut` here; the
    // header must render the integer-cents total via centsToDisplay.
    expect(section!.textContent).toContain('$1,593.42');
    expect(section!.textContent).not.toContain('NaN');
  });

  it('Needs-attention shows the overdue invoice amount due and a human due date (no $NaN, no raw ISO)', () => {
    const { container } = renderPage();
    expect(screen.getByText('INV-0026 · $93.42 · Was due Jan 15')).toBeInTheDocument();
    expect(container.textContent).not.toContain('NaN');
    expect(container.textContent).not.toContain('T02:23:19');
  });

  it('refreshes the live dashboard panels within the 30s freshness budget', () => {
    renderPage();
    for (const path of ['/api/appointments', '/api/jobs', '/api/estimates', '/api/invoices', '/api/leads']) {
      const call = vi.mocked(useListQuery).mock.calls.find(([p]) => p === path);
      expect(call?.[1]?.refetchInterval, path).toBeLessThanOrEqual(30_000);
    }
  });
});
