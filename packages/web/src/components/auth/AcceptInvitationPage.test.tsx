import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcceptInvitationPage } from './AcceptInvitationPage';

const useMeMock = vi.fn();
const useSearchParamsMock = vi.fn();

vi.mock('../../hooks/useMe', () => ({
  useMe: () => useMeMock(),
}));

vi.mock('react-router', () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
  useSearchParams: () => useSearchParamsMock(),
}));

vi.mock('../ui', () => ({
  Spinner: () => <div data-testid="spinner" />,
}));

describe('AcceptInvitationPage (1.11)', () => {
  beforeEach(() => {
    useMeMock.mockReset();
    useSearchParamsMock.mockReset();
    useSearchParamsMock.mockReturnValue([
      new URLSearchParams('invitation_id=inv-123'),
      vi.fn(),
    ]);
  });

  it('shows a loading state while identity is resolving', () => {
    useMeMock.mockReturnValue({ me: null, isLoading: true, error: null });
    render(<AcceptInvitationPage />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('navigate')).not.toBeInTheDocument();
  });

  it('hands off to RoleHome (Navigate to "/") once /api/me resolves', () => {
    useMeMock.mockReturnValue({ me: { role: 'technician' }, isLoading: false, error: null });
    render(<AcceptInvitationPage />);
    expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/');
  });

  it('hands off the same way for a non-technician role (owner/dispatcher)', () => {
    useMeMock.mockReturnValue({ me: { role: 'owner' }, isLoading: false, error: null });
    render(<AcceptInvitationPage />);
    expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/');
  });

  it('shows an error message when /api/me never resolves (expired/invalid link)', () => {
    useMeMock.mockReturnValue({ me: null, isLoading: false, error: new Error('boom') });
    render(<AcceptInvitationPage />);
    expect(screen.queryByTestId('navigate')).not.toBeInTheDocument();
    expect(screen.getByText(/couldn't confirm your invitation/i)).toBeInTheDocument();
  });

  it('names the missing invitation code when the link has no invitation_id', () => {
    useSearchParamsMock.mockReturnValue([new URLSearchParams(''), vi.fn()]);
    useMeMock.mockReturnValue({ me: null, isLoading: false, error: null });
    render(<AcceptInvitationPage />);
    expect(screen.getByText(/missing its invitation code/i)).toBeInTheDocument();
  });
});
