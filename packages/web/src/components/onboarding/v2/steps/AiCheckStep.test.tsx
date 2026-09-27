/**
 * #1282 — the stepper let "Verify AI" open before a plan existed, and the
 * step's pending branch said "Running the check…" and polled forever: the
 * verify worker only runs once billing is done, so nothing would ever come.
 * A not-yet-reachable Verify AI step must fail fast and point at the step
 * that is actually blocking it.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { OnboardingStatusResponse } from '../../../../types/onboarding';

vi.mock('../../../../lib/apiClient', () => ({ useApiClient: () => vi.fn() }));
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
