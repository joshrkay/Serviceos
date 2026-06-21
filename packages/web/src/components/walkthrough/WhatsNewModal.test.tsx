import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhatsNewModal, WHATS_NEW_SEEN_KEY } from './WhatsNewModal';
import { latestReleaseId } from './whatsNew';

vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

describe('WhatsNewModal', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('shows the changelog to a user with an unseen release (empty cursor)', () => {
    // Established user on first deploy: no cursor yet → the changelog shows.
    // (New accounts are suppressed upstream by WelcomeWalkthrough seeding the
    // cursor; this component no longer couples to the welcome flag.)
    render(<WhatsNewModal />);
    expect(screen.getByText(/what’s new in rivet/i)).toBeInTheDocument();
  });

  it('records the latest release id on dismissal so it does not show again', () => {
    render(<WhatsNewModal />);
    fireEvent.click(screen.getByRole('button', { name: /got it/i }));
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBe(latestReleaseId());
    expect(screen.queryByText(/what’s new in rivet/i)).not.toBeInTheDocument();
  });

  it('stays hidden when the cursor already points at the latest release', () => {
    window.localStorage.setItem(WHATS_NEW_SEEN_KEY, latestReleaseId()!);
    render(<WhatsNewModal />);
    expect(screen.queryByText(/what’s new in rivet/i)).not.toBeInTheDocument();
  });

  it('stays hidden when the cursor was seeded (new account, day one)', () => {
    // Simulates WelcomeWalkthrough having seeded the cursor for a new account.
    window.localStorage.setItem(WHATS_NEW_SEEN_KEY, latestReleaseId()!);
    render(<WhatsNewModal />);
    expect(screen.queryByText(/what’s new in rivet/i)).not.toBeInTheDocument();
  });
});
