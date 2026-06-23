import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PendingProposalsCard } from './PendingProposalsCard';
import type { PendingProposalSummary } from '../../hooks/usePendingProposals';

const mockApiFetch = vi.fn();
const mockNavigate = vi.fn();
const mockRefresh = vi.fn();
let hookState: {
  proposals: PendingProposalSummary[];
  count: number;
  isLoading: boolean;
};

vi.mock('../../lib/apiClient', () => ({ useApiClient: () => mockApiFetch }));
vi.mock('react-router', () => ({ useNavigate: () => mockNavigate }));
vi.mock('../../hooks/usePendingProposals', () => ({
  usePendingProposals: () => ({
    ...hookState,
    error: null,
    refresh: mockRefresh,
  }),
}));

function proposal(over: Partial<PendingProposalSummary>): PendingProposalSummary {
  return {
    id: `p-${Math.random().toString(36).slice(2)}`,
    summary: 'Book Jane Doe for Tue 9am',
    proposalType: 'create_booking',
    createdAt: '2026-06-21T10:00:00.000Z',
    ...over,
  };
}

describe('PendingProposalsCard', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockNavigate.mockReset();
    mockRefresh.mockReset();
    hookState = { proposals: [], count: 0, isLoading: false };
  });

  it('renders nothing when the queue is empty', () => {
    const { container } = render(<PendingProposalsCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists proposal cards with a humanized type and an expiry countdown', () => {
    const inThreeHours = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    hookState = {
      proposals: [proposal({ id: 'a', summary: 'Book Jane', expiresAt: inThreeHours })],
      count: 1,
      isLoading: false,
    };
    render(<PendingProposalsCard />);
    expect(screen.getByTestId('pending-proposals')).toBeInTheDocument();
    expect(screen.getByText('Create booking')).toBeInTheDocument();
    expect(screen.getByText('Book Jane')).toBeInTheDocument();
    expect(screen.getByText(/Expires in 2h/)).toBeInTheDocument();
  });

  it('approves inline, hides the row, and notifies + refreshes', async () => {
    mockApiFetch.mockResolvedValue({ ok: true });
    hookState = { proposals: [proposal({ id: 'a', summary: 'Approve me' })], count: 1, isLoading: false };
    render(<PendingProposalsCard />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith('/api/proposals/a/approve', { method: 'POST' }),
    );
    await waitFor(() => expect(screen.queryByText('Approve me')).not.toBeInTheDocument());
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('surfaces an error and keeps the row when the action fails', async () => {
    mockApiFetch.mockResolvedValue({ ok: false, status: 500 });
    hookState = { proposals: [proposal({ id: 'a', summary: 'Keep me' })], count: 1, isLoading: false };
    render(<PendingProposalsCard />);

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(screen.getByText(/HTTP 500/)).toBeInTheDocument());
    expect(screen.getByText('Keep me')).toBeInTheDocument();
  });

  it('caps the list and links the overflow + header to the inbox', () => {
    hookState = {
      proposals: Array.from({ length: 6 }, (_, i) => proposal({ id: `p${i}`, summary: `S${i}` })),
      count: 6,
      isLoading: false,
    };
    render(<PendingProposalsCard />);
    expect(screen.getAllByTestId('pending-proposal-row')).toHaveLength(4);
    fireEvent.click(screen.getByText(/2 more awaiting decision/));
    expect(mockNavigate).toHaveBeenCalledWith('/inbox');
  });

  it('gives approve/reject 44px tap targets', () => {
    hookState = { proposals: [proposal({ id: 'a' })], count: 1, isLoading: false };
    render(<PendingProposalsCard />);
    for (const name of ['Approve', 'Reject']) {
      expect(screen.getByRole('button', { name }).className).toContain('min-h-11');
    }
  });
});
