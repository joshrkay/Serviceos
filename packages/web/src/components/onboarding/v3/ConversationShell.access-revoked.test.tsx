/**
 * A deactivated teammate who lands on /onboarding (the route guard sends an
 * ACCESS_REVOKED user here) must be told why, with a way out, not shown the
 * generic connection error and a retry that can never succeed. Same seam as
 * the v2 shell's test: the real useOnboardingStatus hook, the API mocked at
 * useApiClient.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signOut = vi.fn();
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ userId: 'user-1', isLoaded: true, isSignedIn: true, getToken: () => Promise.resolve(null), signOut }),
  useUser: () => ({ user: { firstName: 'Jenna' } }),
}));
const apiFetch = vi.fn();
vi.mock('../../../lib/apiClient', () => ({ useApiClient: () => apiFetch }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn(), trackFunnel: vi.fn() }));
vi.mock('../v2/OnboardingShell', () => ({ OnboardingShell: () => <div>v2 shell</div> }));

import { ConversationShell } from './ConversationShell';
import { _resetOnboardingStatusCacheForTests } from '../../../hooks/useOnboardingStatus';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <Routes>
        <Route path="/onboarding" element={<ConversationShell />} />
        <Route path="/" element={<div>home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ConversationShell: removed teammate', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    signOut.mockReset();
    _resetOnboardingStatusCacheForTests();
  });

  it('tells a deactivated user their access was removed and offers sign-out, not a retry', async () => {
    apiFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: 'FORBIDDEN', code: 'ACCESS_REVOKED', message: 'User access has been revoked' }, 403)),
    );
    renderShell();
    expect(await screen.findByRole('heading', { level: 1, name: 'Your access was removed.' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/deactivated your account/);
    // A setup countdown means nothing to someone locked out of setup.
    expect(document.querySelector('header')).not.toHaveTextContent(/minute/);
    expect(screen.queryByText(/couldn.t load your setup/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledWith({ redirectUrl: '/login' });
  });

  it('a plain load failure still shows the generic retry state', async () => {
    apiFetch.mockImplementation(() => Promise.resolve(jsonResponse({ error: 'INTERNAL' }, 500)));
    renderShell();
    expect(await screen.findByText(/couldn.t load your setup/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
