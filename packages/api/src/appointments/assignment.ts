import { v4 as uuidv4 } from 'uuid';
import { JobRepository } from '../jobs/job';
import { ValidationError, ConflictError } from '../shared/errors';
import { AppointmentRepository, AppointmentStatus } from './appointment';
import { detectOverlappingAppointments } from '../dispatch/validation';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { notifyTechnicianAssignmentChange } from './assignment-notifications';

/**
 * Optional dependencies for `assignTechnician`.
 *
 * - `appointmentRepo`: when supplied, enforces a double-booking guard —
 *   the technician cannot be assigned to an appointment whose time range
 *   overlaps another of their active appointments (throws `ConflictError`,
 *   409). The authoritative protection against the cross-request TOCTOU
 *   race is the DB-level EXCLUDE constraint `no_double_booking` on
 *   `appointment_assignments` (migration 131); this application-layer
 *   check stays as a fast/friendly pre-flight that avoids a DB round-trip
 *   on the obvious case and produces a context-rich error message.
 * - `auditRepo` / `actorRole`: when `auditRepo` is supplied, emits an
 *   `appointment.technician_assigned` audit event (CLAUDE.md: all
 *   mutations emit audit events).
 */
export interface AssignTechnicianDeps {
  appointmentRepo?: AppointmentRepository;
  auditRepo?: AuditRepository;
  actorRole?: string;
}

/** Optional dependencies for `unassignTechnician` (audit emission). */
export interface UnassignTechnicianDeps {
  auditRepo?: AuditRepository;
  actorId?: string;
  actorRole?: string;
  /** Audit metadata describing the removed assignment. */
  appointmentId?: string;
  technicianId?: string;
}

export interface AppointmentAssignment {
  id: string;
  tenantId: string;
  appointmentId: string;
  technicianId: string;
  isPrimary: boolean;
  assignedBy: string;
  assignedAt: Date;
  /** Denormalised from the parent appointment for the double-booking trigger. */
  scheduledStart?: Date;
  scheduledEnd?: Date;
}

export interface CreateAssignmentInput {
  tenantId: string;
  appointmentId: string;
  technicianId: string;
  technicianRole: string;
  isPrimary?: boolean;
  assignedBy: string;
}

export interface AssignmentRepository {
  create(assignment: AppointmentAssignment): Promise<AppointmentAssignment>;
  update(assignment: AppointmentAssignment): Promise<AppointmentAssignment>;
  findByAppointment(tenantId: string, appointmentId: string): Promise<AppointmentAssignment[]>;
  findByTechnician(tenantId: string, technicianId: string): Promise<AppointmentAssignment[]>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

export function validateAssignmentInput(input: CreateAssignmentInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.appointmentId) errors.push('appointmentId is required');
  if (!input.technicianId) errors.push('technicianId is required');
  if (!input.assignedBy) errors.push('assignedBy is required');
  if (input.technicianRole !== 'technician') {
    errors.push('Assigned user must have technician role');
  }
  return errors;
}

export async function assignTechnician(
  input: CreateAssignmentInput,
  repository: AssignmentRepository,
  deps: AssignTechnicianDeps = {},
): Promise<AppointmentAssignment> {
  const errors = validateAssignmentInput(input);
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  const isPrimary = input.isPrimary ?? true;

  // Double-booking backstop. When an appointment repo is supplied, refuse
  // to assign a technician who already has an active appointment whose time
  // range overlaps the target. Callers that run a richer feasibility gate
  // upstream still benefit from this as defense-in-depth. The authoritative
  // race-safe check is the DB EXCLUDE constraint `no_double_booking`
  // (migration 131); this layer fires earlier with a friendlier message
  // and saves a DB round-trip on the obvious case.
  if (deps.appointmentRepo) {
    const target = await deps.appointmentRepo.findById(input.tenantId, input.appointmentId);
    if (target) {
      const techAssignments = await repository.findByTechnician(input.tenantId, input.technicianId);
      const otherApptIds = Array.from(
        new Set(
          techAssignments
            .map((a) => a.appointmentId)
            .filter((apptId) => apptId !== input.appointmentId),
        ),
      );
      const others: Array<{
        id: string;
        technicianId: string;
        scheduledStart: Date;
        scheduledEnd: Date;
        status: AppointmentStatus;
      }> = [];
      for (const apptId of otherApptIds) {
        const appt = await deps.appointmentRepo.findById(input.tenantId, apptId);
        if (appt) {
          others.push({
            id: appt.id,
            technicianId: input.technicianId,
            scheduledStart: appt.scheduledStart,
            scheduledEnd: appt.scheduledEnd,
            status: appt.status,
          });
        }
      }
      const conflicts = detectOverlappingAppointments(
        input.technicianId,
        target.scheduledStart,
        target.scheduledEnd,
        others,
        input.appointmentId,
      );
      if (conflicts.length > 0) {
        throw new ConflictError(
          `Technician is already booked at this time: ${conflicts[0].message}`,
        );
      }
    }
  }

  // Demote any existing primary assignments before assigning new primary.
  // Race protection: the partial unique index
  // `uq_assignment_primary_per_appointment` (migration 131) is the durable
  // backstop — two simultaneous primary assigns can't both INSERT
  // is_primary=true; whichever loses the race surfaces as a 23505 which
  // PgAssignmentRepository.create maps to ConflictError (409).
  if (isPrimary) {
    const existing = await repository.findByAppointment(input.tenantId, input.appointmentId);
    const currentPrimaries = existing.filter((a) => a.isPrimary);
    await Promise.all(currentPrimaries.map((a) => repository.update({ ...a, isPrimary: false })));
  }

  const assignment: AppointmentAssignment = {
    id: uuidv4(),
    tenantId: input.tenantId,
    appointmentId: input.appointmentId,
    technicianId: input.technicianId,
    isPrimary,
    assignedBy: input.assignedBy,
    assignedAt: new Date(),
    // Denormalise the appointment's time window into the assignment row so
    // the DB-level double-booking trigger (migration 129) can enforce the
    // no-overlap constraint without a cross-table join in the trigger body.
    scheduledStart: deps.appointmentRepo
      ? (await deps.appointmentRepo.findById(input.tenantId, input.appointmentId))?.scheduledStart
      : undefined,
    scheduledEnd: deps.appointmentRepo
      ? (await deps.appointmentRepo.findById(input.tenantId, input.appointmentId))?.scheduledEnd
      : undefined,
  };

  const created = await repository.create(assignment);

  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.assignedBy,
        actorRole: deps.actorRole ?? 'system',
        eventType: 'appointment.technician_assigned',
        entityType: 'appointment',
        entityId: input.appointmentId,
        metadata: {
          assignmentId: created.id,
          technicianId: input.technicianId,
          isPrimary: created.isPrimary,
        },
      }),
    );
  }

  // Story 6.1/6.3 — notify the assigned technician (in-app push). Failure-
  // isolated: a notification problem never breaks the assignment write.
  await notifyTechnicianAssignmentChange({
    tenantId: input.tenantId,
    appointmentId: input.appointmentId,
    technicianId: input.technicianId,
    kind: 'assigned',
  });

  return created;
}

