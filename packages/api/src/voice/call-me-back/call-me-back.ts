/**
 * Voice-parity (Feature 7) — `call_me_back` task model + repository.
 *
 * A call_me_back task is created when a warm transfer to the tenant's
 * `transfer_number` fails (no-answer / busy). The AI takes a short callback
 * message from the caller, persists it here, and acknowledges the caller. The
 * async sweep (`call-me-back-worker`) then notifies the CSR.
 *
 * This is a first-class operational TASK, not a proposal: a callback is work a
 * human must do, not an AI mutation requiring approval. Backed by the
 * `call_me_back_tasks` table (migration 153), tenant-scoped via RLS.
 */
import { v4 as uuidv4 } from 'uuid';

export type CallMeBackStatus = 'pending' | 'notified' | 'completed' | 'cancelled';

export interface CallMeBackTask {
  id: string;
  tenantId: string;
  /** Originating voice session id, when known. */
  sessionId?: string;
  /** Twilio CallSid of the originating call, when known. */
  callSid?: string;
  /** E.164 number to call back. */
  callerPhone: string;
  callerName?: string;
  /** The caller's spoken callback message (what they need). */
  callbackMessage?: string;
  /** Short intent summary captured at escalation time (for the CSR). */
  intentSummary?: string;
  /** Why the callback was scheduled (default 'transfer_failed'). */
  reason: string;
  status: CallMeBackStatus;
  scheduledFor: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCallMeBackInput {
  tenantId: string;
  sessionId?: string;
  callSid?: string;
  callerPhone: string;
  callerName?: string;
  callbackMessage?: string;
  intentSummary?: string;
  /** Defaults to 'transfer_failed'. */
  reason?: string;
  /** Defaults to now. */
  scheduledFor?: Date;
}

export interface CallMeBackRepository {
  create(input: CreateCallMeBackInput): Promise<CallMeBackTask>;
  /** Pending tasks for a tenant, oldest-scheduled first. */
  listPending(tenantId: string): Promise<CallMeBackTask[]>;
  /** Transition pending → notified once the CSR has been told. Idempotent. */
  markNotified(tenantId: string, id: string): Promise<CallMeBackTask | null>;
  /** Transition → completed once the callback has been made. */
  markCompleted(tenantId: string, id: string): Promise<CallMeBackTask | null>;
}

/** Shared row builder so the in-memory + pg repos stay in shape-sync. */
export function buildCallMeBackTask(input: CreateCallMeBackInput): CallMeBackTask {
  const now = new Date();
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.callSid !== undefined ? { callSid: input.callSid } : {}),
    callerPhone: input.callerPhone,
    ...(input.callerName !== undefined ? { callerName: input.callerName } : {}),
    ...(input.callbackMessage !== undefined
      ? { callbackMessage: input.callbackMessage }
      : {}),
    ...(input.intentSummary !== undefined ? { intentSummary: input.intentSummary } : {}),
    reason: input.reason ?? 'transfer_failed',
    status: 'pending',
    scheduledFor: input.scheduledFor ?? now,
    createdAt: now,
    updatedAt: now,
  };
}

export class InMemoryCallMeBackRepository implements CallMeBackRepository {
  private readonly rows = new Map<string, CallMeBackTask>();

  async create(input: CreateCallMeBackInput): Promise<CallMeBackTask> {
    // Idempotent on (tenantId, sessionId) — mirrors the pg unique index so a
    // retried /callback-message returns the existing callback instead of a dup.
    if (input.sessionId != null) {
      const existing = Array.from(this.rows.values()).find(
        (r) => r.tenantId === input.tenantId && r.sessionId === input.sessionId,
      );
      if (existing) return { ...existing };
    }
    const task = buildCallMeBackTask(input);
    this.rows.set(task.id, task);
    return { ...task };
  }

  async listPending(tenantId: string): Promise<CallMeBackTask[]> {
    const now = Date.now();
    return Array.from(this.rows.values())
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          r.status === 'pending' &&
          r.scheduledFor.getTime() <= now,
      )
      .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())
      .map((r) => ({ ...r }));
  }

  async markNotified(tenantId: string, id: string): Promise<CallMeBackTask | null> {
    // Only pending → notified, so a stale list can't clobber a terminal row.
    return this.transition(tenantId, id, 'notified', ['pending']);
  }

  async markCompleted(tenantId: string, id: string): Promise<CallMeBackTask | null> {
    return this.transition(tenantId, id, 'completed', ['pending', 'notified']);
  }

  private transition(
    tenantId: string,
    id: string,
    status: CallMeBackStatus,
    fromStatuses: CallMeBackStatus[],
  ): CallMeBackTask | null {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    if (!fromStatuses.includes(row.status)) return null;
    row.status = status;
    row.updatedAt = new Date();
    this.rows.set(id, row);
    return { ...row };
  }
}
