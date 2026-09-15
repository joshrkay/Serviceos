import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog';

function renderDialog(overrides: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ConfirmDialog
      open
      title="Turn off AI phone answering?"
      description="Callers will hear voicemail until you turn it back on."
      confirmLabel="Turn off"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel, ...utils };
}

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByTestId('modal')).toBeNull();
  });

  it('renders title, description, and both action labels when open', () => {
    renderDialog();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Turn off AI phone answering?')).toBeInTheDocument();
    expect(
      screen.getByText('Callers will hear voicemail until you turn it back on.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('confirm-dialog-confirm')).toHaveTextContent('Turn off');
    expect(screen.getByTestId('confirm-dialog-cancel')).toHaveTextContent('Cancel');
  });

  it('fires onConfirm exactly once from the confirm button', () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('fires onCancel from the cancel button without confirming', () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('fires onCancel on Escape', () => {
    const { onCancel } = renderDialog();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('blocks every dismissal path while busy', () => {
    const { onConfirm, onCancel } = renderDialog({ busy: true });
    expect(screen.getByTestId('confirm-dialog-cancel')).toBeDisabled();
    // `loading` disables the confirm button too — no double-submit.
    expect(screen.getByTestId('confirm-dialog-confirm')).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders a danger confirm button for tone="danger"', () => {
    renderDialog({ tone: 'danger' });
    expect(screen.getByTestId('confirm-dialog-confirm').className).toContain('bg-destructive');
  });

  // Class-contract: mobile tap targets ≥44px (CLAUDE.md). Button size
  // `lg` is h-12 (48px); this pins the choice so a refactor to a smaller
  // size fails loudly.
  it('both action buttons clear the 44px tap-target floor', () => {
    renderDialog();
    expect(screen.getByTestId('confirm-dialog-confirm').className).toContain('h-12');
    expect(screen.getByTestId('confirm-dialog-cancel').className).toContain('h-12');
  });
});
