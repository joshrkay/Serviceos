import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { VoiceRecorder } from './VoiceRecorder';

describe('P3-002 — Voice capture UI', () => {
  const defaultProps = {
    state: 'idle' as const,
    duration: 0,
    onStart: vi.fn(),
    onStop: vi.fn(),
    onCancel: vi.fn(),
    onReRecord: vi.fn(),
    onUpload: vi.fn(),
  };

  it('happy path — idle state shows record button', () => {
    render(<VoiceRecorder {...defaultProps} />);
    expect(screen.getByTestId('record-button')).toBeInTheDocument();
    expect(screen.queryByTestId('stop-button')).not.toBeInTheDocument();
  });

  it('happy path — recording state shows stop and cancel buttons', () => {
    render(<VoiceRecorder {...defaultProps} state="recording" duration={5} />);
    expect(screen.getByTestId('stop-button')).toBeInTheDocument();
    expect(screen.getByTestId('cancel-button')).toBeInTheDocument();
    expect(screen.getByTestId('recording-duration')).toHaveTextContent('0:05');
    expect(screen.queryByTestId('record-button')).not.toBeInTheDocument();
  });

  it('happy path — stopped state shows upload, re-record, cancel buttons', () => {
    render(<VoiceRecorder {...defaultProps} state="stopped" duration={30} />);
    expect(screen.getByTestId('upload-button')).toBeInTheDocument();
    expect(screen.getByTestId('rerecord-button')).toBeInTheDocument();
    expect(screen.getByTestId('cancel-button')).toBeInTheDocument();
    expect(screen.getByTestId('recording-duration')).toHaveTextContent('0:30');
  });

  it('happy path — uploading state shows uploading status', () => {
    render(<VoiceRecorder {...defaultProps} state="uploading" />);
    expect(screen.getByTestId('upload-status')).toHaveTextContent('Uploading...');
  });

  it('happy path — transcribing state shows transcribing status', () => {
    render(<VoiceRecorder {...defaultProps} state="transcribing" />);
    expect(screen.getByTestId('transcribing-status')).toHaveTextContent('Transcribing...');
  });

  it('happy path — button actions fire correct callbacks', () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const onCancel = vi.fn();
    const onReRecord = vi.fn();
    const onUpload = vi.fn();

    const { rerender } = render(
      <VoiceRecorder {...defaultProps} onStart={onStart} />
    );
    fireEvent.click(screen.getByTestId('record-button'));
    expect(onStart).toHaveBeenCalled();

    rerender(
      <VoiceRecorder {...defaultProps} state="recording" onStop={onStop} onCancel={onCancel} />
    );
    fireEvent.click(screen.getByTestId('stop-button'));
    expect(onStop).toHaveBeenCalled();

    rerender(
      <VoiceRecorder
        {...defaultProps}
        state="stopped"
        onUpload={onUpload}
        onReRecord={onReRecord}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByTestId('upload-button'));
    expect(onUpload).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('rerecord-button'));
    expect(onReRecord).toHaveBeenCalled();
  });

  it('validation — cannot upload empty recording (idle state has no upload button)', () => {
    render(<VoiceRecorder {...defaultProps} state="idle" />);
    expect(screen.queryByTestId('upload-button')).not.toBeInTheDocument();
  });

  it('happy path — duration formatted correctly', () => {
    render(<VoiceRecorder {...defaultProps} state="recording" duration={125} />);
    expect(screen.getByTestId('recording-duration')).toHaveTextContent('2:05');
  });
});
