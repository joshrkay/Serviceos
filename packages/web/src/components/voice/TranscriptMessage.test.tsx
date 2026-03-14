import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TranscriptMessage } from './TranscriptMessage';

describe('P3-003 — Transcript rendering and status', () => {
  it('happy path — renders completed transcript with text', () => {
    render(
      <TranscriptMessage
        status="completed"
        transcript="Customer said they need a new HVAC unit installed."
        senderId="tech-1"
        senderRole="technician"
        createdAt="2024-01-01T10:00:00Z"
      />
    );

    expect(screen.getByTestId('transcript-content')).toHaveTextContent(
      'Customer said they need a new HVAC unit installed.'
    );
    expect(screen.getByTestId('transcript-sender')).toHaveTextContent('tech-1');
  });

  it('happy path — renders processing state with spinner', () => {
    render(<TranscriptMessage status="processing" />);
    expect(screen.getByTestId('transcript-processing')).toBeInTheDocument();
    expect(screen.getByTestId('transcript-spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('transcript-content')).not.toBeInTheDocument();
  });

  it('happy path — renders pending state', () => {
    render(<TranscriptMessage status="pending" />);
    expect(screen.getByTestId('transcript-pending')).toBeInTheDocument();
  });

  it('validation — failed status shows error message and retry button', () => {
    const onRetry = vi.fn();
    render(
      <TranscriptMessage
        status="failed"
        errorMessage="Service unavailable"
        onRetry={onRetry}
      />
    );

    expect(screen.getByTestId('transcript-failed')).toBeInTheDocument();
    expect(screen.getByTestId('transcript-error')).toHaveTextContent('Service unavailable');
    expect(screen.getByTestId('transcript-retry-button')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('transcript-retry-button'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('happy path — failed without retry callback shows no retry button', () => {
    render(
      <TranscriptMessage status="failed" errorMessage="Permanent error" />
    );

    expect(screen.getByTestId('transcript-error')).toHaveTextContent('Permanent error');
    expect(screen.queryByTestId('transcript-retry-button')).not.toBeInTheDocument();
  });

  it('happy path — default error message when none provided', () => {
    render(<TranscriptMessage status="failed" onRetry={vi.fn()} />);
    expect(screen.getByTestId('transcript-error')).toHaveTextContent('Transcription failed');
  });
});
