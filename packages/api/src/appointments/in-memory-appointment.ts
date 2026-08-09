/**
 * VQ-002 — InMemoryAppointmentRepository (canonical module).
 *
 * Mirrors `InMemoryCustomerRepository` (packages/api/src/customers/customer.ts)
 * — tenant-isolated `Map<id, Appointment>` with copy-on-read / copy-on-write
 * semantics. Status transitions (scheduled → confirmed → in_progress → …) are
 * applied via `update()`; the in-memory store does not enforce transition
 * legality (that lives in the service layer in `appointment.ts`).
 *
 * Implements `AppointmentRepository` from `./appointment` verbatim so it is
 * substitutable with `PgAppointmentRepository` (packages/api/src/appointments/
 * pg-appointment.ts). The Voice Quality Layer 1 corpus runner uses this to
 * seed appointment fixtures per script without touching Postgres on PR-CI.
 *
 * `technicianId` filtering: Pg answers it with an EXISTS subquery against
 * `appointment_assignments` (pg-appointment.ts). This store has no such
 * table, so the equivalent lookup must be threaded in from outside via the
 * constructor (see `TechnicianAssignmentLookup` below) — app.ts passes the
 * same `InMemoryAssignmentRepository` instance constructed alongside this
 * repo. Without one configured, a `technicianId` filter request throws
 * rather than silently returning every appointment in the tenant (the prior
 * behavior).
 *
 * Originally lived inline in `./appointment`; extracted here so the in-memory
 * and Pg variants are symmetric. The original `./appointment` re-exports for
 * backwards-compat with existing callers.
 */
import {
  Appointment,
  AppointmentListOptions,
  AppointmentListResult,
  AppointmentRepository,
  DEFAULT_APPOINTMENT_LIMIT,
  MAX_APPOINTMENT_LIMIT,
} from './appointment';

/**
 * Narrow shape needed to resolve `technicianId` → assigned appointment ids.
 * Declared locally (rather than importing `AssignmentRepository` from
 * `./assignment`) to avoid a module dependency in this direction; the real
 * `AssignmentRepository`/`InMemoryAssignmentRepository` satisfy this
 * structurally, so the production instance can be passed directly.
 */
export interface TechnicianAssignmentLookup {
  findByTechnician(
    tenantId: string,
    technicianId: string
  ): Promise<Array<{ appointmentId: string }>>;
}

export class InMemoryAppointmentRepository implements AppointmentRepository {
  private appointments: Map<string, Appointment> = new Map();

  constructor(private readonly technicianAssignments?: TechnicianAssignmentLookup) {}

  async create(appointment: Appointment): Promise<Appointment> {
    // Idempotency: a redelivered write with the same key returns the
    // existing appointment instead of inserting a duplicate (mirrors the
    // Pg partial-unique-index ON CONFLICT behavior).
    if (appointment.idempotencyKey) {
      const existing = Array.from(this.appointments.values()).find(
        (a) =>
          a.tenantId === appointment.tenantId &&
          a.idempotencyKey === appointment.idempotencyKey,
      );
      if (existing) return { ...existing };
    }
    this.appointments.set(appointment.id, { ...appointment });
    return { ...appointment };
  }

  async findById(tenantId: string, id: string): Promise<Appointment | null> {
    const a = this.appointments.get(id);
    if (!a || a.tenantId !== tenantId) return null;
    return { ...a };
  }

  async findByJob(tenantId: string, jobId: string): Promise<Appointment[]> {
    return Array.from(this.appointments.values())
      .filter((a) => a.tenantId === tenantId && a.jobId === jobId)
      .map((a) => ({ ...a }));
  }

  async findByDateRange(tenantId: string, start: Date, end: Date): Promise<Appointment[]> {
    return Array.from(this.appointments.values())
      .filter(
        (a) =>
          a.tenantId === tenantId &&
          a.scheduledStart >= start &&
          a.scheduledStart <= end
      )
      .map((a) => ({ ...a }));
  }

  async findExpiredHolds(tenantId: string, now: Date): Promise<Appointment[]> {
    const cutoff = now.getTime();
    return Array.from(this.appointments.values())
      .filter(
        (a) =>
          a.tenantId === tenantId &&
          a.holdPendingApproval === true &&
          a.holdExpiryAt !== undefined &&
          a.holdExpiryAt.getTime() < cutoff
      )
      .map((a) => ({ ...a }));
  }

  async listWithMeta(
    tenantId: string,
    options?: AppointmentListOptions
  ): Promise<AppointmentListResult> {
    let results = Array.from(this.appointments.values()).filter(
      (a) => a.tenantId === tenantId
    );
    if (options?.fromDate) {
      const from = options.fromDate.getTime();
      results = results.filter((a) => a.scheduledStart.getTime() >= from);
    }
    if (options?.toDate) {
      const to = options.toDate.getTime();
      results = results.filter((a) => a.scheduledStart.getTime() <= to);
    }
    if (options?.jobId) results = results.filter((a) => a.jobId === options.jobId);
    if (options?.status) results = results.filter((a) => a.status === options.status);
    if (options?.technicianId) {
      if (!this.technicianAssignments) {
        // toErrorResponse (shared/errors.ts) maps a plain Error to a generic
        // 500 with a static message — the route's catch block doesn't log —
        // so without logging here, this carefully-worded message is loud in
        // tests (a rejected assertion) and invisible in a running server.
        const message =
          'InMemoryAppointmentRepository.listWithMeta: technicianId filter requires an ' +
          'assignment lookup — construct with `new InMemoryAppointmentRepository(assignmentRepo)`. ' +
          'Silently ignoring technicianId would return every appointment in the tenant.';
        console.error(message, { tenantId, technicianId: options.technicianId });
        throw new Error(message);
      }
      const assigned = await this.technicianAssignments.findByTechnician(
        tenantId,
        options.technicianId
      );
      const assignedIds = new Set(assigned.map((a) => a.appointmentId));
      results = results.filter((a) => assignedIds.has(a.id));
    }
    const sortDir = options?.sort === 'desc' ? -1 : 1;
    results.sort((a, b) => sortDir * (a.scheduledStart.getTime() - b.scheduledStart.getTime()));
    const total = results.length;
    const limit = Math.min(options?.limit ?? DEFAULT_APPOINTMENT_LIMIT, MAX_APPOINTMENT_LIMIT);
    const offset = options?.offset ?? 0;
    const data = results.slice(offset, offset + limit).map((a) => ({ ...a }));
    return { data, total };
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<Appointment>
  ): Promise<Appointment | null> {
    const a = this.appointments.get(id);
    if (!a || a.tenantId !== tenantId) return null;
    const updated = { ...a, ...updates };
    this.appointments.set(id, updated);
    return { ...updated };
  }
}
