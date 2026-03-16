import React from 'react';

export interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="error-state">
      <h3>Something went wrong</h3>
      <p>{message}</p>
      {onRetry && <button onClick={onRetry}>Retry</button>}
    </div>
  );
}
