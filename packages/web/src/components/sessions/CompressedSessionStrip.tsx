/**
 * P12-003 — CompressedSessionStrip.
 *
 * Sticky top strip rendered when the operator is in 'both' mode. Shows
 * up to 4 active AI session mini-cards so the supervisor can keep an
 * eye on inbound calls while still working a job. Click a mini-card to
 * navigate to the focused session view.
 *
 * Until the supervisor wall WebSocket transport ships, the underlying
 * `useActiveSessions` hook returns an empty list and this component
 * renders a placeholder strip with the session count + a "Sessions"
 * link to /assistant. The component is intentionally a thin renderer
 * so swapping in real WS data is a one-hook change.
 */
import { NavLink } from 'react-router';
import { Mic, MessageSquare } from 'lucide-react';
import {
  useActiveSessions,
  type ActiveSessionSummary,
  type SessionChannel,
} from '../../hooks/useActiveSessions';

const MAX_VISIBLE = 4;

const CHANNEL_ICON: Record<SessionChannel, typeof Mic> = {
  voice_inbound: Mic,
  inapp_voice: Mic,
  sms: MessageSquare,
  mms: MessageSquare,
};

interface MiniCardProps {
  session: ActiveSessionSummary;
}

function MiniCard({ session }: MiniCardProps): JSX.Element {
  const Icon = CHANNEL_ICON[session.channel];
  const confidencePct =
    typeof session.confidence === 'number'
      ? Math.round(session.confidence * 100)
      : null;

  return (
    <NavLink
      to={`/sessions/${session.id}`}
      data-testid="session-mini-card"
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-white border border-slate-200 hover:border-slate-300 min-w-0"
    >
      <Icon size={12} className="text-slate-500 shrink-0" />
      <span className="text-xs text-slate-800 truncate min-w-0">
        {session.customerLabel}
      </span>
      {confidencePct !== null && (
        <span
          className="ml-auto text-[10px] text-slate-500 shrink-0"
          aria-label={`confidence ${confidencePct}%`}
        >
          {confidencePct}%
        </span>
      )}
      {typeof session.countdownSecs === 'number' && (
        <span
          className="text-[10px] text-blue-600 shrink-0"
          aria-label={`auto-approve in ${session.countdownSecs} seconds`}
        >
          {session.countdownSecs}s
        </span>
      )}
    </NavLink>
  );
}

export function CompressedSessionStrip(): JSX.Element | null {
  const { sessions, isConnecting, pendingProposalCount } = useActiveSessions();

  // Render even when empty so the operator has predictable placement +
  // a link back to the wall. Hidden entirely if connecting + nothing
  // to show would be jumpy.
  const visible = sessions.slice(0, MAX_VISIBLE);
  const overflow = Math.max(0, sessions.length - MAX_VISIBLE);

  return (
    <div
      data-testid="compressed-session-strip"
      className="flex items-center gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200 overflow-x-auto"
    >
      <span className="text-[10px] uppercase tracking-wide text-slate-500 shrink-0">
        Sessions
      </span>
      {visible.length === 0 && !isConnecting && (
        <span
          className="text-xs text-slate-500"
          data-testid="empty-session-strip"
        >
          No active AI sessions
        </span>
      )}
      {isConnecting && visible.length === 0 && (
        <span className="text-xs text-slate-400">Connecting…</span>
      )}
      {visible.map((session) => (
        <MiniCard key={session.id} session={session} />
      ))}
      {overflow > 0 && (
        <span className="text-xs text-slate-500 shrink-0">+{overflow} more</span>
      )}
      {pendingProposalCount > 0 && (
        <NavLink
          to="/assistant"
          className="ml-auto text-xs text-blue-600 shrink-0"
          data-testid="pending-proposal-link"
        >
          {pendingProposalCount} pending review
        </NavLink>
      )}
    </div>
  );
}
