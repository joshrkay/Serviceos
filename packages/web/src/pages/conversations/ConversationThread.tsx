import React from 'react';
import { Message, Role } from '../../types/conversation';
import { MessageBubble } from '../../components/conversations/MessageBubble';
import { SystemEvent } from '../../components/conversations/SystemEvent';
import {
  LookupEventInline,
  isLookupEventMessage,
} from '../../components/conversations/LookupEventInline';
import { MessageInput } from '../../components/conversations/MessageInput';

export interface ConversationThreadProps {
  messages: Message[];
  currentUserRole?: Role;
  onSendMessage: (content: string) => void;
  renderTranscript?: (message: Message) => React.ReactNode;
  renderClarification?: (message: Message) => React.ReactNode;
  renderProposal?: (message: Message) => React.ReactNode;
  disabled?: boolean;
  /** When provided, the composer shows an AI "Suggest reply" action. */
  onSuggestReply?: () => Promise<string>;
}

export function ConversationThread({
  messages,
  currentUserRole,
  onSendMessage,
  renderTranscript,
  renderClarification,
  renderProposal,
  disabled = false,
  onSuggestReply,
}: ConversationThreadProps) {
  const sortedMessages = [...messages].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const renderMessage = (message: Message) => {
    switch (message.messageType) {
      case 'system_event':
        // P11-001: voice lookup_events ride into the thread as
        // system_event rows tagged with `metadata.kind === 'lookup_event'`.
        // Render those with the dedicated expandable inline component;
        // everything else stays on the existing SystemEvent surface.
        if (isLookupEventMessage(message)) {
          return <LookupEventInline key={message.id} message={message} />;
        }
        return <SystemEvent key={message.id} message={message} />;
      case 'transcript':
        return renderTranscript ? (
          <React.Fragment key={message.id}>{renderTranscript(message)}</React.Fragment>
        ) : (
          <MessageBubble key={message.id} message={message} currentUserRole={currentUserRole} />
        );
      case 'clarification':
        return renderClarification ? (
          <React.Fragment key={message.id}>{renderClarification(message)}</React.Fragment>
        ) : (
          <MessageBubble key={message.id} message={message} currentUserRole={currentUserRole} />
        );
      case 'proposal':
        return renderProposal ? (
          <React.Fragment key={message.id}>{renderProposal(message)}</React.Fragment>
        ) : (
          <MessageBubble key={message.id} message={message} currentUserRole={currentUserRole} />
        );
      case 'text':
      case 'note':
      default:
        return <MessageBubble key={message.id} message={message} currentUserRole={currentUserRole} />;
    }
  };

  return (
    <div className="conversation-thread" data-testid="conversation-thread">
      <div className="conversation-messages" data-testid="conversation-messages">
        {sortedMessages.map(renderMessage)}
      </div>
      <MessageInput onSend={onSendMessage} disabled={disabled} onSuggestReply={onSuggestReply} />
    </div>
  );
}
