import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RoleHome } from './RoleHome';

const useMeMock = vi.fn();

vi.mock('../../hooks/useMe', () => ({
  useMe: () => useMeMock(),
}));

// Render the destinations as cheap stand-ins so the test asserts routing,
// not the (heavy) real pages.
vi.mock('./HomePage', () => ({
  HomePage: () => <div data-testid="home-page" />,
}));
vi.mock('react-router', () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
}));
vi.mock('../ui', () => ({
  Spinner: () => <div data-testid="spinner" />,
}));

describe('RoleHome', () => {
  beforeEach(() => useMeMock.mockReset());

  it('shows a spinner while identity is loading', () => {
    useMeMock.mockReturnValue({ me: null, isLoading: true });
    render(<RoleHome />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('home-page')).not.toBeInTheDocument();
  });

  it('redirects technicians to the TechJobView', () => {
    useMeMock.mockReturnValue({ me: { role: 'technician' }, isLoading: false });
    render(<RoleHome />);
    expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/technician/day');
    expect(screen.queryByTestId('home-page')).not.toBeInTheDocument();
  });

  it('lands owners on the HomePage', () => {
    useMeMock.mockReturnValue({ me: { role: 'owner' }, isLoading: false });
    render(<RoleHome />);
    expect(screen.getByTestId('home-page')).toBeInTheDocument();
    expect(screen.queryByTestId('navigate')).not.toBeInTheDocument();
  });

  it('lands dispatchers on the HomePage', () => {
    useMeMock.mockReturnValue({ me: { role: 'dispatcher' }, isLoading: false });
    render(<RoleHome />);
    expect(screen.getByTestId('home-page')).toBeInTheDocument();
  });

  it('falls back to HomePage when identity lookup failed', () => {
    useMeMock.mockReturnValue({ me: null, isLoading: false, error: new Error('boom') });
    render(<RoleHome />);
    expect(screen.getByTestId('home-page')).toBeInTheDocument();
    expect(screen.queryByTestId('navigate')).not.toBeInTheDocument();
  });
});
