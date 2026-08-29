import React from 'react';
import { Modal } from './modal';
import { Button } from './button';

export interface ConfirmDialogProps {
  /** Controls visibility. */
  open: boolean;
  /** Question being confirmed, e.g. "Turn off AI phone answering?". */
  title: React.ReactNode;
  /** Consequence of confirming, in plain language. */
  description?: React.ReactNode;
  /** Label on the confirming button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Label on the dismissing button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** `danger` renders the confirm button destructive (red). */
  tone?: 'default' | 'danger';
  /**
   * True while the confirmed action is running: shows a spinner on the
   * confirm button and blocks every dismissal path (cancel button,
   * backdrop, Escape) so the dialog can't be closed mid-flight.
   */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional extra body content rendered under the description. */
  children?: React.ReactNode;
}

/**
 * Confirmation step for actions with real-world consequences — pausing
 * the AI phone line, leaving the app for an external portal, deleting
 * things. Wraps the canonical `Modal` (portal, scroll-lock, focus trap,
 * aria wiring) so a confirm is one declarative element instead of a raw
 * `window.confirm`.
 *
 * Buttons use the `lg` size (h-12 = 48px) so both actions clear the
 * 44px mobile tap-target floor.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  busy = false,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onCancel();
      }}
      title={title}
      description={description}
      size="sm"
      showClose={false}
      footer={
        <>
          <Button
            variant="ghost"
            size="lg"
            onClick={onCancel}
            disabled={busy}
            data-testid="confirm-dialog-cancel"
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            size="lg"
            loading={busy}
            onClick={onConfirm}
            data-testid="confirm-dialog-confirm"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
