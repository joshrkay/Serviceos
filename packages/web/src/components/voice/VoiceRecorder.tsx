import React from 'react';
import { RecordingState } from './useVoiceRecorder';

export interface VoiceRecorderProps {
  state: RecordingState;
  duration: number;
  recordedBlob?: Blob;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
  onReRecord: () => void;
  onUpload: () => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VoiceRecorder({
  state,
  duration,
  onStart,
  onStop,
  onCancel,
  onReRecord,
  onUpload,
}: VoiceRecorderProps) {
  return (
    <div className="voice-recorder" data-testid="voice-recorder" data-state={state}>
      {state === 'idle' && (
        <button className="voice-record-btn" data-testid="record-button" onClick={onStart} aria-label="Start recording">
          Record
        </button>
      )}

      {state === 'recording' && (
        <>
          <span className="voice-duration" data-testid="recording-duration" role="status" aria-live="polite">
            {formatDuration(duration)}
          </span>
          <button className="voice-stop-btn" data-testid="stop-button" onClick={onStop} aria-label="Stop recording">
            Stop
          </button>
          <button className="voice-cancel-btn" data-testid="cancel-button" onClick={onCancel} aria-label="Cancel recording">
            Cancel
          </button>
        </>
      )}

      {state === 'stopped' && (
        <>
          <span className="voice-duration" data-testid="recording-duration">
            {formatDuration(duration)}
          </span>
          <button className="voice-upload-btn" data-testid="upload-button" onClick={onUpload} aria-label="Upload recording">
            Upload
          </button>
          <button className="voice-rerecord-btn" data-testid="rerecord-button" onClick={onReRecord} aria-label="Re-record">
            Re-record
          </button>
          <button className="voice-cancel-btn" data-testid="cancel-button" onClick={onCancel} aria-label="Cancel recording">
            Cancel
          </button>
        </>
      )}

      {state === 'uploading' && (
        <span className="voice-status" data-testid="upload-status" role="status" aria-live="polite" aria-busy="true">
          Uploading...
        </span>
      )}

      {state === 'transcribing' && (
        <span className="voice-status" data-testid="transcribing-status" role="status" aria-live="polite" aria-busy="true">
          Transcribing...
        </span>
      )}
    </div>
  );
}
