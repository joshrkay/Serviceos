import { render, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as analytics from '../../../../lib/analytics';
import type { OnboardingStatusResponse, OnboardingStepStatus } from '../../../../types/onboarding';
import { TestCallStep } from './TestCallStep';

vi.mock('../../../../lib/analytics', () => ({
  track: vi.fn(),
  trackFunnel: vi.fn(),
}));

function status(testCall: OnboardingStepStatus): OnboardingStatusResponse {
  return {
    steps: [
      { id: 'signup', status: 'done' },
      { id: 'identity', status: 'done' },
      { id: 'pack', status: 'done' },
      { id: 'phone', status: 'done', metadata: { phoneNumber: '+15125551234' } },
      { id: 'billing', status: 'done' },
      { id: 'ai_check', status: 'done' },
      { id: 'test_call', status: testCall },
    ],
    currentStep: 'test_call',
    isComplete: false,
    voiceAgentLive: false,
    tenantId: 'tenant-123',
    subscriptionStatus: 'trialing',
  };
}

describe('TestCallStep funnel instrumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires test_call_initiated when the user taps the number', () => {
    render(
      <MemoryRouter>
        <TestCallStep status={status('current')} onSkipped={() => {}} onRefresh={() => {}} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('(512) 555-1234'));
    expect(analytics.trackFunnel).toHaveBeenCalledWith(
      'test_call_initiated',
      expect.objectContaining({ tenantId: 'tenant-123' }),
    );
  });

  it('fires test_call_initiated at most once per mount', () => {
    render(
      <MemoryRouter>
        <TestCallStep status={status('current')} onSkipped={() => {}} onRefresh={() => {}} />
      </MemoryRouter>,
    );
    const link = screen.getByText('(512) 555-1234');
    fireEvent.click(link);
    fireEvent.click(link);
    const initiatedCalls = (analytics.trackFunnel as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'test_call_initiated',
    );
    expect(initiatedCalls).toHaveLength(1);
  });

  it('fires test_call_succeeded when the step transitions to done', () => {
    const { rerender } = render(
      <MemoryRouter>
        <TestCallStep status={status('current')} onSkipped={() => {}} onRefresh={() => {}} />
      </MemoryRouter>,
    );
    // No success event on the initial (still-waiting) render.
    expect(
      (analytics.trackFunnel as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'test_call_succeeded',
      ),
    ).toHaveLength(0);

    rerender(
      <MemoryRouter>
        <TestCallStep status={status('done')} onSkipped={() => {}} onRefresh={() => {}} />
      </MemoryRouter>,
    );
    expect(analytics.trackFunnel).toHaveBeenCalledWith(
      'test_call_succeeded',
      expect.objectContaining({ tenantId: 'tenant-123' }),
    );
  });

  it('does not replay test_call_succeeded for a resumed (already-done) session', () => {
    render(
      <MemoryRouter>
        <TestCallStep status={status('done')} onSkipped={() => {}} onRefresh={() => {}} />
      </MemoryRouter>,
    );
    expect(
      (analytics.trackFunnel as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'test_call_succeeded',
      ),
    ).toHaveLength(0);
  });
});
