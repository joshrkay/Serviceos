/**
 * #1282 — the stepper let "Verify AI" open before a plan existed, and the
 * step's pending branch said "Running the check…" and polled forever: the
 * verify worker only runs once billing is done, so nothing would ever come.
 * A not-yet-reachable Verify AI step must fail fast and point at the step
 * that is actually blocking it.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OnboardingStatusResponse } from '../../../../types/onboarding';

const apiFetchMock = vi.fn();
vi.mock('../../../../lib/apiClient', () => ({ useApiClient: () => apiFetchMock }));
vi.mock('../VoiceConfigPanel', () => ({ VoiceConfigPanel: () => null }));
vi.mock('../VoiceApprovalPinPanel', () => ({ VoiceApprovalPinPanel: () => null }));

import { AiCheckStep } from './AiCheckStep';

function status(overrides: Partial<Record<string, string>>, currentStep: OnboardingStatusResponse['currentStep']): OnboardingStatusResponse {
  const ids = ['signup', 'identity', 'pack', 'phone', 'billing', 'ai_check', 'test_call'] as const;
  return {
    steps: ids.map((id) => ({ id, status: (overrides[id] ?? 'done') as never })),
    currentStep,
    isComplete: false,
    voiceAgentLive: false,
    tenantId: 't-1',
    subscriptionStatus: null,
  };
}

describe('AiCheckStep (#1282)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('before a plan exists it does not claim to be running — it points at Start trial', () => {
    const onGoToStep = vi.fn();
    render(
      <AiCheckStep
        status={status({ billing: 'current', ai_check: 'pending', test_call: 'pending' }, 'billing')}
        onGoToStep={onGoToStep}
      />,
    );
    expect(screen.queryByText(/running the check/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /start trial/i }));
    expect(onGoToStep).toHaveBeenCalledWith('billing');
  });

  it('once it is the current step it shows the running state as before', () => {
    render(
      <AiCheckStep
        status={status({ ai_check: 'current', test_call: 'pending' }, 'ai_check')}
        onGoToStep={vi.fn()}
      />,
    );
    expect(screen.getByText(/running the check/i)).toBeTruthy();
  });
});

describe('AiCheckStep skip escape hatch', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('pending state (no plan yet) offers no skip — #1282 fail-fast is preserved', () => {
    render(
      <AiCheckStep
        status={status({ billing: 'current', ai_check: 'pending', test_call: 'pending' }, 'billing')}
        onGoToStep={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /skip for now/i })).toBeNull();
  });

  it('error state: "Skip for now" posts to the skip endpoint and refreshes', async () => {
    apiFetchMock.mockResolvedValue({ ok: true });
    const onRetryComplete = vi.fn();
    render(
      <AiCheckStep
        status={status({ ai_check: 'error', test_call: 'pending' }, 'ai_check')}
        onRetryComplete={onRetryComplete}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/api/onboarding/ai-check/skip', { method: 'POST' }),
    );
    await waitFor(() => expect(onRetryComplete).toHaveBeenCalled());
  });

  it('verifying state: "Skip for now" is offered (a hung worker never resolves)', () => {
    render(
      <AiCheckStep
        status={status({ ai_check: 'current', test_call: 'pending' }, 'ai_check')}
        onGoToStep={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /skip for now/i })).toBeTruthy();
  });

  it('error state: a failed skip surfaces the error instead of refreshing', async () => {
    apiFetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const onRetryComplete = vi.fn();
    render(
      <AiCheckStep
        status={status({ ai_check: 'error', test_call: 'pending' }, 'ai_check')}
        onRetryComplete={onRetryComplete}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    await waitFor(() => expect(screen.getByText(/skip failed/i)).toBeTruthy());
    expect(onRetryComplete).not.toHaveBeenCalled();
  });

  it('skipped state: revisiting shows the skipped copy with a retry — never the running spinner', async () => {
    apiFetchMock.mockResolvedValue({ ok: true });
    const onRetryComplete = vi.fn();
    render(
      <AiCheckStep
        status={status({ ai_check: 'skipped', test_call: 'done' }, 'ai_check')}
        onRetryComplete={onRetryComplete}
      />,
    );
    expect(screen.getByText(/ai check skipped/i)).toBeTruthy();
    expect(screen.queryByText(/running the check/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /retry verification/i }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/api/onboarding/ai-check/retry', { method: 'POST' }),
    );
    await waitFor(() => expect(onRetryComplete).toHaveBeenCalled());
  });
});
