/**
 * §7 Layer A — T−24h appointment reminder sweep.
 *
 * Finds confirmed appointments starting in ~24 hours and sends a
 * one-time SMS reminder per appointment (idempotent via message_dispatches).
 */
import { Logger } from '../logging/logger';
import { AppointmentRepository } from '../appointments/appointment';
import { TransactionalCommsListener } from '../notifications/transactional-comms-listener';

export interface AppointmentReminderWorkerDeps {
  appointmentRepo: AppointmentRepository;
  transactionalComms: TransactionalCommsListener;
  listTenantIds: () => Promise<string[]>;
  logger: Logger;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
}

/** Window: 23h–25h ahead of `now` (2h band around T−24h). */
const REMINDER_WINDOW_START_MS = 23 * 60 * 60 * 1000;
const REMINDER_WINDOW_END_MS = 25 * 60 * 60 * 1000;

export async function runAppointmentReminderSweep(
  deps: AppointmentReminderWorkerDeps,
): Promise<{ tenants: number; reminders: number; failed: number }> {
  const now = deps.now ?? (() => new Date());
  const asOf = now();

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Appointment-reminder sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, reminders: 0, failed: 0 };
  }

  let reminders = 0;
  let failed = 0;

  const windowStart = new Date(asOf.getTime() + REMINDER_WINDOW_START_MS);
  const windowEnd = new Date(asOf.getTime() + REMINDER_WINDOW_END_MS);

  for (const tenantId of tenantIds) {
    try {
      const appointments = await deps.appointmentRepo.findByDateRange(
        tenantId,
        windowStart,
        windowEnd,
      );

      for (const appointment of appointments) {
        if (appointment.status === 'canceled') continue;
        if (appointment.holdPendingApproval) continue;

        await deps.transactionalComms.sendAppointmentReminder(tenantId, appointment.id);
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
