/**
 * VoiceSessionPanel — minimal text-only UI for the in-app voice session
 * adapter (P8-009). Pairs with the useVoiceSession hook.
 *
 * - "Start session" → POST /api/voice/sessions
 * - Text input + Send → POST /api/voice/sessions/:id/input
 * - "End session" → DELETE /api/voice/sessions/:id
 * - Renders the current FSM state badge and replays TTS audio in an
 *   <audio> element (handled inside the hook).
 *
 * Real microphone capture is intentionally out of scope here — that's
 * P8-012. The point of this component is to prove the round-trip and
 * give QA something to click before the streaming-STT story lands.
 */

import { useState, FormEvent } from 'react';
import { useVoiceSession } from '../../hooks/useVoiceSession';

const STATE_COLORS: Record<string, string> = {
  idle: 'bg-slate-100 text-slate-700',
  greeting: 'bg-blue-100 text-blue-800',
  identifying: 'bg-blue-100 text-blue-800',
  ask_caller: 'bg-amber-100 text-amber-800',
  intent_capture: 'bg-violet-100 text-violet-800',
  entity_resolution: 'bg-violet-100 text-violet-800',
  intent_confirm: 'bg-emerald-100 text-emerald-800',
  proposal_draft: 'bg-emerald-100 text-emerald-800',
  closing: 'bg-emerald-100 text-emerald-800',
  escalating: 'bg-rose-100 text-rose-800',
  degraded: 'bg-amber-100 text-amber-800',
  terminated: 'bg-slate-200 text-slate-600',
};

export function VoiceSessionPanel(): JSX.Element {
  const session = useVoiceSession();
  const [draft, setDraft] = useState('');

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    const text = draft;
    setDraft('');
    void session.send(text);
  };

  const stateBadgeClass =
    session.state && STATE_COLORS[session.state]
      ? STATE_COLORS[session.state]
      : 'bg-slate-100 text-slate-700';

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Voice session (text mode)</h3>
        {session.state ? (
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${stateBadgeClass}`}>
            {session.state}
          </span>
        ) : null}
      </div>

      {session.lastTtsText ? (
        <p className="mb-3 rounded bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <span className="font-medium text-slate-500">agent:</span> {session.lastTtsText}
        </p>
      ) : null}

      {!session.sessionId ? (
        <button
          type="button"
          onClick={() => void session.start()}
          disabled={session.isStarting}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {session.isStarting ? 'Starting…' : 'Start session'}
        </button>
      ) : (
        <form onSubmit={onSubmit} className="flex gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={session.ended ? 'Session ended' : 'Type your message…'}
            disabled={session.ended || session.isSending}
            className="flex-1 rounded border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={session.ended || session.isSending || !draft.trim()}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {session.isSending ? 'Sending…' : 'Send'}
          </button>
          <button
            type="button"
            onClick={() => void session.end()}
            disabled={session.ended}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            End
          </button>
        </form>
      )}

      {session.proposalIds.length > 0 ? (
        <p className="mt-3 text-xs text-slate-500">
          Proposals queued: {session.proposalIds.length}
        </p>
      ) : null}
    </div>
  );
}

export default VoiceSessionPanel;
