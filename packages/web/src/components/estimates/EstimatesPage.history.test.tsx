/**
 * Estimate detail — "History" section (document-revision read path).
 *
 * The API records a document revision for every estimate edit (source
 * manual | ai_generated | ai_revised) plus a diff summary; GET
 * /api/estimates/:id/revisions surfaces them. This pins the read-only
 * History card: source badge + relative time + summary line, the empty
 * state, and the best-effort error handling (a failed fetch hides the
 * section instead of breaking the page).
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { EstimatesPage } from './EstimatesPage';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('../../hooks/useEstimateTerm', () => ({ useEstimateTerm: vi.fn(() => 'Estimate') }));
vi.mock('./NewEstimateFlow', () => ({ NewEstimateFlow: () => null }));
vi.mock('./ConvertToInvoiceSheet', () => ({ ConvertToInvoiceSheet: () => null }));
vi.mock('../shared/CameraCapture', () => ({
  CameraCapture: () => <div data-testid="mock-capture-sheet">Capture open</div>,
}));

import { useListQuery } from '../../hooks/useListQuery';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useMutation } from '../../hooks/useMutation';

const totals = {
  subtotalCents: 150000,
  discountCents: 0,
  taxRateBps: 0,
  taxableSubtotalCents: 150000,
  taxCents: 0,
  totalCents: 150000,
};

const detailFixture = {
  id: 'e1',
  estimateNumber: 'EST-001',
  status: 'draft',
  customerMessage: 'Repair',
  createdAt: '2026-06-01T00:00:00.000Z',
  lineItems: [],
  totals,
  customer: { id: 'c1', displayName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith' },
};

const FIVE_MIN_AGO = new Date(Date.now() - 5 * 60_000).toISOString();
const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60_000).toISOString();

const revisionsFixture = [
  { id: 'rev-2', version: 2, source: 'ai_revised', createdAt: FIVE_MIN_AGO, summary: '1 change(s)' },
  { id: 'rev-1', version: 1, source: 'manual', createdAt: TWO_HOURS_AGO },
];

function stubFetch(revisions: 'ok' | 'empty' | 'fail') {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/estimates/e1/revisions')) {
        if (revisions === 'fail') return new Response('boom', { status: 500 });
        return json(revisions === 'ok' ? revisionsFixture : []);
      }
      return json([]);
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(useListQuery).mockReturnValue({
    data: [],
    total: 0,
    page: 1,
    pageSize: 25,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    setPage: vi.fn(),
    setSearch: vi.fn(),
    setFilters: vi.fn(),
  });
  vi.mocked(useDetailQuery).mockReturnValue({
    data: detailFixture,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
});

function renderDetail() {
  return render(
    <MemoryRouter>
      <EstimatesPage defaultSelectedId="e1" />
    </MemoryRouter>,
  );
}

describe('EstimateDetail History section (document revisions)', () => {
  it('renders revisions with a source badge, relative time, and summary line', async () => {
    stubFetch('ok');
    renderDetail();

    expect(await screen.findByText('History')).toBeInTheDocument();
    // Source badges
    expect(screen.getByText('AI revised')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
    // Diff summary line (only where the API provided one)
    expect(screen.getByText('1 change(s)')).toBeInTheDocument();
    // Relative timestamps
    expect(screen.getByText('5m ago')).toBeInTheDocument();
    expect(screen.getByText('2h ago')).toBeInTheDocument();
  });

  it('shows an empty state when no revisions were recorded', async () => {
    stubFetch('empty');
    renderDetail();

    expect(await screen.findByText('History')).toBeInTheDocument();
    expect(screen.getByText(/No revisions yet/i)).toBeInTheDocument();
  });

  it('hides the section when the fetch fails (best-effort)', async () => {
    stubFetch('fail');
    renderDetail();

    // Let the effect settle, then confirm the section never appeared.
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes('/revisions'))).toBe(true),
    );
    expect(screen.queryByText('History')).not.toBeInTheDocument();
    expect(screen.queryByText(/No revisions yet/i)).not.toBeInTheDocument();
  });
});
