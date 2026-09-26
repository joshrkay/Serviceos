import type { Pool } from 'pg';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import { voiceBlocksTotal } from '../monitoring/metrics';
import { loadVoiceAgentLiveAt } from './go-live';
import { decideTrialCall, type GateReason, type SubscriptionStatus } from './trial-limits';
import { PgCallUsageRepository } from '../billing/call-usage-events';
import { PgOverageCapStore } from '../billing/overage-cap';
import { isOverageCapReached } from '../billing/call-usage-pricing';
import { readTenantBillingState } from '../billing/tenant-billing-state';

export interface VoiceGateInput {
  tenantId: string;
  callSid: string;
}

export interface VoiceGateResult {
  allowed: boolean;
  reason?: GateReason;
  /**
   * Usage caps (trial minutes, trial concurrency, paid overage cap) ring the
   * owner instead of dropping the caller: their phone, or null when none is
   * on file (the route then falls back to voicemail). Absent for other blocks.
   */
  forwardTo?: string | null;
}

export type VoiceGate = (input: VoiceGateInput) => Promise<VoiceGateResult>;

export interface VoiceGateDeps {
  pool: Pool;
  auditRepo: AuditRepository;
}

/**
 * Composes Gate A (subscription), go-live gate, and Gate B (usage caps) for
 * the telephony /voice webhook. Setup blocks return voicemail TwiML upstream;
 * usage caps forward to the owner (see VoiceGateResult.forwardTo).
 */
export function createVoiceGate(deps: VoiceGateDeps): VoiceGate {
  const ledger = new PgCallUsageRepository(deps.pool);
  const overageCaps = new PgOverageCapStore(deps.pool);
  return async ({ tenantId, callSid }) => {
    const tenant = await readTenantBillingState(deps.pool, tenantId);
    const rawStatus = tenant?.status ?? null;
    const status = normalizeStatus(rawStatus);

    if (status !== 'trialing' && status !== 'active') {
      return block(deps, {
        tenantId,
        callSid,
        reason: 'no_billing',
        rawStatus,
        usage: null,
      });
    }

    const liveAt = await loadVoiceAgentLiveAt(deps.pool, tenantId);
    if (!liveAt) {
      return block(deps, {
        tenantId,
        callSid,
        reason: 'not_live',
        rawStatus,
        usage: null,
      });
    }

    const safetyRes = await deps.pool.query<{
      e1_reviewed_script: string | null;
      owner_phone: string | null;
    }>(
      `SELECT e1_reviewed_script, owner_phone FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    const reviewedScript = safetyRes.rows[0]?.e1_reviewed_script?.trim();
    if (!reviewedScript) {
      return block(deps, {
        tenantId,
        callSid,
        reason: 'e1_script_unreviewed',
        rawStatus,
        usage: null,
      });
    }

    const forwardTo = safetyRes.rows[0]?.owner_phone?.trim() || null;

    if (status === 'trialing') {
      const concurrentRes = await deps.pool.query<{ concurrent: number }>(
        `SELECT COUNT(*)::int AS concurrent FROM voice_sessions
          WHERE tenant_id = $1 AND channel = 'voice_inbound' AND ended_at IS NULL`,
        [tenantId],
      );
      // The whole trial: every billable second recorded so far.
      const billableSecondsUsed = await ledger.sumBillableSeconds(
        tenantId,
        new Date(0),
        new Date(8.64e15),
      );
      const decision = decideTrialCall({
        billableSecondsUsed,
        concurrentCalls: concurrentRes.rows[0]?.concurrent ?? 0,
      });
      if (decision.action === 'answer') return { allowed: true };
      return block(deps, {
        tenantId,
        callSid,
        reason: decision.reason,
        rawStatus,
        usage: { billableSecondsUsed },
        forwardTo,
      });
    }

    // Paid: forward once this period's overage has reached the owner's cap
    // (one plan price by default; none if they removed it). Without a
    // mirrored period, nothing to measure.
    const period = tenant?.period ?? null;
    const cap = period ? await overageCaps.get(tenantId) : null;
    if (cap !== null && period) {
      const planId = tenant?.planId ?? 'starter';
      const billableSeconds = await ledger.sumBillableSeconds(tenantId, period.start, period.end);
      if (isOverageCapReached({ planId, billableSeconds, overageCapCents: cap })) {
        return block(deps, {
          tenantId,
          callSid,
          reason: 'overage_cap',
          rawStatus,
          usage: { billableSeconds },
          forwardTo,
        });
      }
    }
    return { allowed: true };
  };
}

async function block(
  deps: VoiceGateDeps,
  input: {
    tenantId: string;
    callSid: string;
    reason: GateReason;
    rawStatus: string | null;
    usage: Record<string, number> | null;
    forwardTo?: string | null;
  },
): Promise<VoiceGateResult> {
  voiceBlocksTotal.inc({ reason: input.reason });

  const eventType =
    input.reason === 'no_billing'
      ? 'voice_blocked_no_billing'
      : input.reason === 'not_live'
        ? 'voice_blocked_not_live'
        : input.reason === 'e1_script_unreviewed'
          ? 'voice_blocked_e1_script_unreviewed'
        : input.reason === 'overage_cap'
          ? 'voice_forwarded_overage_cap'
          : 'voice_forwarded_trial_cap';

  try {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: 'system',
        actorRole: 'system',
        eventType,
        entityType: 'voice_session',
        entityId: input.callSid,
        metadata: {
          reason: input.reason,
          subscriptionStatus: input.rawStatus,
          ...(input.usage ? { usage: input.usage } : {}),
        },
      }),
    );
  } catch {
    // Audit failures must not block the response.
  }

  return input.forwardTo === undefined
    ? { allowed: false, reason: input.reason }
    : { allowed: false, reason: input.reason, forwardTo: input.forwardTo };
}

const VALID_STATUSES = new Set(['trialing', 'active', 'past_due', 'canceled', 'incomplete']);

function normalizeStatus(raw: string | null): SubscriptionStatus {
  if (!raw) return null;
  return VALID_STATUSES.has(raw) ? (raw as SubscriptionStatus) : null;
}
