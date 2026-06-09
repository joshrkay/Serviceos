import React from 'react';
import { Spinner } from './ui/spinner';

export interface LoadingStateProps {
  message?: string;
}

export function LoadingState({ message = 'Loading...' }: LoadingStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-slate-500">
      <Spinner size="md" className="spinner text-slate-400" />
      <p className="text-sm">{message}</p>
    </div>
  );
}
