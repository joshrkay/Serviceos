import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  LookupEventInline,
  isLookupEventMessage,
} from '../LookupEventInline';
import { ConversationThread } from '../../../pages/conversations/ConversationThread';
import { Message } from '../../../types/conversation';

function makeLookupMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-lookup-1',
    tenantId: 'tenant-1',
    conversationId: 'conv-1',
    messageType: 'system_event',
    content: 'fallback content',
    senderId: 'system',
    senderRole: 'system',
    createdAt: '2026-05-02T15:00:00Z',
    metadata: {
      kind: 'lookup_event',
      intent: 'lookup_appointments',
      resultStatus: 'found',
      resultCount: 2,
      summary: 'Your next appointment is Tuesday at 1 PM for AC repair.',
      latencyMs: 312,
    },
    ...overrides,
  } as Message;
}

describe('P11-001 — LookupEventInline', () => {
  it('happy path — renders headline with intent label + count', () => {
    render(<LookupEventInline message={makeLookupMessage()} />);
    const headline = screen.getByTestId('lookup-event-headline');
    expect(headline.textContent).toContain('Customer asked about appointments');
    expect(headline.textContent).toContain('2 results');
  });

  it('expandable — clicking the headline reveals the full summary', () => {
    render(<LookupEventInline message={makeLookupMessage()} />);
    expect(screen.queryByTestId('lookup-event-summary')).toBeNull();
    fireEvent.click(screen.getByTestId('lookup-event-headline'));
    expect(screen.getByTestId('lookup-event-summary').textContent).toContain('Tuesday at 1 PM');
  });

  it('error state — renders the error headline', () => {
    render(
      <LookupEventInline
        message={makeLookupMessage({
          metadata: {
            kind: 'lookup_event',
            intent: 'lookup_balance',
            resultStatus: 'error',
            resultCount: 0,
            summary: 'oops',
            latencyMs: 1,
          },
        })}
      />,
    );
    expect(screen.getByTestId('lookup-event-headline').textContent).toContain('error');
  });

  it('predicate — isLookupEventMessage returns true only for tagged metadata', () => {
    expect(isLookupEventMessage(makeLookupMessage())).toBe(true);
    expect(
      isLookupEventMessage({
        ...makeLookupMessage(),
        metadata: { kind: 'something_else' },
      }),
    ).toBe(false);
    expect(
      isLookupEventMessage({
        ...makeLookupMessage(),
        messageType: 'text',
      }),
    ).toBe(false);
  });

  it('integration — ConversationThread renders LookupEventInline for lookup_event rows', () => {
    const messages: Message[] = [
      {
        id: 'msg-1',
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        messageType: 'system_event',
        content: 'Job created',
        senderId: 'system',
        senderRole: 'system',
        createdAt: '2026-05-02T14:00:00Z',
      },
      makeLookupMessage(),
    ];
    render(<ConversationThread messages={messages} onSendMessage={() => {}} />);
    expect(screen.getByTestId('lookup-event-inline')).toBeInTheDocument();
    expect(screen.getByTestId('system-event')).toBeInTheDocument();
  });
});
