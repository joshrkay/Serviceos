import { useEffect, useState } from 'react';
import { X, Square, Send } from 'lucide-react';
import { useLocation } from 'react-router';
import { apiFetch } from '../../utils/api-fetch';
import { AIProposalCard } from '../shared/AIProposalCard';
import type { AIProposal } from '../../data/mock-data';
import {
  derivePageVoiceContext,
  useGlobalVoice,
  type PageVoiceContext,
} from './useGlobalVoice';

interface VoiceOverlayProps {
  open: boolean;
  onClose: () => void;
}

interface AssistantChatResponse {
  message?: {
    content?: string;
    proposal?: AIProposal;
  };
}

export function VoiceOverlay({ open, onClose }: VoiceOverlayProps) {
  const location = useLocation();
  const voice = useGlobalVoice();
  const [proposal, setProposal] = useState<AIProposal | null>(null);
  const pageContext: PageVoiceContext = derivePageVoiceContext(location.pathname);

  useEffect(() => {
    if (!open) voice.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  async function submitTranscript() {
    const text = voice.transcript.trim();
    if (!text) return;

    const res = await apiFetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: text }],
        pageContext,
      }),
    });

    if (!res.ok) {
      voice.setTranscript(`${text}\n\n(Unable to reach assistant — try again.)`);
      return;
    }

    const data = (await res.json()) as AssistantChatResponse;
    const nextProposal = data.message?.proposal ?? null;
    setProposal(nextProposal);
    voice.setTranscript(data.message?.content ?? (nextProposal ? 'Proposal ready for review.' : 'Done.'));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Voice assistant"
      data-testid="voice-overlay"
    >
      <div className="w-full md:max-w-lg rounded-t-2xl md:rounded-2xl bg-white shadow-xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <p className="text-sm font-medium text-slate-900">Voice assistant</p>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {voice.error && (
            <p className="text-sm text-red-600" role="alert">
              {voice.error}
            </p>
          )}

          <div aria-live="polite" className="text-sm text-slate-700 min-h-[3rem]">
            {voice.transcript || (voice.phase === 'recording' ? 'Listening…' : 'Tap the mic to speak.')}
          </div>
          {proposal ? (
            <AIProposalCard proposal={proposal} />
          ) : null}
        </div>

        <div className="border-t border-slate-100 px-4 py-3 flex items-center gap-2">
          {voice.phase === 'idle' && (
            <button
              type="button"
              onClick={() => void voice.startRecording()}
              className="flex-1 min-h-11 rounded-xl bg-slate-900 text-white text-sm"
            >
              Start recording
            </button>
          )}
          {voice.phase === 'recording' && (
            <button
              type="button"
              onClick={() => void voice.stopRecording()}
              className="flex size-11 min-h-11 min-w-11 items-center justify-center rounded-full bg-red-500 text-white"
            >
              <Square size={16} className="fill-current" />
            </button>
          )}
          {(voice.phase === 'transcript' || voice.transcript) && (
            <button
              type="button"
              onClick={() => void submitTranscript()}
              className="flex flex-1 min-h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 text-white text-sm"
            >
              <Send size={14} /> Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