export async function unassignTechnician(
  tenantId: string,
  assignmentId: string,
  repository: AssignmentRepository,
  deps: UnassignTechnicianDeps = {},
): Promise<boolean> {
  const removed = await repository.delete(tenantId, assignmentId);

  if (removed && deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: deps.actorId ?? 'system',
        actorRole: deps.actorRole ?? 'system',
        eventType: 'appointment.technician_unassigned',
        entityType: 'appointment',
        entityId: deps.appointmentId ?? assignmentId,
        metadata: {
          assignmentId,
          technicianId: deps.technicianId,
        },
      }),
    );
  }

  // Story 6.8 — notify the technician a job was moved off them. Requires the
  // appointment + technician ids in deps (the reassignment handler supplies
  // both). Failure-isolated.
  if (removed && deps.appointmentId && deps.technicianId) {
    await notifyTechnicianAssignmentChange({
      tenantId,
      appointmentId: deps.appointmentId,
      technicianId: deps.technicianId,
      kind: 'unassigned',
    });
  }

  return removed;
}

export async function getAssignments(
  tenantId: string,
  appointmentId: string,
  repository: AssignmentRepository
): Promise<AppointmentAssignment[]> {
  return repository.findByAppointment(tenantId, appointmentId);
}

export async function syncJobAssignment(
  tenantId: string,
  jobId: string,
  appointmentId: string,
  assignmentRepo: AssignmentRepository,
  jobRepo: JobRepository
): Promise<void> {
  const assignments = await assignmentRepo.findByAppointment(tenantId, appointmentId);
  const primaryAssignments = assignments.filter((a) => a.isPrimary);
  const primary = primaryAssignments.length > 0 ? primaryAssignments[primaryAssignments.length - 1] : undefined;

  if (primaryAssignments.length > 1) {
    const assignmentsToDemote = primaryAssignments.slice(0, -1);
    await Promise.all(assignmentsToDemote.map((assignment) => assignmentRepo.update({ ...assignment, isPrimary: false })));
  }

  if (primary) {
    await jobRepo.update(tenantId, jobId, {
      assignedTechnicianId: primary.technicianId,
      updatedAt: new Date(),
    });
  } else {
    await jobRepo.update(tenantId, jobId, {
      assignedTechnicianId: undefined,
      updatedAt: new Date(),
    });
  }
}

export class InMemoryAssignmentRepository implements AssignmentRepository {
  private assignments: Map<string, AppointmentAssignment> = new Map();

  async create(assignment: AppointmentAssignment): Promise<AppointmentAssignment> {
    this.assignments.set(assignment.id, { ...assignment });
    return { ...assignment };
  }

  async update(assignment: AppointmentAssignment): Promise<AppointmentAssignment> {
    this.assignments.set(assignment.id, { ...assignment });
    return { ...assignment };
  }

  async findByAppointment(tenantId: string, appointmentId: string): Promise<AppointmentAssignment[]> {
    return Array.from(this.assignments.values())
      .filter((a) => a.tenantId === tenantId && a.appointmentId === appointmentId)
      .map((a) => ({ ...a }));
  }

  async findByTechnician(tenantId: string, technicianId: string): Promise<AppointmentAssignment[]> {
    return Array.from(this.assignments.values())
      .filter((a) => a.tenantId === tenantId && a.technicianId === technicianId)
      .map((a) => ({ ...a }));
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const a = this.assignments.get(id);
    if (!a || a.tenantId !== tenantId) return false;
    this.assignments.delete(id);
    return true;
  }
}
