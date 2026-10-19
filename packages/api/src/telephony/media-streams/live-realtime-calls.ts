/**
 * LCR-05 — the realtime (media-streams) call legs this process is carrying,
 * so shutdown can hand them to the next process instead of hanging up.
 *
 * A realtime call has no next webhook: when the process holding its stream
 * goes away, nothing follows `</Connect>` and Twilio ends the call. Voice
 * session state is process-local (VoiceSessionStore is an in-memory Map), so
 * the only way a live realtime call survives a deploy is to move it, while
 * this process is still up, to a leg that re-requests TwiML: the Gather
 * fallback. `handOffAll` asks every tracked leg to do that through its own
 * degrade (`TwilioMediaStreamAdapter.handOffForShutdown`), which is what keeps
 * the old leg from stamping a terminal outcome on a call that continues.
 *
 * The stream server adds each leg once its adapter starts and forgets it when
 * the socket closes; runShutdown calls `handOffAll` before it drains.
 */

/**
 * Upper bound on the whole shutdown hand-off. Each REST update is capped at
 * TWILIO_CALL_UPDATE_TIMEOUT_MS (3 s) on its own; the rest is headroom for the
 * credential lookup that precedes it. Taken out of the drain window.
 */
export const SHUTDOWN_HAND_OFF_TIMEOUT_MS = 5_000;

/** A leg that can move its live call off this process. Never throws. */
export interface ShutdownHandOffLeg {
  /** `true` once the call was accepted onto the Gather fallback. */
  handOffForShutdown(): Promise<boolean>;
}

export interface HandOffResult {
  /** Legs asked to hand off. */
  attempted: number;
  /** Legs whose call was accepted onto the Gather fallback within the bound. */
  handedOff: number;
}

export interface LiveRealtimeCalls {
  /** Track a live leg. Returns the function that forgets it (idempotent). */
  add(leg: ShutdownHandOffLeg): () => void;
  size(): number;
  /**
   * Hand every tracked leg off in parallel. Resolves within `timeoutMs` even
   * when a redirect hangs (each REST update is also capped on its own), so it
   * fits inside the shutdown drain window. Never rejects.
   */
  handOffAll(opts: { timeoutMs: number }): Promise<HandOffResult>;
}

export function createLiveRealtimeCalls(): LiveRealtimeCalls {
  const legs = new Set<ShutdownHandOffLeg>();
  return {
    add(leg) {
      legs.add(leg);
      return () => {
        legs.delete(leg);
      };
    },
    size: () => legs.size,
    async handOffAll({ timeoutMs }) {
      const snapshot = [...legs];
      let handedOff = 0;
      const all = Promise.allSettled(
        snapshot.map(async (leg) => {
          if (await leg.handOffForShutdown()) handedOff += 1;
        }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      try {
        await Promise.race([all, bound]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return { attempted: snapshot.length, handedOff };
    },
  };
}
