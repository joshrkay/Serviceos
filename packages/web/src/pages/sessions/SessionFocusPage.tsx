/**
 * Focused live-session view (/sessions/:id) — where the supervisor wall's
 * CompressedSessionStrip mini-cards land.
 *
 * Read-only. Reuses the wall's existing plumbing end-to-end: session
 * identity/status/confidence come from `useActiveSessions()` (discovery via
 * GET /api/voice/sessions/active + per-session `{subscribe, channel:'voice',
 * targetId}` on the shared client-gateway WS, provider mounted in Shell),
 * and the live feed here is just a `gateway.onFrame` listener filtered to
 * this session id — no new transport, no extra socket, no extra subscribe
 * (the provider already subscribed to every discovered session).
 *
 * Transcript scope: the voice event bus carries AGENT speech text
 * (`transition` frames' tts_play side effects, `repair_template_fired`,
 * `filler_fired`, and the eval harness's `speech_outbound`) but caller turns
 * only as a text-less `transcript_received` marker (see VoiceSessionEvent in
 * packages/api/src/ai/agents/customer-calling/voice-session-store.ts), so
 * the live feed shows the agent side of the call. Confidence updates ride
 * `intent_classified` frames and are folded into the session summary by the
 * provider — this page just renders `session.confidence`.
 *
 * Ended / unknown ids render a clean "Call ended" state (mini-cards can
 * outlive their sessions), keeping any transcript captured while live.
 */
import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router';
import { ArrowLeft, Mic, MessageSquare, PhoneOff } from 'lucide-react';
import {
  useActiveSessions,
  type SessionChannel,
} from '../../hooks/useActiveSessions';
import type { WsServerFrame } from '../../hooks/useResilientStream';

const CHANNEL_LABEL: Record<SessionChannel, string> = {
  voice_inbound: 'Inbound call',
  inapp_voice: 'In-app voice',
  sms: 'SMS',
  mms: 'MMS',
};

const CHANNEL_ICON: Record<SessionChannel, typeof Mic> = {
  voice_inbound: Mic,
  inapp_voice: Mic,
  sms: MessageSquare,
  mms: MessageSquare,
};

/** Mirrors TERMINAL_VOICE_EVENTS in useActiveSessions. */
const TERMINAL_EVENTS = new Set(['ended', 'session_terminated']);

interface TranscriptTurn {
  speaker: 'agent';
  text: string;
}

/**
 * Extract renderable transcript turns from one voice.event frame. The frame
 * `payload` is the raw VoiceSessionEvent, so agent text lives in different
 * fields per event type.
 */
function turnsFromFrame(frame: Extract<WsServerFrame, { kind: 'voice.event' }>): TranscriptTurn[] {
  const payload = frame.payload ?? {};
  switch (frame.event) {
    case 'transition': {
      const sideEffects = Array.isArray(payload.sideEffects) ? payload.sideEffects : [];
      return sideEffects
        .filter(
          (fx): fx is { type: string; payload: { text: string } } =>
            typeof fx === 'object' &&
            fx !== null &&
            (fx as { type?: unknown }).type === 'tts_play' &&
            typeof (fx as { payload?: { text?: unknown } }).payload?.text === 'string',
        )
        .map((fx) => ({ speaker: 'agent' as const, text: fx.payload.text }));
    }
    case 'speech_outbound':
      return typeof payload.transcript === 'string'
        ? [{ speaker: 'agent', text: payload.transcript }]
        : [];
    case 'repair_template_fired':
      return typeof payload.text === 'string' ? [{ speaker: 'agent', text: payload.text }] : [];
    case 'filler_fired':
      return typeof payload.fillerText === 'string'
        ? [{ speaker: 'agent', text: payload.fillerText }]
        : [];
    default:
      return [];
  }
}

export interface SessionFocusPageProps {
  sessionId: string;
}

export function SessionFocusPage({ sessionId }: SessionFocusPageProps): JSX.Element {
  const { sessions, isConnecting, gateway } = useActiveSessions();
  const session = sessions.find((s) => s.id === sessionId);

  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [fsmState, setFsmState] = useState<string | null>(null);
  const [endedByFrame, setEndedByFrame] = useState(false);
  // Once we've seen the session live, its later disappearance from the
  // discovery list means the call ended — not "still loading".
  const seenLiveRef = useRef(false);
  if (session) seenLiveRef.current = true;

  useEffect(() => {
    return gateway.onFrame((frame) => {
      if (frame.kind !== 'voice.event' || frame.sessionId !== sessionId) return;
      if (typeof frame.state === 'string') setFsmState(frame.state);
      if (TERMINAL_EVENTS.has(frame.event)) {
        setEndedByFrame(true);
        return;
      }
      const next = turnsFromFrame(frame);
      if (next.length > 0) setTurns((prev) => [...prev, ...next]);
    });
  }, [gateway, sessionId]);

  const ended = endedByFrame || (!session && (seenLiveRef.current || !isConnecting));

  const backLink = (
    <NavLink
      to="/"
      data-testid="session-back-link"
      className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700"
    >
      <ArrowLeft size={14} />
      Back to dashboard
    </NavLink>
  );

  // Still discovering / WS connecting and we never saw the session: don't
  // claim the call ended yet.
  if (!session && !ended) {
    return (
      <div data-testid="session-focus-page" className="p-6 space-y-4">
        {backLink}
        <p className="text-sm text-slate-500">Connecting…</p>
      </div>
    );
  }

  const channel = session?.channel ?? 'voice_inbound';
  const Icon = ended ? PhoneOff : CHANNEL_ICON[channel];
  const confidencePct =
    typeof session?.confidence === 'number' ? Math.round(session.confidence * 100) : null;

  return (
    <div data-testid="session-focus-page" className="p-6 max-w-3xl mx-auto space-y-4">
      {backLink}

      {/* Channel + status header */}
      <div className="flex items-center gap-3 border-b border-slate-200 pb-4">
        <div className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
          <Icon size={16} className="text-slate-600" />
        </div>
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-slate-900 truncate">
            {session?.customerLabel ?? 'Caller'}
            <span className="ml-2 font-normal text-slate-500">{CHANNEL_LABEL[channel]}</span>
          </h1>
          <p className="text-xs text-slate-500">
            {ended ? 'Ended' : `Live${fsmState ? ` — ${fsmState}` : ''}`}
            {session?.startedAt && (
              <> · started {new Date(session.startedAt).toLocaleTimeString()}</>
            )}
          </p>
        </div>
        {confidencePct !== null && (
          <span
            className="ml-auto text-sm text-slate-600 shrink-0"
            aria-label={`confidence ${confidencePct}%`}
          >
            {confidencePct}%
          </span>
        )}
      </div>

      {ended && (
        <div
          data-testid="session-ended"
          className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3"
        >
          <p className="text-sm font-medium text-slate-700">Call ended</p>
          <p className="text-xs text-slate-500 mt-0.5">
            This session is no longer active. It may have finished after you opened its card.
          </p>
        </div>
      )}

      {/* Live transcript (agent side — see header comment for scope) */}
      <div data-testid="session-transcript" className="space-y-2">
        {turns.length === 0 ? (
          <p className="text-sm text-slate-400">
            {ended ? 'No transcript was captured while this view was open.' : 'Waiting for the agent to speak…'}
          </p>
        ) : (
          turns.map((turn, i) => (
            <div
              key={i}
              data-testid="transcript-turn"
              className="rounded-md bg-white border border-slate-200 px-3 py-2"
            >
              <span className="block text-[10px] uppercase tracking-wide text-slate-400">
                Agent
              </span>
              <p className="text-sm text-slate-800">{turn.text}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
