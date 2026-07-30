import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Volume2, AlertCircle, Check } from 'lucide-react';
import { useConversationVoice } from '../../../../hooks/useConversationVoice';
import { useOnboardingConversation } from '../../../../hooks/useOnboardingConversation';
import { Button, Input, Spinner, cn } from '../../../ui';

interface ConversationStepProps {
  tenantId: string;
  /** Called once when the FSM reaches a terminal state (completed/capped)
   *  so the shell can refetch onboarding status and reflect any config the
   *  conversation just proposed (e.g. the identity step flipping to done
   *  once its proposal is approved). */
  onCompleted: () => void;
  /** Switches the shell back to the form wizard. Always present — the
   *  wizard remains the default fallback and edit surface (AC-1). */
  onExit: () => void;
}

const STATE_LABELS: Record<string, string> = {
  profile_capture: 'Business profile',
  category_capture: 'Services offered',
  pricing_capture: 'Pricing',
  team_capture: 'Team',
  schedule_capture: 'Schedule',
  tools_capture: 'Tools',
  review: 'Review',
  completed: 'Done',
  capped: 'Done',
};

/**
 * B1.19 AC-1 — "talk it through" onboarding step.
 *
 * Mic capture reuses useConversationVoice (continuous STT, barge-in, 60s
 * silence timeout — the same seam AssistantPage's conversation mode uses)
 * so every settled utterance auto-submits as one turn of
 * POST /api/onboarding/conversation/turn. A typed fallback sits alongside
 * the mic at all times: mic support varies by browser/permission, and it's
 * what drives the mocked-gateway E2E script (AC-8) without a real
 * microphone in CI.
 *
 * The form wizard (IdentityStep, PackStep, …) is unaffected — this is an
 * alternate entry point the shell renders in place of a form step, never a
 * replacement for it (AC-1, B1.20 guard tests stay green).
 */
export function ConversationStep({ tenantId, onCompleted, onExit }: ConversationStepProps) {
  const { history, state, completed, sending, loading, error, sendMessage } =
    useOnboardingConversation(tenantId);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const notifiedRef = useRef(false);

  const voice = useConversationVoice({
    onSubmit: (text) => sendMessage(text),
  });

  // Speak newly-arrived assistant turns, but only while a live mic session
  // is running — replaying the whole resumed history through TTS on a
  // plain page load/refresh would be surprising and can't be interrupted
  // by barge-in (no mic open yet).
  const spokenCountRef = useRef(0);
  useEffect(() => {
    if (!voice.active) {
      spokenCountRef.current = history.length;
      return;
    }
    for (let i = spokenCountRef.current; i < history.length; i++) {
      if (history[i].role === 'assistant') voice.speak(history[i].text);
    }
    spokenCountRef.current = history.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, voice.active]);

  useEffect(() => {
    const el = listRef.current;
    // jsdom (unit tests) doesn't implement scrollTo — guard rather than
    // require every test to polyfill it.
    if (el && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [history]);

  useEffect(() => {
    if (completed && !notifiedRef.current) {
      notifiedRef.current = true;
      onCompleted();
    }
  }, [completed, onCompleted]);

  function submitDraft() {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft('');
    void sendMessage(text);
  }

  const stateLabel = state ? (STATE_LABELS[state] ?? state) : null;

  return (
    <div className="max-w-xl min-w-0 space-y-5">
      <header className="min-w-0">
        <h1 className="text-2xl font-medium tracking-tight text-slate-900">Talk it through</h1>
        <p className="mt-2 text-sm text-slate-500">
          Tell the AI about your business out loud — it&apos;ll ask follow-up questions and draft
          your setup as you go. You can switch back to the form any time.
        </p>
      </header>

      {stateLabel && !completed && (
        <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-slate-500">
          <span className="size-2 rounded-full bg-slate-900" aria-hidden="true" />
          {stateLabel}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      <div
        ref={listRef}
        data-testid="conversation-transcript"
        className="max-h-[50vh] min-h-[200px] min-w-0 space-y-3 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-4"
      >
        {loading && history.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <Spinner size="md" />
          </div>
        )}
        {history.map((turn, i) => (
          <div
            key={`${turn.role}-${i}-${turn.at}`}
            className={cn('flex min-w-0', turn.role === 'user' ? 'justify-end' : 'justify-start')}
          >
            <div
              className={cn(
                'max-w-[85%] min-w-0 break-words rounded-2xl px-4 py-2 text-sm',
                turn.role === 'user'
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-200 bg-white text-slate-800',
              )}
            >
              {turn.text}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-400">
              <span className="size-1.5 animate-pulse rounded-full bg-slate-400" />
              <span className="size-1.5 animate-pulse rounded-full bg-slate-400 [animation-delay:150ms]" />
              <span className="size-1.5 animate-pulse rounded-full bg-slate-400 [animation-delay:300ms]" />
            </div>
          </div>
        )}
      </div>

      {voice.active && (
        <div className="flex min-w-0 items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2.5">
          <Mic size={13} className="shrink-0 text-green-600" />
          <span className="min-w-0 flex-1 truncate text-sm italic text-green-800">
            {voice.partial || 'Listening…'}
          </span>
          {voice.isSpeaking && (
            <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-green-600">
              <Volume2 size={12} /> Speaking — talk to interrupt
            </span>
          )}
        </div>
      )}

      {voice.error && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{voice.error}</span>
        </div>
      )}

      {completed ? (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
            <Check size={14} />
          </div>
          <div className="min-w-0 space-y-3">
            <p className="text-sm text-emerald-800">
              Setup captured. Check your inbox to review and approve the proposals — nothing is
              written to your account until you do.
            </p>
            <Button variant="primary" size="lg" className="min-h-11" onClick={onExit}>
              Continue setup
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={voice.active ? 'secondary' : 'primary'}
              size="lg"
              className="min-h-11"
              aria-pressed={voice.active}
              disabled={!voice.supported && !voice.active}
              onClick={() => (voice.active ? voice.stop() : void voice.start())}
              leftIcon={voice.active ? <Square size={14} /> : <Mic size={14} />}
            >
              {voice.active ? 'Stop talking' : 'Start talking'}
            </Button>
            {!voice.supported && (
              <span className="min-w-0 text-xs text-slate-500">
                Mic isn&apos;t available in this browser — type your answers below instead.
              </span>
            )}
          </div>

          <form
            className="flex min-w-0 items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitDraft();
            }}
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Or type your answer…"
              aria-label="Your answer"
              className="min-h-11 min-w-0 flex-1"
              disabled={sending}
            />
            <Button
              type="submit"
              variant="outline"
              size="lg"
              className="min-h-11 shrink-0"
              disabled={!draft.trim() || sending}
              loading={sending}
            >
              Send
            </Button>
          </form>
        </>
      )}

      <button
        type="button"
        onClick={onExit}
        className="flex min-h-11 items-center text-xs text-slate-500 underline underline-offset-2 hover:text-slate-700"
      >
        Prefer the form? Switch back
      </button>
    </div>
  );
}
