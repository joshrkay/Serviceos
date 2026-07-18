/**
 * RV-086 — shared estimate-nudge send composition.
 *
 * Extracted from the estimate-reminder worker so the `send_estimate_nudge`
 * proposal handler and the automated reminder sweep dispatch a nudge through
 * ONE path: SendService.sendEstimate (templates, view-token persistence,
 * dispatch audit rows, DNC/consent gates) + the reminder bookkeeping on the
 * estimate (reminder_count / last_reminder_at) + the `estimate.reminder_sent`
 * audit event. Keeping the composition here means the two callers can never
 * drift on what "nudging an estimate" means.
 *
 * T4-F01 — the send is claimed BEFORE `sendService.sendEstimate` runs (see
 * notifications/send-claim-ledger.ts) so a crash/restart between the send and
 * the reminder_count/last_reminder_at write can't cause the next sweep tick
 * (or a racing proposal-handler execution) to resend. The claim key is
 * per-OCCURRENCE (`estimate_nudge:{id}:{reminderCount+1}`), not per-estimate —
 * nudges are deliberately repeatable, so a later nudge at a higher
 * reminderCount is a fresh, independent claim.
 *
 * Codex P1 #2 follow-up — `sendService.sendEstimate` itself does a
 * provider-then-entity-write (estimate.sentAt/lastDispatchId/status): if that
 * internal entity write throws AFTER the provider call already succeeded, a
 * naive claim wrapper here would release the claim on the rethrow and let a
 * retry duplicate the send. We thread `withSendClaim`'s
 * `markProviderAccepted` signal into `sendEstimate` (as `onProviderAccepted`)
 * so a throw from that internal write finalizes the claim to 'sent' instead
 * of releasing it — see notifications/send-claim-ledger.ts and
 * notifications/send-service.ts's `SendEntityOptions` for the full mechanism.
 * The reminderCount/lastReminderAt bookkeeping BELOW this module owns is
 * unaffected either way: it only runs once the send has genuinely completed.
 */
import type { Pool } from 'pg';
import type { Estimate, EstimateRepository } from './estimate';
import type { SendChannel, SendService } from '../notifications/send-service';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { withSendClaim } from '../notifications/send-claim-ledger';

export interface EstimateNudgeDeps {
  estimateRepo: EstimateRepository;
  sendService: Pick<SendService, 'sendEstimate'>;
  /** Optional audit trail of each nudge. */
  auditRepo?: AuditRepository;
  /**
   * T4-F01 claim ledger pool. Null in dev/test without a DB — mirrors the
   * no-DB-no-op posture elsewhere (e.g. lifecycle-email.ts): the claim
   * wrapper is skipped entirely and the send proceeds directly, so the many
   * existing in-memory-repo unit tests without a pool are unaffected. REQUIRED
   * (not optional) so both production callers (estimate-reminder-worker
   * sweep, send_estimate_nudge proposal handler) are compiler-forced to
   * thread a real pool through rather than silently omitting it.
   */
  pool: Pool | null;
}

export interface DispatchEstimateNudgeInput {
  tenantId: string;
  estimate: Estimate;
  channel: SendChannel;
  /** Timestamp recorded as last_reminder_at. */
  asOf: Date;
  /** Actor recorded on the audit event (worker id or executing user). */
  actorId: string;
  /** Optional note appended to the outbound message. */
  customMessage?: string;
}

/** Thrown when a concurrent attempt already claimed this exact nudge occurrence. */
export class EstimateNudgeAlreadyClaimedError extends Error {
  constructor(estimateId: string, occurrence: number) {
    super(
      `Estimate nudge already in flight for estimate ${estimateId} (reminder #${occurrence}) — ` +
        'a concurrent attempt already claimed this occurrence.',
    );
    this.name = 'EstimateNudgeAlreadyClaimedError';
  }
}

/** T4-F01 claim key — per-occurrence, not per-estimate (nudges are deliberately repeatable). */
function estimateNudgeClaimKey(estimateId: string, occurrence: number): string {
  return `estimate_nudge:${estimateId}:${occurrence}`;
}

/**
 * Re-send the estimate link and record the nudge. Throws when the send
 * fails (callers own failure isolation / retry semantics), and throws
 * `EstimateNudgeAlreadyClaimedError` when a concurrent attempt already
 * claimed this exact reminder occurrence.
 */
export async function dispatchEstimateNudge(
  deps: EstimateNudgeDeps,
  input: DispatchEstimateNudgeInput,
): Promise<void> {
  const { tenantId, estimate, channel, asOf } = input;
  const occurrence = (estimate.reminderCount ?? 0) + 1;

  const sendInput = {
    tenantId,
    estimateId: estimate.id,
    channel,
    ...(input.customMessage !== undefined ? { customMessage: input.customMessage } : {}),
  };

  if (deps.pool) {
    const claimKey = estimateNudgeClaimKey(estimate.id, occurrence);
    const outcome = await withSendClaim(deps.pool, tenantId, claimKey, (markProviderAccepted) =>
      deps.sendService.sendEstimate(sendInput, { onProviderAccepted: markProviderAccepted }),
    );
    if (outcome.outcome === 'duplicate') {
      throw new EstimateNudgeAlreadyClaimedError(estimate.id, occurrence);
    }
  } else {
    await deps.sendService.sendEstimate(sendInput);
  }

  await deps.estimateRepo.update(tenantId, estimate.id, {
    reminderCount: occurrence,
    lastReminderAt: asOf,
    updatedAt: asOf,
  });

  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: input.actorId,
        actorRole: 'system',
        eventType: 'estimate.reminder_sent',
        entityType: 'estimate',
        entityId: estimate.id,
        metadata: {
          estimateNumber: estimate.estimateNumber,
          reminderCount: occurrence,
          channel,
        },
      }),
    );
  }
}
