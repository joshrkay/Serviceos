/**
 * §7 Layer A — T-24h appointment reminder sweep.
 *
 * Hourly cross-tenant sweep: appointments starting in ~24 hours receive a
 * one-shot reminder SMS/email (idempotent via dispatch idempotency keys).
 */
import { Logger } from '../logging/logger';
import { AppointmentRepository } from '../appointments/appointment';
import { TransactionalCommsService } from '../notifications/transactional-comms-service';

/** Default reminder lead time (24 hours before start). */
export const APPOINTMENT_REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

/** Window width around the target fire time (±30 minutes). */
export const APPOINTMENT_REMINDER_WINDOW_MS = 30 * 60 * 1000;

export interface AppointmentReminderWorkerDeps {
  appointmentRepo: AppointmentRepository;
  transactionalComms: TransactionalCommsService;
  listTenantIds: () => Promise<string[]>;
  logger: Logger;
  now?: () => Date;
}

export async function runAppointmentReminderSweep(
  deps: AppointmentReminderWorkerDeps,
): Promise<{ tenants: number; reminders: number; failed: number }> {
  const now = deps.now ?? (() => new Date());

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Appointment-reminder sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, reminders: 0, failed: 0 };
  }

  const asOf = now().getTime();
  const windowStart = new Date(asOf + APPOINTMENT_REMINDER_LEAD_MS - APPOINTMENT_REMINDER_WINDOW_MS);
  const windowEnd = new Date(asOf + APPOINTMENT_REMINDER_LEAD_MS + APPOINTMENT_REMINDER_WINDOW_MS);

  let reminders = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      const appointments = await deps.appointmentRepo.findByDateRange(
        tenantId,
        windowStart,
        windowEnd,
      );
      for (const appointment of appointments) {
        if (appointment.status === 'canceled' || appointment.holdPendingApproval) {
          continue;
        }
        await deps.transactionalComms.notifyReminder(tenantId, appointment.id);
        reminders++;
      }
    } catch (err) {
      failed++;
      deps.logger.warn('Appointment-reminder sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info('Appointment-reminder sweep completed', {
    tenants: tenantIds.length,
    reminders,
    failed,
  });

  return { tenants: tenantIds.length, reminders, failed };
}
