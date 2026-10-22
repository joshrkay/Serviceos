import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { DispatchLogPage } from './DispatchLogPage';
import { expectAllTapTargets } from '../../test-utils/tap-target';

// DispatchLogPage calls the non-hook apiFetch helper directly.
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../utils/api-fetch';

const mockApiFetch = vi.mocked(apiFetch);

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

function renderAt(url = '/interactions/dispatch') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <DispatchLogPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('DispatchLogPage', () => {
  it('shows the loading spinner while the request is in flight', () => {
    mockApiFetch.mockReturnValue(pendingResponse());
    renderAt();
    expect(screen.getByLabelText('Loading dispatch log')).toBeInTheDocument();
  });

  it('shows the empty state when no dispatches are returned', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ dispatches: [], total: 0 }));
    renderAt();
    expect(await screen.findByText('No outbound messages yet')).toBeInTheDocument();
  });

  it('shows the error state when the request fails', async () => {
    mockApiFetch.mockRejectedValue(new Error('boom'));
    renderAt();
    expect(
      await screen.findByText("Couldn't load the dispatch log."),
    ).toBeInTheDocument();
  });

  it('renders dispatch rows from the API response', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        dispatches: [
          {
            id: 'd1',
            entityType: 'estimate',
            entityId: 'e1',
            channel: 'email',
            recipient: 'alice@example.com',
            provider: 'sendgrid',
            status: 'delivered',
            sentAt: '2026-05-01T10:00:00Z',
          },
        ],
        total: 1,
      }),
    );
    renderAt();
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    expect(screen.queryByText('No outbound messages yet')).toBeNull();
  });

  it('fetches the dispatch-log endpoint on mount', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ dispatches: [], total: 0 }));
    renderAt();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    // U6 (E8): reads the dedicated dispatch log, not the voice-sessions list,
    // so `data.dispatches` is populated rather than always-empty.
    expect(String(mockApiFetch.mock.calls[0][0])).toContain('/api/interactions/dispatches');
  });
});

describe('DispatchLogPage — D-045 filters', () => {
  const blocked = {
    id: 'd2', entityType: 'thank_you', entityId: 'job-1', channel: 'sms', recipient: '',
    provider: 'unknown', status: 'blocked', blockReason: 'revoked', sentAt: '2026-10-21T18:00:00Z',
    jobId: 'job-1', customerId: 'cust-1',
  };

  it('passes the status, job and customer filters from the URL to the API', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ dispatches: [], total: 0 }));
    renderAt('/interactions/dispatch?status=blocked&jobId=job-1');
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    const url = String(mockApiFetch.mock.calls[0][0]);
    expect(url).toContain('status=blocked');
    expect(url).toContain('jobId=job-1');
    expect(screen.getByTestId('dispatch-log-scope')).toHaveTextContent('Showing messages for this job.');
    expect(await screen.findByText('Every text went out')).toBeInTheDocument();
  });

  it('shows why a text was not sent and links to its job and customer', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ dispatches: [blocked], total: 1 }));
    renderAt('/interactions/dispatch?status=blocked');
    expect(await screen.findByText('Text not sent: the customer opted out of texts')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open job' }).getAttribute('href')).toBe('/jobs/job-1');
    expect(screen.getByRole('link', { name: 'Open customer' }).getAttribute('href')).toBe('/customers/cust-1');
    // A recorded block has no provider; "unknown" is not shown as one.
    expect(screen.queryByText(/unknown/)).toBeNull();
  });

  it('switching to "Not sent" refetches blocked texts only', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ dispatches: [], total: 0 }));
    renderAt();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    expect(String(mockApiFetch.mock.calls[0][0])).not.toContain('status=');
    screen.getByRole('button', { name: 'Not sent' }).click();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    expect(String(mockApiFetch.mock.calls[1][0])).toContain('status=blocked');
    expect(screen.getByRole('button', { name: 'Not sent' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('every control meets the 44px tap-target contract', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ dispatches: [blocked], total: 1 }));
    const { container } = renderAt('/interactions/dispatch?customerId=cust-1');
    await screen.findByText('Open job');
    expectAllTapTargets(container, 'dispatch log');
  });
});
