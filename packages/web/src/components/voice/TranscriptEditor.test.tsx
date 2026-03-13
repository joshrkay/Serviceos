import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TranscriptEditor, canEditTranscript, validateCorrection } from './TranscriptEditor';

describe('P3-004 — Transcript review and correction', () => {
  const defaultProps = {
    originalTranscript: 'Customer needs new HVAC unit.',
    onSave: vi.fn(),
    onCancel: vi.fn(),
    userRole: 'dispatcher' as const,
  };

  it('happy path — edit saves corrected transcript preserving original', () => {
    const onSave = vi.fn();
    render(<TranscriptEditor {...defaultProps} onSave={onSave} />);

    expect(screen.getByTestId('transcript-original-text')).toHaveTextContent(
      'Customer needs new HVAC unit.'
    );

    const editField = screen.getByTestId('transcript-edit-field');
    fireEvent.change(editField, {
      target: { value: 'Customer needs a new HVAC unit installed.' },
    });
    fireEvent.click(screen.getByTestId('transcript-save-button'));

    expect(onSave).toHaveBeenCalledWith('Customer needs a new HVAC unit installed.');
    // Original is still visible
    expect(screen.getByTestId('transcript-original-text')).toHaveTextContent(
      'Customer needs new HVAC unit.'
    );
  });

  it('happy path — owner can edit transcripts', () => {
    render(<TranscriptEditor {...defaultProps} userRole="owner" />);
    expect(screen.getByTestId('transcript-edit-field')).toBeInTheDocument();
  });

  it('happy path — dispatcher can edit transcripts', () => {
    expect(canEditTranscript('dispatcher')).toBe(true);
    expect(canEditTranscript('owner')).toBe(true);
  });

  it('happy path — cancel calls onCancel', () => {
    const onCancel = vi.fn();
    render(<TranscriptEditor {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('transcript-cancel-button'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('validation — empty correction rejected', () => {
    const onSave = vi.fn();
    render(<TranscriptEditor {...defaultProps} onSave={onSave} />);

    const editField = screen.getByTestId('transcript-edit-field');
    fireEvent.change(editField, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('transcript-save-button'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('transcript-edit-error')).toHaveTextContent(
      'Corrected transcript cannot be empty'
    );
  });

  it('validation — no changes detected rejected', () => {
    const error = validateCorrection('Hello world', 'Hello world');
    expect(error).toBe('No changes detected');
  });

  it('validation — technician role cannot edit', () => {
    render(<TranscriptEditor {...defaultProps} userRole="technician" />);

    expect(screen.queryByTestId('transcript-edit-field')).not.toBeInTheDocument();
    expect(screen.getByTestId('transcript-no-edit-permission')).toBeInTheDocument();
  });
});
