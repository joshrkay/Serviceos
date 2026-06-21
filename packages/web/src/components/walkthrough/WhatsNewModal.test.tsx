import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhatsNewModal, WHATS_NEW_SEEN_KEY } from './WhatsNewModal';
import { WELCOME_SEEN_KEY } from './WelcomeWalkthrough';
import { latestReleaseId } from './whatsNew';

vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

describe('WhatsNewModal', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('shows the changelog to an existing user with an unseen release', () => {
    // Existing user: welcome tour already seen, but no changelog cursor yet.
    window.localStorage.setItem(WELCOME_SEEN_KEY, new Date().toISOString());
    render(<WhatsNewModal />);
    expect(screen.getByText(/what’s new in rivet/i)).toBeInTheDocument();
  });

  it('records the latest release id on dismissal so it does not show again', () => {
    window.localStorage.setItem(WELCOME_SEEN_KEY, new Date().toISOString());
    render(<WhatsNewModal />);
    fireEvent.click(screen.getByRole('button', { name: /got it/i }));
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBe(latestReleaseId());
    expect(screen.queryByText(/what’s new in rivet/i)).not.toBeInTheDocument();
  });

  it('stays hidden when the user is already up to date', () => {
    window.localStorage.setItem(WELCOME_SEEN_KEY, new Date().toISOString());
    window.localStorage.setItem(WHATS_NEW_SEEN_KEY, latestReleaseId()!);
    render(<WhatsNewModal />);
    expect(screen.queryByText(/what’s new in rivet/i)).not.toBeInTheDocument();
  });

  it('suppresses the changelog for a brand-new account (initializes the cursor)', () => {
    // No welcome flag + no cursor → brand-new account: only the tour shows.
    render(<WhatsNewModal />);
    expect(screen.queryByText(/what’s new in rivet/i)).not.toBeInTheDocument();
    // Cursor initialized so the changelog won't pop the moment the tour ends.
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBe(latestReleaseId());
  });
});
