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
 * Note: `technicianId` filtering is a Pg-only concept (joins through the
 * assignments table); the in-memory variant silently ignores it.
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

export class InMemoryAppointmentRepository implements AppointmentRepository {
  private appointments: Map<string, Appointment> = new Map();

  async create(appointment: Appointment): Promise<Appointment> {
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
    // technicianId is implemented via an assignments-table JOIN in Pg.
    // The InMemory store doesn't reference assignments here, so the
    // option is best-effort only and silently ignored when unset.
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
