import React from 'react';
import { Message, Role } from '../../types/conversation';

export interface MessageBubbleProps {
  message: Message;
  currentUserRole?: Role;
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  dispatcher: 'Dispatcher',
  technician: 'Technician',
  system: 'System',
};

export function MessageBubble({ message }: MessageBubbleProps) {
  return (
    <div
      className="message-bubble"
      data-testid="message-bubble"
      data-type={message.messageType}
    >
      <div className="message-header">
        <span className="message-sender" data-testid="message-sender">
          {message.senderId}
        </span>
        <span className="message-role-badge" data-testid="message-role">
          {ROLE_LABELS[message.senderRole] ?? message.senderRole}
        </span>
        <span className="message-time" data-testid="message-time">
          {new Date(message.createdAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="message-content" data-testid="message-content">
        {message.content}
      </div>
    </div>
  );
}
