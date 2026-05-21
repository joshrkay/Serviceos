/**
 * P8-015 — Dropped-call recovery scheduler.
 *
 * The DURABLE "queue" for the 60-second deferred recovery SMS. Rather than a
 * `setTimeout` (which is lost on restart — see the superseded B5 MVP in
 * telephony/dropped-call-recovery.ts), recovery is enqueued by inserting a row
 * into `dropped_call_recoveries` with `scheduled_for = now + 60s`. The
 * `dropped-call-worker` polls that table and sends due rows, so a server
 * restart between schedule (T=0) and send (T=60s) never drops a recovery.
 *
 * This mirrors the repo's other durable-schedule patterns (appointment
 * reminders, agreement runs): the table-with-`scheduled_for`-plus-poller IS
 * the queue. The `UNIQUE (tenant_id, voice_session_id)` constraint makes
 * scheduling idempotent — a duplicate finalize for the same session is a no-op.
 *
 * The scheduler is the trigger-site dependency the adapter DIs as
 * `droppedCallScheduler`; `schedule()` is fire-and-forget from the caller's
 * point of view and must NEVER throw into a call-teardown path.
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import type { Logger } from '../../logging/logger';
import {
  shouldRecoverDroppedCall,
  type DropDetectionInput,
} from '../../voice/recovery/detect-dropped';
import type { CallOutcome } from '../../voice/voice-service';

/** Deferred-send delay: SMS goes out ~60s after the drop is detected. */
export const RECOVERY_DELAY_MS = 60_000;

/**
 * A pending/sent recovery row. Mirrors the `dropped_call_recoveries` table
 * (migration 112). `sentAt`/`suppressedReason`/`smsMessageSid` are stamped by
 * the worker at execution time.
 */
export interface DroppedCallRecoveryRow {
  id: string;
  tenantId: string;
  voiceSessionId: string;
  callerE164: string;
  scheduledFor: Date;
  sentAt?: Date | null;
  suppressedReason?: string | null;
  smsMessageSid?: string | null;
  createdAt: Date;
}

/** What the adapter passes when a terminal session may need recovery. */
export interface ScheduleRecoveryInput {
  tenantId: string;
  voiceSessionId: string;
  callerE164: string;
  outcome: CallOutcome;
  channel: string;
}

/** Persistence port — in-memory for unit tests, Pg in production. */
export interface DroppedCallRecoveryRepository {
  /**
   * Insert a pending recovery. Idempotent on (tenantId, voiceSessionId):
   * returns the existing row (and inserts nothing) on conflict.
   */
  schedule(
    input: {
      tenantId: string;
      voiceSessionId: string;
      callerE164: string;
      scheduledFor: Date;
    },
  ): Promise<DroppedCallRecoveryRow>;
  /** Cross-tenant: due rows not yet sent or suppressed (worker drain). */
  findDue(now: Date, limit: number): Promise<DroppedCallRecoveryRow[]>;
  /** Stamp a successful send. */
  markSent(
    tenantId: string,
    id: string,
    smsMessageSid: string,
    sentAt: Date,
  ): Promise<void>;
  /** Stamp a suppression (booking_completed / rate_limited / …). */
  markSuppressed(
    tenantId: string,
    id: string,
    reason: string,
  ): Promise<void>;
}

/**
 * The trigger-site dependency. `schedule()` is the single method the adapter
 * calls; it is intentionally swallow-on-error so a recovery failure can never
 * break a call's terminal path.
 */
