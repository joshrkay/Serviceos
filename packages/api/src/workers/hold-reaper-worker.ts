/**
 * U6 — held-slot reaper sweep.
 *
 * Tentative holds (`hold_pending_approval = true` with a `hold_expiry_at`) are
 * created when the AI books a slot pending owner approval. If the owner never
 * approves, the hold's expiry passes but the row lingers as `scheduled`. The
 * conflict-checker / availability-finder already treat an EXPIRED hold as free
 * (lazy read-time filtering, defense in depth), but the stale row still shows
 * up in raw appointment reads. This sweep is the durable cleanup: it cancels
 * expired holds so they leave the board entirely.
 *
 * Idempotent BY CONSTRUCTION: it only ever touches rows that are still
 * `hold_pending_approval = true` AND past `hold_expiry_at`. Cancelling clears
 * the flag and flips the status to `canceled`, so the next sweep's
 * `findExpiredHolds` no longer returns the row. A second concurrent tick
 * (guarded by the leader lock in app.ts) re-finds nothing.
 */
import { Logger } from '../logging/logger';
import { AppointmentRepository } from '../appointments/appointment';
import { AuditRepository, createAuditEvent } from '../audit/audit';

export interface HoldReaperWorkerDeps {
  appointmentRepo: AppointmentRepository;
  listTenantIds: () => Promise<string[]>;
  logger: Logger;
  auditRepo?: AuditRepository;
  now?: () => Date;
}

export async function runHoldReaperSweep(
  deps: HoldReaperWorkerDeps,
): Promise<{ tenants: number; reaped: number; failed: number }> {
  const now = (deps.now ?? (() => new Date()))();

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Hold-reaper sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, reaped: 0, failed: 0 };
  }

  let reaped = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      const expired = await deps.appointmentRepo.findExpiredHolds(tenantId, now);
      for (const appt of expired) {
        const updated = await deps.appointmentRepo.update(tenantId, appt.id, {
          status: 'canceled',
          holdPendingApproval: false,
        });
        if (!updated) continue;
        reaped++;
        if (deps.auditRepo) {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: 'hold-reaper-worker',
              actorRole: 'system',
              eventType: 'appointment.hold_expired',
              entityType: 'appointment',
              entityId: appt.id,
              metadata: {
                holdExpiryAt: appt.holdExpiryAt?.toISOString() ?? null,
                jobId: appt.jobId,
                scheduledStart: appt.scheduledStart.toISOString(),
              },
            }),
          );
        }
      }
    } catch (err) {
      failed++;
      deps.logger.warn('Hold-reaper sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info('Hold-reaper sweep completed', {
    tenants: tenantIds.length,
    reaped,
    failed,
  });

  return { tenants: tenantIds.length, reaped, failed };
}
