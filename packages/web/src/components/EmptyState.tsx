import React from 'react';
import { Inbox } from 'lucide-react';
import { Button } from './ui/button';

export interface EmptyStateProps {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: React.ReactNode;
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  icon,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        {icon ?? <Inbox size={20} />}
      </span>
      <div>
        <h3 className="text-sm font-medium text-slate-900">{title}</h3>
        {description && (
          <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>
        )}
      </div>
      {actionLabel && onAction && (
        <Button size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
