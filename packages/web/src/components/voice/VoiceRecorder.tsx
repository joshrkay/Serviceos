import React from 'react';
import { RecordingState } from './useVoiceRecorder';

export interface VoiceRecorderProps {
  state: RecordingState;
  duration: number;
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
        <button className="voice-record-btn" data-testid="record-button" onClick={onStart}>
          Record
        </button>
      )}

      {state === 'recording' && (
        <>
          <span className="voice-duration" data-testid="recording-duration">
            {formatDuration(duration)}
          </span>
          <button className="voice-stop-btn" data-testid="stop-button" onClick={onStop}>
            Stop
          </button>
          <button className="voice-cancel-btn" data-testid="cancel-button" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}

      {state === 'stopped' && (
        <>
          <span className="voice-duration" data-testid="recording-duration">
            {formatDuration(duration)}
          </span>
          <button className="voice-upload-btn" data-testid="upload-button" onClick={onUpload}>
            Upload
          </button>
          <button className="voice-rerecord-btn" data-testid="rerecord-button" onClick={onReRecord}>
            Re-record
          </button>
          <button className="voice-cancel-btn" data-testid="cancel-button" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}

      {state === 'uploading' && (
        <span className="voice-status" data-testid="upload-status">
          Uploading...
        </span>
      )}

      {state === 'transcribing' && (
        <span className="voice-status" data-testid="transcribing-status">
          Transcribing...
        </span>
      )}
    </div>
  );
}
