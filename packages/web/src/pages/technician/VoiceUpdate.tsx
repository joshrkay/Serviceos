import React, { useState, useCallback } from 'react';
import { VoiceRecorder } from '../../components/voice/VoiceRecorder';
import { TranscriptMessage } from '../../components/voice/TranscriptMessage';
import { RecordingState } from '../../components/voice/useVoiceRecorder';
import { TranscriptionStatus, Proposal } from '../../types/conversation';

export interface JobContext {
  jobId: string;
  jobTitle: string;
  appointmentId?: string;
}

export interface VoiceUpdateProps {
  jobContext: JobContext | null;
  onUploadRecording: (jobId: string, blob: Blob) => Promise<string>;
  onRetryTranscription?: (recordingId: string) => void;
  transcriptionStatus?: TranscriptionStatus;
  transcript?: string;
  transcriptionError?: string;
  proposal?: Proposal;
}

export function validateJobContext(context: JobContext | null): string | null {
  if (!context) {
    return 'No active job context. Select a job before recording.';
  }
  if (!context.jobId) {
    return 'Job ID is required';
  }
  return null;
}

export function VoiceUpdate({
  jobContext,
  onUploadRecording,
  onRetryTranscription,
  transcriptionStatus,
  transcript,
  transcriptionError,
}: VoiceUpdateProps) {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [duration, setDuration] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob>(new Blob());
  const [error, setError] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);

  const contextError = validateJobContext(jobContext);

  const handleStart = useCallback(() => {
    if (contextError) {
      setError(contextError);
      return;
    }
    setError(null);
    setRecordingState('recording');
    setDuration(0);
  }, [contextError]);

  const handleStop = useCallback(() => {
    setRecordingState('stopped');
  }, []);

  const handleCancel = useCallback(() => {
    setRecordingState('idle');
    setDuration(0);
  }, []);

  const handleReRecord = useCallback(() => {
    setRecordingState('idle');
    setDuration(0);
  }, []);

  const handleUpload = useCallback(async () => {
    if (!jobContext) return;
    setRecordingState('uploading');
    try {
      const id = await onUploadRecording(jobContext.jobId, recordedBlob);
      setRecordingId(id);
      setRecordingState('transcribing');
    } catch {
      setRecordingState('stopped');
      setError('Upload failed. Please try again.');
    }
  }, [jobContext, onUploadRecording]);

  return (
    <div className="voice-update" data-testid="voice-update">
      {jobContext ? (
        <div className="voice-update-context" data-testid="voice-update-context">
          <h3 data-testid="job-title">{jobContext.jobTitle}</h3>
          {jobContext.appointmentId && (
            <span data-testid="appointment-id">Appointment: {jobContext.appointmentId}</span>
          )}
        </div>
      ) : (
        <div className="voice-update-no-context" data-testid="voice-update-no-context">
          Select a job to start recording a voice update.
        </div>
      )}

      {error && (
        <div className="voice-update-error" data-testid="voice-update-error">
          {error}
        </div>
      )}

      <VoiceRecorder
        state={recordingState}
        duration={duration}
        onStart={handleStart}
        onStop={handleStop}
        onCancel={handleCancel}
        onReRecord={handleReRecord}
        onUpload={handleUpload}
      />

      {transcriptionStatus && (
        <TranscriptMessage
          status={transcriptionStatus}
          transcript={transcript}
          errorMessage={transcriptionError}
          onRetry={
            onRetryTranscription && recordingId
              ? () => onRetryTranscription(recordingId)
              : undefined
          }
        />
      )}
    </div>
  );
}
