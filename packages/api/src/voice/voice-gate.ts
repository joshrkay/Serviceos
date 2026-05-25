import type { Pool } from 'pg';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import { voiceBlocksTotal } from '../monitoring/metrics';
import { loadVoiceAgentLiveAt } from './go-live';
import { loadTrialUsage } from './load-trial-usage';
import { evaluateTrialCap, type GateReason, type SubscriptionStatus } from './trial-limits';

export interface VoiceGateInput {
  tenantId: string;
  callSid: string;
}

export interface VoiceGateResult {
  allowed: boolean;
  reason?: GateReason;
}

export type VoiceGate = (input: VoiceGateInput) => Promise<VoiceGateResult>;

export interface VoiceGateDeps {
  pool: Pool;
  auditRepo: AuditRepository;
}

/**
 * Composes Gate A (subscription), go-live gate, and Gate B (trial caps) for
 * the telephony /voice webhook. Blocks return voicemail TwiML upstream.
 */
export function createVoiceGate(deps: VoiceGateDeps): VoiceGate {
  return async ({ tenantId, callSid }) => {
    const subRes = await deps.pool.query<{ subscription_status: string | null }>(
      `SELECT subscription_status FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const rawStatus = subRes.rows[0]?.subscription_status ?? null;
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

    const usage = await loadTrialUsage(deps.pool, tenantId);
    const evalResult = evaluateTrialCap({
      status,
      dailyMinutes: usage.dailyMinutes,
      trialTotalMinutes: usage.trialTotalMinutes,
      concurrentCalls: usage.concurrentCalls,
    });

    if (evalResult.allowed) return { allowed: true };

    const reason = evalResult.reason ?? 'no_billing';
    return block(deps, { tenantId, callSid, reason, rawStatus, usage });
  };
}

async function block(
  deps: VoiceGateDeps,
  input: {
    tenantId: string;
    callSid: string;
    reason: GateReason;
    rawStatus: string | null;
    usage: Awaited<ReturnType<typeof loadTrialUsage>> | null;
  },
): Promise<VoiceGateResult> {
  voiceBlocksTotal.inc({ reason: input.reason });

  const eventType =
    input.reason === 'no_billing'
      ? 'voice_blocked_no_billing'
      : input.reason === 'not_live'
        ? 'voice_blocked_not_live'
        : 'voice_blocked_trial_cap';

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

  return { allowed: false, reason: input.reason };
}

const VALID_STATUSES = new Set(['trialing', 'active', 'past_due', 'canceled', 'incomplete']);

function normalizeStatus(raw: string | null): SubscriptionStatus {
  if (!raw) return null;
  return VALID_STATUSES.has(raw) ? (raw as SubscriptionStatus) : null;
}
