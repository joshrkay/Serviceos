import React from 'react';
import { cn } from './utils';

export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

/** Shimmer placeholder used while content loads to avoid layout shift. */
export function Skeleton({ className, ...rest }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-slate-200/70', className)}
      {...rest}
    />
  );
}

export interface SkeletonTextProps {
  /** Number of lines to render. */
  lines?: number;
  className?: string;
}

/** A stack of skeleton lines approximating a paragraph of text. */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn('h-3.5', i === lines - 1 ? 'w-2/3' : 'w-full')}
        />
      ))}
    </div>
  );
}
