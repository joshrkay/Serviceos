import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Sparkles, Send, CheckCircle2 } from 'lucide-react';
import { useApiClient } from '../../../lib/apiClient';
import { Button, Textarea, Spinner } from '../../ui';
import {
  postOnboardingTurn,
  type OnboardingTurnResponse,
} from '../../../api/onboarding-conversation';

interface ChatMessage {
  role: 'assistant' | 'user';
  text: string;
}

export interface OnboardingConversationProps {
  /**
   * Fired when the agent reaches a terminal state. The shell typically
   * refetches onboarding status so the wizard reflects the drafted
   * proposals (which the owner approves from their inbox).
   */
  onComplete?: (result: OnboardingTurnResponse) => void;
}

/**
 * Conversational onboarding — a chat front-end for the Onboarding Agent
 * FSM exposed at `POST /api/onboarding/conversation/turn`.
 *
 * The opening prompt is fetched on mount (a turn with no session/message
 * costs nothing). Each reply advances the FSM; on a terminal turn the
 * agent has emitted config-change *proposals* (never auto-applied — the
 * owner reviews them), so we surface a "drafted N changes" confirmation
 * rather than claiming the setup is live.
 */
export function OnboardingConversation({ onComplete }: OnboardingConversationProps) {
  const apiFetch = useApiClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [input, setInput] = useState('');
  const [starting, setStarting] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [proposalCount, setProposalCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Open the session on mount. A turn with no sessionId/userMessage
  // returns the assistant's opening line without consuming a turn.
  //
  // Guarded so it runs exactly once: `apiFetch` is normally a stable
  // useCallback, but if its identity ever changed (e.g. Clerk re-issuing
  // getToken) the effect would re-fire and reset the live conversation.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let alive = true;
    (async () => {
      try {
        const res = await postOnboardingTurn(apiFetch);
        if (!alive) return;
        setSessionId(res.sessionId);
        setMessages([{ role: 'assistant', text: res.assistantMessage }]);
      } catch (err) {
        if (alive) {
          setError(
            err instanceof Error ? err.message : 'Could not start the conversation.',
          );
        }
      } finally {
        if (alive) setStarting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [apiFetch]);

  // Keep the transcript pinned to the latest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || sending || completed) return;
    setError(null);
    setSending(true);
    setMessages((m) => [...m, { role: 'user', text }]);
    setInput('');
    try {
      const res = await postOnboardingTurn(apiFetch, { sessionId, userMessage: text });
      setSessionId(res.sessionId);
      setMessages((m) => [...m, { role: 'assistant', text: res.assistantMessage }]);
      if (res.completed) {
        setCompleted(true);
        setProposalCount(res.proposalIds.length);
        onComplete?.(res);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong — try again.');
      // Don't lose the operator's words: roll the optimistic bubble back
      // and restore the text so they can resend.
      setMessages((m) => m.slice(0, -1));
      setInput(text);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter sends; Shift+Enter inserts a newline (chat convention).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  if (starting) {
    return (
      <div className="flex items-center justify-center py-12 text-slate-500">
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <div className="flex flex-col rounded-2xl border border-slate-200 bg-white">
      {/* Transcript */}
      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4 max-h-[28rem]"
        aria-live="polite"
      >
        {messages.map((m, i) => (
          <div
            key={i}
            className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
          >
            <div
              className={
                m.role === 'user'
                  ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-slate-900 px-3.5 py-2 text-sm text-white whitespace-pre-wrap break-words'
                  : 'max-w-[85%] rounded-2xl rounded-bl-sm bg-slate-100 px-3.5 py-2 text-sm text-slate-800 whitespace-pre-wrap break-words'
              }
            >
              {m.text}
            </div>
          </div>
        ))}

        {sending && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-slate-100 px-3.5 py-2 text-sm text-slate-400">
              <span className="inline-flex items-center gap-1">
                <Spinner size="sm" /> thinking…
              </span>
            </div>
          </div>
        )}
      </div>

      {completed && (
        <div
          role="status"
          className="mx-4 mb-3 flex items-start gap-2 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800"
        >
          <CheckCircle2 size={18} className="mt-0.5 shrink-0" />
          <span>
            {proposalCount > 0
              ? `Setup drafted — I prepared ${proposalCount} change${
                  proposalCount === 1 ? '' : 's'
                } for you to review and approve in your inbox.`
              : 'All set — nothing needed changing.'}
          </span>
        </div>
      )}

      {error && (
        <div role="alert" className="mx-4 mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Composer */}
      {!completed && (
        <div className="flex items-end gap-2 border-t border-slate-100 p-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Type your answer…"
            aria-label="Your message to the setup assistant"
            className="flex-1 resize-none"
            disabled={sending}
          />
          <Button
            type="button"
            variant="primary"
            onClick={() => void send()}
            disabled={sending || input.trim().length === 0}
            aria-label="Send"
            className="min-h-11 shrink-0"
          >
            <Send size={16} />
          </Button>
        </div>
      )}

      <p className="flex items-center gap-1 px-4 pb-3 text-xs text-slate-400">
        <Sparkles size={12} /> The assistant drafts changes for your approval — nothing goes live until you say so.
      </p>
    </div>
  );
}
