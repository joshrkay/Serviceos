import React from 'react';

export interface LoadingStateProps {
  message?: string;
}

export function LoadingState({ message = 'Loading...' }: LoadingStateProps) {
  return (
    <div className="loading-state">
      <div className="spinner" />
      <p>{message}</p>
    </div>
  );
}
