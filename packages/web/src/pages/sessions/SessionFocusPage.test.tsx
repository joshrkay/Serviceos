import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { SessionFocusPage } from './SessionFocusPage';
import type { ActiveSessionSummary, GatewayHandle } from '../../hooks/useActiveSessions';
import type { WsServerFrame } from '../../hooks/useResilientStream';

vi.mock('../../hooks/useActiveSessions', () => ({
  useActiveSessions: vi.fn(),
}));

import { useActiveSessions } from '../../hooks/useActiveSessions';

/**
 * The page reuses the supervisor wall's single client-gateway WS (the
 * provider already subscribed per session), so tests drive "live frames"
 * by invoking the listeners the page registered via gateway.onFrame.
 */
const frameListeners = new Set<(frame: WsServerFrame) => void>();

function makeGateway(status: GatewayHandle['status'] = 'open'): GatewayHandle {
  return {
    status,
    send: () => {},
    onFrame: (listener) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
  };
}

function emitFrame(frame: WsServerFrame): void {
  act(() => {
    for (const listener of Array.from(frameListeners)) listener(frame);
  });
}

function voiceEvent(
  sessionId: string,
  event: string,
  payload?: Record<string, unknown>,
  state?: string,
): WsServerFrame {
  return {
    kind: 'voice.event',
    channel: 'voice',
    sessionId,
    event,
    ...(state !== undefined ? { state } : {}),
    ...(payload !== undefined ? { payload } : {}),
  };
}

const liveSession: ActiveSessionSummary = {
  id: 'sess-1',
  channel: 'voice_inbound',
  customerLabel: 'Jane Doe',
  confidence: 0.87,
  startedAt: new Date().toISOString(),
};

function setup(
  sessions: ActiveSessionSummary[],
  { isConnecting = false, sessionId = 'sess-1' }: { isConnecting?: boolean; sessionId?: string } = {},
) {
  vi.mocked(useActiveSessions).mockReturnValue({
    sessions,
    isConnecting,
    pendingProposalCount: 0,
    gateway: makeGateway(),
  });
  return render(
    <MemoryRouter initialEntries={[`/sessions/${sessionId}`]}>
      <SessionFocusPage sessionId={sessionId} />
    </MemoryRouter>,
  );
}

describe('SessionFocusPage — focused live-session view (/sessions/:id)', () => {
  beforeEach(() => {
    vi.mocked(useActiveSessions).mockReset();
    frameListeners.clear();
  });

  it('renders channel + status header and current confidence for a live session', () => {
    setup([liveSession]);
    expect(screen.getByTestId('session-focus-page')).toBeInTheDocument();
    expect(screen.getByText(/Inbound call/i)).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText(/live/i)).toBeInTheDocument();
    expect(screen.getByText('87%')).toBeInTheDocument();
    // No ended banner while the session is live.
    expect(screen.queryByTestId('session-ended')).not.toBeInTheDocument();
  });

  it('appends agent transcript turns as voice.event frames arrive over the WS', () => {
    setup([liveSession]);
    // Agent speech rides `transition` frames as tts_play side effects.
    emitFrame(
      voiceEvent(
        'sess-1',
        'transition',
        {
          type: 'transition',
          state: 'triage',
          event: 'intent_classified',
          sideEffects: [
            { type: 'audit_log', payload: {} },
            { type: 'tts_play', payload: { text: 'Sure — what day works for you?' } },
          ],
        },
        'triage',
      ),
    );
    expect(screen.getByText('Sure — what day works for you?')).toBeInTheDocument();

    // Repair templates carry agent text too.
    emitFrame(
      voiceEvent('sess-1', 'repair_template_fired', {
        type: 'repair_template_fired',
        trigger: 'no_input',
        text: 'Sorry, I did not catch that.',
        ts: Date.now(),
      }),
    );
    expect(screen.getByText('Sorry, I did not catch that.')).toBeInTheDocument();
    expect(screen.getAllByTestId('transcript-turn')).toHaveLength(2);
  });

  it('ignores frames for other sessions', () => {
    setup([liveSession]);
    emitFrame(
      voiceEvent('other-session', 'transition', {
        type: 'transition',
        state: 'triage',
        event: 'x',
        sideEffects: [{ type: 'tts_play', payload: { text: 'Not for this page' } }],
      }),
    );
    expect(screen.queryByText('Not for this page')).not.toBeInTheDocument();
  });

  it('flips to the ended state when a terminal frame arrives, keeping the transcript', () => {
    setup([liveSession]);
    emitFrame(
      voiceEvent('sess-1', 'transition', {
        type: 'transition',
        state: 'closing',
        event: 'done',
        sideEffects: [{ type: 'tts_play', payload: { text: 'Goodbye!' } }],
      }),
    );
    emitFrame(voiceEvent('sess-1', 'ended', { type: 'ended', reason: 'hangup' }));
    expect(screen.getByTestId('session-ended')).toBeInTheDocument();
    expect(screen.getByText(/call ended/i)).toBeInTheDocument();
    // Last-known transcript stays visible after the call ends.
    expect(screen.getByText('Goodbye!')).toBeInTheDocument();
  });

  it('shows a clean "Call ended" state for an unknown/ended session id (cards can outlive sessions)', () => {
    setup([], { sessionId: 'gone-session' });
    expect(screen.getByTestId('session-ended')).toBeInTheDocument();
    expect(screen.getByText(/call ended/i)).toBeInTheDocument();
    // And a way back.
    const back = screen.getByTestId('session-back-link');
    expect(back.getAttribute('href')).toBe('/');
  });

  it('shows a connecting placeholder (not "Call ended") while the WS is still connecting', () => {
    setup([], { isConnecting: true });
    expect(screen.queryByTestId('session-ended')).not.toBeInTheDocument();
    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
  });

  it('always renders a link back to the dashboard', () => {
    setup([liveSession]);
    const back = screen.getByTestId('session-back-link');
    expect(back.getAttribute('href')).toBe('/');
  });
});
