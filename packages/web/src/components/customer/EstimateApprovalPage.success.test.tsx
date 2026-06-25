import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// EstimateApprovalPage pulls in toast/sonner; stub to avoid cross-talk.
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

// An already-accepted estimate → EstimateApprovalPage flips to SuccessScreen on
// load (view.status === 'accepted' calls setAccept(true)). Mirrors the accepted
// fixture pattern in EstimateApprovalPage.deposit.test.tsx.
const acceptedView = (overrides: Record<string, unknown> = {}) => ({
  id: 'est-1',
  estimateNumber: 'EST-1042',
  status: 'accepted',
  acceptedAt: '2026-03-15T12:00:00Z',
  customerName: 'Sarah Johnson',
  businessName: 'Acme HVAC',
  businessPhone: '(512) 555-0100',
  lineItems: [
    { description: 'AC tune-up', quantity: 1, unitPriceCents: 12500, totalCents: 12500 },
  ],
  totalCents: 12500,
  subtotalCents: 12500,
  taxCents: 0,
  discountCents: 0,
  isActionable: false,
  isExpired: false,
  depositRequiredCents: 0,
  depositPaidCents: 0,
  depositStatus: 'not_required',
  ...overrides,
});

function renderAccepted(view: Record<string, unknown>) {
  apiFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    // GET (no method) returns the view; any mutation returns OK.
    if (!init || init.method === undefined) return jsonResponse(view);
    return jsonResponse({});
  });
  return render(
    <MemoryRouter initialEntries={['/e/tok-1']}>
      <Routes>
        <Route path="/e/:id" element={<EstimateApprovalPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EstimateApprovalPage — SuccessScreen tenant branding (QA-004)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('renders the tenant business name on the accepted screen, never "Fieldly"', async () => {
    const { container } = renderAccepted(acceptedView());
    await screen.findByText('Estimate accepted!'); // SuccessScreen mounted

    // Real tenant name shows in both the page header and the job card.
    expect(screen.getAllByText('Acme HVAC').length).toBeGreaterThanOrEqual(2);
    // The old hardcoded brand and "F" avatar are gone.
    expect(screen.queryAllByText(/Fieldly Pro Services/i)).toHaveLength(0);
    expect(screen.queryAllByText('F')).toHaveLength(0);
    // Avatar shows the tenant's initial, derived from businessName.
    expect(screen.getAllByText('A').length).toBeGreaterThanOrEqual(1);
    // Phone link is wired to the real businessPhone (digits only).
    expect(container.querySelector('a[href="tel:5125550100"]')).not.toBeNull();
    // The acceptance date is the real acceptedAt, and the fabricated date +
    // mock job number are gone.
    expect(screen.getByText(/Mar 15, 2026 · Estimate approved/)).toBeInTheDocument();
    expect(screen.queryAllByText(/March 10, 2026/)).toHaveLength(0);
    expect(screen.queryAllByText('JOB-1053')).toHaveLength(0);
  });

  it('derives the avatar initial from the business name (not a hardcoded letter)', async () => {
    renderAccepted(acceptedView({ businessName: 'Zephyr Plumbing' }));
    await screen.findByText('Estimate accepted!');

    expect(screen.getAllByText('Zephyr Plumbing').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Z').length).toBeGreaterThanOrEqual(1);
    // Not the prior fixture's "A" initial — proves the value is derived.
    expect(screen.queryAllByText('A')).toHaveLength(0);
  });

  it('omits the phone link and date row when the tenant has no businessPhone or acceptedAt', async () => {
    const { container } = renderAccepted(
      acceptedView({ businessPhone: undefined, acceptedAt: undefined }),
    );
    await screen.findByText('Estimate accepted!');

    expect(screen.getAllByText('Acme HVAC').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
    // Falls back to the bare label when there is no acceptedAt timestamp.
    expect(screen.getByText('Estimate approved')).toBeInTheDocument();
  });

  it("stamps today's date on the signing sheet, not a hardcoded one", async () => {
    // Fake only Date so findBy/await still use real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-04T12:00:00Z'));
    try {
      // A still-open (sent, actionable) estimate so the Accept CTA renders.
      renderAccepted(acceptedView({ status: 'sent', isActionable: true }));
      const acceptBtn = await screen.findByRole('button', { name: /accept this/i });
      acceptBtn.click();
      // The signing sheet stamps today (frozen), not the old "March 10, 2026".
      expect(await screen.findByText('Jul 4, 2026')).toBeInTheDocument();
      expect(screen.queryAllByText(/March 10, 2026/)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