export class DroppedCallScheduler {
  constructor(
    private readonly repo: DroppedCallRecoveryRepository,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Schedule a recovery SMS if (and only if) the terminal session qualifies.
   * Returns the persisted row when scheduled, or null when detection rejected
   * it (wrong outcome, non-voice channel, bogus caller id). Never throws.
   */
  async schedule(input: ScheduleRecoveryInput): Promise<DroppedCallRecoveryRow | null> {
    const detection: DropDetectionInput = {
      outcome: input.outcome,
      callerE164: input.callerE164,
      channel: input.channel,
    };
    if (!shouldRecoverDroppedCall(detection)) return null;

    const scheduledFor = new Date(this.now().getTime() + RECOVERY_DELAY_MS);
    try {
      const row = await this.repo.schedule({
        tenantId: input.tenantId,
        voiceSessionId: input.voiceSessionId,
        callerE164: input.callerE164,
        scheduledFor,
      });
      this.logger.info('dropped-call recovery scheduled', {
        tenantId: input.tenantId,
        voiceSessionId: input.voiceSessionId,
        scheduledFor: scheduledFor.toISOString(),
        outcome: input.outcome,
      });
      return row;
    } catch (err) {
      this.logger.warn('dropped-call recovery scheduling failed', {
        tenantId: input.tenantId,
        voiceSessionId: input.voiceSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

/** In-memory repo for unit tests (no live Postgres in this environment). */
export class InMemoryDroppedCallRecoveryRepository
  implements DroppedCallRecoveryRepository
{
  public rows: DroppedCallRecoveryRow[] = [];
  private seq = 0;

  async schedule(input: {
    tenantId: string;
    voiceSessionId: string;
    callerE164: string;
    scheduledFor: Date;
  }): Promise<DroppedCallRecoveryRow> {
    const existing = this.rows.find(
      (r) =>
        r.tenantId === input.tenantId &&
        r.voiceSessionId === input.voiceSessionId,
    );
    if (existing) return { ...existing };
    const row: DroppedCallRecoveryRow = {
      id: `rec_${++this.seq}`,
      tenantId: input.tenantId,
      voiceSessionId: input.voiceSessionId,
      callerE164: input.callerE164,
      scheduledFor: input.scheduledFor,
      sentAt: null,
      suppressedReason: null,
      smsMessageSid: null,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async findDue(now: Date, limit: number): Promise<DroppedCallRecoveryRow[]> {
    return this.rows
      .filter(
        (r) =>
          !r.sentAt &&
          !r.suppressedReason &&
          r.scheduledFor.getTime() <= now.getTime(),
      )
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async markSent(
    tenantId: string,
    id: string,
    smsMessageSid: string,
    sentAt: Date,
  ): Promise<void> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (row) {
      row.sentAt = sentAt;
      row.smsMessageSid = smsMessageSid;
    }
  }

  async markSuppressed(
    tenantId: string,
    id: string,
    reason: string,
  ): Promise<void> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (row) row.suppressedReason = reason;
  }
}

/** Postgres-backed repo. */
export class PgDroppedCallRecoveryRepository
  extends PgBaseRepository
  implements DroppedCallRecoveryRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async schedule(input: {
    tenantId: string;
    voiceSessionId: string;
    callerE164: string;
    scheduledFor: Date;
  }): Promise<DroppedCallRecoveryRow> {
    return this.withTenant(input.tenantId, async (client) => {
      // tenant_id comes from the RLS GUC so it can never diverge from the
      // tenant context that gates the row. ON CONFLICT makes scheduling
      // idempotent per (tenant_id, voice_session_id).
      const { rows } = await client.query(
        `INSERT INTO dropped_call_recoveries
           (tenant_id, voice_session_id, caller_e164, scheduled_for)
         VALUES (current_setting('app.current_tenant_id')::uuid, $1, $2, $3)
         ON CONFLICT (tenant_id, voice_session_id) DO UPDATE
           SET voice_session_id = dropped_call_recoveries.voice_session_id
         RETURNING id, tenant_id, voice_session_id, caller_e164,
                   scheduled_for, sent_at, suppressed_reason,
                   sms_message_sid, created_at`,
        [input.voiceSessionId, input.callerE164, input.scheduledFor],
      );
      return mapRow(rows[0]);
    });
  }

  async findDue(now: Date, limit: number): Promise<DroppedCallRecoveryRow[]> {
    // Cross-tenant drain: the worker is a system process, so we read across
    // tenants via withClient and rely on the per-row tenant_id for the
    // subsequent tenant-scoped send/stamp. Documented use of withClient.
    return this.withClient(async (client) => {
      const { rows } = await client.query(
        `SELECT id, tenant_id, voice_session_id, caller_e164,
                scheduled_for, sent_at, suppressed_reason,
                sms_message_sid, created_at
           FROM dropped_call_recoveries
          WHERE sent_at IS NULL
            AND suppressed_reason IS NULL
            AND scheduled_for <= $1
          ORDER BY scheduled_for ASC
          LIMIT $2`,
        [now, limit],
      );
      return rows.map(mapRow);
    });
  }

  async markSent(
    tenantId: string,
    id: string,
    smsMessageSid: string,
    sentAt: Date,
  ): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE dropped_call_recoveries
            SET sent_at = $2, sms_message_sid = $3
          WHERE id = $1 AND sent_at IS NULL`,
        [id, sentAt, smsMessageSid],
      );
    });
  }

  async markSuppressed(
    tenantId: string,
    id: string,
    reason: string,
  ): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE dropped_call_recoveries
            SET suppressed_reason = $2
          WHERE id = $1 AND sent_at IS NULL AND suppressed_reason IS NULL`,
        [id, reason],
      );
    });
  }
}

function mapRow(row: Record<string, unknown>): DroppedCallRecoveryRow {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    voiceSessionId: String(row.voice_session_id),
    callerE164: String(row.caller_e164),
    scheduledFor: new Date(row.scheduled_for as string),
    sentAt: row.sent_at ? new Date(row.sent_at as string) : null,
    suppressedReason: (row.suppressed_reason as string | null) ?? null,
    smsMessageSid: (row.sms_message_sid as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
  };
}
