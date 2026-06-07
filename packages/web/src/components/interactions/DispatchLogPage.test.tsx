import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DispatchLogPage } from './DispatchLogPage';

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

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('DispatchLogPage', () => {
  it('shows the loading spinner while the request is in flight', () => {
    mockApiFetch.mockReturnValue(pendingResponse());
    render(<DispatchLogPage />);
    expect(screen.getByLabelText('Loading dispatch log')).toBeInTheDocument();
  });

  it('shows the empty state when no dispatches are returned', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ dispatches: [], total: 0 }));
    render(<DispatchLogPage />);
    expect(await screen.findByText('No outbound messages yet')).toBeInTheDocument();
  });

  it('shows the error state when the request fails', async () => {
    mockApiFetch.mockRejectedValue(new Error('boom'));
    render(<DispatchLogPage />);
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
    render(<DispatchLogPage />);
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    expect(screen.queryByText('No outbound messages yet')).toBeNull();
  });

  it('fetches the interactions endpoint on mount', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ dispatches: [], total: 0 }));
    render(<DispatchLogPage />);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(String(mockApiFetch.mock.calls[0][0])).toContain('/api/interactions');
  });
});
