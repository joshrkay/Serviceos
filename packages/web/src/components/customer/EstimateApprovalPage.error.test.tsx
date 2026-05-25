import { render, screen, waitFor } from '@testing-library/react';
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

/**
 * Blocker 8 — the public estimate page must never fall back to fixture
 * data. A failed load used to render `estimates[0]` from mock-data, leaking
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

  it('shows "Link not found" on a 404', async () => {
    apiFetchMock.mockResolvedValue(errResponse(404));
    renderPageAtToken('missing-token');

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Link not found/i })).toBeInTheDocument(),
    );
  });
});
