import React, { useId, useState } from 'react';
import { cn } from './utils';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

const SIDE_CLASSES: Record<TooltipSide, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
  left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
  right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
};

export interface TooltipProps {
  /** Tooltip text. */
  content: React.ReactNode;
  side?: TooltipSide;
  /** The trigger element. Must accept mouse/focus handlers. */
  children: React.ReactElement;
  className?: string;
}

/**
 * Lightweight, CSS-positioned tooltip shown on hover and keyboard focus.
 * Dependency-free (no floating-ui); for short hints on icon buttons and
 * truncated labels. Associates via `aria-describedby` for screen readers.
 */
export function Tooltip({ content, side = 'top', children, className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();

  const show = () => setOpen(true);
  const hide = () => setOpen(false);

  // Compose with — never overwrite — the child's existing handlers and
  // described-by relationship, so wrapping an already-interactive control
  // (e.g. an input tied to helper text) keeps its original behavior.
  const childProps = children.props as React.HTMLAttributes<HTMLElement>;
  const describedBy =
    [childProps['aria-describedby'], open ? id : null].filter(Boolean).join(' ') ||
    undefined;

  const trigger = React.cloneElement(children, {
    'aria-describedby': describedBy,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      childProps.onMouseEnter?.(e);
      show();
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      childProps.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      childProps.onFocus?.(e);
      show();
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(e);
      hide();
    },
  } as React.HTMLAttributes<HTMLElement>);

  return (
    <span className="relative inline-flex">
      {trigger}
      {open && (
        <span
          role="tooltip"
          id={id}
          className={cn(
            'pointer-events-none absolute z-50 whitespace-nowrap rounded-lg bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-md',
            SIDE_CLASSES[side],
            className,
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
