import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { OperationStatus } from './OperationStatus';
import { OperationInfo } from '../../types/conversation';

describe('P3-011 — Conversation state and retry handling (Web)', () => {
  it('happy path — renders pending state', () => {
    const op: OperationInfo = { id: 'op-1', type: 'upload', state: 'pending', retryable: false };
    render(<OperationStatus operation={op} />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('happy path — renders in_progress state with spinner', () => {
    const op: OperationInfo = { id: 'op-1', type: 'transcription', state: 'in_progress', retryable: false };
    render(<OperationStatus operation={op} />);
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('happy path — renders success state', () => {
    const op: OperationInfo = { id: 'op-1', type: 'proposal', state: 'success', retryable: false };
    render(<OperationStatus operation={op} />);
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('happy path — renders failure state with error message and retry button', () => {
    const onRetry = vi.fn();
    const op: OperationInfo = {
      id: 'op-1',
      type: 'transcription',
      state: 'failure',
      retryable: true,
      errorMessage: 'Service unavailable',
    };
    render(<OperationStatus operation={op} onRetry={onRetry} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByTestId('error-message')).toHaveTextContent('Service unavailable');
    expect(screen.getByTestId('retry-button')).toBeInTheDocument();
  });

  it('happy path — retry button calls onRetry', () => {
    const onRetry = vi.fn();
    const op: OperationInfo = {
      id: 'op-1',
      type: 'transcription',
      state: 'failure',
      retryable: true,
    };
    render(<OperationStatus operation={op} onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId('retry-button'));
    expect(onRetry).toHaveBeenCalledWith('op-1');
  });

  it('validation — no retry button when not retryable', () => {
    const op: OperationInfo = {
      id: 'op-1',
      type: 'upload',
      state: 'failure',
      retryable: false,
      errorMessage: 'Invalid file',
    };
    render(<OperationStatus operation={op} />);
    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
  });
});
