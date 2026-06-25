import React from 'react';
import { cn } from './utils';

export type CardProps = React.HTMLAttributes<HTMLDivElement>;

/** Surface container — the standard rounded panel used across the app. */
export function Card({ className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-border bg-card',
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({ className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 px-4 pt-4 pb-2',
        className,
      )}
      {...rest}
    />
  );
}

export function CardTitle({
  className,
  ...rest
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn('text-sm font-medium text-foreground', className)}
      {...rest}
    />
  );
}

export function CardContent({ className, ...rest }: CardProps) {
  return <div className={cn('px-4 py-3', className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 pb-4 pt-2',
        className,
      )}
      {...rest}
    />
  );
}
