import React, { useState, useCallback } from 'react';
import { ClarificationRequest } from '../../types/conversation';

export interface ClarificationCardProps {
  clarification: ClarificationRequest;
  onRespond: (clarificationId: string, response: string) => void;
}

export function validateClarificationResponse(response: string): string | null {
  if (!response.trim()) {
    return 'Response cannot be empty';
  }
  return null;
}

export function ClarificationCard({ clarification, onRespond }: ClarificationCardProps) {
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(() => {
    const validationError = validateClarificationResponse(response);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    onRespond(clarification.id, response.trim());
  }, [response, clarification.id, onRespond]);

  if (clarification.resolved) {
    return (
      <div className="clarification-card resolved" data-testid="clarification-card" data-resolved="true">
        <div className="clarification-question" data-testid="clarification-question">
          {clarification.question}
        </div>
        <div className="clarification-response" data-testid="clarification-response">
          {clarification.response}
        </div>
      </div>
    );
  }

  return (
    <div className="clarification-card" data-testid="clarification-card" data-resolved="false">
      <div className="clarification-question" data-testid="clarification-question">
        {clarification.question}
      </div>

      {clarification.options && clarification.options.length > 0 ? (
        <div className="clarification-options" data-testid="clarification-options">
          {clarification.options.map((option, i) => (
            <button
              key={i}
              className="clarification-option-btn"
              data-testid={`clarification-option-${i}`}
              onClick={() => onRespond(clarification.id, option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : (
        <div className="clarification-text-response">
          <textarea
            className="clarification-input"
            data-testid="clarification-input"
            value={response}
            onChange={(e) => {
              setResponse(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Type your response..."
            rows={2}
          />
          <button
            className="clarification-submit-btn"
            data-testid="clarification-submit"
            onClick={handleSubmit}
          >
            Respond
          </button>
          {error && (
            <span className="clarification-error" data-testid="clarification-error">
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
