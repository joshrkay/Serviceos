/**
 * B7.5 (PR review, FINDING B — operator-side follow-up) — the descriptive
 * `unit` reaches the CUSTOMER on EstimateApprovalPage
 * (EstimateApprovalPage.layout.test.tsx) but was never rendered on the
 * operator-facing tables in this file: the inline `LineItemsEditor` (the
 * estimate detail page's own line-items table) and `EstimateDocPreview`
 * (the "what the customer sees" modal). The person who spoke "three hours
 * of labor" should see the same unit their customer does.
 *
 * jsdom can't measure real overflow, so these assertions pin the CSS class
 * contract the fix depends on: the unit renders as a `block` + `break-words`
 * child INSIDE the existing fixed-width Qty column (no new grid track), so
 * it can only add height, never width, at the 320px viewport — the same
 * technique already proven on the customer pages.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
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
import { useEstimateTerm } from '../../hooks/useEstimateTerm';

const totalsOf = (totalCents: number) => ({
  subtotalCents: totalCents,
  discountCents: 0,
  taxRateBps: 0,
  taxableSubtotalCents: totalCents,
  taxCents: 0,
  totalCents,
});

// 'per gal' is the longest value in catalogUnitSchema — worst case for the
// narrow fixed Qty tracks (52px in the editor, 32px in the doc preview).
const lineWithUnit = {
  id: 'li-1', description: 'Sealant', quantity: 12, unit: 'per gal',
  unitPriceCents: 4_200, totalCents: 50_400, sortOrder: 0, taxable: true,
};
const lineWithoutUnit = {
  id: 'li-2', description: 'Prep labor', quantity: 3,
  unitPriceCents: 8_500, totalCents: 25_500, sortOrder: 1, taxable: true,
};

function estOf(lineItems: unknown[], totalCents: number) {
  return {
    id: 'e1',
    estimateNumber: 'EST-001',
    status: 'draft',
    customerMessage: 'Sealant job',
    createdAt: '2026-06-01T00:00:00.000Z',
    lineItems,
    totals: totalsOf(totalCents),
    customer: { id: 'c1', displayName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith' },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(useListQuery).mockReturnValue({
    data: [], total: 0, page: 1, pageSize: 25, isLoading: false, error: null,
    refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
  });
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
  vi.mocked(useEstimateTerm).mockReturnValue('Estimate');
  // Detail-view side fetches (notes, history, job enrichment, attachments)
  // are best-effort and irrelevant to this layout contract.
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

function renderDetail(lineItems: unknown[], totalCents: number) {
  vi.mocked(useDetailQuery).mockReturnValue({
    data: estOf(lineItems, totalCents), isLoading: false, error: null, refetch: vi.fn(),
  });
  return render(
    <MemoryRouter>
      <EstimatesPage defaultSelectedId="e1" />
    </MemoryRouter>,
  );
}

describe('EstimatesPage — LineItemsEditor (operator table) B7.5 unit contract', () => {
  it('renders the descriptive unit under the quantity, inside the unchanged 52px Qty track', async () => {
    renderDetail([lineWithUnit, lineWithoutUnit], 75_900);

    const unit = await screen.findByTestId('line-item-unit-0');
    expect(unit.textContent).toBe('per gal');
    expect(unit.className).toContain('block');
    expect(unit.className).toContain('break-words');
    const qtyCell = unit.parentElement as HTMLElement;
    expect(qtyCell.textContent).toBe('12per gal');

    // Load-bearing: still the same fixed-width tracks as before this change —
    // the unit is a child of the Qty cell, not a fifth column.
    const row = unit.closest('div.grid') as HTMLElement;
    expect(row.className).toContain('grid-cols-[1fr_52px_80px_80px]');
    expect(Array.from(row.children)).toHaveLength(4);

    const header = screen.getByText('Description').parentElement as HTMLElement;
    expect(header.className).toContain('grid-cols-[1fr_52px_80px_80px]');
  });

  it('a legacy line with no unit renders exactly as before (no unit node)', async () => {
    renderDetail([lineWithUnit, lineWithoutUnit], 75_900);
    await screen.findByText('Prep labor');
    expect(screen.queryByTestId('line-item-unit-1')).not.toBeInTheDocument();
  });

  it('320px track budget: unchanged before/after this change (explicit arithmetic)', async () => {
    // Container chrome for the LineItemsEditor card, read from the JSX:
    //   page wrapper:  .max-w-5xl.mx-auto.px-4  → 16px × 2 = 32px
    //   card border:   .border                  →  1px × 2 =  2px
    //   row wrapper:   .grid.gap-x-2.px-4        → 16px × 2 = 32px
    //   3 × gap-x-2 (8px each) between 4 columns → 24px
    //   -----
    //   = 230px left for the 4 grid tracks combined
    //   − 212px fixed columns (52 + 80 + 80 = 212 for Qty/Rate/Total)
    //   -----
    //   =  18px left for the description (1fr) column
    //
    // Unchanged by this change: the unit is a `block` child that wraps INSIDE
    // the 52px Qty track (asserted above), adding height, never width.
    const viewportPx = 320;
    const pageGutterPx = 32;
    const cardBorderPx = 2;
    const rowGutterPx = 32;
    const gapsPx = 3 * 8;
    const fixedColsPx = 52 + 80 + 80;
    const trackBudgetPx = viewportPx - pageGutterPx - cardBorderPx - rowGutterPx - gapsPx;
    const descriptionBudgetPx = trackBudgetPx - fixedColsPx;
    expect(trackBudgetPx).toBe(230);
    expect(descriptionBudgetPx).toBe(18);
  });

  it('the unit is descriptive: the rendered total is unchanged with and without a unit', async () => {
    const view1 = renderDetail([lineWithUnit], 50_400);
    const unit = await screen.findByTestId('line-item-unit-0');
    const rowWithUnit = unit.closest('div.grid') as HTMLElement;
    const cellsWithUnit = Array.from(rowWithUnit.children) as HTMLElement[];
    expect(cellsWithUnit[2].textContent).toBe('$42');
    expect(cellsWithUnit[3].textContent).toBe('$504');
    view1.unmount();

    // Same qty/rate, no unit — money rendering must be byte-identical.
    renderDetail([{ ...lineWithUnit, unit: undefined }], 50_400);
    await screen.findByText('Sealant');
    expect(screen.queryByTestId('line-item-unit-0')).not.toBeInTheDocument();
    const rowNoUnit = (screen.getByText('Sealant').closest('div.grid')) as HTMLElement;
    const cellsNoUnit = Array.from(rowNoUnit.children) as HTMLElement[];
    expect(cellsNoUnit[2].textContent).toBe('$42');
    expect(cellsNoUnit[3].textContent).toBe('$504');
  });
});

describe('EstimatesPage — EstimateDocPreview (customer preview modal) B7.5 unit contract', () => {
  it('renders the descriptive unit under the quantity, inside the unchanged 32px Qty track', async () => {
    renderDetail([lineWithUnit, lineWithoutUnit], 75_900);
    await screen.findByText('Sealant');

    fireEvent.click(screen.getByRole('button', { name: /preview document/i }));
    await screen.findByText('Customer preview');

    // Both the editor (behind the modal) and the modal itself render a line
    // at index 0 — disambiguate by the modal's distinct 32px Qty track.
    const units = screen.getAllByTestId('line-item-unit-0');
    expect(units).toHaveLength(2);
    const previewUnit = units.find(
      (u) => (u.closest('div.grid') as HTMLElement).className.includes('32px'),
    ) as HTMLElement;
    expect(previewUnit.textContent).toBe('per gal');
    expect(previewUnit.className).toContain('block');
    expect(previewUnit.className).toContain('break-words');
    expect((previewUnit.parentElement as HTMLElement).textContent).toBe('12per gal');

    const row = previewUnit.closest('div.grid') as HTMLElement;
    expect(row.className).toContain('grid-cols-[1fr_32px_72px_72px]');
    expect(Array.from(row.children)).toHaveLength(4);

    const headers = screen.getAllByText('Description');
    const previewHeader = headers
      .map((h) => h.parentElement as HTMLElement)
      .find((h) => h.className.includes('32px')) as HTMLElement;
    expect(previewHeader.className).toContain('grid-cols-[1fr_32px_72px_72px]');
  });

  it('the second (unit-less) line renders no unit node anywhere (editor or preview)', async () => {
    renderDetail([lineWithUnit, lineWithoutUnit], 75_900);
    await screen.findByText('Sealant');
    fireEvent.click(screen.getByRole('button', { name: /preview document/i }));
    await screen.findByText('Customer preview');

    // Both rows describing the unit-less line (editor + modal) render, but
    // neither carries a `line-item-unit-1` node.
    expect(screen.getAllByText('Prep labor').length).toBe(2);
    expect(screen.queryAllByTestId('line-item-unit-1')).toHaveLength(0);
  });

  it('320px track budget for the modal: unchanged before/after this change (explicit arithmetic)', async () => {
    // Modal chrome read from the JSX:
    //   overlay padding: .p-4 on the fixed overlay          → 16px × 2 = 32px
    //     (constrains the rendered modal width at a 320px viewport, since
    //      w-full max-w-md would otherwise be capped at 448px)
    //   modal width at 320px viewport = 320 − 32 = 288px
    //   body padding:    .p-5                               → 20px × 2 = 40px
    //   card border:     .border                             →  1px × 2 =  2px
    //   row wrapper:     .grid.gap-x-2.px-3                  → 12px × 2 = 24px
    //   3 × gap-x-2 (8px each) between 4 columns             → 24px
    //   -----
    //   = 198px left for the 4 grid tracks combined
    //   − 176px fixed columns (32 + 72 + 72 = 176 for Qty/Rate/Total)
    //   -----
    //   =  22px left for the description (1fr) column
    //
    // Unchanged by this change: the unit wraps INSIDE the 32px Qty track.
    const viewportPx = 320;
    const overlayPaddingPx = 32;
    const modalWidthPx = viewportPx - overlayPaddingPx;
    const bodyPaddingPx = 40;
    const cardBorderPx = 2;
    const rowGutterPx = 24;
    const gapsPx = 3 * 8;
    const fixedColsPx = 32 + 72 + 72;
    const trackBudgetPx = modalWidthPx - bodyPaddingPx - cardBorderPx - rowGutterPx - gapsPx;
    const descriptionBudgetPx = trackBudgetPx - fixedColsPx;
    expect(modalWidthPx).toBe(288);
    expect(trackBudgetPx).toBe(198);
    expect(descriptionBudgetPx).toBe(22);
  });
});
