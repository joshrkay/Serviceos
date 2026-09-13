/**
 * B1.19 — the compact mobile mic toggle: ≥44px tap target (size-11) since
 * the full Sidebar toggle is hidden below the md breakpoint.
 */
import { render, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileProgress } from './MobileProgress';
import type { OnboardingStatusResponse } from '../../../types/onboarding';

const STEP_IDS = ['signup', 'identity', 'pack', 'phone', 'billing', 'ai_check', 'test_call'] as const;

function makeStatus(): OnboardingStatusResponse {
  return {
    steps: STEP_IDS.map((id) => ({ id, status: id === 'identity' ? 'current' : 'pending' })),
    currentStep: 'identity',
    isComplete: false,
    voiceAgentLive: false,
    tenantId: 'tenant-1',
    subscriptionStatus: null,
  } as unknown as OnboardingStatusResponse;
}

describe('MobileProgress — voice toggle (B1.19)', () => {
  it('omits the mic button when voiceAvailable is false', () => {
    render(<MobileProgress status={makeStatus()} activeId="phone" voiceAvailable={false} />);
    expect(screen.queryByLabelText(/talk it through/i)).not.toBeInTheDocument();
  });

  it('renders a size-11 (≥44px) mic toggle that calls onToggleVoice', () => {
    const onToggleVoice = vi.fn();
    render(
      <MobileProgress
        status={makeStatus()}
        activeId="identity"
        voiceAvailable
        voiceMode={false}
        onToggleVoice={onToggleVoice}
      />,
    );
    const toggle = screen.getByLabelText('Talk it through (mic)');
    expect(toggle.className).toContain('size-11');
    fireEvent.click(toggle);
    expect(onToggleVoice).toHaveBeenCalledTimes(1);
  });
});
