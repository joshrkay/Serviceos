import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WelcomeWalkthrough, WELCOME_SEEN_KEY } from './WelcomeWalkthrough';

vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

const mockStatus = vi.fn();
vi.mock('../../hooks/useOnboardingStatus', () => ({
  useOnboardingStatus: () => mockStatus(),
}));

describe('WelcomeWalkthrough', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('shows for a newly-onboarded account that has not seen it', () => {
    mockStatus.mockReturnValue({ data: { isComplete: true }, isLoading: false });
    render(<WelcomeWalkthrough />);
    expect(screen.getByText('Rivet answers your phone')).toBeInTheDocument();
  });

  it('does not show while onboarding is incomplete', () => {
    mockStatus.mockReturnValue({ data: { isComplete: false }, isLoading: false });
    render(<WelcomeWalkthrough />);
    expect(screen.queryByText('Rivet answers your phone')).not.toBeInTheDocument();
  });

  it('does not show once the seen flag is set', () => {
    window.localStorage.setItem(WELCOME_SEEN_KEY, new Date().toISOString());
    mockStatus.mockReturnValue({ data: { isComplete: true }, isLoading: false });
    render(<WelcomeWalkthrough />);
    expect(screen.queryByText('Rivet answers your phone')).not.toBeInTheDocument();
  });

  it('persists the seen flag and hides after dismissal', () => {
    mockStatus.mockReturnValue({ data: { isComplete: true }, isLoading: false });
    render(<WelcomeWalkthrough />);
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(window.localStorage.getItem(WELCOME_SEEN_KEY)).not.toBeNull();
    expect(screen.queryByText('Rivet answers your phone')).not.toBeInTheDocument();
  });
});
