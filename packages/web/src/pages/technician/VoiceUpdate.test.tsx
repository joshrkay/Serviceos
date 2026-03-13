import React, { useState, useRef } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../components/voice/useVoiceRecorder', () => ({
  useVoiceRecorder: () => {
    const [state, setState] = useState<string>('idle');
    const [duration, setDuration] = useState(0);
    const blobRef = useRef(new Blob(['test-audio'], { type: 'audio/webm' }));
    return {
      state,
      duration,
      start: () => { setState('recording'); setDuration(0); },
      stop: () => setState('stopped'),
      cancel: () => { setState('idle'); setDuration(0); },
      reRecord: () => { setState('idle'); setDuration(0); },
      getBlob: () => blobRef.current,
      upload: async (onUpload: (blob: Blob) => Promise<void>) => {
        setState('uploading');
        try {
          await onUpload(blobRef.current);
          setState('transcribing');
        } catch {
          setState('stopped');
        }
      },
    };
  },
}));

import { VoiceUpdate, validateJobContext, JobContext } from './VoiceUpdate';

describe('P3-008 — Technician voice update workflow', () => {
  const jobContext: JobContext = {
    jobId: 'job-123',
    jobTitle: 'HVAC Installation at 123 Main St',
    appointmentId: 'apt-456',
  };

  it('happy path — renders job context and voice recorder', () => {
    render(
      <VoiceUpdate
        jobContext={jobContext}
        onUploadRecording={vi.fn().mockResolvedValue('rec-1')}
      />
    );

    expect(screen.getByTestId('job-title')).toHaveTextContent('HVAC Installation at 123 Main St');
    expect(screen.getByTestId('appointment-id')).toHaveTextContent('apt-456');
    expect(screen.getByTestId('voice-recorder')).toBeInTheDocument();
  });

  it('happy path — voice capture creates recording linked to job', async () => {
    const onUpload = vi.fn().mockResolvedValue('rec-1');
    render(<VoiceUpdate jobContext={jobContext} onUploadRecording={onUpload} />);

    // Start recording
    await act(async () => {
      fireEvent.click(screen.getByTestId('record-button'));
    });
    // Stop recording
    await act(async () => {
      fireEvent.click(screen.getByTestId('stop-button'));
    });
    // Upload
    await act(async () => {
      fireEvent.click(screen.getByTestId('upload-button'));
    });

    // Wait for async upload
    await vi.waitFor(() => {
      expect(onUpload).toHaveBeenCalledWith('job-123', expect.any(Blob));
    });
  });

  it('happy path — shows transcript status after upload', () => {
    render(
      <VoiceUpdate
        jobContext={jobContext}
        onUploadRecording={vi.fn().mockResolvedValue('rec-1')}
        transcriptionStatus="completed"
        transcript="Customer needs new HVAC unit."
      />
    );

    expect(screen.getByTestId('transcript-message')).toBeInTheDocument();
    expect(screen.getByTestId('transcript-content')).toHaveTextContent(
      'Customer needs new HVAC unit.'
    );
  });

  it('validation — cannot submit without active job context', () => {
    render(
      <VoiceUpdate jobContext={null} onUploadRecording={vi.fn()} />
    );

    expect(screen.getByTestId('voice-update-no-context')).toBeInTheDocument();
    expect(validateJobContext(null)).toBe(
      'No active job context. Select a job before recording.'
    );

    // Try to start recording
    fireEvent.click(screen.getByTestId('record-button'));
    expect(screen.getByTestId('voice-update-error')).toBeInTheDocument();
  });

  it('validation — validates job context fields', () => {
    expect(validateJobContext({ jobId: '', jobTitle: 'Test' })).toBe('Job ID is required');
    expect(validateJobContext(jobContext)).toBeNull();
  });
});
