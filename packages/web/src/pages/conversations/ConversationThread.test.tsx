import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ConversationThread } from './ConversationThread';
import { Message } from '../../types/conversation';

describe('P3-001 — Core conversation thread UI', () => {
  const messages: Message[] = [
    {
      id: 'msg-1',
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      messageType: 'text',
      content: 'Hello, we need an estimate.',
      senderId: 'user-1',
      senderRole: 'dispatcher',
      createdAt: '2024-01-01T10:00:00Z',
    },
    {
      id: 'msg-2',
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      messageType: 'system_event',
      content: 'Job #123 created',
      senderId: 'system',
      senderRole: 'system',
      createdAt: '2024-01-01T10:01:00Z',
    },
    {
      id: 'msg-3',
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      messageType: 'note',
      content: 'Internal note: customer prefers morning appointments',
      senderId: 'user-2',
      senderRole: 'owner',
      createdAt: '2024-01-01T10:02:00Z',
    },
  ];

  it('happy path — renders messages in chronological order with correct type components', () => {
    const onSend = vi.fn();
    render(<ConversationThread messages={messages} onSendMessage={onSend} />);

    const thread = screen.getByTestId('conversation-thread');
    expect(thread).toBeInTheDocument();

    const bubbles = screen.getAllByTestId('message-bubble');
    expect(bubbles).toHaveLength(2); // text + note

    const systemEvents = screen.getAllByTestId('system-event');
    expect(systemEvents).toHaveLength(1);

    expect(screen.getByText('Hello, we need an estimate.')).toBeInTheDocument();
    expect(screen.getByText('Job #123 created')).toBeInTheDocument();
    expect(screen.getByText('Internal note: customer prefers morning appointments')).toBeInTheDocument();
  });

  it('happy path — renders messages sorted chronologically', () => {
    const reverseMessages = [...messages].reverse();
    const onSend = vi.fn();
    render(<ConversationThread messages={reverseMessages} onSendMessage={onSend} />);

    const allElements = screen.getByTestId('conversation-messages');
    const children = allElements.children;
    // First should be text message (10:00), then system event (10:01), then note (10:02)
    expect(children[0]).toHaveAttribute('data-testid', 'message-bubble');
    expect(children[1]).toHaveAttribute('data-testid', 'system-event');
    expect(children[2]).toHaveAttribute('data-testid', 'message-bubble');
  });

  it('happy path — sends message via MessageInput', () => {
    const onSend = vi.fn();
    render(<ConversationThread messages={[]} onSendMessage={onSend} />);

    const input = screen.getByTestId('message-input-field');
    fireEvent.change(input, { target: { value: 'Hello!' } });
    fireEvent.click(screen.getByTestId('message-send-button'));

    expect(onSend).toHaveBeenCalledWith('Hello!');
  });

  it('happy path — displays role badges on messages', () => {
    const onSend = vi.fn();
    render(<ConversationThread messages={messages} onSendMessage={onSend} />);

    const roles = screen.getAllByTestId('message-role');
    expect(roles[0]).toHaveTextContent('Dispatcher');
  });

  it('validation — empty/whitespace message input rejected', () => {
    const onSend = vi.fn();
    render(<ConversationThread messages={[]} onSendMessage={onSend} />);

    fireEvent.click(screen.getByTestId('message-send-button'));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('message-input-error')).toHaveTextContent('Message cannot be empty');

    const input = screen.getByTestId('message-input-field');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('message-send-button'));
    expect(onSend).not.toHaveBeenCalled();
  });
});
