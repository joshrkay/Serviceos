import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RevenueBySourcePage } from './RevenueBySourcePage';

// useApiClient returns a fetch-shaped function; mock the module.
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

/** A never-resolving fetch so the loading state stays visible. */
function pendingResponse() {
  return new Promise<Response>(() => {});
}

// Endpoint returns { data: rows }.
const rows = [
  {
    source: 'web_form',
    utmSource: 'google',
    utmMedium: 'cpc',
    utmCampaign: 'spring',
    leadCount: 4,
    customerCount: 2,
    invoicedCents: 200000,
    paidCents: 150000,
  },
];

beforeEach(() => {
  mockFetch.mockReset();
});

describe('RevenueBySourcePage', () => {
  it('shows the loading spinner while the request is in flight', () => {
    mockFetch.mockReturnValue(pendingResponse());
    render(<RevenueBySourcePage />);
    expect(screen.getByLabelText('Loading revenue report')).toBeInTheDocument();
  });

  it('shows the empty state when no rows are returned', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    render(<RevenueBySourcePage />);
    expect(
      await screen.findByText('No attributed revenue in this period.'),
    ).toBeInTheDocument();
  });

  it('shows the error state with a retry affordance when the request fails', async () => {
    mockFetch.mockRejectedValue(new Error('boom'));
    render(<RevenueBySourcePage />);
    expect(
      await screen.findByText("Couldn't load the revenue report."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders a revenue row using the source label and formatted paid total', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: rows }));
    render(<RevenueBySourcePage />);
    // SOURCE_LABEL['web_form'] === 'Web form'
    expect(await screen.findByText('Web form')).toBeInTheDocument();
    // formatCents(150000) === '$1,500' (maximumFractionDigits: 0)
    expect(screen.getAllByText('$1,500').length).toBeGreaterThan(0);
    expect(screen.queryByText('No attributed revenue in this period.')).toBeNull();
  });

  it('queries the revenue-by-source endpoint on mount', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    render(<RevenueBySourcePage />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      '/api/reports/revenue-by-source',
    );
  });
});
