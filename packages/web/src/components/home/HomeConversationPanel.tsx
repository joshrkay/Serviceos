import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Sparkles, Send, Mic, Square, ArrowRight, MessageSquare } from 'lucide-react';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useDeepgramDictation } from '../../hooks/useDeepgramDictation';

/**
 * Story 3.1 — conversation thread panel on HomePage.
 *
 * Product decision: keep the operational dashboard AND surface the running
 * conversation as a prominent inline panel (not a full-screen replacement).
 *
 * This panel is the on-ramp into the persistent thread (AssistantPage at
 * /assistant, which persists to the conversations table and renders the
 * interactive proposal cards). It previews the most recent turns and its
 * composer hands the message off to `/assistant?q=…` — the AssistantPage's
 * existing auto-submit param — so a message started here continues the SAME
 * persisted conversation, with the full approve/edit/reject card flow living
 * in one place rather than being duplicated here.
 */

interface ApiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

interface ApiConversation {
  id: string;
  messages: ApiMessage[];
}

const PREVIEW_COUNT = 4;

export function HomeConversationPanel() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState('');

  // Same active-conversation handle the AssistantPage uses, so the preview and
  // the composer act on the one running thread. Lazy useState initializer so the
  // localStorage read runs once on mount, not on every render.
  const [conversationId] = useState<string | null>(() =>
    typeof localStorage !== 'undefined' ? localStorage.getItem('conversationId') : null,
  );
  // useDetailQuery with a null id does not fetch — empty state renders cleanly.
  const { data: conversation } = useDetailQuery<ApiConversation>(
    '/api/conversations',
    conversationId,
  );

  const messages = conversation?.messages ?? [];
  const preview = messages.slice(-PREVIEW_COUNT);

  // Story 3.2 — live dictation: interim transcripts stream into the composer
  // as they arrive; the final transcript lands in the draft for the operator
  // to review and send to the agent.
  const dictation = useDeepgramDictation({
    onPartial: (text) => setDraft(text),
    onFinal: (text) => setDraft(text),
  });

  function toggleDictation() {
    if (dictation.isRecording) dictation.stop();
    else void dictation.start();
  }

  function openThread(seed?: string) {
    const q = (seed ?? draft).trim();
    navigate(q ? `/assistant?q=${encodeURIComponent(q)}` : '/assistant');
    setDraft('');
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      openThread();
    }
  }

  return (
    <section
      data-testid="home-conversation-panel"
      className="px-4 md:px-6 py-5"
    >
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary shadow-sm">
              <Sparkles size={13} className="text-primary-foreground" />
            </span>
            <p className="text-sm text-foreground truncate">Your conversation</p>
          </div>
          <button
            type="button"
            onClick={() => openThread()}
            className="flex items-center gap-1 min-h-11 px-2 -mr-2 text-xs text-primary hover:text-primary transition-colors shrink-0"
          >
            Open <ArrowRight size={12} />
          </button>
        </div>

        {/* Preview / empty state */}
        <div className="px-4 py-4">
          {preview.length === 0 ? (
            <button
              type="button"
              onClick={() => openThread()}
              data-testid="home-conversation-empty"
              className="flex w-full items-center gap-3 rounded-xl bg-secondary border border-border px-4 py-3 text-left hover:bg-secondary transition-colors min-h-11"
            >
              <MessageSquare size={16} className="text-muted-foreground shrink-0" />
              <span className="text-sm text-muted-foreground">
                Run your business by chat or voice — ask anything or give a command.
              </span>
            </button>
          ) : (
            <div className="flex flex-col gap-2">
              {preview.map((m) =>
                m.role === 'user' ? (
                  <div key={m.id} className="flex justify-end">
                    <p className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-sm text-primary-foreground break-words">
                      {m.content}
                    </p>
                  </div>
                ) : (
                  <div key={m.id} className="flex justify-start">
                    <p className="max-w-[85%] rounded-2xl rounded-tl-sm bg-secondary border border-border px-3 py-2 text-sm text-foreground break-words">
                      {m.content}
                    </p>
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        {/* Dictation error — surfaced, never silent */}
        {dictation.error && (
          <p role="alert" className="px-4 pb-2 text-xs text-destructive">
            {dictation.error}
          </p>
        )}

        {/* Composer — hands off to the persistent thread */}
        <div className="flex items-end gap-2 px-4 pb-4">
          <div className="flex flex-1 items-center gap-2 rounded-2xl border border-border bg-secondary px-3 min-h-11">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={dictation.isRecording ? 'Listening…' : 'Ask anything or give a command…'}
              aria-label="Message the assistant"
              className="flex-1 bg-transparent text-sm text-foreground placeholder-slate-400 outline-none min-w-0 py-2"
            />
            <button
              type="button"
              onClick={toggleDictation}
              aria-label={dictation.isRecording ? 'Stop dictation' : 'Voice'}
              aria-pressed={dictation.isRecording}
              className={`flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                dictation.isRecording
                  ? 'bg-destructive/10 text-destructive'
                  : 'text-muted-foreground hover:text-primary hover:bg-primary/10'
              }`}
            >
              {dictation.isRecording ? <Square size={13} className="fill-current" /> : <Mic size={15} />}
            </button>
          </div>
          <button
            type="button"
            onClick={() => openThread()}
            disabled={draft.trim().length === 0}
            aria-label="Send"
            className={`flex size-11 shrink-0 items-center justify-center rounded-xl transition-all ${
              draft.trim().length > 0
                ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm active:scale-95'
                : 'bg-secondary text-muted-foreground cursor-not-allowed'
            }`}
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </section>
  );
}
