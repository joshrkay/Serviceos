/**
 * #1481 item 6 — a deactivated teammate who lands on /onboarding saw the
 * generic "We couldn't load your setup / check your connection" state. The
 * API answers 403 { code: 'ACCESS_REVOKED' } for a removed user; say so.
 *
 * Seam: OnboardingShell with the real useOnboardingStatus hook, API mocked
 * at useApiClient.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ userId: 'user-1', isLoaded: true, isSignedIn: true, getToken: async () => null, signOut: vi.fn() }),
}));

const apiFetch = vi.fn();
vi.mock('../../../lib/apiClient', () => ({ useApiClient: () => apiFetch }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn(), trackFunnel: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

vi.mock('./Sidebar', () => ({ Sidebar: () => <div data-testid="sidebar" /> }));
vi.mock('./MobileProgress', () => ({ MobileProgress: () => <div data-testid="mobile-progress" /> }));
vi.mock('./steps/ConversationStep', () => ({
  ConversationStep: () => <div data-testid="conversation-step" />,
}));
vi.mock('./steps/IdentityStep', () => ({ IdentityStep: () => <div data-testid="identity-step" /> }));
vi.mock('./steps/PackStep', () => ({ PackStep: () => <div data-testid="pack-step" /> }));
vi.mock('./steps/PhoneStep', () => ({ PhoneStep: () => <div data-testid="phone-step" /> }));
vi.mock('./steps/BillingStep', () => ({ BillingStep: () => <div data-testid="billing-step" /> }));
vi.mock('./steps/AiCheckStep', () => ({ AiCheckStep: () => <div data-testid="ai-check-step" /> }));
vi.mock('./steps/TestCallStep', () => ({ TestCallStep: () => <div data-testid="test-call-step" /> }));

import { OnboardingShell } from './OnboardingShell';
import { _resetOnboardingStatusCacheForTests } from '../../../hooks/useOnboardingStatus';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingShell />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OnboardingShell — removed user (#1481)', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    _resetOnboardingStatusCacheForTests();
  });

  it('tells a deactivated user their access was removed', async () => {
    apiFetch.mockImplementation(async () =>
      jsonResponse(
        { error: 'FORBIDDEN', code: 'ACCESS_REVOKED', message: 'User access has been revoked' },
        403,
      ),
    );
    renderShell();
    expect(await screen.findByText(/your access .* removed/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t load your setup/i)).not.toBeInTheDocument();
  });

  it('a plain load failure still shows the generic retry state', async () => {
    apiFetch.mockImplementation(async () => jsonResponse({ error: 'INTERNAL' }, 500));
    renderShell();
    expect(await screen.findByText(/couldn.t load your setup/i)).toBeInTheDocument();
  });
});
