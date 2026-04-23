import React, { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceUpdate, JobContext } from './VoiceUpdate';
import { TranscriptionStatus } from '../../types/conversation';

export interface VoiceUpdatePageProps {
  jobContext: JobContext | null;
  /**
   * Optional callback fired when a transcription finishes. Lets a parent
   * route navigate to the auto-generated proposal, since the backend's
   * voice-action-router worker creates the proposal asynchronously off the
   * transcription completion event.
   */
  onTranscribed?: (recordingId: string, transcript: string) => void;
}

interface RecordingResponse {
  id: string;
  status?: TranscriptionStatus;
  transcript?: string;
  error?: string;
}

const POLL_INTERVAL_MS = 2000;

/**
 * P3-008 — Technician voice update container.
 *
 * Wraps the VoiceUpdate leaf component and hooks it up to the real
 * /api/voice/recordings endpoint. Auto-generates a proposal server-side
 * via voice-action-router once transcription completes.
 */
export function VoiceUpdatePage({ jobContext, onTranscribed }: VoiceUpdatePageProps) {
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [transcriptionStatus, setTranscriptionStatus] = useState<TranscriptionStatus | undefined>();
  const [transcript, setTranscript] = useState<string | undefined>();
  const [transcriptionError, setTranscriptionError] = useState<string | undefined>();
  // Recursive setTimeout — a new tick is only scheduled *after* the previous
  // fetch resolves (or fails), so slow Whisper responses can't produce
  // overlapping in-flight requests. cancelled flips to true on unmount or
  // on a completed/failed status, which short-circuits late responses.
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCancelled = useRef<boolean>(false);

  const clearPoll = () => {
    pollCancelled.current = true;
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  };

  useEffect(() => () => clearPoll(), []);

  const beginPolling = (id: string) => {
    clearPoll();
    pollCancelled.current = false;

    const tick = async () => {
      if (pollCancelled.current) return;
      try {
        const res = await fetch(`/api/voice/recordings/${id}`);
        if (pollCancelled.current) return;
        if (res.ok) {
          const r = (await res.json()) as RecordingResponse;
          if (pollCancelled.current) return;
          if (r.status) setTranscriptionStatus(r.status);
          if (r.transcript) setTranscript(r.transcript);
          if (r.error) setTranscriptionError(r.error);

          if (r.status === 'completed') {
            clearPoll();
            if (onTranscribed && r.transcript) {
              onTranscribed(id, r.transcript);
            }
            return;
          }
          if (r.status === 'failed') {
            clearPoll();
            return;
          }
        }
      } catch {
        // Transient poll failures are ignored — the next tick retries.
      }
      if (!pollCancelled.current) {
        pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
  };

  const uploadRecording = useCallback(
    async (jobId: string, blob: Blob): Promise<string> => {
      const form = new FormData();
      form.append('file', blob, 'recording.webm');
      form.append('jobId', jobId);

      const res = await fetch('/api/voice/recordings', {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        throw new Error(`Voice upload failed (${res.status})`);
      }
      const data = (await res.json()) as { recording: RecordingResponse };
      const id = data.recording.id;

      setRecordingId(id);
      setTranscriptionStatus('processing');
      beginPolling(id);
      return id;
    },
    []
  );

  const retryTranscription = useCallback(async (id: string) => {
    setTranscriptionError(undefined);
    setTranscriptionStatus('processing');
    await fetch(`/api/voice/recordings/${id}/retry`, { method: 'POST' });
    beginPolling(id);
  }, []);

  // Backend auto-generates the proposal off the transcription completion
  // event — onGenerateProposal here is a user-facing acknowledgement hook
  // for the manual/semi-automatic workflow modes.
  const generateProposal = useCallback(() => {
    if (onTranscribed && recordingId && transcript) {
      onTranscribed(recordingId, transcript);
    }
  }, [onTranscribed, recordingId, transcript]);

  return (
    <VoiceUpdate
      jobContext={jobContext}
      workflowMode="automatic"
      onUploadRecording={uploadRecording}
      onGenerateProposal={generateProposal}
      onRetryTranscription={retryTranscription}
      transcriptionStatus={transcriptionStatus}
      transcript={transcript}
      transcriptionError={transcriptionError}
    />
  );
}
