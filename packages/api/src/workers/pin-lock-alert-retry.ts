/**
 * #1238 — consumer of the durable PIN-lock owner-alert retry
 * (see ai/tasks/voice-approval-pin-lock-alert.ts for the why).
 */
import type { Logger } from '../logging/logger';
import type { Queue, WorkerHandler } from '../queues/queue';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import type { VoiceApprovalPinLockAlertRepository } from '../settings/voice-approval-pin-lock-alert';
import {
  PIN_LOCK_ALERT_RETRY_DELAYS_MS,
  PIN_LOCK_ALERT_RETRY_JOB_TYPE,
  pinLockAlertBody,
  pinLockAlertRetryKey,
  type PinLockAlertRetryJob,
  type PinLockAlertRetryScheduler,
} from '../ai/tasks/voice-approval-pin-lock-alert';

export interface PinLockAlertRetryWorkerDeps {
  queue: Pick<Queue, 'send'>;
  alertRepo: Pick<VoiceApprovalPinLockAlertRepository, 'isSent' | 'markSent'>;
  auditRepo?: Pick<AuditRepository, 'create'>;
  sendSms: (to: string, body: string) => Promise<void>;
  resolveOwnerPhone: (tenantId: string) => Promise<string | null | undefined>;
}

function isJob(p: unknown): p is PinLockAlertRetryJob {
  const j = p as Partial<PinLockAlertRetryJob> | null;
  return (
    !!j &&
    typeof j.tenantId === 'string' &&
    typeof j.episodeKey === 'string' &&
    typeof j.strikeCount === 'number' &&
    typeof j.attempt === 'number'
  );
}

export const PIN_LOCK_ALERT_RETRIED_EVENT = 'proposal.voice_approval_tenant_lock_alert_retried';

async function auditAttempt(
  deps: PinLockAlertRetryWorkerDeps,
  log: Logger,
  job: PinLockAlertRetryJob,
  smsSent: boolean,
  exhausted: boolean,
): Promise<void> {
  if (!deps.auditRepo) return;
  try {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: job.tenantId,
        actorId: 'system:pin-lock-alert-retry',
        actorRole: 'system',
        eventType: PIN_LOCK_ALERT_RETRIED_EVENT,
        entityType: 'voice_approval_pin_lock_alert',
        entityId: job.episodeKey,
        metadata: { attempt: job.attempt, strikeCount: job.strikeCount, smsSent, exhausted },
      }),
    );
  } catch (err) {
    log.warn('pin-lock alert retry: audit write failed', {
      tenantId: job.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function createPinLockAlertRetryWorker(
  deps: PinLockAlertRetryWorkerDeps,
): WorkerHandler<PinLockAlertRetryJob> {
  return {
    type: PIN_LOCK_ALERT_RETRY_JOB_TYPE,
    async handle(message, log: Logger): Promise<void> {
      const job: unknown = message.payload;
      if (!isJob(job)) {
        log.error('pin-lock alert retry: malformed payload — dropping', { idempotencyKey: message.idempotencyKey });
        return;
      }
      if (await deps.alertRepo.isSent(job.tenantId, job.episodeKey)) return;

      // Continuation FIRST (emergency-page ladder pattern): if it cannot be
      // enqueued the step throws and the queue redelivers it before any text.
      // The next job re-checks sent_at, so a success below makes it a no-op.
      const nextDelayMs = PIN_LOCK_ALERT_RETRY_DELAYS_MS[job.attempt];
      if (nextDelayMs !== undefined) {
        const next: PinLockAlertRetryJob = { ...job, attempt: job.attempt + 1 };
        await deps.queue.send(PIN_LOCK_ALERT_RETRY_JOB_TYPE, next, pinLockAlertRetryKey(next), {
          delaySeconds: nextDelayMs / 1000,
        });
      }

      let smsSent = false;
      try {
        const to = await deps.resolveOwnerPhone(job.tenantId);
        if (!to) throw new Error('no owner phone on file');
        await deps.sendSms(to, pinLockAlertBody(job.strikeCount));
        smsSent = true;
      } catch (err) {
        log.warn('pin-lock alert retry: send failed', {
          tenantId: job.tenantId,
          attempt: job.attempt,
          willRetry: nextDelayMs !== undefined,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (smsSent) await deps.alertRepo.markSent(job.tenantId, job.episodeKey);
      await auditAttempt(deps, log, job, smsSent, !smsSent && nextDelayMs === undefined);
    },
  };
}

/** Production scheduler: a delayed job on the shared queue, keyed per attempt. */
export function createPinLockAlertRetryScheduler(queue: Pick<Queue, 'send'>): PinLockAlertRetryScheduler {
  return {
    schedule: async (job) => {
      const delayMs = PIN_LOCK_ALERT_RETRY_DELAYS_MS[job.attempt - 1] ?? PIN_LOCK_ALERT_RETRY_DELAYS_MS[0]!;
      await queue.send(PIN_LOCK_ALERT_RETRY_JOB_TYPE, job, pinLockAlertRetryKey(job), {
        delaySeconds: delayMs / 1000,
      });
    },
  };
}
