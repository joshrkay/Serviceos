/**
 * #1490 item 6 — a deactivated, still signed-in user opening `/` got a burst
 * of 403 ACCESS_REVOKED and then /login with no explanation; only /onboarding
 * said "Your access was removed". The app root must reach that screen too.
 *
 * Seam: ProtectedRoute with the real useOnboardingStatus hook, API mocked at
 * useApiClient (same seam as OnboardingShell.access-revoked.test.tsx).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ userId: 'user-1', isLoaded: true, isSignedIn: true, getToken: async () => null }),
}));

const apiFetch = vi.fn();
vi.mock('../../lib/apiClient', () => ({ useApiClient: () => apiFetch }));

import { ProtectedRoute } from './ProtectedRoute';
import { _resetOnboardingStatusCacheForTests } from '../../hooks/useOnboardingStatus';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>LOGIN PAGE</div>} />
        <Route element={<ProtectedRoute />}>
          <Route path="/onboarding" element={<div>REVOKED SCREEN</div>} />
          <Route path="/" element={<div>HOME</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute — removed user at the app root (#1490)', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    _resetOnboardingStatusCacheForTests();
  });

  it('sends a deactivated user from / to the screen that explains it, not to /login', async () => {
    apiFetch.mockImplementation(async () =>
      jsonResponse({ error: 'FORBIDDEN', code: 'ACCESS_REVOKED', message: 'User access has been revoked' }, 403),
    );

    renderAt('/');

    expect(await screen.findByText('REVOKED SCREEN')).toBeInTheDocument();
    expect(screen.queryByText('HOME')).not.toBeInTheDocument();
    expect(screen.queryByText('LOGIN PAGE')).not.toBeInTheDocument();
  });
});
