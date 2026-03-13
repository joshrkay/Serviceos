import {
  assignTechnician,
  unassignTechnician,
  getAssignments,
  syncJobAssignment,
  validateAssignmentInput,
  InMemoryAssignmentRepository,
} from '../../src/appointments/assignment';
import { InMemoryJobRepository, createJob } from '../../src/jobs/job';

describe('P1-008 — Technician assignment model', () => {
  let assignmentRepo: InMemoryAssignmentRepository;
  let jobRepo: InMemoryJobRepository;

  beforeEach(() => {
    assignmentRepo = new InMemoryAssignmentRepository();
    jobRepo = new InMemoryJobRepository();
  });

  it('happy path — assigns technician to appointment', async () => {
    const assignment = await assignTechnician(
      {
        tenantId: 'tenant-1',
        appointmentId: 'apt-1',
        technicianId: 'tech-1',
        technicianRole: 'technician',
        assignedBy: 'dispatcher-1',
      },
      assignmentRepo
    );

    expect(assignment.id).toBeTruthy();
    expect(assignment.technicianId).toBe('tech-1');
    expect(assignment.isPrimary).toBe(true);
  });

  it('happy path — retrieves assignments for appointment', async () => {
    await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo
    );
    await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-2', technicianRole: 'technician', isPrimary: false, assignedBy: 'disp-1' },
      assignmentRepo
    );

    const assignments = await getAssignments('tenant-1', 'apt-1', assignmentRepo);
    expect(assignments).toHaveLength(2);
  });

  it('happy path — unassigns technician', async () => {
    const assignment = await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo
    );

    const result = await unassignTechnician('tenant-1', assignment.id, assignmentRepo);
    expect(result).toBe(true);

    const remaining = await getAssignments('tenant-1', 'apt-1', assignmentRepo);
    expect(remaining).toHaveLength(0);
  });

  it('happy path — syncs job assignment from appointment', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Test', createdBy: 'u-1' },
      jobRepo
    );

    await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo
    );

    await syncJobAssignment('tenant-1', job.id, 'apt-1', assignmentRepo, jobRepo);

    const updatedJob = await jobRepo.findById('tenant-1', job.id);
    expect(updatedJob!.assignedTechnicianId).toBe('tech-1');
  });

  it('validation — rejects non-technician role', () => {
    const errors = validateAssignmentInput({
      tenantId: 'tenant-1',
      appointmentId: 'apt-1',
      technicianId: 'user-1',
      technicianRole: 'dispatcher',
      assignedBy: 'owner-1',
    });
    expect(errors).toContain('Assigned user must have technician role');
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateAssignmentInput({
      tenantId: '',
      appointmentId: '',
      technicianId: '',
      technicianRole: 'technician',
      assignedBy: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('appointmentId is required');
    expect(errors).toContain('technicianId is required');
    expect(errors).toContain('assignedBy is required');
  });

  it('edge case — syncJobAssignment clears stale technician when no primary', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Test', createdBy: 'u-1' },
      jobRepo
    );

    const assignment = await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo
    );
    await syncJobAssignment('tenant-1', job.id, 'apt-1', assignmentRepo, jobRepo);
    expect((await jobRepo.findById('tenant-1', job.id))!.assignedTechnicianId).toBe('tech-1');

    await unassignTechnician('tenant-1', assignment.id, assignmentRepo);
    await syncJobAssignment('tenant-1', job.id, 'apt-1', assignmentRepo, jobRepo);
    const updatedJob = await jobRepo.findById('tenant-1', job.id);
    expect(updatedJob!.assignedTechnicianId).toBeUndefined();
  });

  it('tenant isolation — cross-tenant assignment inaccessible', async () => {
    await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo
    );

    const crossTenant = await getAssignments('tenant-2', 'apt-1', assignmentRepo);
    expect(crossTenant).toHaveLength(0);
  });
});
