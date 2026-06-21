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
import type { JobRepository, Job } from '../jobs/job';
import type { CustomerRepository } from '../customers/customer';
import type { UserRepository } from '../users/user';
import type { LocationRepository, ServiceLocation } from '../locations/location';
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

/**
 * Staff SMS sender. Wired to the raw message-delivery provider's sendSms in
 * app.ts — NOT the customer message-delivery service: a technician's own job
 * text is internal/transactional and must not be gated by customer DNC/consent
 * (mirrors the emergency owner-cell paging path). Optional: when unset, only
 * the in-app push is sent.
 */
export interface StaffSmsSender {
  (input: { to: string; body: string; tenantId: string; idempotencyKey?: string }): Promise<unknown>;
}

export interface TechnicianAssignmentNotifierDeps {
  appointmentRepo: Pick<AppointmentRepository, 'findById'>;
  jobRepo: Pick<JobRepository, 'findById'>;
  customerRepo: Pick<CustomerRepository, 'findById'>;
  userRepo: Pick<UserRepository, 'findById'>;
  notifier: UserNotifier;
  /** Optional — resolves the service address for the SMS body. */
  locationRepo?: Pick<LocationRepository, 'findById'>;
  /** Optional — when set, an SMS is also sent to the tech's mobile. */
  smsSender?: StaffSmsSender;
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

/** Render a service location as a single-line address for an SMS body. */
export function formatLocationAddress(
  loc: Pick<ServiceLocation, 'street1' | 'street2' | 'city' | 'state' | 'postalCode'>,
): string {
  const street = [loc.street1, loc.street2].map((s) => s?.trim()).filter(Boolean).join(' ');
  const cityState = [loc.city?.trim(), loc.state?.trim()].filter(Boolean).join(', ');
  const cityLine = [cityState, loc.postalCode?.trim()].filter(Boolean).join(' ');
  return [street, cityLine].filter(Boolean).join(', ');
}

interface ResolvedAssignmentContext {
  appointmentId: string;
  technicianId: string;
  customerName: string;
  whenLabel: string;
  serviceLabel: string;
  job: Job | null;
}

export class TechnicianAssignmentNotifier {
  constructor(private readonly deps: TechnicianAssignmentNotifierDeps) {}

  /**
   * Resolve the assignment context and notify the technician via in-app push
   * AND (when an SMS sender is wired) SMS to their own mobile. The two channels
   * are independent — one failing never blocks the other — and the whole method
   * never throws, so the triggering assignment write is unaffected.
   */
  async notifyChange(change: TechnicianAssignmentChange): Promise<void> {
    const { tenantId, appointmentId, technicianId, kind } = change;
    try {
      const user = await this.deps.userRepo.findById(tenantId, technicianId);
      if (!user) return;

      const appointment = await this.deps.appointmentRepo.findById(tenantId, appointmentId);
      if (!appointment) return;

      const job = await this.deps.jobRepo.findById(tenantId, appointment.jobId);
      const customer = job
        ? await this.deps.customerRepo.findById(tenantId, job.customerId)
        : null;

      const ctx: ResolvedAssignmentContext = {
        appointmentId,
        technicianId,
        customerName: customer?.displayName?.trim() || 'A customer',
        whenLabel: formatAssignmentWhenLabel(appointment.scheduledStart, appointment.timezone),
        serviceLabel: job?.summary?.trim() || appointment.appointmentType || 'Service visit',
        job,
      };

      // In-app push (targeted by Clerk subject — device tokens key on it, not
      // users.id) and SMS (to the tech's own mobile) are sent independently.
      await this.sendPush(tenantId, user.clerkUserId ?? null, kind, ctx);
      await this.sendSms(tenantId, user.mobileNumber ?? null, kind, ctx);
    } catch (err) {
      this.warn('technician assignment notification failed', tenantId, { appointmentId, technicianId, kind }, err);
    }
  }

  private async sendPush(
    tenantId: string,
    clerkUserId: string | null,
    kind: AssignmentChangeKind,
    ctx: ResolvedAssignmentContext,
  ): Promise<void> {
    if (!clerkUserId) return; // no signed-in device to reach
    try {
      if (kind === 'assigned') {
        await this.deps.notifier.notifyUser(tenantId, clerkUserId, 'appointment_assigned', {
          appointmentId: ctx.appointmentId,
          customerName: ctx.customerName,
          whenLabel: ctx.whenLabel,
          serviceLabel: ctx.serviceLabel,
        });
      } else {
        await this.deps.notifier.notifyUser(tenantId, clerkUserId, 'appointment_unassigned', {
          appointmentId: ctx.appointmentId,
          customerName: ctx.customerName,
          whenLabel: ctx.whenLabel,
        });
      }
    } catch (err) {
      this.warn('technician assignment push failed', tenantId, { ...ctx, kind }, err);
    }
  }

  private async sendSms(
    tenantId: string,
    mobileNumber: string | null,
    kind: AssignmentChangeKind,
    ctx: ResolvedAssignmentContext,
  ): Promise<void> {
    const sender = this.deps.smsSender;
    if (!sender || !mobileNumber) return; // SMS not wired, or tech has no mobile on file
    try {
      const body =
        kind === 'assigned'
          ? await this.buildAssignedSmsBody(tenantId, ctx)
          : `Reassigned: ${ctx.customerName}'s job (${ctx.whenLabel}) was moved to another tech.`;
      await sender({
        to: mobileNumber,
        body,
        tenantId,
        // Dedupe a retry of the same assignment change at the provider.
        idempotencyKey: `tech-assign-sms:${ctx.appointmentId}:${ctx.technicianId}:${kind}`,
      });
    } catch (err) {
      this.warn('technician assignment SMS failed', tenantId, { ...ctx, kind }, err);
    }
  }

  /** Assigned-job SMS: customer, time, service, and address (AC 6.3). */
  private async buildAssignedSmsBody(
    tenantId: string,
    ctx: ResolvedAssignmentContext,
  ): Promise<string> {
    let addressLine = '';
    if (ctx.job?.locationId && this.deps.locationRepo) {
      const loc = await this.deps.locationRepo.findById(tenantId, ctx.job.locationId);
      if (loc) addressLine = formatLocationAddress(loc);
    }
    return [
      `New job — ${ctx.customerName}`,
      ctx.whenLabel,
      ctx.serviceLabel,
      addressLine,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private warn(
    message: string,
    tenantId: string,
    detail: Record<string, unknown>,
    err: unknown,
  ): void {
    this.deps.logger?.warn(message, {
      tenantId,
      ...detail,
      error: err instanceof Error ? err.message : String(err),
    });
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
