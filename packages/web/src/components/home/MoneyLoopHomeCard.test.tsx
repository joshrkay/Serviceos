import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { MoneyLoopHomeCard } from './MoneyLoopHomeCard';

const mockNavigate = vi.fn();

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../hooks/usePendingProposals', () => ({
  usePendingProposals: vi.fn(() => ({
    count: 3,
    proposals: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

const mockApiFetch = vi.fn();

vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => mockApiFetch,
}));

describe('MoneyLoopHomeCard', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          month: '2026-05',
          revenueCents: 125_000,
          outstandingCents: 45_000,
          overdueCents: 10_000,
          revenueTrendCents: 5_000,
        },
      }),
    });
  });

  it('navigates to inbox and money dashboard', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MoneyLoopHomeCard />
      </MemoryRouter>,
    );

    await screen.findByText(/\$1,250 collected/);

    await user.click(screen.getByTestId('home-inbox-card'));
    expect(mockNavigate).toHaveBeenCalledWith('/inbox');

    await user.click(screen.getByTestId('home-money-card'));
    expect(mockNavigate).toHaveBeenCalledWith('/reports/money');
  });

  it('shows inbox waiting count', () => {
    render(
      <MemoryRouter>
        <MoneyLoopHomeCard />
      </MemoryRouter>,
    );
    expect(screen.getByText('3 waiting for your tap')).toBeInTheDocument();
  });
});
