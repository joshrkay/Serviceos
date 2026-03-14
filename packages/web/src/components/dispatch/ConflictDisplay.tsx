import React from 'react';

export interface ConflictInfo {
  type: string;
  severity: 'blocking' | 'warning';
  message: string;
  conflictingEntityId?: string;
}

export interface ConflictDisplayProps {
  conflicts: ConflictInfo[];
  onAcknowledgeWarnings?: () => void;
}

export function ConflictDisplay({ conflicts, onAcknowledgeWarnings }: ConflictDisplayProps) {
  if (conflicts.length === 0) return null;

  const blockingConflicts = conflicts.filter((c) => c.severity === 'blocking');
  const warningConflicts = conflicts.filter((c) => c.severity === 'warning');
  const hasBlocking = blockingConflicts.length > 0;

  return (
    <div className="conflict-display" data-testid="conflict-display">
      {hasBlocking && (
        <div
          className="conflict-display__blocking"
          data-testid="conflict-display-blocking"
        >
          <div className="conflict-display__title">
            Blocking Conflicts ({blockingConflicts.length})
          </div>
          <ul className="conflict-display__list">
            {blockingConflicts.map((conflict, index) => (
              <li key={index} className="conflict-display__item" data-testid="conflict-item-blocking">
                {conflict.message}
              </li>
            ))}
          </ul>
          <div className="conflict-display__action" data-testid="conflict-blocking-message">
            This proposal cannot be approved due to blocking conflicts.
          </div>
        </div>
      )}

      {warningConflicts.length > 0 && (
        <div
          className="conflict-display__warning"
          data-testid="conflict-display-warning"
        >
          <div className="conflict-display__title">
            Warnings ({warningConflicts.length})
          </div>
          <ul className="conflict-display__list">
            {warningConflicts.map((conflict, index) => (
              <li key={index} className="conflict-display__item" data-testid="conflict-item-warning">
                {conflict.message}
              </li>
            ))}
          </ul>
          {!hasBlocking && onAcknowledgeWarnings && (
            <button
              className="conflict-display__acknowledge"
              data-testid="conflict-acknowledge-btn"
              onClick={onAcknowledgeWarnings}
            >
              Acknowledge and Proceed
            </button>
          )}
        </div>
      )}
    </div>
  );
}
