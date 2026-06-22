import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WelcomeWalkthrough, WELCOME_SEEN_KEY } from './WelcomeWalkthrough';
import { WHATS_NEW_SEEN_KEY, latestReleaseId } from './whatsNew';

vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

const mockStatus = vi.fn();
vi.mock('../../hooks/useOnboardingStatus', () => ({
  useOnboardingStatus: () => mockStatus(),
}));

const RECENT = new Date().toISOString(); // brand-new account
const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // established

function status(over: Record<string, unknown>) {
  return { data: { isComplete: true, accountCreatedAt: RECENT, ...over }, isLoading: false };
}

describe('WelcomeWalkthrough', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('shows for a new, newly-onboarded account that has not seen it', () => {
    mockStatus.mockReturnValue(status({}));
    render(<WelcomeWalkthrough />);
    expect(screen.getByText('Rivet answers your phone')).toBeInTheDocument();
  });

  it('does not show while onboarding is incomplete', () => {
    mockStatus.mockReturnValue(status({ isComplete: false }));
    render(<WelcomeWalkthrough />);
    expect(screen.queryByText('Rivet answers your phone')).not.toBeInTheDocument();
  });

  it('does not show for an established (old) account', () => {
    mockStatus.mockReturnValue(status({ accountCreatedAt: OLD }));
    render(<WelcomeWalkthrough />);
    expect(screen.queryByText('Rivet answers your phone')).not.toBeInTheDocument();
  });

  it('does not show once the seen flag is set', () => {
    window.localStorage.setItem(WELCOME_SEEN_KEY, new Date().toISOString());
    mockStatus.mockReturnValue(status({}));
    render(<WelcomeWalkthrough />);
    expect(screen.queryByText('Rivet answers your phone')).not.toBeInTheDocument();
  });

  it('persists the seen flag and hides after dismissal', () => {
    mockStatus.mockReturnValue(status({}));
    render(<WelcomeWalkthrough />);
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(window.localStorage.getItem(WELCOME_SEEN_KEY)).not.toBeNull();
    expect(screen.queryByText('Rivet answers your phone')).not.toBeInTheDocument();
  });

  it('seeds the what’s-new cursor for a new account (suppresses the changelog on day one)', () => {
    mockStatus.mockReturnValue(status({}));
    render(<WelcomeWalkthrough />);
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBe(latestReleaseId());
  });

  it('does NOT seed the cursor for an established account', () => {
    mockStatus.mockReturnValue(status({ accountCreatedAt: OLD }));
    render(<WelcomeWalkthrough />);
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBeNull();
  });
});
