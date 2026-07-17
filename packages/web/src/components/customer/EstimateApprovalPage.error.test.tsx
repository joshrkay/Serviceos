import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function renderPageAtToken(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/e/${token}`]}>
      <Routes>
        <Route path="/e/:id" element={<EstimateApprovalPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function errResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: async () => ({}),
    text: async () => '{}',
  } as unknown as Response;
}

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A real public-API estimate view, distinct from any fixture data. */
const REAL_VIEW = {
  id: 'est_1',
  estimateNumber: 'EST-2042',
  status: 'sent',
  customerName: 'Dana Realuser',
  customerAddress: '42 Real St, Austin, TX',
  businessName: 'Acme Plumbing',
  lineItems: [
    { id: 'li_1', description: 'Drain repair', quantity: 1, unitPriceCents: 25000, totalCents: 25000 },
  ],
  totalCents: 25000,
  subtotalCents: 25000,
  taxCents: 0,
  discountCents: 0,
  isActionable: true,
  isExpired: false,
  version: 1,
  customerMessage: 'Drain repair',
};

/**
 * Blocker 8 — the public estimate page must never fall back to fixture
 * data. A failed load used to render a fixture estimate, leaking
 * another customer's name, address, and pricing on a public URL.
 */
describe('EstimateApprovalPage — Blocker 8: no fixture-data leak on failure', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('shows an error screen (not fixture data) on a network error', async () => {
    apiFetchMock.mockRejectedValue(new Error('network down'));
    renderPageAtToken('some-token');

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /Couldn’t load this estimate/i }),
      ).toBeInTheDocument(),
    );
    // No fixture customer should ever surface here.
    expect(screen.queryByText(/Sarah Johnson/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Fieldly Pro Services/i)).not.toBeInTheDocument();
  });

  it('shows an error screen on a non-OK (500) response', async () => {
    apiFetchMock.mockResolvedValue(errResponse(500));
    renderPageAtToken('some-token');

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /Couldn’t load this estimate/i }),
      ).toBeInTheDocument(),
    );
  });

  it('shows "Link not found" on a 404 (no retry button)', async () => {
    apiFetchMock.mockResolvedValue(errResponse(404));
    renderPageAtToken('missing-token');

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Link not found/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /Try again/i })).not.toBeInTheDocument();
  });

  it('retry button refetches and renders the real estimate on success', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('network down'));
    renderPageAtToken('real-token');

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /Couldn’t load this estimate/i }),
      ).toBeInTheDocument(),
    );

    apiFetchMock.mockImplementation((path: string) =>
      Promise.resolve(
        typeof path === 'string' && path === '/public/estimates/real-token'
          ? okResponse(REAL_VIEW)
          : okResponse({}),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));

    await waitFor(() =>
      expect(screen.getByText(/Hi, Dana!/i)).toBeInTheDocument(),
    );
    expect(screen.getAllByText(/Acme Plumbing/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Sarah Johnson/i)).not.toBeInTheDocument();
  });

  it('success path renders the API estimate (unchanged)', async () => {
    apiFetchMock.mockImplementation((path: string) =>
      Promise.resolve(
        typeof path === 'string' && path === '/public/estimates/real-token'
          ? okResponse(REAL_VIEW)
          : okResponse({}),
      ),
    );
    renderPageAtToken('real-token');

    await waitFor(() => expect(screen.getByText(/Hi, Dana!/i)).toBeInTheDocument());
    expect(screen.getByText('EST-2042')).toBeInTheDocument();
    expect(screen.getAllByText(/Drain repair/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Sarah Johnson/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Fieldly Pro Services/i)).not.toBeInTheDocument();
  });
});
