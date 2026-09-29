import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { EstimateApprovalPage } from './EstimateApprovalPage';

/**
 * #1473 item 2 — the public approve page treated EVERY 409 as "the estimate
 * was updated". A job that already has an accepted estimate must say that,
 * and must not offer Accept again.
 */

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const sentView = {
  id: 'est-1',
  estimateNumber: 'EST-1042',
  status: 'sent',
  version: 1,
  customerName: 'Sarah Johnson',
  businessName: 'Acme HVAC',
  lineItems: [{ description: 'AC tune-up', quantity: 1, unitPriceCents: 12500, totalCents: 12500 }],
  totalCents: 12500,
  subtotalCents: 12500,
  taxCents: 0,
  discountCents: 0,
  isActionable: true,
  isExpired: false,
  depositRequiredCents: 0,
  depositPaidCents: 0,
  depositStatus: 'not_required',
};

// jsdom has no 2D canvas; a stub context lets the signature pad register a stroke.
beforeEach(() => {
  apiFetchMock.mockReset();
  const ctx = {
    scale: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), clearRect: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AA==');
});
afterEach(() => vi.restoreAllMocks());

async function submitApproval(approveResponse: Response) {
  apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && String(url).endsWith('/approve')) return approveResponse;
    if (init?.method === 'POST') return response(200, {});
    return response(200, sentView);
  });
  render(
    <MemoryRouter initialEntries={['/e/tok-1']}>
      <Routes>
        <Route path="/e/:id" element={<EstimateApprovalPage />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /accept this/i }));
  const canvas = document.querySelector('canvas')!;
  fireEvent.mouseDown(canvas, { clientX: 5, clientY: 5 });
  fireEvent.mouseMove(canvas, { clientX: 20, clientY: 20 });
  fireEvent.mouseUp(canvas);
  fireEvent.click(await screen.findByRole('button', { name: /accept estimate/i }));
}

describe('EstimateApprovalPage — telling 409 conflicts apart (#1473)', () => {
  it('a job that already has an accepted estimate shows that reason and offers no Accept', async () => {
    const message =
      'Another estimate on this job has already been accepted. Please contact us — this estimate may no longer be current.';
    await submitApproval(response(409, { error: 'CONFLICT', message, details: { reason: 'job_already_accepted' } }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/was updated by the business/i)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /accept (this|estimate)/i })).not.toBeInTheDocument(),
    );
  });

  it('a revised estimate still shows the "updated by the business" banner', async () => {
    await submitApproval(
      response(409, {
        error: 'CONFLICT',
        message: 'This estimate was updated after you opened it. Please review the latest version before accepting.',
        details: { reason: 'estimate_revised' },
      }),
    );
    expect(await screen.findByText(/was updated by the business/i)).toBeInTheDocument();
  });
});
