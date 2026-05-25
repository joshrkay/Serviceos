import { describe, it, expect } from 'vitest';
import { createSchedulingProposal, type CreateSchedulingInput } from '../../src/proposals/create-scheduling';
import type { Proposal, ProposalRepository } from '../../src/proposals/proposal';
import type { Appointment } from '../../src/appointments/appointment';
import type { AppointmentAssignment } from '../../src/appointments/assignment';
import type { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';

/**
 * Regression coverage for the PR #450 fix: a reschedule_appointment carries no
 * technician by contract, so feasibility must resolve the appointment's
 * currently-assigned technician and STILL run the conflict check. Earlier the
 * empty-technician guard skipped feasibility for every reschedule, regressing
 * dispatcher feedback from "blocked at creation" to "accepted then rejected
 * later". These tests lock that behavior in.
 */

const TENANT = 'tenant-1';
const TECH = '11111111-1111-1111-1111-111111111111';

function appt(id: string, startISO: string, endISO: string): Appointment {
  const now = new Date('2026-05-20T00:00:00.000Z');
  return {
    id,
    tenantId: TENANT,
    jobId: `job-${id}`,
    scheduledStart: new Date(startISO),
    scheduledEnd: new Date(endISO),
    timezone: 'UTC',
    status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'seed',
    createdAt: now,
    updatedAt: now,
  };
}

/** Build stub deps. `techAssignments` maps technicianId → appointment ids the tech is assigned to. */
function makeDeps(appts: Record<string, Appointment>, techAssignments: Record<string, string[]>): {
  proposalRepo: ProposalRepository;
  appointmentRepo: FeasibilityDependencies['appointmentRepo'];
  feasibilityDeps: FeasibilityDependencies;
} {
  const apptToTech = new Map<string, string>();
  for (const [tech, ids] of Object.entries(techAssignments)) {
    for (const id of ids) apptToTech.set(id, tech);
  }
  const assignment = (appointmentId: string, technicianId: string): AppointmentAssignment =>
    ({ id: `asg-${appointmentId}`, appointmentId, technicianId } as AppointmentAssignment);

  const appointmentRepo = {
    findById: async (_t: string, id: string) => appts[id] ?? null,
  } as unknown as FeasibilityDependencies['appointmentRepo'];

  const assignmentRepo = {
    findByAppointment: async (_t: string, appointmentId: string) => {
      const tech = apptToTech.get(appointmentId);
      return tech ? [assignment(appointmentId, tech)] : [];
    },
    findByTechnician: async (_t: string, technicianId: string) =>
      (techAssignments[technicianId] ?? []).map((id) => assignment(id, technicianId)),
  } as unknown as FeasibilityDependencies['assignmentRepo'];

  const feasibilityDeps = {
    assignmentRepo,
    appointmentRepo,
    jobRepo: { findById: async () => null },
    locationRepo: { findById: async () => null },
    workingHoursRepo: { findByTechnicianAndDay: async () => [] },
    unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] },
    travelTimeProvider: { estimateDriveTime: async () => ({ seconds: 0, source: 'unknown', degraded: false }) },
    skillMatcher: { requiredSkillsForJob: async () => [], skillsForTechnician: async () => [] },
  } as unknown as FeasibilityDependencies;

  const proposalRepo = {
    create: async (p: Proposal) => p,
  } as unknown as ProposalRepository;

  return { proposalRepo, appointmentRepo, feasibilityDeps };
}

function rescheduleInput(target: Appointment, newStartISO: string, newEndISO: string): CreateSchedulingInput {
  return {
    tenantId: TENANT,
    actorId: 'actor-1',
    proposalType: 'reschedule_appointment',
    payload: { appointmentId: target.id, newScheduledStart: newStartISO, newScheduledEnd: newEndISO },
    expectedVersion: target.updatedAt.toISOString(),
  };
}

describe('createSchedulingProposal — reschedule feasibility', () => {
  it('blocks a reschedule that overlaps another appointment of the assigned technician', async () => {
    const target = appt('target', '2026-05-21T08:00:00.000Z', '2026-05-21T09:00:00.000Z');
    const conflict = appt('conflict', '2026-05-21T10:30:00.000Z', '2026-05-21T11:30:00.000Z');
    const { proposalRepo, appointmentRepo, feasibilityDeps } = makeDeps(
      { target, conflict },
      { [TECH]: ['target', 'conflict'] },
    );

    const res = await createSchedulingProposal(
      rescheduleInput(target, '2026-05-21T10:00:00.000Z', '2026-05-21T11:00:00.000Z'),
      proposalRepo, appointmentRepo, feasibilityDeps,
    );

    expect(res.kind).toBe('infeasible');
  });

  it('creates the proposal when the assigned technician has no conflict', async () => {
    const target = appt('target', '2026-05-21T08:00:00.000Z', '2026-05-21T09:00:00.000Z');
    const { proposalRepo, appointmentRepo, feasibilityDeps } = makeDeps(
      { target },
      { [TECH]: ['target'] },
    );

    const res = await createSchedulingProposal(
      rescheduleInput(target, '2026-05-21T14:00:00.000Z', '2026-05-21T15:00:00.000Z'),
      proposalRepo, appointmentRepo, feasibilityDeps,
    );

    expect(res.kind).toBe('created');
  });

  it('skips feasibility for an unassigned appointment (no technician to conflict with)', async () => {
    const target = appt('target', '2026-05-21T08:00:00.000Z', '2026-05-21T09:00:00.000Z');
    const conflict = appt('conflict', '2026-05-21T10:30:00.000Z', '2026-05-21T11:30:00.000Z');
    // target has NO assignment; the conflict belongs to a tech, but target's tech can't be resolved.
    const { proposalRepo, appointmentRepo, feasibilityDeps } = makeDeps(
      { target, conflict },
      { [TECH]: ['conflict'] },
    );

    const res = await createSchedulingProposal(
      rescheduleInput(target, '2026-05-21T10:00:00.000Z', '2026-05-21T11:00:00.000Z'),
      proposalRepo, appointmentRepo, feasibilityDeps,
    );

    expect(res.kind).toBe('created');
  });

  it('rejects a reassign with no target technician at creation', async () => {
    const target = appt('target', '2026-05-21T08:00:00.000Z', '2026-05-21T09:00:00.000Z');
    const { proposalRepo, appointmentRepo, feasibilityDeps } = makeDeps({ target }, {});

    const res = await createSchedulingProposal(
      {
        tenantId: TENANT,
        actorId: 'actor-1',
        proposalType: 'reassign_appointment',
        payload: { appointmentId: target.id },
        expectedVersion: target.updatedAt.toISOString(),
      },
      proposalRepo, appointmentRepo, feasibilityDeps,
    );

    expect(res.kind).toBe('missing_technician');
  });
});
