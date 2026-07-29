/**
 * Mobile/glove layout contract for the public estimate approval page.
 *
 * jsdom can't measure real overflow, so these assertions pin the CSS
 * class contract the mobile fix depends on (minmax(0,1fr) grid tracks,
 * break-words on descriptions, min-h-11 ≥44px glove targets). The real
 * overflow measurement lives in e2e/estimate-approval-mobile.spec.ts
 * (Playwright, 320px/390px viewports).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { EstimateApprovalPage } from './EstimateApprovalPage';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const LONG_DESCRIPTION =
  'TanklessWaterHeaterModelRTGH95DVLN2SerialAB0123456789XYZ Replacement with recirculation pump';

const view = {
  id: 'est-1',
  estimateNumber: 'EST-1042',
  status: 'sent',
  customerName: 'Sarah Johnson',
  businessName: 'Acme HVAC',
  lineItems: [
    // Long unbroken description + big money — the two mobile overflow triggers.
    { description: LONG_DESCRIPTION, quantity: 1, unitPriceCents: 1_234_567, totalCents: 1_234_567 },
    { description: 'AC tune-up', quantity: 1, unitPriceCents: 12_500, totalCents: 12_500 },
    { description: 'Filter swap', quantity: 2, unitPriceCents: 2_000, totalCents: 4_000 },
    { description: 'Thermostat', quantity: 1, unitPriceCents: 9_900, totalCents: 9_900 },
    { description: 'Labor', quantity: 3, unitPriceCents: 15_000, totalCents: 45_000 },
  ],
  totalCents: 1_305_967,
  subtotalCents: 1_305_967,
  taxCents: 0,
  discountCents: 0,
  isActionable: true,
  isExpired: false,
  depositRequiredCents: 0,
  depositPaidCents: 0,
  depositStatus: 'not_required',
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/e/test-token']}>
      <Routes>
        <Route path="/e/:id" element={<EstimateApprovalPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EstimateApprovalPage — mobile layout contract', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return jsonResponse(view);
      return jsonResponse({});
    });
  });

  it('line-items grid tracks use minmax(0,1fr) so descriptions can shrink', async () => {
    renderPage();
    const desc = await screen.findByText(LONG_DESCRIPTION);
    // The description sits inside a flex "item" cell (EE-4 thumbnail + text);
    // the grid row is the nearest .grid ancestor.
    const row = desc.closest('div.grid') as HTMLElement;
    expect(row.className).toContain('minmax(0,1fr)');
    // Header row carries the same track contract.
    const header = screen.getByText('Item').parentElement as HTMLElement;
    expect(header.className).toContain('minmax(0,1fr)');
  });

  it('description cells wrap instead of forcing the track wider', async () => {
    renderPage();
    const desc = await screen.findByText(LONG_DESCRIPTION);
    expect(desc.className).toContain('min-w-0');
    expect(desc.className).toContain('break-words');
  });

  it('money cells use tabular-nums and all four columns render for the long row', async () => {
    renderPage();
    const desc = await screen.findByText(LONG_DESCRIPTION);
    const row = desc.closest('div.grid') as HTMLElement;
    const cells = Array.from(row.children) as HTMLElement[];
    // Cell 0 is the flex item cell (thumbnail + description); 1-3 are money.
    expect(cells).toHaveLength(4);
    expect(cells[1].className).toContain('tabular-nums');
    expect(cells[2].className).toContain('tabular-nums');
    expect(cells[3].className).toContain('tabular-nums');
    expect(cells[3].textContent).toContain('12,345.67');
  });

  it('show-more toggle and Download PDF meet the 44px glove target (min-h-11)', async () => {
    renderPage();
    // 5 line items > 3 → the collapse toggle renders.
    const toggle = await screen.findByRole('button', { name: /more items/i });
    expect(toggle.className).toContain('min-h-11');
    const pdf = screen.getByRole('button', { name: /download pdf/i });
    expect(pdf.className).toContain('min-h-11');
  });

  it('EE-4 — renders a fixed-size thumbnail for a line with an imageUrl', async () => {
    apiFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return jsonResponse({
          ...view,
          lineItems: [
            { description: 'Tankless heater', quantity: 1, unitPriceCents: 250000, totalCents: 250000, imageUrl: 'https://cdn/x.jpg' },
            { description: 'Labor', quantity: 1, unitPriceCents: 15000, totalCents: 15000 },
          ],
        });
      }
      return jsonResponse({});
    });
    renderPage();
    const thumb = (await screen.findByTestId('line-item-thumb-0')) as HTMLImageElement;
    expect(thumb).toHaveAttribute('src', 'https://cdn/x.jpg');
    // Fixed size + shrink-0 + object-cover so a wide photo can't break the
    // ≤320px grid; decorative alt keeps it out of the row's accessible name.
    expect(thumb.className).toContain('h-10');
    expect(thumb.className).toContain('w-10');
    expect(thumb.className).toContain('shrink-0');
    expect(thumb.className).toContain('object-cover');
    expect(thumb).toHaveAttribute('alt', '');
    // Regression guard (a runtime /verify catch): the item cell MUST be
    // flex-wrap. Without it, at ≤390px the 40px thumbnail starves the
    // description track to ~0px and the text renders one character per line.
    // flex-wrap lets the description drop below the thumbnail and reclaim the
    // full column width. jsdom can't measure the collapse; pin the mechanism.
    const itemCell = thumb.parentElement as HTMLElement;
    expect(itemCell.className).toContain('flex-wrap');
    // The image-less line renders no thumbnail.
    expect(screen.queryByTestId('line-item-thumb-1')).not.toBeInTheDocument();
  });

  it('EE-4 — a legacy estimate with no images renders exactly as before (no thumbnails)', async () => {
    renderPage(); // default `view` has no imageUrl on any line
    await screen.findByText('AC tune-up');
    expect(screen.queryByTestId('line-item-thumb-0')).not.toBeInTheDocument();
  });

  it('renders the tenant terminology label (Quote) instead of "Estimate"', async () => {
    // Story 7.4 — the tenant's word flows into the customer-facing approval page.
    apiFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return jsonResponse({ ...view, estimateLabel: 'Quote' });
      return jsonResponse({});
    });
    renderPage();
    expect(await screen.findByText('Quote')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accept this quote/i })).toBeInTheDocument();
    expect(screen.queryByText('Estimate')).not.toBeInTheDocument();
  });
  it('B7.5 — renders the descriptive unit under the quantity, wrapping inside the Qty track', async () => {
    apiFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return jsonResponse({
          ...view,
          lineItems: [
            // 'per gal' is the LONGEST unit in catalogUnitSchema — the worst
            // case for the narrow 2rem Qty track at 320px. The track is
            // deliberately NOT widened: at 320px the description track has
            // only ~30px of slack, and the existing e2e guard requires it to
            // stay above that, so the unit wraps inside the track (adding
            // height) rather than stealing width.
            { description: 'Sealant', quantity: 12, unit: 'per gal', unitPriceCents: 4_200, totalCents: 50_400 },
            { description: 'Prep labor', quantity: 3, unitPriceCents: 8_500, totalCents: 25_500 },
          ],
        });
      }
      return jsonResponse({});
    });
    renderPage();

    const unit = await screen.findByTestId('line-item-unit-0');
    expect(unit.textContent).toBe('per gal');
    // Block + break-words is the mechanism that keeps a long unit INSIDE the
    // fixed Qty track instead of widening the row (jsdom can't measure the
    // overflow; e2e/estimate-approval-mobile.spec.ts does at 320px).
    expect(unit.className).toContain('block');
    expect(unit.className).toContain('break-words');
    // It lives in the Qty cell, immediately after the number.
    const qtyCell = unit.parentElement as HTMLElement;
    expect(qtyCell.textContent).toBe('12per gal');
    // A line with no unit renders no unit node at all.
    expect(screen.queryByTestId('line-item-unit-1')).not.toBeInTheDocument();
  });

  it('B7.5 — the unit wraps inside the unchanged 2rem Qty track (320px budget)', async () => {
    apiFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return jsonResponse({
          ...view,
          lineItems: [
            { description: LONG_DESCRIPTION, quantity: 12, unit: 'per gal', unitPriceCents: 1_234_567, totalCents: 1_234_567 },
          ],
        });
      }
      return jsonResponse({});
    });
    renderPage();
    const desc = await screen.findByText(LONG_DESCRIPTION);
    const row = desc.closest('div.grid') as HTMLElement;
    // Description track can still shrink below its content width…
    expect(row.className).toContain('minmax(0,1fr)');
    // …and the MOBILE Qty track is still 2rem. This is the load-bearing
    // assertion: at 320px the tracks total 238px, so 2rem leaves the
    // description 46px but 3rem would leave exactly 30px — starving it and
    // tripping the e2e `descBox.width > 30` guard. The unit wraps inside the
    // 2rem track instead of widening it.
    expect(row.className).toContain('_2rem_');
    expect(row.className).not.toContain('_3rem_');
    // Only the sm: breakpoint, which has width to spare, widens Qty to 56px.
    expect(row.className).toContain('sm:grid-cols-[minmax(0,1fr)_56px_72px_72px]');
    // Header row carries the identical track contract.
    const header = screen.getByText('Item').parentElement as HTMLElement;
    expect(header.className).toContain('_2rem_');
    expect(header.className).toContain('sm:grid-cols-[minmax(0,1fr)_56px_72px_72px]');
  });

  it('B7.5 — the unit is descriptive: the rendered money is unchanged by it', async () => {
    apiFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return jsonResponse({
          ...view,
          lineItems: [
            { description: 'Sealant', quantity: 12, unit: 'per gal', unitPriceCents: 4_200, totalCents: 50_400 },
          ],
          totalCents: 50_400,
          subtotalCents: 50_400,
        });
      }
      return jsonResponse({});
    });
    renderPage();
    const unit = await screen.findByTestId('line-item-unit-0');
    const row = unit.closest('div.grid') as HTMLElement;
    const cells = Array.from(row.children) as HTMLElement[];
    // 12 x $42.00 = $504.00 — the same figures a unit-less line would show.
    expect(cells[2].textContent).toBe('$42.00');
    expect(cells[3].textContent).toBe('$504.00');
  });
});
