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
    const row = desc.parentElement as HTMLElement;
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
    const row = desc.parentElement as HTMLElement;
    const cells = Array.from(row.children) as HTMLElement[];
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
});
