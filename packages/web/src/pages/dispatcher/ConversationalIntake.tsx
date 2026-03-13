import React, { useState, useCallback } from 'react';
import { Message, Proposal } from '../../types/conversation';
import { ConversationThread } from '../conversations/ConversationThread';
import { VoiceRecorder } from '../../components/voice/VoiceRecorder';
import { ProposalCard } from '../../components/conversations/ProposalCard';
import { useVoiceRecorder } from '../../components/voice/useVoiceRecorder';

export interface ConversationalIntakeProps {
  conversationId?: string;
  messages: Message[];
  proposals: Proposal[];
  onSendMessage: (content: string) => void;
  onUploadVoice: (blob: Blob) => Promise<void>;
  onApproveProposal: (proposalId: string) => void;
  onRejectProposal: (proposalId: string) => void;
}

export function validateIntakeInput(content: string): string | null {
  if (!content.trim()) {
    return 'Intake message cannot be empty';
  }
  return null;
}

export function ConversationalIntake({
  messages,
  proposals,
  onSendMessage,
  onUploadVoice,
  onApproveProposal,
  onRejectProposal,
}: ConversationalIntakeProps) {
  const [voiceState, setVoiceState] = useState<RecordingState>('idle');
  const [duration, setDuration] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob>(new Blob());
  const [showVoice, setShowVoice] = useState(false);

  const handleSend = useCallback(
    (content: string) => {
      const error = validateIntakeInput(content);
      if (error) return;
      onSendMessage(content);
    },
    [onSendMessage]
  );

  const renderProposal = useCallback(
    (message: Message) => {
      const proposal = proposals.find(
        (p) => p.id === message.metadata?.proposalId
      );
      if (!proposal) return null;
      return (
        <ProposalCard
          proposal={proposal}
          userRole="dispatcher"
          onApprove={onApproveProposal}
          onReject={onRejectProposal}
        />
      );
    },
    [proposals, onApproveProposal, onRejectProposal]
  );

  return (
    <div className="conversational-intake" data-testid="conversational-intake">
      <div className="intake-header" data-testid="intake-header">
        <h2>New Intake</h2>
        <button
          className="intake-voice-toggle"
          data-testid="intake-voice-toggle"
          onClick={() => setShowVoice(!showVoice)}
        >
          {showVoice ? 'Hide Voice' : 'Voice Input'}
        </button>
      </div>

      {showVoice && (
        <div className="intake-voice-section" data-testid="intake-voice-section">
          <VoiceRecorder
            state={voiceState}
            duration={duration}
            onStart={() => setVoiceState('recording')}
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
                await onUploadVoice(recordedBlob);
                setVoiceState('transcribing');
              } catch {
                setVoiceState('stopped');
              }
            }}
          />
        </div>
      )}

      <ConversationThread
        messages={messages}
        currentUserRole="dispatcher"
        onSendMessage={handleSend}
        renderProposal={renderProposal}
      />

      {proposals.length > 0 && (
        <div className="intake-proposals" data-testid="intake-proposals">
          <h3>Generated Proposals</h3>
          {proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              userRole="dispatcher"
              onApprove={onApproveProposal}
              onReject={onRejectProposal}
            />
          ))}
        </div>
      )}
    </div>
  );
}
