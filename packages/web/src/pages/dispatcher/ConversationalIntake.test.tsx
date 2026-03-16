import React, { useState, useRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
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
  const messages: Message[] = [
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

  const proposals: Proposal[] = [
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
  ];

  it('happy path — text intake produces proposals in-thread', () => {
    const onSend = vi.fn();
    render(
      <ConversationalIntake
        messages={messages}
        proposals={proposals}
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
    expect(proposalCards).toHaveLength(2);
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
        proposals={proposals}
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
});
