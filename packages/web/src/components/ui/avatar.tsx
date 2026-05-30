import React, { useState } from 'react';
import { cn } from './utils';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<AvatarSize, string> = {
  xs: 'size-6 text-[10px]',
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-12 text-base',
};

export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Full name used to derive initials and the accessible label. */
  name: string;
  /** Optional image URL; falls back to initials if it fails to load. */
  src?: string;
  size?: AvatarSize;
  /** Optional explicit background color (e.g. a technician's lane color). */
  color?: string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Compact identity chip — initials by default, image when available. */
export function Avatar({
  name,
  src,
  size = 'md',
  color,
  className,
  style,
  ...rest
}: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImage = src && !failed;
  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium',
        !showImage && !color && 'bg-slate-100 text-slate-600',
        SIZE_CLASSES[size],
        className,
      )}
      style={{ ...(color && !showImage ? { backgroundColor: color, color: '#fff' } : {}), ...style }}
      {...rest}
    >
      {showImage ? (
        <img
          src={src}
          alt={name}
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
