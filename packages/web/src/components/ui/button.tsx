import React from 'react';
import { cn } from './utils';
import { Spinner } from './spinner';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80 disabled:hover:bg-primary',
  secondary:
    'bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/70 disabled:hover:bg-secondary',
  outline:
    'border border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent/80',
  ghost:
    'bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground active:bg-secondary',
  danger:
    'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80 disabled:hover:bg-destructive',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-5 text-sm gap-2 rounded-xl',
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Icon rendered before the label. */
  leftIcon?: React.ReactNode;
  /** Icon rendered after the label. */
  rightIcon?: React.ReactNode;
  /** Stretches the button to fill its container. */
  fullWidth?: boolean;
}

/**
 * The single source of truth for buttons across the app. Replaces the
 * ~600 hand-rolled `<button className="rounded-lg bg-slate-900 ...">`
 * call sites so variant, spacing, focus-ring, and disabled states stay
 * consistent and themeable.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      leftIcon,
      rightIcon,
      fullWidth,
      disabled,
      className,
      children,
      type = 'button',
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(
          'inline-flex items-center justify-center font-medium whitespace-nowrap',
          'transition-colors cursor-pointer select-none',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1',
          'disabled:cursor-not-allowed disabled:opacity-50',
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          fullWidth && 'w-full',
          className,
        )}
        {...rest}
      >
        {loading ? (
          <Spinner size={size === 'sm' ? 'xs' : 'sm'} className="text-current" />
        ) : (
          leftIcon
        )}
        {children}
        {!loading && rightIcon}
      </button>
    );
  },
);
