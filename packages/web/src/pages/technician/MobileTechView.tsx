import React, { useState } from 'react';
import { Message, TranscriptionStatus, Proposal } from '../../types/conversation';
import { VoiceRecorder } from '../../components/voice/VoiceRecorder';
import { TranscriptMessage } from '../../components/voice/TranscriptMessage';
import { RecordingState } from '../../components/voice/useVoiceRecorder';

export interface AssignedJob {
  id: string;
  title: string;
  address: string;
  appointmentId?: string;
  appointmentTime?: string;
}

export interface MobileTechViewProps {
  assignedJobs: AssignedJob[];
  selectedJobId?: string;
  onSelectJob: (jobId: string) => void;
  onUploadRecording: (jobId: string, blob: Blob) => Promise<void>;
  transcriptionStatus?: TranscriptionStatus;
  transcript?: string;
  messages?: Message[];
  onRetryTranscription?: () => void;
}

const MIN_TOUCH_TARGET_PX = 44;

export function MobileTechView({
  assignedJobs,
  selectedJobId,
  onSelectJob,
  onUploadRecording,
  transcriptionStatus,
  transcript,
  messages = [],
  onRetryTranscription,
}: MobileTechViewProps) {
  const [voiceState, setVoiceState] = useState<RecordingState>('idle');
  const [duration, setDuration] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob>(new Blob());

  const selectedJob = assignedJobs.find((j) => j.id === selectedJobId);

  return (
    <div className="mobile-tech-view" data-testid="mobile-tech-view">
      <nav className="mobile-nav" data-testid="mobile-nav">
        <h2>My Jobs</h2>
      </nav>

      <div className="mobile-job-list" data-testid="mobile-job-list">
        {assignedJobs.map((job) => (
          <button
            key={job.id}
            className="mobile-job-item"
            data-testid="mobile-job-item"
            onClick={() => onSelectJob(job.id)}
            style={{ minHeight: `${MIN_TOUCH_TARGET_PX}px`, minWidth: `${MIN_TOUCH_TARGET_PX}px` }}
            data-selected={job.id === selectedJobId}
          >
            <span className="mobile-job-title">{job.title}</span>
            <span className="mobile-job-address">{job.address}</span>
            {job.appointmentTime && (
              <span className="mobile-job-time">{job.appointmentTime}</span>
            )}
          </button>
        ))}
      </div>

      {selectedJob && (
        <div className="mobile-job-detail" data-testid="mobile-job-detail">
          <h3 data-testid="mobile-job-detail-title">{selectedJob.title}</h3>
          <p>{selectedJob.address}</p>

          <div className="mobile-voice-section" data-testid="mobile-voice-section">
            <VoiceRecorder
              state={voiceState}
              duration={duration}
              onStart={() => {
                setVoiceState('recording');
                setDuration(0);
              }}
              onStop={() => setVoiceState('stopped')}
              onCancel={() => {
                setVoiceState('idle');
                setDuration(0);
              }}
              onReRecord={() => {
                setVoiceState('idle');
                setDuration(0);
              }}
              onUpload={async () => {
                setVoiceState('uploading');
                try {
                  await onUploadRecording(selectedJob.id, recordedBlob);
                  setVoiceState('transcribing');
                } catch {
                  setVoiceState('stopped');
                }
              }}
            />
          </div>

          {transcriptionStatus && (
            <TranscriptMessage
              status={transcriptionStatus}
              transcript={transcript}
              onRetry={onRetryTranscription}
            />
          )}

          {messages.length > 0 && (
            <div className="mobile-messages" data-testid="mobile-messages">
              {messages.slice(-5).map((msg) => (
                <div key={msg.id} className="mobile-message" data-testid="mobile-message">
                  <span>{msg.content}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
