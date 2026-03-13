import React from 'react';
import { Message } from '../../types/conversation';

export interface SystemEventProps {
  message: Message;
}

export function SystemEvent({ message }: SystemEventProps) {
  return (
    <div className="system-event" data-testid="system-event">
      <span className="system-event-marker" />
      <span className="system-event-text" data-testid="system-event-text">
        {message.content ?? 'System event'}
      </span>
      <span className="system-event-time" data-testid="system-event-time">
        {new Date(message.createdAt).toLocaleTimeString()}
      </span>
    </div>
  );
}
