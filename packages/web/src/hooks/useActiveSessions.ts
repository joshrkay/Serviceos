/**
 * P12-003 — `useActiveSessions` placeholder.
 *
 * The supervisor wall WebSocket transport is not yet on `main`. Until
 * it lands, this hook returns an empty array so the
 * `CompressedSessionStrip` and the `ModeSwitchModal` (which reads the
 * active session count) can render and be unit-tested without flaky
 * network deps.
 *
 * Once the wall ships, swap this implementation to subscribe to the
 * real session channel — the public API of the hook is intentionally
 * minimal so the swap is a one-file change.
 *
 * Tests should mock this module if they need a non-empty session list
 * to drive a particular UI state (see `ModeSwitchModal.test.tsx` and
 * `CompressedSessionStrip.test.tsx`).
 */

export type SessionChannel = 'voice_inbound' | 'sms' | 'mms' | 'inapp_voice';

export interface ActiveSessionSummary {
  id: string;
  channel: SessionChannel;
  customerLabel: string;
  /** Confidence of the current draft proposal (0–1), if any. */
  confidence?: number;
  /** Seconds remaining on the auto-approve countdown, if any. */
  countdownSecs?: number;
  startedAt: string;
}

export interface UseActiveSessionsResult {
  sessions: ActiveSessionSummary[];
  /** True while the WS is connecting / waiting for the first frame. */
  isConnecting: boolean;
  /** Count of proposals currently in 'ready_for_review' across all sessions. */
  pendingProposalCount: number;
}

export function useActiveSessions(): UseActiveSessionsResult {
  // TODO(supervisor-wall): subscribe to the session channel. For now we
  // return an empty fixture so dependent components render predictably.
  return {
    sessions: [],
    isConnecting: false,
    pendingProposalCount: 0,
  };
}
