/**
 * Technician assignment notifications (Epic 6 — stories 6.1 / 6.3 / 6.8).
 *
 * When a technician is assigned to (or moved off) an appointment, push an
 * in-app notification to THAT technician's devices — "New job assigned" with
 * the customer, time, and service; a tap opens their day view. This is the
 * in-app channel; the SMS channel is intentionally deferred (a staff-SMS
 * delivery decision, not built here).
 *
 * Wiring: producers call the process-wide {@link notifyTechnicianAssignmentChange}
 * accessor (mirrors `notifyOwner`) from inside assignTechnician / unassignTechnician,
 * so every assign path (appointment create, reassignment, crew) is covered with
 * no dependency threading. Failure-isolated: a missing service or a resolution
 * error NEVER propagates into the assignment write that triggered it.
 *
 * Targeting note: device tokens are keyed by the Clerk user id, but an
 * assignment carries the internal users.id — so we resolve technicianId →
 * clerkUserId via the user repo before targeting.
 */
import type { NotificationType } from '@ai-service-os/shared';
import type { AppointmentRepository } from './appointment';
import type { JobRepository } from '../jobs/job';
import type { CustomerRepository } from '../customers/customer';
import type { UserRepository } from '../users/user';
import type {
  NotificationContextMap,
} from '../notifications/owner-notification-service';
import type { Logger } from '../logging/logger';

export type AssignmentChangeKind = 'assigned' | 'unassigned';

export interface TechnicianAssignmentChange {
  tenantId: string;
  appointmentId: string;
  /** Internal users.id of the technician whose assignment changed. */
  technicianId: string;
  kind: AssignmentChangeKind;
}

/** The narrow slice of the notification service this producer needs. */
export interface UserNotifier {
  notifyUser<K extends NotificationType>(
    tenantId: string,
    userId: string,
    type: K,
    ctx: NotificationContextMap[K],
  ): Promise<void>;
}

export interface TechnicianAssignmentNotifierDeps {
  appointmentRepo: Pick<AppointmentRepository, 'findById'>;
  jobRepo: Pick<JobRepository, 'findById'>;
  customerRepo: Pick<CustomerRepository, 'findById'>;
  userRepo: Pick<UserRepository, 'findById'>;
  notifier: UserNotifier;
  logger?: Logger;
}

/** Render the appointment instant in its display timezone (matches the confirmation notifier). */
export function formatAssignmentWhenLabel(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone,
    }).format(date);
  } catch {
    // An invalid/unknown tz must never break the notification — fall back to UTC.
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(date);
  }
}

export class TechnicianAssignmentNotifier {
  constructor(private readonly deps: TechnicianAssignmentNotifierDeps) {}

  /**
   * Resolve the assignment context and push to the technician's devices.
   * Never throws — failures are logged and swallowed so the triggering
   * assignment write is unaffected.
   */
  async notifyChange(change: TechnicianAssignmentChange): Promise<void> {
    const { tenantId, appointmentId, technicianId, kind } = change;
    try {
      // Targeting: device tokens key on the Clerk subject, not users.id.
      const user = await this.deps.userRepo.findById(tenantId, technicianId);
      const clerkUserId = user?.clerkUserId;
      if (!clerkUserId) return; // no signed-in device to reach

      const appointment = await this.deps.appointmentRepo.findById(tenantId, appointmentId);
      if (!appointment) return;

      const job = await this.deps.jobRepo.findById(tenantId, appointment.jobId);
      const customer = job
        ? await this.deps.customerRepo.findById(tenantId, job.customerId)
        : null;

      const customerName = customer?.displayName?.trim() || 'A customer';
      const whenLabel = formatAssignmentWhenLabel(
        appointment.scheduledStart,
        appointment.timezone,
      );

      if (kind === 'assigned') {
        const serviceLabel =
          job?.summary?.trim() || appointment.appointmentType || 'Service visit';
        await this.deps.notifier.notifyUser(tenantId, clerkUserId, 'appointment_assigned', {
          appointmentId,
          customerName,
          whenLabel,
          serviceLabel,
        });
      } else {
        await this.deps.notifier.notifyUser(tenantId, clerkUserId, 'appointment_unassigned', {
          appointmentId,
          customerName,
          whenLabel,
        });
      }
    } catch (err) {
      this.deps.logger?.warn('technician assignment notification failed', {
        tenantId,
        appointmentId,
        technicianId,
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Process-wide accessor (mirrors owner-notifications-instance). app.ts registers
// one notifier; assignTechnician / unassignTechnician call the accessor so they
// stay free of notification dependencies. No-op (never throws) when unregistered
// — which is the case in unit tests that don't wire one.
// ─────────────────────────────────────────────────────────────────────────────

let instance: TechnicianAssignmentNotifier | undefined;

/** Register (or clear, with `undefined`) the active notifier. Called once in app.ts. */
export function setTechnicianAssignmentNotifier(
  notifier: TechnicianAssignmentNotifier | undefined,
): void {
  instance = notifier;
}

/** Fire a technician assignment-change notification through the registered notifier. */
export async function notifyTechnicianAssignmentChange(
  change: TechnicianAssignmentChange,
): Promise<void> {
  await instance?.notifyChange(change);
}
