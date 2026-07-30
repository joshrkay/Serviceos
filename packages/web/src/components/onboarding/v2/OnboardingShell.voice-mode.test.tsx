/**
 * B1.19 — voiceMode persistence across a tenant switch that does NOT remount
 * the shell.
 *
 * Same family as P-9: state that hydrates once at mount and then goes stale
 * when the tenant changes underneath it. `voiceModeHydrated` was a bare
 * boolean ref, so after a switch the new tenant's persisted mode was never
 * read — and the persistence effect (which re-runs on the key change) wrote
 * the PREVIOUS tenant's voiceMode into the new tenant's key, either forcing
 * the conversation open for a tenant that never chose it or erasing that
 * tenant's saved in-progress mode.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
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

// The steps do their own fetching and are irrelevant here — stub them down to
// markers so the assertions are about which pane the shell chose to render.
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

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const modeKey = (tenantId: string) => `serviceos.onboarding_conversation_mode.${tenantId}`;

const STEP_IDS = ['signup', 'identity', 'pack', 'phone', 'billing', 'ai_check', 'test_call'] as const;

function statusFor(tenantId: string): OnboardingStatusResponse {
  return {
    steps: STEP_IDS.map((id) => ({ id, status: id === 'identity' ? 'current' : 'pending' })),
    currentStep: 'identity',
    isComplete: false,
    voiceAgentLive: false,
    tenantId,
    subscriptionStatus: null,
  } as unknown as OnboardingStatusResponse;
}

function renderShell() {
  return render(
    <MemoryRouter>
      <OnboardingShell />
    </MemoryRouter>,
  );
}

describe('OnboardingShell — voiceMode hydration is keyed by tenant (B1.19)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    onboardingState.data = null;
    onboardingState.isLoading = false;
  });

  it('reads the NEW tenant’s persisted mode after a switch without remounting', async () => {
    // A never opened the conversation; B has one in progress.
    window.localStorage.setItem(modeKey(TENANT_B), '1');

    onboardingState.data = statusFor(TENANT_A);
    const { rerender } = renderShell();

    await waitFor(() => expect(screen.getByTestId('identity-step')).toBeInTheDocument());
    expect(screen.queryByTestId('conversation-step')).not.toBeInTheDocument();

    onboardingState.data = statusFor(TENANT_B);
    rerender(
      <MemoryRouter>
        <OnboardingShell />
      </MemoryRouter>,
    );

    // B's saved in-progress conversation is picked up…
    await waitFor(() => expect(screen.getByTestId('conversation-step')).toBeInTheDocument());
    expect(screen.queryByTestId('identity-step')).not.toBeInTheDocument();
    // …and was not erased by A's `false` being persisted over it.
    expect(window.localStorage.getItem(modeKey(TENANT_B))).toBe('1');
  });

  it('never writes tenant A’s mode into tenant B’s key', async () => {
    // A has the conversation open; B has nothing saved at all.
    window.localStorage.setItem(modeKey(TENANT_A), '1');

    onboardingState.data = statusFor(TENANT_A);
    const { rerender } = renderShell();

    await waitFor(() => expect(screen.getByTestId('conversation-step')).toBeInTheDocument());

    onboardingState.data = statusFor(TENANT_B);
    rerender(
      <MemoryRouter>
        <OnboardingShell />
      </MemoryRouter>,
    );

    // B never chose the conversation, so it must land on the form…
    await waitFor(() => expect(screen.getByTestId('identity-step')).toBeInTheDocument());
    expect(screen.queryByTestId('conversation-step')).not.toBeInTheDocument();
    // …and A's '1' must never have been written under B's key.
    expect(window.localStorage.getItem(modeKey(TENANT_B))).toBeNull();
    // A's own saved mode is untouched by the switch.
    expect(window.localStorage.getItem(modeKey(TENANT_A))).toBe('1');
  });
});
