/**
 * #875 — "Re-run setup assistant" must actually re-run onboarding.
 *
 * The shell's completion gate (`isComplete && !override` → navigate('/'))
 * redirected every completed tenant home before the sidebar could ever
 * set an override, so both re-run entry points silently bounced. An
 * explicit re-run deep-links /onboarding?rerun=1, which pre-seeds the
 * step override at mount and passes the gate; a plain /onboarding visit
 * by a completed tenant still bounces.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OnboardingStatusResponse } from '../../../types/onboarding';

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ userId: 'user-1', isLoaded: true, isSignedIn: true, getToken: async () => null }),
}));

const onboardingState: { data: OnboardingStatusResponse | null; isLoading: boolean } = {
  data: null,
  isLoading: false,
};

vi.mock('../../../hooks/useOnboardingStatus', () => ({
  useOnboardingStatus: () => ({
    data: onboardingState.data,
    isLoading: onboardingState.isLoading,
    error: null,
    refetch: async () => undefined,
  }),
}));

vi.mock('../../../lib/apiClient', () => ({ useApiClient: () => vi.fn() }));
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

const STEP_IDS = ['signup', 'identity', 'pack', 'phone', 'billing', 'ai_check', 'test_call'] as const;

function completedStatus(): OnboardingStatusResponse {
  return {
    steps: STEP_IDS.map((id) => ({ id, status: 'done' })),
    currentStep: null,
    isComplete: true,
    voiceAgentLive: true,
    tenantId: 'tenant-1',
    subscriptionStatus: 'active',
  } as unknown as OnboardingStatusResponse;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div data-testid="home" />} />
        <Route path="/onboarding" element={<OnboardingShell />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OnboardingShell re-run gate (#875)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    onboardingState.data = completedStatus();
    onboardingState.isLoading = false;
  });

  it('a completed tenant on plain /onboarding still bounces home', async () => {
    renderAt('/onboarding');
    await waitFor(() => expect(screen.getByTestId('home')).toBeInTheDocument());
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument();
  });

  it('?rerun=1 mounts the shell for a completed tenant instead of bouncing', async () => {
    renderAt('/onboarding?rerun=1');
    await waitFor(() => expect(screen.getByTestId('sidebar')).toBeInTheDocument());
    expect(screen.queryByTestId('home')).not.toBeInTheDocument();
  });

  it('the re-run lands on the identity step (first reviewable step)', async () => {
    renderAt('/onboarding?rerun=1');
    await waitFor(() => expect(screen.getByTestId('identity-step')).toBeInTheDocument());
  });

  it('an incomplete tenant with ?rerun=1 also gets the shell (no crash, no bounce)', async () => {
    onboardingState.data = {
      ...completedStatus(),
      isComplete: false,
      currentStep: 'phone',
    } as unknown as OnboardingStatusResponse;
    renderAt('/onboarding?rerun=1');
    await waitFor(() => expect(screen.getByTestId('identity-step')).toBeInTheDocument());
    expect(screen.queryByTestId('home')).not.toBeInTheDocument();
  });
});
