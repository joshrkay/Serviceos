/**
 * Voice-parity (Feature 7) — Postgres-backed `call_me_back` repository.
 * Tenant-scoped via RLS (`call_me_back_tasks`, migration 153).
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import {
  buildCallMeBackTask,
  CallMeBackRepository,
  CallMeBackStatus,
  CallMeBackTask,
  CreateCallMeBackInput,
} from './call-me-back';

function mapRow(row: Record<string, unknown>): CallMeBackTask {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    ...(row.session_id != null ? { sessionId: row.session_id as string } : {}),
    ...(row.call_sid != null ? { callSid: row.call_sid as string } : {}),
    callerPhone: row.caller_phone as string,
    ...(row.caller_name != null ? { callerName: row.caller_name as string } : {}),
    ...(row.callback_message != null
      ? { callbackMessage: row.callback_message as string }
      : {}),
    ...(row.intent_summary != null ? { intentSummary: row.intent_summary as string } : {}),
    reason: row.reason as string,
    status: row.status as CallMeBackStatus,
    scheduledFor: new Date(row.scheduled_for as string),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgCallMeBackRepository
  extends PgBaseRepository
  implements CallMeBackRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(input: CreateCallMeBackInput): Promise<CallMeBackTask> {
    const task = buildCallMeBackTask(input);
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO call_me_back_tasks
            (id, tenant_id, session_id, call_sid, caller_phone, caller_name,
             callback_message, intent_summary, reason, status, scheduled_for,
             created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
          RETURNING *`,
        [
          task.id,
          task.tenantId,
          task.sessionId ?? null,
          task.callSid ?? null,
          task.callerPhone,
          task.callerName ?? null,
          task.callbackMessage ?? null,
          task.intentSummary ?? null,
          task.reason,
          task.status,
          task.scheduledFor,
        ],
      );
      return mapRow(result.rows[0]);
    });
  }

  async listPending(tenantId: string): Promise<CallMeBackTask[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        // Only callbacks that are due now — a future scheduled_for stays out of
        // the sweep until its time arrives.
        `SELECT * FROM call_me_back_tasks
          WHERE tenant_id = $1 AND status = 'pending' AND scheduled_for <= NOW()
          ORDER BY scheduled_for ASC`,
        [tenantId],
      );
      return result.rows.map(mapRow);
    });
  }

  async markNotified(tenantId: string, id: string): Promise<CallMeBackTask | null> {
    // Only pending → notified. Guards against a stale pending list clobbering a
    // row a CSR completed/cancelled between listPending and here.
    return this.transition(tenantId, id, 'notified', ['pending']);
  }

  async markCompleted(tenantId: string, id: string): Promise<CallMeBackTask | null> {
    // A callback can be completed whether or not the CSR was notified first.
    return this.transition(tenantId, id, 'completed', ['pending', 'notified']);
  }

  private async transition(
    tenantId: string,
    id: string,
    status: CallMeBackStatus,
    fromStatuses: CallMeBackStatus[],
  ): Promise<CallMeBackTask | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE call_me_back_tasks
            SET status = $3, updated_at = NOW()
          WHERE tenant_id = $1 AND id = $2 AND status = ANY($4::text[])
          RETURNING *`,
        [tenantId, id, status, fromStatuses],
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }
}
