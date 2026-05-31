import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { InteractionsPage } from './InteractionsPage';

// InteractionsPage loads via the api/interactions client, not apiFetch.
vi.mock('../../api/interactions', () => ({
  listInteractions: vi.fn(),
  getInteraction: vi.fn(),
}));

import { listInteractions } from '../../api/interactions';

const mockList = vi.mocked(listInteractions);

beforeEach(() => {
  mockList.mockReset();
});

describe('InteractionsPage', () => {
  it('shows the empty state when there are no interactions', async () => {
    mockList.mockResolvedValue({ data: [], total: 0, limit: 20, offset: 0 });
    render(<InteractionsPage />);
    expect(await screen.findByText('No completed calls yet')).toBeInTheDocument();
  });

  it('shows the error state with a retry affordance when the request fails', async () => {
    mockList.mockRejectedValue(new Error('boom'));
    render(<InteractionsPage />);
    expect(
      await screen.findByText("Couldn't load interactions."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders interaction rows from the API response', async () => {
    mockList.mockResolvedValue({
      data: [
        {
          id: 'i1',
          channel: 'voice_inbound',
          outcome: 'completed',
          callSid: null,
          startedAt: '2026-05-01T10:00:00Z',
          endedAt: '2026-05-01T10:02:05Z',
          durationSeconds: 125,
          customer: { id: 'c1', displayName: 'Alice Smith', address: null },
          excerpt: 'Customer asked about a quote',
          transcriptTurnCount: 4,
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    });
    render(<InteractionsPage />);
    expect(await screen.findByText('Alice Smith')).toBeInTheDocument();
    expect(screen.queryByText('No completed calls yet')).toBeNull();
  });

  it('queries the interactions list on mount', async () => {
    mockList.mockResolvedValue({ data: [], total: 0, limit: 20, offset: 0 });
    render(<InteractionsPage />);
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: expect.any(Number), offset: 0 }),
    );
  });
});
