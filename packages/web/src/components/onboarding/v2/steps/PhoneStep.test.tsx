import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../../../lib/apiClient', () => ({ useApiClient: () => apiFetchMock }));

import { PhoneStep } from './PhoneStep';
import type { OnboardingStatusResponse } from '../../../../types/onboarding';

const STEP_IDS = ['signup', 'identity', 'pack', 'phone', 'billing', 'ai_check', 'test_call'] as const;

function makeStatus(phone: {
  status: string;
  metadata?: Record<string, unknown>;
  blockers?: string[];
}): OnboardingStatusResponse {
  return {
    steps: STEP_IDS.map((id) =>
      id === 'phone'
        ? {
            id,
            status: phone.status,
            ...(phone.metadata ? { metadata: phone.metadata } : {}),
            ...(phone.blockers ? { blockers: phone.blockers } : {}),
          }
        : { id, status: 'done' },
    ),
    currentStep: 'phone',
    isComplete: false,
    voiceAgentLive: false,
    tenantId: 'tenant-1',
    subscriptionStatus: null,
  } as unknown as OnboardingStatusResponse;
}

describe('PhoneStep — number picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the picker with 44px tap targets while provisioning is in progress', () => {
    render(<PhoneStep status={makeStatus({ status: 'current' })} onAdvance={() => {}} />);

    expect(screen.getByRole('heading', { name: /pick your own number/i })).toBeInTheDocument();

    const areaInput = screen.getByLabelText('Area code');
    expect(areaInput.className).toContain('min-h-11');

    const searchBtn = screen.getByRole('button', { name: /^search$/i });
    expect(searchBtn.className).toContain('min-h-11');
    // Disabled until a full 3-digit area code is entered.
    expect(searchBtn).toBeDisabled();
  });

  it('searches by area code, lists candidates, and claims the selected number', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/onboarding/phone/available') {
        return {
          ok: true,
          json: async () => ({
            numbers: [
              { phoneNumber: '+15125550001', locality: 'Austin', region: 'TX' },
              { phoneNumber: '+15125550002', locality: 'Austin', region: 'TX' },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    const onRetryComplete = vi.fn();
    render(
      <PhoneStep
        status={makeStatus({ status: 'current' })}
        onAdvance={() => {}}
        onRetryComplete={onRetryComplete}
      />,
    );

    fireEvent.change(screen.getByLabelText('Area code'), { target: { value: '512' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    // Candidate rows render after the search resolves.
    await waitFor(() => expect(screen.getByText('(512) 555-0001')).toBeInTheDocument());

    const sendAvailable = apiFetchMock.mock.calls.find((c) => c[0] === '/api/onboarding/phone/available');
    expect(JSON.parse((sendAvailable![1] as RequestInit).body as string)).toEqual({ areaCode: '512' });

    // Each candidate row meets the tap-target contract (queried before
    // selection so the number regex matches only the row, not the claim CTA).
    const row = screen.getByRole('button', { name: /\(512\) 555-0001/ });
    expect(row.className).toContain('min-h-11');

    // Claim is disabled until a number is selected.
    const claimBtn = () => screen.getByRole('button', { name: /select a number|claim/i });
    expect(claimBtn()).toBeDisabled();

    fireEvent.click(row);
    await waitFor(() => expect(claimBtn()).toBeEnabled());

    fireEvent.click(claimBtn());

    await waitFor(() => {
      const claimCall = apiFetchMock.mock.calls.find((c) => c[0] === '/api/onboarding/phone/claim');
      expect(claimCall).toBeTruthy();
      expect(JSON.parse((claimCall![1] as RequestInit).body as string)).toEqual({
        phoneNumber: '+15125550001',
      });
    });
    expect(onRetryComplete).toHaveBeenCalled();
  });

  it('offers the picker as the primary recovery in the error state', () => {
    render(
      <PhoneStep
        status={makeStatus({ status: 'error', blockers: ['twilio_provisioning_failed'] })}
        onAdvance={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { name: /pick your own number/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /let us pick a number for you/i })).toBeInTheDocument();
  });
});
