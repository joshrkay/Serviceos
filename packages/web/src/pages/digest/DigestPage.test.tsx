import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { DigestPage } from './DigestPage';
import { TenantTimezoneProvider } from '../../hooks/useTenantTimezone';

// useApiClient returns a fetch-shaped function; mock the module so the page
// drives off our controlled responses.
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => mockFetch,
}));

const mockFetch = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response;
}

function pendingResponse() {
  return new Promise<Response>(() => {});
}

const basePayload = {
  date: '2026-06-10',
  timezone: 'America/New_York',
  revenueCents: 125_00,
  grossRevenueCents: 130_00,
  refundsCents: 5_00,
  paymentsCount: 3,
  jobsCompletedCount: 2,
  tomorrow: { appointmentCount: 1, firstStartIso: '2026-06-12T13:00:00.000Z' },
  pendingApprovals: {
    totalCount: 2,
    top: [
      {
        proposalId: 'p-1',
        proposalType: 'estimate_send',
        summary: 'Send estimate',
        customerName: 'Sarah Johnson',
        amountCents: 45_00,
      },
      {
        proposalId: 'p-2',
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

function digestResponse(payload = basePayload, narrative: string | null = 'A solid day.') {
  return jsonResponse({
    data: {
      date: payload.date,
      payload,
      narrative,
      generatedAt: '2026-06-10T22:00:00.000Z',
    },
  });
}

function renderAt(path: string) {
  return render(
    <TenantTimezoneProvider overrideTimezone="America/New_York">
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/digest" element={<DigestPage />} />
          <Route path="/digest/:date" element={<DigestPage />} />
          <Route path="/inbox" element={<div>Inbox page</div>} />
        </Routes>
      </MemoryRouter>
    </TenantTimezoneProvider>,
  );
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('DigestPage', () => {
  it('shows a spinner while the request is in flight', () => {
    mockFetch.mockReturnValue(pendingResponse());
    renderAt('/digest/2026-06-10');
    expect(screen.getByLabelText('Loading digest')).toBeInTheDocument();
  });

  it('renders all sections from a fixture payload', async () => {
    mockFetch.mockResolvedValue(digestResponse());
    renderAt('/digest/2026-06-10');

    // Narrative
    expect(await screen.findByText('A solid day.')).toBeInTheDocument();
    // Headline money row
    expect(screen.getByText('Revenue today')).toBeInTheDocument();
    expect(screen.getByText('$125.00')).toBeInTheDocument();
    expect(screen.getByText('Payments received')).toBeInTheDocument();
    // Jobs completed + tomorrow
    expect(screen.getByText('Jobs completed')).toBeInTheDocument();
    expect(screen.getByText('Tomorrow')).toBeInTheDocument();
    expect(screen.getByText(/First at/)).toBeInTheDocument();
    // Pending approvals (count in title)
    expect(screen.getByText('Pending approvals (2)')).toBeInTheDocument();
    expect(screen.getByText(/Sarah Johnson/)).toBeInTheDocument();
    // Overdue invoices
    expect(screen.getByText('Overdue invoices')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    // Completed-unbilled
    expect(screen.getByText('Completed, not yet invoiced (1)')).toBeInTheDocument();
    expect(screen.getByText('Acme Co')).toBeInTheDocument();
  });

  it('queries the digest endpoint with the route date', async () => {
    mockFetch.mockResolvedValue(digestResponse());
    renderAt('/digest/2026-06-10');
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(String(mockFetch.mock.calls[0][0])).toBe('/api/digests/2026-06-10');
  });

  it('queries `latest` when no date param is present', async () => {
    mockFetch.mockResolvedValue(digestResponse());
    renderAt('/digest');
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(String(mockFetch.mock.calls[0][0])).toBe('/api/digests/latest');
  });

  it('reviewInApp approvals get a "Review in app" link, not a one-tap approve', async () => {
    mockFetch.mockResolvedValue(digestResponse());
    renderAt('/digest/2026-06-10');
    const reviewLink = await screen.findByRole('link', { name: /review in app/i });
    expect(reviewLink).toHaveAttribute('href', '/inbox');
    // The page must never offer a one-tap approve affordance on this surface.
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('only the low-confidence approval gets the review link (high-confidence does not)', async () => {
    mockFetch.mockResolvedValue(digestResponse());
    renderAt('/digest/2026-06-10');
    await screen.findByText('A solid day.');
    // Two approvals, one reviewInApp → exactly one review link in the list.
    const reviewLinks = screen.getAllByRole('link', { name: /review in app/i });
    expect(reviewLinks).toHaveLength(1);
  });

  it('renders the empty state on 404', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'NOT_FOUND' }, 404));
    renderAt('/digest/2026-06-10');
    expect(await screen.findByText('No digest for this day')).toBeInTheDocument();
  });

  it('renders an error state with retry when the request fails', async () => {
    mockFetch.mockRejectedValue(new Error('boom'));
    renderAt('/digest/2026-06-10');
    expect(await screen.findByText("Couldn't load this digest.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  describe('N-005 reflection sections', () => {
    const enriched = {
      ...basePayload,
      quotesSent: { count: 2, pipelineValueCents: 65_000 },
      unsureAbout: [
        {
          proposalId: 'u-1',
          proposalType: 'draft_estimate',
          summary: 'Estimate for the Diaz job',
          confidence: 'very_low',
          factors: ['ambiguous scope'],
          outcome: 'rejected' as const,
        },
      ],
      learnedToday: [
        { lessonId: 'l-1', lessonType: 'labor_rate_changed', summary: 'labor rate is $145 going forward' },
      ],
    };

    it('renders quotes-sent, "what I wasn\'t sure about", and "what I learned today"', async () => {
      mockFetch.mockResolvedValue(digestResponse(enriched));
      renderAt('/digest/2026-06-10');
      await screen.findByText('A solid day.');

      expect(screen.getByText('Quotes sent')).toBeInTheDocument();
      expect(screen.getByText('Pipeline value')).toBeInTheDocument();
      expect(screen.getByText('$650.00')).toBeInTheDocument();

      expect(screen.getByText("What I wasn't sure about today")).toBeInTheDocument();
      expect(screen.getByText('Estimate for the Diaz job')).toBeInTheDocument();
      expect(screen.getByText('rejected')).toBeInTheDocument();

      expect(screen.getByText('What I learned today')).toBeInTheDocument();
      expect(screen.getByText('labor rate is $145 going forward')).toBeInTheDocument();
    });

    it('omits the reflection sections when absent (empty/pre-N005 payloads)', async () => {
      mockFetch.mockResolvedValue(digestResponse(basePayload));
      renderAt('/digest/2026-06-10');
      await screen.findByText('A solid day.');
      expect(screen.queryByText('Quotes sent')).not.toBeInTheDocument();
      expect(screen.queryByText("What I wasn't sure about today")).not.toBeInTheDocument();
      expect(screen.queryByText('What I learned today')).not.toBeInTheDocument();
    });

    it('the unsure list rows meet the 44px glove target (min-h-11)', async () => {
      mockFetch.mockResolvedValue(digestResponse(enriched));
      renderAt('/digest/2026-06-10');
      const row = (await screen.findByText('Estimate for the Diaz job')).closest('li');
      expect(row?.className).toContain('min-h-11');
    });
  });

  describe('date navigation', () => {
    it('prev/next links target the adjacent calendar days', async () => {
      mockFetch.mockResolvedValue(digestResponse());
      renderAt('/digest/2026-06-10');
      const nav = await screen.findByRole('navigation', { name: /digest date navigation/i });
      const prev = within(nav).getByRole('link', { name: /previous day/i });
      const next = within(nav).getByRole('link', { name: /next day/i });
      expect(prev).toHaveAttribute('href', '/digest/2026-06-09');
      expect(next).toHaveAttribute('href', '/digest/2026-06-11');
    });

    it('disables next when the digest is for today (cannot navigate to the future)', async () => {
      // Use the real tenant-local "today" so `next` is disabled without
      // fake timers (fake timers stall testing-library's findBy polling).
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      const todayPayload = { ...basePayload, date: today };
      mockFetch.mockResolvedValue(digestResponse(todayPayload));
      renderAt(`/digest/${today}`);
      const nav = await screen.findByRole('navigation', { name: /digest date navigation/i });
      // No "Next day" link — it's a disabled span instead.
      expect(within(nav).queryByRole('link', { name: /next day/i })).not.toBeInTheDocument();
      const disabled = within(nav).getByText(/next day/i);
      expect(disabled).toHaveAttribute('aria-disabled', 'true');
      // Previous day still navigates.
      expect(within(nav).getByRole('link', { name: /previous day/i })).toBeInTheDocument();
    });
  });
});
