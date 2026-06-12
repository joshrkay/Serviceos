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
 */
import type { Estimate, EstimateRepository } from './estimate';
import type { SendChannel, SendService } from '../notifications/send-service';
import { AuditRepository, createAuditEvent } from '../audit/audit';

export interface EstimateNudgeDeps {
  estimateRepo: EstimateRepository;
  sendService: Pick<SendService, 'sendEstimate'>;
  /** Optional audit trail of each nudge. */
  auditRepo?: AuditRepository;
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

/**
 * Re-send the estimate link and record the nudge. Throws when the send
 * fails (callers own failure isolation / retry semantics).
 */
export async function dispatchEstimateNudge(
  deps: EstimateNudgeDeps,
  input: DispatchEstimateNudgeInput,
): Promise<void> {
  const { tenantId, estimate, channel, asOf } = input;

  await deps.sendService.sendEstimate({
    tenantId,
    estimateId: estimate.id,
    channel,
    ...(input.customMessage !== undefined ? { customMessage: input.customMessage } : {}),
  });

  await deps.estimateRepo.update(tenantId, estimate.id, {
    reminderCount: (estimate.reminderCount ?? 0) + 1,
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
          reminderCount: (estimate.reminderCount ?? 0) + 1,
          channel,
        },
      }),
    );
  }
}
