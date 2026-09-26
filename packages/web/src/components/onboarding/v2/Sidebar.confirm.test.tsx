/**
 * #907 — the sidebar's downstream-invalidation warning (re-editing a
 * completed identity/pack step) used to gate navigation behind
 * `window.confirm`; it now uses the shared `ConfirmDialog`. No prior test
 * covered this behavior at all — these are the first characterization
 * tests for it, written directly against the ConfirmDialog-based flow.
 */
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { Sidebar } from './Sidebar';
import type { OnboardingStatusResponse, OnboardingStepId, OnboardingStepStatus } from '../../../types/onboarding';

const STEP_IDS = ['signup', 'identity', 'pack', 'phone', 'billing', 'ai_check', 'test_call'] as const;

function makeStatus(overrides: Partial<Record<OnboardingStepId, OnboardingStepStatus>> = {}): OnboardingStatusResponse {
  return {
    steps: STEP_IDS.map((id) => ({
      id,
      status: overrides[id] ?? (id === 'phone' ? 'current' : 'pending'),
    })),
    currentStep: 'phone',
    isComplete: false,
    voiceAgentLive: false,
    tenantId: 'tenant-1',
    subscriptionStatus: null,
  } as unknown as OnboardingStatusResponse;
}

describe('Sidebar — downstream-invalidation ConfirmDialog (#907)', () => {
  it('clicking a completed, non-active identity step opens the ConfirmDialog instead of navigating immediately', () => {
    const onSelect = vi.fn();
    render(
      <MemoryRouter>
        <Sidebar status={makeStatus({ identity: 'done' })} activeId="phone" onSelect={onSelect} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /business identity/i }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Downstream setup \(phone, billing, AI check\) is not reset/i),
    ).toBeInTheDocument();
  });

  it('confirming the dialog calls onSelect with the staged step', async () => {
    const onSelect = vi.fn();
    render(
      <MemoryRouter>
        <Sidebar status={makeStatus({ identity: 'done' })} activeId="phone" onSelect={onSelect} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /business identity/i }));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

    expect(onSelect).toHaveBeenCalledWith('identity');
  });

  it('cancelling the dialog never calls onSelect', async () => {
    const onSelect = vi.fn();
    render(
      <MemoryRouter>
        <Sidebar status={makeStatus({ pack: 'done' })} activeId="phone" onSelect={onSelect} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /pick your trade/i }));
    expect(
      await screen.findByText(/will not reset the job types and templates/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));

    await waitFor(() =>
      expect(screen.queryByText(/will not reset the job types and templates/i)).not.toBeInTheDocument(),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a step that is not done+identity/pack navigates directly, with no dialog', () => {
    const onSelect = vi.fn();
    render(
      <MemoryRouter>
        <Sidebar status={makeStatus({ billing: 'current' })} activeId="phone" onSelect={onSelect} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /start trial/i }));

    expect(onSelect).toHaveBeenCalledWith('billing');
    expect(screen.queryByTestId('confirm-dialog-confirm')).not.toBeInTheDocument();
  });
});
