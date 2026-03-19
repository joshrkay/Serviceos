import { v4 as uuidv4 } from 'uuid';
import { JobRepository } from '../jobs/job';
import { ValidationError } from '../shared/errors';

export interface AppointmentAssignment {
  id: string;
  tenantId: string;
  appointmentId: string;
  technicianId: string;
  isPrimary: boolean;
  assignedBy: string;
  assignedAt: Date;
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
  repository: AssignmentRepository
): Promise<AppointmentAssignment> {
  const errors = validateAssignmentInput(input);
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  const isPrimary = input.isPrimary ?? true;

  // Demote any existing primary assignments before assigning new primary
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
  };

  return repository.create(assignment);
}

export async function unassignTechnician(
  tenantId: string,
  assignmentId: string,
  repository: AssignmentRepository
): Promise<boolean> {
  return repository.delete(tenantId, assignmentId);
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
