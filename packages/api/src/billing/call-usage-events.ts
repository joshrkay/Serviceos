import type { Pool } from "pg";
import { PgBaseRepository } from "../db/pg-base";
import { samePhone } from "../voice/activation";

/**
 * Billable-call classification and the per-call usage ledger.
 *
 * A call is billable when the AI answered it, it lasted at least 30 seconds,
 * and the caller is not the business's own owner/business phone. Transfers
 * and message-taking still count — the AI did the work.
 */
export interface CallFacts {
  channel: "voice_inbound" | "inapp_voice";
  usageSeconds: number;
  callerPhone?: string;
}

export interface TenantPhones {
  ownerPhone?: string | null;
  businessPhone?: string | null;
}

export type CallClassification =
  | { billable: true }
  | { billable: false; reason: "not_inbound_call" | "under_30_seconds" | "own_number" };

export type CallUsageOutcome =
  | CallClassification
  | { billable: false; reason: "repeat_within_10_minutes" };

export const MIN_BILLABLE_CALL_SECONDS = 30;
/** A same-number call starting this soon after a counted call is that call. */
export const REPEAT_CALL_WINDOW_MINUTES = 10;

export function classifyCall(
  call: CallFacts,
  phones: TenantPhones,
): CallClassification {
  if (call.channel !== "voice_inbound") {
    return { billable: false, reason: "not_inbound_call" };
  }
  if (
    samePhone(call.callerPhone, phones.ownerPhone) ||
    samePhone(call.callerPhone, phones.businessPhone)
  ) {
    return { billable: false, reason: "own_number" };
  }
  if (call.usageSeconds < MIN_BILLABLE_CALL_SECONDS) {
    return { billable: false, reason: "under_30_seconds" };
  }
  return { billable: true };
}

export interface CallEndedInput extends CallFacts {
  tenantId: string;
  /** Voice session id — a call is recorded once, ever. */
  callId: string;
  endedAt: Date;
}

export class PgCallUsageRepository extends PgBaseRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async recordCallEnded(input: CallEndedInput): Promise<void> {
    await this.withTenant(input.tenantId, async (client) => {
      const startedAt = new Date(
        input.endedAt.getTime() - input.usageSeconds * 1000,
      );
      const settings = await client.query<{
        owner_phone: string | null;
        business_phone: string | null;
      }>(
        `SELECT owner_phone, business_phone FROM tenant_settings WHERE tenant_id = $1`,
        [input.tenantId],
      );
      let classification: CallUsageOutcome = classifyCall(input, {
        ownerPhone: settings.rows[0]?.owner_phone,
        businessPhone: settings.rows[0]?.business_phone,
      });
      if (classification.billable && input.callerPhone) {
        const repeat = await client.query(
          `SELECT 1 FROM call_usage_events
            WHERE tenant_id = $1 AND caller_phone = $2 AND billable
              AND call_id <> $3
              AND ended_at <= $4
              AND ended_at >= $4 - make_interval(mins => $5)
            LIMIT 1`,
          [
            input.tenantId,
            input.callerPhone,
            input.callId,
            startedAt,
            REPEAT_CALL_WINDOW_MINUTES,
          ],
        );
        if (repeat.rowCount) {
          classification = { billable: false, reason: "repeat_within_10_minutes" };
        }
      }
      await client.query(
        `INSERT INTO call_usage_events
           (tenant_id, call_id, caller_phone, started_at, ended_at,
            duration_seconds, billable, not_billable_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, call_id) DO NOTHING`,
        [
          input.tenantId,
          input.callId,
          input.callerPhone ?? null,
          startedAt,
          input.endedAt,
          input.usageSeconds,
          classification.billable,
          classification.billable ? null : classification.reason,
        ],
      );
    });
  }

  async countBillableCalls(
    tenantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{ calls: string }>(
        `SELECT COUNT(*)::text AS calls
           FROM call_usage_events
          WHERE tenant_id = $1 AND billable
            AND ended_at >= $2 AND ended_at < $3`,
        [tenantId, periodStart, periodEnd],
      );
      return Number(result.rows[0]?.calls ?? 0);
    });
  }
}
