import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ConversationalIntake } from './ConversationalIntake';
import { Message, Proposal, ProposalStatus } from '../../types/conversation';
import { apiFetch } from '../../utils/api-fetch';

interface AssistantChatReply {
  message?: {
    content?: string;
    reasoning?: string;
    proposal?: {
      id: string;
      proposalType: string;
      payload: Record<string, unknown>;
      confidenceScore?: number;
      summary?: string;
    };
  };
  conversationId?: string;
}

const DISPATCHER_SENDER_ROLE = 'dispatcher';
const ASSISTANT_SENDER_ROLE = 'ai-assistant';

function makeMessage(params: {
  role: typeof DISPATCHER_SENDER_ROLE | typeof ASSISTANT_SENDER_ROLE;
  content: string;
  conversationId: string;
  metadata?: Record<string, unknown>;
}): Message {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: '',
    conversationId: params.conversationId,
    messageType: 'text',
    content: params.content,
    senderId: params.role === DISPATCHER_SENDER_ROLE ? 'dispatcher' : 'ai-assistant',
    senderRole: params.role,
    createdAt: new Date().toISOString(),
    metadata: params.metadata,
  };
}

/**
 * P3-009 — Dispatcher conversational intake container.
 *
 * Wraps ConversationalIntake with real API wiring:
 *   • onSendMessage → POST /api/assistant/chat with prior history
 *   • onApproveProposal → POST /api/proposals/:id/approve
 *   • onRejectProposal → POST /api/proposals/:id/reject
 *   • onUploadVoice → POST /api/voice/recordings.
 */
export function ConversationalIntakePage() {
  const [conversationId, setConversationId] = useState<string>('pending');
  const [messages, setMessages] = useState<Message[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);

  const appendMessage = (m: Message) => setMessages((prev) => [...prev, m]);

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;

      appendMessage(
        makeMessage({
          role: DISPATCHER_SENDER_ROLE,
          content: trimmed,
          conversationId,
        })
      );

      try {
        const history = messages
          .filter((m) => m.content && m.messageType === 'text')
          .map((m) => ({
            role: m.senderRole === DISPATCHER_SENDER_ROLE ? 'user' : 'assistant',
            content: m.content ?? '',
          }));

        const res = await apiFetch('/api/assistant/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [...history, { role: 'user', content: trimmed }],
            conversationId: conversationId === 'pending' ? undefined : conversationId,
          }),
        });
        if (!res.ok) throw new Error(`chat failed: ${res.status}`);

        const data = (await res.json()) as AssistantChatReply;
        if (data.conversationId && conversationId === 'pending') {
          setConversationId(data.conversationId);
        }

        const replyContent = data.message?.content ?? '(no reply)';
        appendMessage(
          makeMessage({
            role: ASSISTANT_SENDER_ROLE,
            content: replyContent,
            conversationId: data.conversationId ?? conversationId,
            metadata: data.message?.proposal
              ? {
                  proposalId: data.message.proposal.id,
                  proposalType: data.message.proposal.proposalType,
                  intakeChannel: 'text',
                }
              : { intakeChannel: 'text' },
          })
        );

        if (data.message?.proposal) {
          const p = data.message.proposal;
          setProposals((prev) => [
            ...prev,
            {
              id: p.id,
              type: p.proposalType,
              summary: p.summary ?? trimmed,
              status: 'ready_for_review' as ProposalStatus,
              details: p.payload,
              createdAt: new Date().toISOString(),
            },
          ]);
        }
      } catch (err) {
        appendMessage(
          makeMessage({
            role: ASSISTANT_SENDER_ROLE,
            content: err instanceof Error ? err.message : String(err),
            conversationId,
          })
        );
      }
    },
    [messages, conversationId]
  );

  const uploadVoice = useCallback(
    async (blob: Blob) => {
      const form = new FormData();
      form.append('file', blob, 'recording.webm');
      if (conversationId !== 'pending') form.append('conversationId', conversationId);
      try {
        const res = await apiFetch('/api/voice/recordings', { method: 'POST', body: form });
        if (!res.ok) throw new Error(`upload failed: ${res.status}`);
      } catch (err) {
        toast.error(
          `Voice note upload failed — ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    },
    [conversationId]
  );

  const approveProposal = useCallback(async (proposalId: string) => {
    try {
      const res = await apiFetch(`/api/proposals/${proposalId}/approve`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Only drop the card once the server confirmed: removing it on
      // failure showed an approval that never happened.
      setProposals((prev) => prev.filter((p) => p.id !== proposalId));
    } catch (err) {
      toast.error(
        `Couldn't approve proposal — ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }, []);

  const rejectProposal = useCallback(async (proposalId: string) => {
    try {
      const res = await apiFetch(`/api/proposals/${proposalId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'dispatcher rejected' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setProposals((prev) => prev.filter((p) => p.id !== proposalId));
    } catch (err) {
      toast.error(
        `Couldn't reject proposal — ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }, []);

  useEffect(() => {
    // Placeholder hook for future conversation-resume logic. Intentionally
    // a no-op on first mount so the intake starts from an empty thread.
  }, []);

  return (
    <ConversationalIntake
      conversationId={conversationId === 'pending' ? undefined : conversationId}
      messages={messages}
      proposals={proposals}
      onSendMessage={sendMessage}
      onUploadVoice={uploadVoice}
      onApproveProposal={approveProposal}
      onRejectProposal={rejectProposal}
    />
  );
}
