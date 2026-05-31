import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from './utils';
import { useFocusTrap, useScrollLock } from './overlay';

export type SheetSide = 'right' | 'left' | 'bottom';

const SIDE_CLASSES: Record<SheetSide, string> = {
  right: 'inset-y-0 right-0 h-full w-full max-w-md rounded-l-2xl',
  left: 'inset-y-0 left-0 h-full w-full max-w-md rounded-r-2xl',
  bottom: 'inset-x-0 bottom-0 max-h-[85vh] w-full rounded-t-2xl',
};

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  /** Edge the panel slides in from. Defaults to `right` (mobile-friendly). */
  side?: SheetSide;
  showClose?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Edge-anchored panel for forms and detail/edit flows that are too large
 * for a centered Modal — especially on mobile, where `side="bottom"`
 * reads as a native sheet. Shares the Modal's accessibility behavior.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  footer,
  side = 'right',
  showClose = true,
  className,
  children,
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const labelId = React.useId();
  const descId = React.useId();

  useScrollLock(open);
  useFocusTrap(panelRef, open, onClose);

  // Guard against SSR: createPortal needs a real document.body.
  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50" data-testid="sheet">
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
          'absolute z-10 flex flex-col border border-slate-200 bg-white shadow-xl outline-none',
          SIDE_CLASSES[side],
          className,
        )}
      >
        {(title || description || showClose) && (
          <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
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
                className="-mr-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                <X size={18} />
              </button>
            )}
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
