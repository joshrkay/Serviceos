import React from 'react';
import { Message, Role } from '../../types/conversation';
import { MessageBubble } from '../../components/conversations/MessageBubble';
import { SystemEvent } from '../../components/conversations/SystemEvent';
import { MessageInput } from '../../components/conversations/MessageInput';

export interface ConversationThreadProps {
  messages: Message[];
  currentUserRole?: Role;
  onSendMessage: (content: string) => void;
  renderTranscript?: (message: Message) => React.ReactNode;
  renderClarification?: (message: Message) => React.ReactNode;
  renderProposal?: (message: Message) => React.ReactNode;
  disabled?: boolean;
}

export function ConversationThread({
  messages,
  currentUserRole,
  onSendMessage,
  renderTranscript,
  renderClarification,
  renderProposal,
  disabled = false,
}: ConversationThreadProps) {
  const sortedMessages = [...messages].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const renderMessage = (message: Message) => {
    switch (message.messageType) {
      case 'system_event':
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
      <MessageInput onSend={onSendMessage} disabled={disabled} />
    </div>
  );
}
