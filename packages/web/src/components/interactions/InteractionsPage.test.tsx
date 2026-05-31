import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { InteractionsPage } from './InteractionsPage';

// InteractionsPage calls the non-hook apiFetch helper directly.
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

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('InteractionsPage', () => {
  it('shows the empty state when there are no interactions', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ interactions: [], total: 0 }));
    render(<InteractionsPage />);
    expect(await screen.findByText('No completed calls yet')).toBeInTheDocument();
  });

  it('shows the error state with a retry affordance when the request fails', async () => {
    mockApiFetch.mockRejectedValue(new Error('boom'));
    render(<InteractionsPage />);
    expect(
      await screen.findByText("Couldn't load interactions."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders interaction rows from the API response', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        interactions: [
          {
            id: 'i1',
            type: 'call',
            direction: 'inbound',
            status: 'completed',
            durationSeconds: 125,
            startedAt: '2026-05-01T10:00:00Z',
            hasTranscript: true,
          },
        ],
        total: 1,
      }),
    );
    render(<InteractionsPage />);
    // 125s → "2:05"; "Incoming" label for an inbound call.
    expect(await screen.findByText(/Incoming/)).toBeInTheDocument();
    expect(screen.getByText(/2:05/)).toBeInTheDocument();
    expect(screen.queryByText('No completed calls yet')).toBeNull();
  });

  it('fetches the interactions endpoint on mount', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ interactions: [], total: 0 }));
    render(<InteractionsPage />);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(String(mockApiFetch.mock.calls[0][0])).toContain('/api/interactions');
  });
});
