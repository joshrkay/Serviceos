/**
 * Mobile layout contract for the End-of-Day Digest web view (RV-062).
 *
 * This page is opened from an SMS link on a phone, so every interactive
 * target must meet the 44px glove rule (min-h-11 per CLAUDE.md) and the
 * page must not overflow horizontally at 320px. jsdom can't measure real
 * overflow, so this pins the CSS class contract; the live overflow check
 * belongs in a Playwright viewport test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { DigestPage } from './DigestPage';
import { TenantTimezoneProvider } from '../../hooks/useTenantTimezone';

vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => mockFetch,
}));

const mockFetch = vi.fn();

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response;
}

const payload = {
  date: '2026-06-10',
  timezone: 'America/New_York',
  revenueCents: 125_00,
  grossRevenueCents: 130_00,
  refundsCents: 0,
  paymentsCount: 3,
  jobsCompletedCount: 2,
  tomorrow: { appointmentCount: 1, firstStartIso: '2026-06-12T13:00:00.000Z' },
  pendingApprovals: {
    totalCount: 1,
    top: [
      {
        proposalId: 'p-1',
        proposalType: 'invoice_send',
        summary: 'Send invoice',
        customerName: 'Bob Lee',
        amountCents: 90_00,
        overallConfidence: 'low',
        reviewInApp: true,
      },
    ],
  },
  overdueInvoicesCount: 4,
  unbilledJobs: [
    { jobId: 'j-1', customerId: 'c-1', customerName: 'Acme Co', amountCents: 200_00 },
  ],
};

function renderPage() {
  return render(
    <TenantTimezoneProvider overrideTimezone="America/New_York">
      <MemoryRouter initialEntries={['/digest/2026-06-10']}>
        <Routes>
          <Route path="/digest/:date" element={<DigestPage />} />
          <Route path="/inbox" element={<div>Inbox</div>} />
        </Routes>
      </MemoryRouter>
    </TenantTimezoneProvider>,
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(
    jsonResponse({
      data: { date: payload.date, payload, narrative: 'Hi.', generatedAt: '2026-06-10T22:00:00.000Z' },
    }),
  );
});

describe('DigestPage — mobile layout contract', () => {
  it('date-nav links meet the 44px glove target (min-h-11)', async () => {
    renderPage();
    const prev = await screen.findByRole('link', { name: /previous day/i });
    const next = screen.getByRole('link', { name: /next day/i });
    expect(prev.className).toContain('min-h-11');
    expect(next.className).toContain('min-h-11');
  });

  it('the "Review in app" link meets the 44px glove target', async () => {
    renderPage();
    const review = await screen.findByRole('link', { name: /review in app/i });
    expect(review.className).toContain('min-h-11');
  });

  it('long customer/approval text can wrap (min-w-0 + break-words) so it cannot overflow', async () => {
    renderPage();
    const review = await screen.findByRole('link', { name: /review in app/i });
    // The approval row holds a min-w-0 text column so a long label shrinks.
    const row = review.parentElement as HTMLElement;
    const textCol = row.querySelector('.min-w-0') as HTMLElement | null;
    expect(textCol).not.toBeNull();
    expect((textCol as HTMLElement).querySelector('.break-words')).not.toBeNull();
  });
});
