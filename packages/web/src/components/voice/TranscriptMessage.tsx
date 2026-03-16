import React from 'react';
import { TranscriptionStatus } from '../../types/conversation';

export interface TranscriptMessageProps {
  transcript?: string;
  status: TranscriptionStatus;
  errorMessage?: string;
  onRetry?: () => void;
  senderId?: string;
  senderRole?: string;
  createdAt?: string;
}

function formatTime(dateString: string): string {
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleTimeString();
}

export function TranscriptMessage({
  transcript,
  status,
  errorMessage,
  onRetry,
  senderId,
  senderRole,
  createdAt,
}: TranscriptMessageProps) {
  return (
    <div className="transcript-message" data-testid="transcript-message" data-status={status}>
      {senderId && (
        <div className="transcript-header">
          <span className="transcript-sender" data-testid="transcript-sender">{senderId}</span>
          {senderRole && <span className="transcript-role">{senderRole}</span>}
          {createdAt && formatTime(createdAt) && (
            <span className="transcript-time">
              {formatTime(createdAt)}
            </span>
          )}
        </div>
      )}

      {status === 'processing' && (
        <div className="transcript-processing" data-testid="transcript-processing">
          <span className="transcript-spinner" data-testid="transcript-spinner" aria-label="Processing" />
          <span>Transcribing audio...</span>
        </div>
      )}

      {status === 'pending' && (
        <div className="transcript-pending" data-testid="transcript-pending">
          <span>Waiting to process...</span>
        </div>
      )}

      {status === 'completed' && transcript && (
        <div className="transcript-content" data-testid="transcript-content">
          {transcript}
        </div>
      )}

      {status === 'failed' && (
        <div className="transcript-failed" data-testid="transcript-failed">
          <span className="transcript-error" data-testid="transcript-error">
            {errorMessage ?? 'Transcription failed'}
          </span>
          {onRetry && (
            <button
              className="transcript-retry-btn"
              data-testid="transcript-retry-button"
              onClick={onRetry}
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
