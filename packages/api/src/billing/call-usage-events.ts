import type { Pool } from "pg";
import { PgBaseRepository } from "../db/pg-base";
import { samePhone } from "../voice/activation";

/**
 * Billable AI answering classification and the per-call usage ledger.
 *
 * Every second the AI spends on an inbound call is billable unless the
 * caller is the business's own owner/business phone (the setup test call).
 * Transfers and message-taking still count — the AI did the work.
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
  | { billable: false; reason: "not_inbound_call" | "own_number" };



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
      const classification = classifyCall(input, {
        ownerPhone: settings.rows[0]?.owner_phone,
        businessPhone: settings.rows[0]?.business_phone,
      });
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

  /**
   * Every billable second the tenant has recorded — the trial allowance
   * measure (a trial has no billing period of its own; the meter resets at
   * conversion because paid usage is measured per period instead).
   */
  async sumTrialBillableSeconds(tenantId: string): Promise<number> {
    return this.sumBillableSeconds(tenantId, new Date(0), new Date(8.64e15));
  }

  async sumBillableSeconds(
    tenantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{ seconds: string }>(
        `SELECT COALESCE(SUM(duration_seconds), 0)::text AS seconds
           FROM call_usage_events
          WHERE tenant_id = $1 AND billable
            AND ended_at >= $2 AND ended_at < $3`,
        [tenantId, periodStart, periodEnd],
      );
      return Number(result.rows[0]?.seconds ?? 0);
    });
  }
}
