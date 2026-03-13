import React, { useState, useCallback, useRef, useEffect } from 'react';
import { OperationState, OperationInfo } from '../../types/conversation';

export interface OperationStatusProps {
  operation: OperationInfo;
  onRetry?: (operationId: string) => void;
}

const STATUS_LABELS: Record<OperationState, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  success: 'Completed',
  failure: 'Failed',
};

export function OperationStatus({ operation, onRetry }: OperationStatusProps) {
  return (
    <div className="operation-status" data-testid="operation-status" data-state={operation.state}>
      <span className="operation-status-indicator" data-state={operation.state} />
      <span className="operation-status-label">{STATUS_LABELS[operation.state]}</span>
      {operation.state === 'in_progress' && (
        <span className="operation-status-spinner" data-testid="spinner" aria-label="Loading" />
      )}
      {operation.state === 'failure' && (
        <div className="operation-status-error">
          {operation.errorMessage && (
            <span className="operation-status-error-message" data-testid="error-message">
              {operation.errorMessage}
            </span>
          )}
          {operation.retryable && onRetry && (
            <RetryButton operationId={operation.id} onRetry={onRetry} />
          )}
        </div>
      )}
    </div>
  );
}

interface RetryButtonProps {
  operationId: string;
  onRetry: (operationId: string) => void;
}

export function RetryButton({ operationId, onRetry }: RetryButtonProps) {
  const [retrying, setRetrying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleRetry = useCallback(() => {
    setRetrying(true);
    onRetry(operationId);
    timerRef.current = setTimeout(() => setRetrying(false), 2000);
  }, [operationId, onRetry]);

  return (
    <button
      className="retry-button"
      data-testid="retry-button"
      onClick={handleRetry}
      disabled={retrying}
    >
      {retrying ? 'Retrying...' : 'Retry'}
    </button>
  );
}

export interface UseOperationStatusResult {
  operation: OperationInfo;
  updateState: (state: OperationState, errorMessage?: string) => void;
  reset: () => void;
}

export function useOperationStatus(
  id: string,
  type: string,
  initialState: OperationState = 'pending'
): UseOperationStatusResult {
  const [operation, setOperation] = useState<OperationInfo>({
    id,
    type,
    state: initialState,
    retryable: true,
  });

  const updateState = useCallback((state: OperationState, errorMessage?: string) => {
    setOperation((prev) => ({
      ...prev,
      state,
      errorMessage: errorMessage ?? prev.errorMessage,
    }));
  }, []);

  const reset = useCallback(() => {
    setOperation({ id, type, state: 'pending', retryable: true });
  }, [id, type]);

  return { operation, updateState, reset };
}
