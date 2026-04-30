/**
 * VoiceSessionPanel — P8-009
 *
 * Minimal in-app voice session UI:
 *   - Current FSM state badge
 *   - Text input + Send button (mic comes in P8-012)
 *   - TTS audio playback when ttsAudio is returned
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useVoiceSession } from '../../hooks/useVoiceSession';
import type { VoiceSessionEvent } from '../../hooks/useVoiceSession';

const STATE_LABELS: Record<string, string> = {
  idle: 'Idle',
  greeting: 'Greeting',
  identifying: 'Identifying',
  ask_caller: 'Asking for Info',
  intent_capture: 'Listening',
  entity_resolution: 'Looking Up',
  intent_confirm: 'Confirming',
  proposal_draft: 'Drafting',
  closing: 'Closing',
  escalating: 'Escalating',
  degraded: 'Degraded',
  terminated: 'Ended',
};

const STATE_COLORS: Record<string, string> = {
  idle: 'bg-gray-100 text-gray-700',
  greeting: 'bg-blue-100 text-blue-700',
  identifying: 'bg-yellow-100 text-yellow-700',
  ask_caller: 'bg-yellow-100 text-yellow-700',
  intent_capture: 'bg-green-100 text-green-700',
  entity_resolution: 'bg-purple-100 text-purple-700',
  intent_confirm: 'bg-orange-100 text-orange-700',
  proposal_draft: 'bg-blue-100 text-blue-700',
  closing: 'bg-green-100 text-green-700',
  escalating: 'bg-red-100 text-red-700',
  degraded: 'bg-red-100 text-red-700',
  terminated: 'bg-gray-100 text-gray-500',
};

export interface VoiceSessionPanelProps {
  /** When provided, the panel will auto-start a session for this conversation. */
  conversationId?: string;
  onProposalCreated?: (proposalId: string) => void;
}

export function VoiceSessionPanel({ conversationId, onProposalCreated }: VoiceSessionPanelProps) {
  const { createSession, sendInput, subscribeEvents, deleteSession } = useVoiceSession();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<string>('idle');
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'system'; text: string }>>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Start a session on mount.
  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const id = await createSession(conversationId);
        if (cancelled) return;
        setSessionId(id);

        const unsubscribe = subscribeEvents(id, (event: VoiceSessionEvent) => {
          if (event.error) {
            setError(event.error);
          } else {
            setState(event.state ?? 'idle');
          }
        });
        unsubscribeRef.current = unsubscribe;
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void start();

    return () => {
      cancelled = true;
      unsubscribeRef.current?.();
      // Clean up the session on unmount if we have one.
      // Use a fire-and-forget pattern; we can't await in cleanup.
      if (sessionId) {
        void deleteSession(sessionId);
      }
    };
    // We intentionally run this only once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = useCallback(async () => {
    if (!sessionId || !inputText.trim() || isLoading) return;

    const text = inputText.trim();
    setInputText('');
    setIsLoading(true);
    setError(null);

    setMessages((prev) => [...prev, { role: 'user', text }]);

    try {
      const result = await sendInput(sessionId, text);
      setState(result.state);

      if (result.ttsAudio) {
        // Decode base64 audio and play it.
        const binary = atob(result.ttsAudio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);

        if (!audioRef.current) {
          audioRef.current = new Audio();
        }
        audioRef.current.src = url;
        audioRef.current.onended = () => URL.revokeObjectURL(url);
        void audioRef.current.play().catch(() => {
          // Browser may block autoplay — non-fatal.
        });
      }

      if (result.proposalId && onProposalCreated) {
        onProposalCreated(result.proposalId);
      }

      if (result.state === 'terminated') {
        setMessages((prev) => [...prev, { role: 'system', text: 'Session ended.' }]);
        unsubscribeRef.current?.();
        unsubscribeRef.current = null;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, inputText, isLoading, sendInput, onProposalCreated]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const stateLabel = STATE_LABELS[state] ?? state;
  const stateColor = STATE_COLORS[state] ?? 'bg-gray-100 text-gray-700';
  const isTerminated = state === 'terminated';

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-800">Voice Session</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${stateColor}`}>
          {stateLabel}
        </span>
      </div>

      {/* Message list */}
      {messages.length > 0 && (
        <div className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-lg bg-gray-50 p-2">
          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={`text-xs ${msg.role === 'user' ? 'text-gray-800' : 'italic text-gray-500'}`}
            >
              {msg.role === 'user' ? 'You: ' : ''}
              {msg.text}
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      )}

      {/* Input */}
      {!isTerminated && (
        <div className="flex gap-2">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message…"
            disabled={isLoading || !sessionId}
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />
          <button
            onClick={() => void handleSend()}
            disabled={isLoading || !inputText.trim() || !sessionId}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isLoading ? '…' : 'Send'}
          </button>
        </div>
      )}
    </div>
  );
}
