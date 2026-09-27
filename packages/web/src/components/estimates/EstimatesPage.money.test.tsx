/**
 * #1400 (QA 2026-09-26 §4) — money on the estimate detail view is the API's.
 * Fixtures are parsed through the shared estimateResponseSchema so they are
 * exactly what GET /api/estimates/:id serializes. EST-0030 from the sweep:
 * subtotal $300.99, 8.25% tax $24.83, total $325.82 — the preview/PDF showed
 * $300.99 because it re-summed qty × rate and ignored tax and discount.
 */
import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { EstimatesPage } from './EstimatesPage';
import { listQueryResult } from '../../test-utils/list-query-result';
import { apiEstimate } from '../../test-utils/money-fixtures';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('../../hooks/useEstimateTerm', () => ({ useEstimateTerm: vi.fn(() => 'Estimate') }));
vi.mock('./NewEstimateFlow', () => ({ NewEstimateFlow: () => null }));
vi.mock('./ConvertToInvoiceSheet', () => ({ ConvertToInvoiceSheet: () => null }));

import { useListQuery } from '../../hooks/useListQuery';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useMutation } from '../../hooks/useMutation';

const est0030 = apiEstimate({
  id: '00000000-0000-4000-8000-0000000000e1',
  estimateNumber: 'EST-0030',
  customer: { id: '00000000-0000-4000-8000-0000000000c1', displayName: 'Alice Smith' },
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(useListQuery).mockReturnValue(listQueryResult([]));
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

function renderDetail(estimate = est0030) {
  vi.mocked(useDetailQuery).mockReturnValue({ data: estimate, isLoading: false, error: null, refetch: vi.fn() });
  return render(
    <MemoryRouter>
      <EstimatesPage defaultSelectedId={estimate.id} />
    </MemoryRouter>,
  );
}

describe('EstimatesPage money (#1400)', () => {
  it('the customer preview shows the API total with tax, not the untaxed line sum', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: /Preview document/ }));
    const preview = screen.getByRole('dialog', { name: 'Customer preview' });
    expect(within(preview).getByText('Tax (8.25%)')).toBeInTheDocument();
    expect(within(preview).getByText('$24.83')).toBeInTheDocument();
    expect(within(preview).getByText('$325.82')).toBeInTheDocument();
  });

  it('the downloaded PDF carries the API subtotal, tax and total ($325.82, not $300.99)', async () => {
    const written: string[] = [];
    vi.spyOn(window, 'open').mockReturnValue({
      document: { write: (html: string) => written.push(html), close: () => {} },
    } as unknown as Window);
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: /Preview document/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Customer preview' })).getByRole('button', { name: /PDF/ }));
    const html = written.join('');
    expect(html).toContain('Tax (8.25%)');
    expect(html).toContain('$24.83');
    expect(html).toMatch(/<span>Total<\/span>\s*<span>\$325\.82<\/span>/);
  });

  it('the approval tracker shows the real sent / viewed / approved dates (they were hard-coded blank)', async () => {
    renderDetail(apiEstimate({
      id: '00000000-0000-4000-8000-0000000000e2',
      status: 'accepted',
      sentAt: '2026-09-20T15:00:00.000Z',
      firstViewedAt: '2026-09-21T15:00:00.000Z',
      acceptedAt: '2026-09-22T15:00:00.000Z',
      customer: { id: '00000000-0000-4000-8000-0000000000c1', displayName: 'Alice Smith' },
    }));
    await screen.findByText('Approval tracking');
    const tracker = screen.getByText('Approval tracking').parentElement!;
    expect(within(tracker).getByText('Sep 20')).toBeInTheDocument();
    expect(within(tracker).getByText('Sep 21')).toBeInTheDocument();
    expect(within(tracker).getByText('Sep 22')).toBeInTheDocument();
  });
});
