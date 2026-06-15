/**
 * Held-slot reaper sweep (JTBD #3).
 *
 * Tentative AI-placed holds (`hold_pending_approval = true`) auto-release
 * their slot on the scheduling READ paths once `hold_expiry_at` passes
 * (see `isExpiredHold`). But the underlying row keeps `status = 'scheduled'`
 * and `hold_pending_approval = true` forever — so any RAW appointment
 * list/report (anything that doesn't apply the lazy read-time skip) keeps
 * surfacing a dead hold as if it were a live booking.
 *
 * This leader-locked, per-tenant sweep durably resolves them: every expired
 * hold is transitioned to `status = 'canceled'` with `holdPendingApproval`
 * cleared, and an `appointment.hold_expired` audit event is emitted. The
 * `scheduled → canceled` transition is permitted by the appointment
 * lifecycle (see VALID_APPOINTMENT_TRANSITIONS).
 *
 * Idempotent by construction: `findExpiredHolds` only returns rows that are
 * STILL `hold_pending_approval = true` and past expiry, so a second sweep
 * over an already-reaped row finds nothing. Errors are isolated per tenant —
 * one tenant's failure never aborts the others.
 */
import { Logger } from '../logging/logger';
import { AppointmentRepository } from '../appointments/appointment';
import { AuditRepository, createAuditEvent } from '../audit/audit';

/** Actor stamped on the reaper's audit events (a background system sweep). */
export const HOLD_REAPER_ACTOR_ID = 'system:hold-reaper';

export interface HoldReaperWorkerDeps {
  appointmentRepo: AppointmentRepository;
  auditRepo: AuditRepository;
  listTenantIds: () => Promise<string[]>;
  logger: Logger;
  now?: () => Date;
}

export async function runHoldReaperSweep(
  deps: HoldReaperWorkerDeps,
): Promise<{ tenants: number; reaped: number; failed: number }> {
  const now = deps.now ?? (() => new Date());

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Hold-reaper sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, reaped: 0, failed: 0 };
  }

  // Older repos may not implement findExpiredHolds — nothing to reap then.
  if (!deps.appointmentRepo.findExpiredHolds) {
    deps.logger.warn('Hold-reaper sweep: repository has no findExpiredHolds; skipping');
    return { tenants: tenantIds.length, reaped: 0, failed: 0 };
  }

  let reaped = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      const asOf = now();
      const expired = await deps.appointmentRepo.findExpiredHolds(tenantId, asOf);
      for (const appt of expired) {
        // Transition the dead hold to a durable canceled state and clear the
        // hold flags. `scheduled → canceled` is an allowed lifecycle move.
        const updated = await deps.appointmentRepo.update(tenantId, appt.id, {
          status: 'canceled',
          holdPendingApproval: false,
          holdExpiryAt: undefined,
          updatedAt: new Date(),
        });
        // A concurrent reaper / approval may have already resolved the row
        // (update returned null, or it's no longer a pending hold). Skip
        // emitting an audit event for a no-op — keeps the sweep idempotent.
        if (!updated) continue;

        await deps.auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: HOLD_REAPER_ACTOR_ID,
            actorRole: 'system',
            eventType: 'appointment.hold_expired',
            entityType: 'appointment',
            entityId: appt.id,
            metadata: {
              jobId: appt.jobId,
              holdExpiryAt: appt.holdExpiryAt?.toISOString(),
            },
          }),
        );
        reaped++;
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
