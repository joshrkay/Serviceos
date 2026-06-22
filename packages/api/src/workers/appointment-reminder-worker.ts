/**
 * §7 Layer A — T-24h appointment reminder sweep.
 *
 * Hourly cross-tenant sweep: appointments starting in ~24 hours receive a
 * one-shot reminder SMS/email (idempotent via dispatch idempotency keys).
 *
 * U4 — alongside the customer SMS/email, the owner's registered devices get an
 * `appointment_reminder` push (best-effort). The owner push is INDEPENDENTLY
 * idempotent across sweeps: it records its own `message_dispatches` row under a
 * SEPARATE idempotency key (`owner-push:appt-reminder:<id>`), distinct from the
 * customer reminder's key, so a re-sweep never double-pushes. The push never
 * blocks or changes the customer reminder — a resolution/notify failure is
 * swallowed.
 */
import { Logger } from '../logging/logger';
import { AppointmentRepository, Appointment } from '../appointments/appointment';
import { TransactionalCommsService } from '../notifications/transactional-comms-service';
import { JobRepository } from '../jobs/job';
import { CustomerRepository } from '../customers/customer';
import {
  SettingsRepository,
  DEFAULT_REMINDER_OFFSETS_HOURS,
  normalizeReminderOffsets,
} from '../settings/settings';
import { DispatchRepository } from '../notifications/dispatch-repository';
import { notifyOwner } from '../notifications/owner-notifications-instance';

/** Default reminder lead time (24 hours before start). */
export const APPOINTMENT_REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/** Window width around the target fire time (±30 minutes). */
export const APPOINTMENT_REMINDER_WINDOW_MS = 30 * 60 * 1000;

/** Idempotency key for the owner push — distinct from the customer reminder's. */
export function ownerReminderDispatchKey(appointmentId: string): string {
  return `owner-push:appt-reminder:${appointmentId}`;
}

export interface AppointmentReminderWorkerDeps {
  appointmentRepo: AppointmentRepository;
  transactionalComms: TransactionalCommsService;
  listTenantIds: () => Promise<string[]>;
  logger: Logger;
  now?: () => Date;
  /**
   * U4 owner push. All four are needed to resolve the owner-push context
   * (customer name + tenant-tz time label) and to gate the push idempotently.
   * Omit any → the owner push is skipped (the customer reminder is unaffected),
   * keeping pre-U4 callers and lean unit tests working unchanged.
   */
  jobRepo?: JobRepository;
  customerRepo?: CustomerRepository;
  settingsRepo?: SettingsRepository;
  dispatchRepo?: DispatchRepository;
}

/** Owner-facing display name (mirrors transactional-comms' customer label). */
function customerDisplayName(customer: {
  firstName?: string;
  lastName?: string;
  displayName?: string;
}): string {
  return (
    customer.displayName ||
    [customer.firstName, customer.lastName].filter(Boolean).join(' ') ||
    'A customer'
  );
}

/** Render an appointment start in the tenant/appointment timezone. */
function formatWhenLabel(start: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone,
    }).format(start);
  } catch {
    // Bad/unknown tz → fall back to UTC rather than failing the push.
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(start);
  }
}

/**
 * Fire the owner `appointment_reminder` push for one appointment, gated by a
 * SEPARATE owner-push dispatch key so it is independently idempotent across
 * sweeps. Best-effort: returns silently (without sending) when the owner-push
 * deps aren't wired, when the customer can't be resolved, or on any error.
 * Exported for focused unit testing of the deep seam.
 */
export async function notifyOwnerAppointmentReminder(
  tenantId: string,
  appointment: Appointment,
  deps: AppointmentReminderWorkerDeps,
): Promise<void> {
  const { jobRepo, customerRepo, settingsRepo, dispatchRepo } = deps;
  if (!jobRepo || !customerRepo || !settingsRepo || !dispatchRepo) return;

  try {
    // Idempotency gate: a prior sweep that already owner-pushed this
    // appointment recorded a row under the owner-push key. Skip if present.
    const key = ownerReminderDispatchKey(appointment.id);
    const prior = await dispatchRepo.findByEntity(
      tenantId,
      'appointment_reminder',
      appointment.id,
    );
    if (prior.some((d) => d.idempotencyKey === key)) return;

    const job = await jobRepo.findById(tenantId, appointment.jobId);
    if (!job) return;
    const customer = await customerRepo.findById(tenantId, job.customerId);
    if (!customer) return;

    const settings = await settingsRepo.findByTenant(tenantId);
    const timezone = settings?.timezone || appointment.timezone || 'UTC';

    // Record the owner-push dispatch row FIRST so a concurrent/re-run sweep
    // that loses the UNIQUE(tenant_id, idempotency_key) race (23505) skips it.
    try {
      await dispatchRepo.create({
        tenantId,
        entityType: 'appointment_reminder',
        entityId: appointment.id,
        channel: 'sms',
        recipient: 'owner-push',
        provider: 'expo',
        idempotencyKey: key,
      });
    } catch (err) {
      // A duplicate-key violation means another sweep already claimed (and
      // pushed) this appointment — don't push again.
      if ((err as { code?: string }).code === '23505') return;
      throw err;
    }

    await notifyOwner(tenantId, 'appointment_reminder', {
      appointmentId: appointment.id,
      customerName: customerDisplayName(customer),
      whenLabel: formatWhenLabel(appointment.scheduledStart, timezone),
    });
  } catch (err) {
    // Best-effort: the owner push must never disturb the customer reminder.
    deps.logger.warn('Appointment-reminder sweep: owner push failed', {
      tenantId,
      appointmentId: appointment.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Resolve a tenant's reminder cadence. Falls back to the conservative default
 * [24] when settings aren't wired or can't be read — the sweep must never fail
 * a whole tenant over a settings lookup.
 */
async function resolveReminderOffsets(
  tenantId: string,
  deps: AppointmentReminderWorkerDeps,
): Promise<number[]> {
  if (!deps.settingsRepo) return [...DEFAULT_REMINDER_OFFSETS_HOURS];
  try {
    const settings = await deps.settingsRepo.findByTenant(tenantId);
    return normalizeReminderOffsets(settings?.appointmentReminderOffsetsHours);
  } catch {
    return [...DEFAULT_REMINDER_OFFSETS_HOURS];
  }
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

  let reminders = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      // Story 10.2 — per-tenant cadence. Default [24] keeps the legacy single
      // T-24h reminder. A single offset uses the legacy (offset-agnostic)
      // idempotency key; multiple offsets key per offset so each fires once.
      const offsets = await resolveReminderOffsets(tenantId, deps);
      const singleOffset = offsets.length === 1;

      for (const offsetHours of offsets) {
        const center = asOf + offsetHours * HOUR_MS;
        const windowStart = new Date(center - APPOINTMENT_REMINDER_WINDOW_MS);
        const windowEnd = new Date(center + APPOINTMENT_REMINDER_WINDOW_MS);

        const appointments = await deps.appointmentRepo.findByDateRange(
          tenantId,
          windowStart,
          windowEnd,
        );
        for (const appointment of appointments) {
          if (appointment.status === 'canceled' || appointment.holdPendingApproval) {
            continue;
          }
          await deps.transactionalComms.notifyReminder(
            tenantId,
            appointment.id,
            singleOffset ? undefined : offsetHours,
          );
          // U4 — owner push alongside the customer reminder. Independently
          // idempotent (separate, offset-agnostic dispatch key), so a multi-
          // offset cadence still pushes the owner at most once per appointment.
          await notifyOwnerAppointmentReminder(tenantId, appointment, deps);
          reminders++;
        }
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
