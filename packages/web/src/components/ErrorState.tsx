import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './ui/button';

export interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 py-16 text-center"
    >
      <span className="flex size-11 items-center justify-center rounded-full bg-red-50 text-red-500">
        <AlertTriangle size={20} />
      </span>
      <div>
        <h3 className="text-sm font-medium text-slate-900">
          Something went wrong
        </h3>
        <p className="mt-1 max-w-sm text-sm text-slate-500">{message}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
