import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ModeSwitchModal,
  shouldShowModeSwitchModal,
} from './ModeSwitchModal';
import type { Mode } from '../../hooks/useMe';

describe('P12-003 — shouldShowModeSwitchModal suppression rules', () => {
  it('suppresses for same-mode no-ops', () => {
    const modes: Mode[] = ['supervisor', 'tech', 'both'];
    for (const m of modes) {
      expect(shouldShowModeSwitchModal(m, m)).toBe(false);
    }
  });

  it('shows for transitions that leave supervisor coverage (→ tech)', () => {
    expect(shouldShowModeSwitchModal('supervisor', 'tech')).toBe(true);
    expect(shouldShowModeSwitchModal('both', 'tech')).toBe(true);
  });

  it('suppresses gentler transitions (→ supervisor / → both / tech → both)', () => {
    expect(shouldShowModeSwitchModal('tech', 'supervisor')).toBe(false);
    expect(shouldShowModeSwitchModal('tech', 'both')).toBe(false);
    expect(shouldShowModeSwitchModal('both', 'supervisor')).toBe(false);
    expect(shouldShowModeSwitchModal('supervisor', 'both')).toBe(false);
  });
});

describe('P12-003 — ModeSwitchModal rendering + actions', () => {
  function renderModal(props: {
    from?: Mode;
    to?: Mode;
    activeSessionCount?: number;
    pendingProposalCount?: number;
  } = {}) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const result = render(
      <ModeSwitchModal
        from={props.from ?? 'supervisor'}
        to={props.to ?? 'tech'}
        activeSessionCount={props.activeSessionCount ?? 3}
        pendingProposalCount={props.pendingProposalCount ?? 2}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    return { ...result, onConfirm, onCancel };
  }

  it('renders nothing for a suppressed transition', () => {
    const { onConfirm, onCancel } = renderModal({ from: 'tech', to: 'supervisor' });
    expect(screen.queryByTestId('mode-switch-modal')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('renders modal with destination mode label and counts on supervisor → tech', () => {
    renderModal({
      from: 'supervisor',
      to: 'tech',
      activeSessionCount: 4,
      pendingProposalCount: 7,
    });
    expect(screen.getByTestId('mode-switch-modal')).toBeInTheDocument();
    expect(screen.getByText(/Switch to Tech mode\?/i)).toBeInTheDocument();
    expect(screen.getByTestId('active-session-count')).toHaveTextContent('4');
    expect(screen.getByTestId('pending-proposal-count')).toHaveTextContent('7');
  });

  it('confirm button calls onConfirm', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderModal();
    await user.click(screen.getByTestId('mode-switch-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancel button calls onCancel', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderModal();
    await user.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders the locked behavior bullets so the operator knows what changes', () => {
    renderModal();
    expect(screen.getByText(/Auto-approve threshold rises to 0\.95/)).toBeInTheDocument();
    expect(screen.getByText(/Voice approval becomes read-only/)).toBeInTheDocument();
    expect(screen.getByText(/Emergency intents on inbound calls Dial/)).toBeInTheDocument();
  });
});
