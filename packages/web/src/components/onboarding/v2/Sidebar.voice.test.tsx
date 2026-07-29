/**
 * B1.19 — the sidebar's "talk it through" toggle: only rendered when the
 * active step has a conversational alternative, ≥44px tap target, and
 * reports its pressed state via aria-pressed.
 */
import { render, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { Sidebar } from './Sidebar';
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

describe('Sidebar — voice toggle (B1.19)', () => {
  it('does not render the toggle when voiceAvailable is false', () => {
    render(
      <MemoryRouter>
        <Sidebar status={makeStatus()} activeId="phone" onSelect={() => {}} voiceAvailable={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: /talk it through/i })).not.toBeInTheDocument();
  });

  it('renders a ≥44px toggle that calls onToggleVoice and reflects pressed state', () => {
    const onToggleVoice = vi.fn();
    render(
      <MemoryRouter>
        <Sidebar
          status={makeStatus()}
          activeId="identity"
          onSelect={() => {}}
          voiceAvailable
          voiceMode={false}
          onToggleVoice={onToggleVoice}
        />
      </MemoryRouter>,
    );

    const toggle = screen.getByRole('button', { name: /talk it through instead/i });
    expect(toggle.className).toContain('min-h-11');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);
    expect(onToggleVoice).toHaveBeenCalledTimes(1);
  });

  it('shows the active label + aria-pressed=true while voiceMode is on', () => {
    render(
      <MemoryRouter>
        <Sidebar
          status={makeStatus()}
          activeId="identity"
          onSelect={() => {}}
          voiceAvailable
          voiceMode
          onToggleVoice={() => {}}
        />
      </MemoryRouter>,
    );
    const toggle = screen.getByRole('button', { name: /talking it through/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });
});
