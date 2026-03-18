import React, { useState, useCallback } from 'react';
import { Message, Proposal } from '../../types/conversation';
import { ConversationThread } from '../conversations/ConversationThread';
import { VoiceRecorder } from '../../components/voice/VoiceRecorder';
import { ProposalCard } from '../../components/conversations/ProposalCard';
import { useVoiceRecorder } from '../../components/voice/useVoiceRecorder';

const SUPPORTED_PROPOSAL_TYPES = [
  'create_customer',
  'create_job',
  'create_appointment',
] as const;

type SupportedProposalType = (typeof SUPPORTED_PROPOSAL_TYPES)[number];

function isSupportedProposalType(type: unknown): type is SupportedProposalType {
  return typeof type === 'string' && SUPPORTED_PROPOSAL_TYPES.includes(type as SupportedProposalType);
}

function getMessageProposalType(message: Message): unknown {
  return message.metadata?.proposalType ?? message.metadata?.type;
}

function getMessageProposalId(message: Message): string | null {
  const proposalId = message.metadata?.proposalId;
  return typeof proposalId === 'string' ? proposalId : null;
}

function getMessageIntakeChannel(message: Message): string {
  const channel = message.metadata?.intakeChannel;
  if (channel === 'voice' || channel === 'text') return channel;
  return 'submission';
}

function resolveProposalForMessage(message: Message, proposals: Proposal[]): { proposal?: Proposal; error?: string } {
  const mappedProposalId = getMessageProposalId(message);
  if (mappedProposalId) {
    const proposal = proposals.find((candidate) => candidate.id === mappedProposalId);
    if (!proposal) {
      return { error: `Unable to render proposal card: proposal "${mappedProposalId}" was not found.` };
    }
    if (!isSupportedProposalType(proposal.type)) {
      return { error: `Unsupported proposal type "${proposal.type}" for ${getMessageIntakeChannel(message)} intake.` };
    }
    return { proposal };
  }

  const proposalType = getMessageProposalType(message);
  if (!isSupportedProposalType(proposalType)) {
    const parsedType = typeof proposalType === 'string' ? proposalType : 'unknown';
    return { error: `Unsupported proposal type "${parsedType}" for ${getMessageIntakeChannel(message)} intake.` };
  }

  const proposal = proposals
    .filter((candidate) => candidate.type === proposalType)
    .sort((a, b) => {
      const timeDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id);
    })[0];

  if (!proposal) {
    return { error: `No ${proposalType} proposal is available for this ${getMessageIntakeChannel(message)} intake.` };
  }

  return { proposal };
}

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
  const recorder = useVoiceRecorder();
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
      const { proposal, error } = resolveProposalForMessage(message, proposals);
      if (error) {
        return (
          <div className="intake-proposal-error" data-testid="intake-proposal-error" role="alert">
            {error}
          </div>
        );
      }

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
            state={recorder.state}
            duration={recorder.duration}
            onStart={() => recorder.start()}
            onStop={() => recorder.stop()}
            onCancel={() => recorder.cancel()}
            onReRecord={() => recorder.reRecord()}
            onUpload={() => recorder.upload(onUploadVoice)}
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
