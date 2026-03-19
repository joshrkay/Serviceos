import React, { useState, useRef } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../components/voice/useVoiceRecorder', () => ({
  useVoiceRecorder: () => {
    const [state, setState] = useState<string>('idle');
    const [duration, setDuration] = useState(0);
    const blobRef = useRef(new Blob(['test-audio'], { type: 'audio/webm' }));
    return {
      state,
      duration,
      start: () => { setState('recording'); setDuration(0); },
      stop: () => setState('stopped'),
      cancel: () => { setState('idle'); setDuration(0); },
      reRecord: () => { setState('idle'); setDuration(0); },
      getBlob: () => blobRef.current,
      upload: async (onUpload: (blob: Blob) => Promise<void>) => {
        setState('uploading');
        try {
          await onUpload(blobRef.current);
          setState('transcribing');
        } catch {
          setState('stopped');
        }
      },
    };
  },
}));

import { ConversationalIntake, validateIntakeInput } from './ConversationalIntake';
import { Message, Proposal } from '../../types/conversation';

describe('P3-009 — Dispatcher conversational intake workflow', () => {
  const baseMessages: Message[] = [
    {
      id: 'msg-1',
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      messageType: 'text',
      content: 'Customer called about HVAC repair',
      senderId: 'dispatcher-1',
      senderRole: 'dispatcher',
      createdAt: '2024-01-01T10:00:00Z',
    },
  ];

  const baseProposals: Proposal[] = [
    {
      id: 'prop-1',
      type: 'create_customer',
      summary: 'Create customer: John Smith, 555-1234',
      status: 'pending',
      details: { name: 'John Smith', phone: '555-1234' },
      createdAt: '2024-01-01T10:01:00Z',
    },
    {
      id: 'prop-2',
      type: 'create_job',
      summary: 'Create HVAC repair job',
      status: 'pending',
      details: { serviceType: 'HVAC repair' },
      createdAt: '2024-01-01T10:01:01Z',
    },
    {
      id: 'prop-3',
      type: 'create_appointment',
      summary: 'Create appointment for Jan 3 @ 10:00 AM',
      status: 'pending',
      details: { start: '2024-01-03T10:00:00Z' },
      createdAt: '2024-01-01T10:01:02Z',
    },
  ];

  it('happy path — text intake produces proposals in-thread', () => {
    const onSend = vi.fn();
    render(
      <ConversationalIntake
        messages={baseMessages}
        proposals={baseProposals}
        onSendMessage={onSend}
        onUploadVoice={vi.fn()}
        onApproveProposal={vi.fn()}
        onRejectProposal={vi.fn()}
      />
    );

    expect(screen.getByTestId('conversational-intake')).toBeInTheDocument();
    expect(screen.getByText('Customer called about HVAC repair')).toBeInTheDocument();
    expect(screen.getByTestId('intake-proposals')).toBeInTheDocument();

    const proposalCards = screen.getAllByTestId('proposal-card');
    expect(proposalCards).toHaveLength(3);
  });

  it('happy path — required create_* proposals are rendered and actionable in-thread', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const proposalMessages: Message[] = [
      {
        id: 'proposal-message-1',
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        messageType: 'proposal',
        content: 'Text intake mapped to customer creation',
        senderId: 'system-1',
        senderRole: 'dispatcher',
        metadata: { intakeChannel: 'text', proposalType: 'create_customer' },
        createdAt: '2024-01-01T10:05:00Z',
      },
      {
        id: 'proposal-message-2',
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        messageType: 'proposal',
        content: 'Voice intake mapped to job creation',
        senderId: 'system-1',
        senderRole: 'dispatcher',
        metadata: { intakeChannel: 'voice', proposalType: 'create_job' },
        createdAt: '2024-01-01T10:05:01Z',
      },
      {
        id: 'proposal-message-3',
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        messageType: 'proposal',
        content: 'Voice intake mapped to appointment creation',
        senderId: 'system-1',
        senderRole: 'dispatcher',
        metadata: { intakeChannel: 'voice', proposalType: 'create_appointment' },
        createdAt: '2024-01-01T10:05:02Z',
      },
    ];

    render(
      <ConversationalIntake
        messages={proposalMessages}
        proposals={baseProposals}
        onSendMessage={vi.fn()}
        onUploadVoice={vi.fn()}
        onApproveProposal={onApprove}
        onRejectProposal={onReject}
      />
    );

    const messagesContainer = screen.getByTestId('conversation-messages');
    expect(within(messagesContainer).getByText('Create customer: John Smith, 555-1234')).toBeInTheDocument();
    expect(within(messagesContainer).getByText('Create HVAC repair job')).toBeInTheDocument();
    expect(within(messagesContainer).getByText('Create appointment for Jan 3 @ 10:00 AM')).toBeInTheDocument();

    const inThreadApproveButtons = within(messagesContainer).getAllByTestId('proposal-approve-button');
    fireEvent.click(inThreadApproveButtons[0]);
    fireEvent.click(inThreadApproveButtons[1]);
    fireEvent.click(inThreadApproveButtons[2]);

    expect(onApprove).toHaveBeenNthCalledWith(1, 'prop-1');
    expect(onApprove).toHaveBeenNthCalledWith(2, 'prop-2');
    expect(onApprove).toHaveBeenNthCalledWith(3, 'prop-3');

    const inThreadRejectButtons = within(messagesContainer).getAllByTestId('proposal-reject-button');
    fireEvent.click(inThreadRejectButtons[0]);
    expect(onReject).toHaveBeenCalledWith('prop-1');
  });

  it('happy path — sending message calls onSendMessage', () => {
    const onSend = vi.fn();
    render(
      <ConversationalIntake
        messages={[]}
        proposals={[]}
        onSendMessage={onSend}
        onUploadVoice={vi.fn()}
        onApproveProposal={vi.fn()}
        onRejectProposal={vi.fn()}
      />
    );

    const input = screen.getByTestId('message-input-field');
    fireEvent.change(input, { target: { value: 'New customer call' } });
    fireEvent.click(screen.getByTestId('message-send-button'));
    expect(onSend).toHaveBeenCalledWith('New customer call');
  });

  it('happy path — voice toggle shows/hides voice recorder', () => {
    render(
      <ConversationalIntake
        messages={[]}
        proposals={[]}
        onSendMessage={vi.fn()}
        onUploadVoice={vi.fn()}
        onApproveProposal={vi.fn()}
        onRejectProposal={vi.fn()}
      />
    );

    expect(screen.queryByTestId('intake-voice-section')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('intake-voice-toggle'));
    expect(screen.getByTestId('intake-voice-section')).toBeInTheDocument();
  });

  it('happy path — approve/reject proposals', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <ConversationalIntake
        messages={[]}
        proposals={baseProposals}
        onSendMessage={vi.fn()}
        onUploadVoice={vi.fn()}
        onApproveProposal={onApprove}
        onRejectProposal={onReject}
      />
    );

    const approveButtons = screen.getAllByTestId('proposal-approve-button');
    fireEvent.click(approveButtons[0]);
    expect(onApprove).toHaveBeenCalledWith('prop-1');
  });

  it('validation — empty intake rejected', () => {
    expect(validateIntakeInput('')).toBe('Intake message cannot be empty');
    expect(validateIntakeInput('   ')).toBe('Intake message cannot be empty');
    expect(validateIntakeInput('Valid input')).toBeNull();
  });

  it('validation — unsupported or malformed proposal types show clear error and cannot be actioned', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const unsupportedMessages: Message[] = [
      {
        id: 'bad-proposal-message-1',
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        messageType: 'proposal',
        content: 'Unsupported create_invoice proposal',
        senderId: 'system-1',
        senderRole: 'dispatcher',
        metadata: { intakeChannel: 'text', proposalType: 'create_invoice' },
        createdAt: '2024-01-01T10:06:00Z',
      },
      {
        id: 'bad-proposal-message-2',
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        messageType: 'proposal',
        content: 'Malformed proposal type payload',
        senderId: 'system-1',
        senderRole: 'dispatcher',
        metadata: { intakeChannel: 'voice', proposalType: 42 },
        createdAt: '2024-01-01T10:06:01Z',
      },
    ];

    render(
      <ConversationalIntake
        messages={unsupportedMessages}
        proposals={[]}
        onSendMessage={vi.fn()}
        onUploadVoice={vi.fn()}
        onApproveProposal={onApprove}
        onRejectProposal={onReject}
      />
    );

    const errors = screen.getAllByTestId('intake-proposal-error');
    expect(errors).toHaveLength(2);
    expect(errors[0]).toHaveTextContent('Unsupported proposal type "create_invoice" for text intake.');
    expect(errors[1]).toHaveTextContent('Unsupported proposal type "unknown" for voice intake.');

    const messagesContainer = screen.getByTestId('conversation-messages');
    expect(within(messagesContainer).queryByTestId('proposal-approve-button')).not.toBeInTheDocument();
    expect(within(messagesContainer).queryByTestId('proposal-reject-button')).not.toBeInTheDocument();
    expect(onApprove).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });
});
