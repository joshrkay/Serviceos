import type { Pool } from 'pg';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import { voiceBlocksTotal } from '../monitoring/metrics';
import { loadTrialUsage } from './load-trial-usage';
import { evaluateTrialCap, type SubscriptionStatus } from './trial-limits';

export interface VoiceGateInput {
  tenantId: string;
  callSid: string;
}

export interface VoiceGateResult {
  allowed: boolean;
  reason?: 'no_billing' | 'trial_cap_daily' | 'trial_cap_total' | 'trial_cap_concurrent';
}

export type VoiceGate = (input: VoiceGateInput) => Promise<VoiceGateResult>;

export interface VoiceGateDeps {
  pool: Pool;
  auditRepo: AuditRepository;
}

/**
 * Composes Gate A (subscription status) and Gate B (trial usage caps) into
 * a single async hook the telephony /voice route can invoke before routing
 * to the AI. Blocks fall through to a voicemail TwiML response upstream.
 */
export function createVoiceGate(deps: VoiceGateDeps): VoiceGate {
  return async ({ tenantId, callSid }) => {
    const subRes = await deps.pool.query<{ subscription_status: string | null }>(
      `SELECT subscription_status FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const rawStatus = subRes.rows[0]?.subscription_status ?? null;
    const status = normalizeStatus(rawStatus);

    const usage = await loadTrialUsage(deps.pool, tenantId);
    const evalResult = evaluateTrialCap({
      status,
      dailyMinutes: usage.dailyMinutes,
      trialTotalMinutes: usage.trialTotalMinutes,
      concurrentCalls: usage.concurrentCalls,
    });

    if (evalResult.allowed) return { allowed: true };

    const reason = evalResult.reason ?? 'no_billing';
    voiceBlocksTotal.inc({ reason });

    const eventType =
      reason === 'no_billing' ? 'voice_blocked_no_billing' : 'voice_blocked_trial_cap';
    try {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: 'system',
          actorRole: 'system',
          eventType,
          entityType: 'voice_session',
          entityId: callSid,
          metadata: { reason, subscriptionStatus: rawStatus, usage },
        }),
      );
    } catch {
      // Audit failures must not block the response.
    }

    return { allowed: false, reason };
  };
}

const VALID_STATUSES = new Set(['trialing', 'active', 'past_due', 'canceled', 'incomplete']);

function normalizeStatus(raw: string | null): SubscriptionStatus {
  if (!raw) return null;
  return VALID_STATUSES.has(raw) ? (raw as SubscriptionStatus) : null;
}
