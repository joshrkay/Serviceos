import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MoneyDashboardPage } from './MoneyDashboardPage';

// useApiClient returns a fetch-shaped function; mock the module so the page
// drives off our controlled responses.
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
    blob: async () => new Blob([]),
    headers: new Headers(),
  } as unknown as Response;
}

/** A never-resolving fetch so the loading state stays visible. */
function pendingResponse() {
  return new Promise<Response>(() => {});
}

// Endpoint returns { data: summary }.
const summary = {
  month: '2026-05',
  revenueCents: 150000,
  priorMonthRevenueCents: 100000,
  revenueTrendCents: 50000,
  expensesCents: 30000,
  outstandingCents: 50000,
  overdueCents: 25000,
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('MoneyDashboardPage', () => {
  it('shows the loading spinner while the request is in flight', () => {
    mockFetch.mockReturnValue(pendingResponse());
    render(<MoneyDashboardPage />);
    expect(screen.getByLabelText('Loading money dashboard')).toBeInTheDocument();
  });

  it('renders the summary tiles from the API response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: summary }));
    render(<MoneyDashboardPage />);
    // Local formatCents uses maximumFractionDigits: 0 → no cents shown.
    expect(await screen.findByText('$1,500')).toBeInTheDocument(); // revenue
    expect(screen.getByText('$50,000')).toBeInTheDocument(); // outstanding
    expect(screen.getByText('$25,000')).toBeInTheDocument(); // overdue
  });

  it('shows the error state with a retry affordance when the request fails', async () => {
    mockFetch.mockRejectedValue(new Error('boom'));
    render(<MoneyDashboardPage />);
    expect(
      await screen.findByText("Couldn't load the money dashboard."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('queries the money-dashboard endpoint on mount', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: summary }));
    render(<MoneyDashboardPage />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      '/api/reports/money-dashboard',
    );
  });
});
