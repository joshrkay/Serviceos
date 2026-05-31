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

  it('shows the empty state when no messages are returned', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ interactions: [] }));
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

  it('renders message rows for sms/email interactions', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        interactions: [
          {
            id: 'm1',
            channel: 'email',
            toAddress: 'alice@example.com',
            subject: 'Your estimate',
            status: 'sent',
            createdAt: '2026-05-01T10:00:00Z',
          },
          {
            id: 'm2',
            channel: 'sms',
            toAddress: '+15125550100',
            status: 'delivered',
            createdAt: '2026-05-01T11:00:00Z',
          },
        ],
      }),
    );
    render(<DispatchLogPage />);
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('+15125550100')).toBeInTheDocument();
    // Non-message interactions (e.g. voice calls) are filtered out.
    expect(screen.queryByText('No outbound messages yet')).toBeNull();
  });

  it('filters out non-message (voice) interactions', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        interactions: [
          { id: 'v1', channel: 'voice', toNumber: '+15125550101', status: 'completed' },
        ],
      }),
    );
    render(<DispatchLogPage />);
    expect(await screen.findByText('No outbound messages yet')).toBeInTheDocument();
  });

  it('fetches the interactions endpoint on mount', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ interactions: [] }));
    render(<DispatchLogPage />);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(String(mockApiFetch.mock.calls[0][0])).toContain('/api/interactions');
  });
});
