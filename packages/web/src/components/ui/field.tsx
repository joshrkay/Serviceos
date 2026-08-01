import React, { useId } from 'react';
import { cn } from './utils';

export interface FieldProps {
  label?: React.ReactNode;
  /** Helper text rendered below the label, above the control. */
  hint?: React.ReactNode;
  /** Error message; when present the control is marked invalid. */
  error?: string | null;
  required?: boolean;
  className?: string;
  /**
   * A single form control. The Field injects `id`, `aria-invalid`,
   * `aria-describedby`, and (when `error` is set) `invalid` so labels
   * and error text are correctly associated for screen readers — the
   * `htmlFor`/`id` pairing that the hand-rolled forms were missing.
   */
  children: React.ReactElement;
}

/**
 * Label + control + error wrapper. Generates a stable id and wires up
 * accessibility relationships automatically so consumers don't have to
 * hand-manage `htmlFor`/`id`/`aria-describedby`.
 */
export function Field({
  label,
  hint,
  error,
  required,
  className,
  children,
}: FieldProps) {
  const generatedId = useId();
  const child = children as React.ReactElement<Record<string, unknown>>;
  const controlId = (child.props.id as string | undefined) ?? generatedId;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  const control = React.cloneElement(child, {
    id: controlId,
    invalid: Boolean(error) || (child.props.invalid as boolean | undefined),
    // Forward `required` so the rendered control is actually marked required
    // for screen readers (and native validation), not just visually with the
    // asterisk. An explicit `required` on the child still wins.
    required: (child.props.required as boolean | undefined) ?? required,
    'aria-describedby': describedBy,
  });

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label
          htmlFor={controlId}
          className="text-xs font-medium text-muted-foreground"
        >
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </label>
      )}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {control}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
