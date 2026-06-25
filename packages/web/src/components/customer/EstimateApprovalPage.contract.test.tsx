/**
 * Tenant-neutral class contract + money-format contract for the public
 * estimate approval page (U13b).
 *
 * The portal must read as the TENANT, not ServiceOS: no raw Tailwind palette
 * and no Path A brand blue (`--primary`/`--ring`/brand-tinted `accent`). This
 * is the regression tripwire for the states it mounts; the authoritative
 * coverage is the per-cluster source grep (a jsdom guard only sees the states
 * it renders). Also pins that selectable tier/add-on prices show cents — a
 * bare `n.toLocaleString()` was dropping them on round-dollar amounts.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

const view = {
  id: 'est-1',
  estimateNumber: 'EST-1042',
  status: 'sent',
  customerName: 'Sarah Johnson',
  businessName: 'Acme HVAC',
  lineItems: [
    { description: 'AC tune-up', quantity: 1, unitPriceCents: 12_500, totalCents: 12_500 },
    { description: 'Filter swap', quantity: 2, unitPriceCents: 2_000, totalCents: 4_000 },
  ],
  totalCents: 16_500,
  subtotalCents: 16_500,
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

const RAW_PALETTE =
  /(bg|text|border|border-l|border-r|border-t|border-b|placeholder|ring|divide|shadow|from|via|to)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/;

describe('EstimateApprovalPage — tenant-neutral class contract', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return jsonResponse(view);
      return jsonResponse({});
    });
  });

  it('renders no raw Tailwind palette classes', async () => {
    const { container } = renderPage();
    await screen.findByText('Acme HVAC');
    expect(container.innerHTML).not.toMatch(RAW_PALETTE);
  });

  it('renders no ServiceOS brand blue (primary / ring / accent) — tenant-neutral', async () => {
    const { container } = renderPage();
    await screen.findByText('Acme HVAC');
    const html = container.innerHTML;
    expect(html).not.toMatch(/\b(bg|text|border|ring)-primary\b/);
    expect(html).not.toMatch(/\bring-ring\b/);
    expect(html).not.toMatch(/\b(bg|text|border)-accent\b|accent-foreground/);
  });

  it('shows cents on round-dollar selectable add-on prices (fmtUsd, not bare toLocaleString)', async () => {
    apiFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return jsonResponse({
          ...view,
          hasSelectableItems: true,
          lineItems: [
            { id: 'base-1', description: 'Base service', quantity: 1, unitPriceCents: 12_500, totalCents: 12_500 },
            // Round-dollar add-on: bare toLocaleString() renders "+$42", fmtUsd renders "+$42.00".
            { id: 'addon-1', description: 'Surge protector', quantity: 1, unitPriceCents: 4_200, totalCents: 4_200, isOptional: true, taxable: false },
          ],
        });
      }
      return jsonResponse({});
    });
    renderPage();
    expect(await screen.findByText('+$42.00')).toBeInTheDocument();
  });
});
