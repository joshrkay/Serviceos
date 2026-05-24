/**
 * Estimate-reminder sweeper.
 *
 * Mirrors the P0-009 sweep pattern from overdue-invoice-worker.ts: a
 * cross-tenant sweep with per-tenant try/catch so one tenant's failure
 * never crashes the loop, plus a per-estimate try/catch so one bad
 * recipient doesn't skip the rest of that tenant's estimates. For each
 * tenant it finds estimates that were SENT more than `reminderAfterDays`
 * ago, are still awaiting a customer response (never viewed/accepted/
 * declined), and haven't hit the `maxReminders` cap, then re-sends the
 * estimate link via SendService and records the nudge on the estimate.
 *
 * Idempotency is two-layered: the reminder_count/last_reminder_at guard
 * caps re-sends across sweeps, and SendService's per-minute dispatch
 * idempotency key prevents a double fire within a single sweep.
 *
 * The sweep cadence is owned by app.ts (a setInterval driver). Tests
 * exercise this function directly with in-memory repos and a fixed clock.
 */
import { Logger } from '../logging/logger';
import { EstimateRepository } from '../estimates/estimate';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { SendChannel, SendService } from '../notifications/send-service';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EstimateReminderWorkerDeps {
  estimateRepo: EstimateRepository;
  sendService: SendService;
  /** Returns the list of tenant IDs to sweep. */
  listTenantIds: () => Promise<string[]>;
  logger: Logger;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
  /** Optional audit trail of each reminder. */
  auditRepo?: AuditRepository;
  /** Days a sent estimate must age before the first reminder. Default 3. */
  reminderAfterDays?: number;
  /** Max follow-up reminders per estimate. Default 1. */
  maxReminders?: number;
  /** Channel used for the nudge. Defaults to 'sms' (matches the send route). */
  channel?: SendChannel;
}

export async function runEstimateReminderSweep(
  deps: EstimateReminderWorkerDeps,
): Promise<{ tenants: number; reminders: number; failed: number }> {
  const now = deps.now ?? (() => new Date());
  const reminderAfterDays = deps.reminderAfterDays ?? 3;
  const maxReminders = deps.maxReminders ?? 1;
  const channel = deps.channel ?? 'sms';

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Estimate-reminder sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, reminders: 0, failed: 0 };
  }

  const asOf = now(); // One snapshot for the entire sweep.
  const sentBefore = new Date(asOf.getTime() - reminderAfterDays * DAY_MS);
  let reminders = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    let candidates;
    try {
      candidates = await deps.estimateRepo.findByTenant(tenantId, {
        status: 'sent',
        sentBefore,
      });
    } catch (err) {
      // Mirror overdue-invoice-worker.ts: one tenant's failure is logged
      // and swallowed so the sweep keeps going.
      failed++;
      deps.logger.warn('Estimate-reminder sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const estimate of candidates) {
      // Only nudge estimates still awaiting a customer response that
      // haven't already hit the reminder cap. (status is already 'sent',
      // but firstViewedAt/accepted/rejected are the real "they engaged"
      // signals.)
      if (estimate.firstViewedAt || estimate.acceptedAt || estimate.rejectedAt) continue;
      if ((estimate.reminderCount ?? 0) >= maxReminders) continue;
      // Space reminders by reminderAfterDays. Since sentAt is set-once (it no
      // longer advances on a re-send), gate on the last actual contact —
      // the most recent reminder, falling back to the original send.
      const lastContactAt = estimate.lastReminderAt ?? estimate.sentAt;
      if (lastContactAt && lastContactAt.getTime() >= sentBefore.getTime()) continue;

      try {
        await deps.sendService.sendEstimate({
          tenantId,
          estimateId: estimate.id,
          channel,
        });
        await deps.estimateRepo.update(tenantId, estimate.id, {
          reminderCount: (estimate.reminderCount ?? 0) + 1,
          lastReminderAt: asOf,
          updatedAt: asOf,
        });
        reminders++;
        if (deps.auditRepo) {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: 'estimate-reminder-worker',
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
      } catch (err) {
        // A single estimate's send failure (e.g. recipient has no phone,
        // delivery provider error) must not skip the rest of the tenant.
        failed++;
        deps.logger.warn('Estimate-reminder sweep: estimate failed', {
          tenantId,
          estimateId: estimate.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  deps.logger.info('Estimate-reminder sweep completed', {
    tenants: tenantIds.length,
    reminders,
    failed,
  });

  return { tenants: tenantIds.length, reminders, failed };
}
