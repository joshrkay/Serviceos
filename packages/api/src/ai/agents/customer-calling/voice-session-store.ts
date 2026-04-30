/**
 * Voice Session Store — P8-009
 *
 * In-memory store for active in-app voice sessions.
 * Sessions expire after 30 minutes of inactivity (cleaned up every 5 min).
 */

import { v4 as uuidv4 } from 'uuid';
import { CallingAgentStateMachine } from './state-machine';
import { SessionCostTracker } from '../../skills/session-cost-tracker';
import type { CallingAgentChannel, CallingAgentContext } from './types';

export interface ActiveSession {
  machine: CallingAgentStateMachine;
  costTracker: SessionCostTracker;
  tenantId: string;
  channel: CallingAgentChannel;
  /** SSE push functions — each client registers one. */
  sseClients: Set<(event: string) => void>;
  lastActivityAt: number;
  /** Running turn list for summarize_session later. */
  transcript: string[];
  proposalIds: string[];
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class VoiceSessionStore {
  private sessions = new Map<string, ActiveSession>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupInterval = setInterval(() => this.sweepExpired(), CLEANUP_INTERVAL_MS);
    // Allow the process to exit even if this interval is still running.
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Create a new session and return its id.
   *
   * `context` must contain at least `sessionId`, `tenantId`, and `channel`.
   * The `retryCount` and `startedAt` fields are injected by the state machine
   * constructor — they must be omitted from the input.
   */
  create(
    tenantId: string,
    channel: CallingAgentChannel,
    context: Omit<CallingAgentContext, 'retryCount' | 'startedAt'>,
  ): string {
    const sessionId = context.sessionId || uuidv4();
    const fullContext: Omit<CallingAgentContext, 'retryCount' | 'startedAt'> = {
      ...context,
      sessionId,
      tenantId,
      channel,
    };

    const machine = new CallingAgentStateMachine(fullContext);
    const costTracker = new SessionCostTracker();

    const session: ActiveSession = {
      machine,
      costTracker,
      tenantId,
      channel,
      sseClients: new Set(),
      lastActivityAt: Date.now(),
      transcript: [],
      proposalIds: [],
    };

    this.sessions.set(sessionId, session);
    return sessionId;
  }

  get(sessionId: string): ActiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Touch the lastActivityAt timestamp for an existing session. */
  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = Date.now();
    }
  }

  private sweepExpired(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions.entries()) {
      if (session.lastActivityAt < cutoff) {
        this.sessions.delete(id);
      }
    }
  }

  /** Stop the cleanup interval (useful in tests). */
  destroy(): void {
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
