import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from './utils';
import { useFocusTrap, useScrollLock } from './overlay';

export type ModalSize = 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

export interface ModalProps {
  /** Controls visibility. */
  open: boolean;
  /** Called on backdrop click, the close button, or Escape. */
  onClose: () => void;
  /** Heading rendered in the header; also labels the dialog for a11y. */
  title?: React.ReactNode;
  /** Optional sub-heading under the title. */
  description?: React.ReactNode;
  /** Footer content, typically action buttons. */
  footer?: React.ReactNode;
  size?: ModalSize;
  /** Hides the default close (×) button when false. */
  showClose?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/**
 * The canonical centered overlay dialog. Replaces the bespoke fixed-inset
 * modals scattered across the app with one accessible implementation
 * (portal, scroll-lock, focus trap, Escape + backdrop dismissal).
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  size = 'md',
  showClose = true,
  className,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const labelId = React.useId();
  const descId = React.useId();

  useScrollLock(open);
  useFocusTrap(panelRef, open, onClose);

  // Guard against SSR: createPortal needs a real document.body.
  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      data-testid="modal"
    >
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? labelId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          'relative z-10 flex w-full flex-col rounded-2xl border border-slate-200 bg-white shadow-xl outline-none',
          'max-h-[calc(100vh-2rem)]',
          SIZE_CLASSES[size],
          className,
        )}
      >
        {(title || showClose) && (
          <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-2">
            <div className="min-w-0">
              {title && (
                <h2
                  id={labelId}
                  className="text-base font-semibold text-slate-900"
                >
                  {title}
                </h2>
              )}
              {description && (
                <p id={descId} className="mt-0.5 text-sm text-slate-500">
                  {description}
                </p>
              )}
            </div>
            {showClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="-mr-1 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                <X size={18} />
              </button>
            )}
          </div>
        )}
        <div className="overflow-y-auto px-5 py-3">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 px-5 pb-5 pt-2">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
