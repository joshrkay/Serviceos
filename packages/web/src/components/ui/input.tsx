import React from 'react';
import { cn } from './utils';

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Renders the error styling (red border/ring). */
  invalid?: boolean;
  /** Optional icon rendered inside the field, on the left. */
  leftIcon?: React.ReactNode;
}

const BASE_FIELD =
  'w-full rounded-xl border bg-white text-sm text-slate-800 placeholder-slate-400 ' +
  'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 ' +
  'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400';

function fieldStateClasses(invalid?: boolean): string {
  return invalid
    ? 'border-red-300 focus:border-red-400 focus-visible:ring-red-500/30'
    : 'border-slate-200 focus:border-blue-400';
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ invalid, leftIcon, className, ...rest }, ref) {
    const control = (
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          BASE_FIELD,
          fieldStateClasses(invalid),
          'px-3.5 py-2.5',
          leftIcon && 'pl-10',
          className,
        )}
        {...rest}
      />
    );
    if (!leftIcon) return control;
    return (
      <div className="relative">
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
          {leftIcon}
        </span>
        {control}
      </div>
    );
  },
);

export type TextareaProps =
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean };

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ invalid, className, rows = 3, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        aria-invalid={invalid || undefined}
        className={cn(
          BASE_FIELD,
          fieldStateClasses(invalid),
          'px-3.5 py-2.5 resize-y',
          className,
        )}
        {...rest}
      />
    );
  },
);

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ invalid, className, children, ...rest }, ref) {
    return (
      <div className="relative">
        <select
          ref={ref}
          aria-invalid={invalid || undefined}
          className={cn(
            BASE_FIELD,
            fieldStateClasses(invalid),
            'appearance-none px-3.5 py-2.5 pr-9 cursor-pointer',
            className,
          )}
          {...rest}
        >
          {children}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
        >
          <path
            d="M6 8l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    );
  },
);
