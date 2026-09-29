/**
 * #1402 §13 — the tenant's business address appears on the public estimate
 * approval page (header) and on the PDF the customer downloads from it.
 * Seam: the rendered page over a mocked public API; the print document is
 * observed through the window it writes to.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { EstimateApprovalPage } from './EstimateApprovalPage';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const view = {
  id: 'est-1',
  estimateNumber: 'EST-1042',
  status: 'sent',
  customerName: 'Sarah Johnson',
  businessName: 'Acme HVAC',
  businessAddress: '1200 W Main St\nMesa, AZ 85201',
  lineItems: [{ description: 'AC tune-up', quantity: 1, unitPriceCents: 12_500, totalCents: 12_500 }],
  totalCents: 12_500,
  subtotalCents: 12_500,
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

describe('EstimateApprovalPage — #1402 §13 business address', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      !init || init.method === undefined ? jsonResponse(view) : jsonResponse({}),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the business address under the business name in the header', async () => {
    renderPage();

    const address = await screen.findByTestId('business-address');
    expect(address).toHaveTextContent('1200 W Main St');
    expect(address).toHaveTextContent('Mesa, AZ 85201');
  });

  it('prints the business address on the downloaded PDF', async () => {
    const writes: string[] = [];
    vi.spyOn(window, 'open').mockReturnValue({
      document: { write: (s: string) => writes.push(s), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
    } as unknown as Window);
    renderPage();

    await screen.findByTestId('business-address');
    fireEvent.click(screen.getByRole('button', { name: /PDF/i }));

    expect(writes.join('')).toContain('1200 W Main St<br>Mesa, AZ 85201');
  });
});
