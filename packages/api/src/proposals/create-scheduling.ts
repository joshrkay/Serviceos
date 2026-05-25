import { ProposalRepository, Proposal, createProposal } from './proposal';
import { AppointmentRepository } from '../appointments/appointment';
import { FeasibilityDependencies, FeasibilityResult } from '../scheduling/feasibility-types';
import { checkFeasibility } from '../scheduling/feasibility';

export type CreateSchedulingProposalResult =
  | { kind: 'created'; proposal: Proposal }
  | { kind: 'stale'; currentVersion: string; providedVersion: string }
  | { kind: 'infeasible'; feasibility: FeasibilityResult }
  | { kind: 'missing_version' }
  | { kind: 'invalid_version' }
  | { kind: 'missing_technician'; proposalType: 'reassign_appointment' | 'add_crew_member' }
  | { kind: 'not_found'; entity: 'appointment' };

export interface CreateSchedulingInput {
  tenantId: string;
  actorId: string;
  proposalType:
    | 'reschedule_appointment'
    | 'reassign_appointment'
    | 'add_crew_member'
    | 'remove_crew_member';
  payload: {
    appointmentId: string;
    newScheduledStart?: string;
    newScheduledEnd?: string;
    toTechnicianId?: string;
    fromTechnicianId?: string;
    technicianId?: string;
    reason?: string;
  };
  summary?: string;
  expectedVersion: string | null;
}

function parseVersion(v: string | null): { ok: true; date: Date } | { ok: false; reason: 'missing' | 'invalid' } {
  if (!v) return { ok: false, reason: 'missing' };
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return { ok: false, reason: 'invalid' };
  return { ok: true, date: d };
}

export async function createSchedulingProposal(
  input: CreateSchedulingInput,
  proposalRepo: ProposalRepository,
  appointmentRepo: AppointmentRepository,
  feasibilityDeps: FeasibilityDependencies,
): Promise<CreateSchedulingProposalResult> {
  const parsed = parseVersion(input.expectedVersion);
  if (!parsed.ok) {
    return parsed.reason === 'missing'
      ? { kind: 'missing_version' }
      : { kind: 'invalid_version' };
  }

  const appointment = await appointmentRepo.findById(input.tenantId, input.payload.appointmentId);
  if (!appointment) return { kind: 'not_found', entity: 'appointment' };

  const currentIso = appointment.updatedAt.toISOString();
  if (currentIso !== parsed.date.toISOString()) {
    return { kind: 'stale', currentVersion: currentIso, providedVersion: parsed.date.toISOString() };
  }

  const proposedStart = input.payload.newScheduledStart ? new Date(input.payload.newScheduledStart) : appointment.scheduledStart;
  const proposedEnd = input.payload.newScheduledEnd ? new Date(input.payload.newScheduledEnd) : appointment.scheduledEnd;

  // Resolve the technician whose calendar feasibility should check.
  // reassign/add_crew carry it in the payload; reschedule carries no
  // technician by contract (contracts/reschedule.ts) — its technician is
  // whoever is currently assigned to the appointment, so resolve that from
  // the assignment repo. Passing an empty string to checkFeasibility would
  // hit the assignment query with an invalid UUID (Postgres 22P02).
  let proposedTechnicianId =
    input.payload.toTechnicianId ?? input.payload.technicianId ?? input.payload.fromTechnicianId ?? '';
  if (proposedTechnicianId === '' && input.proposalType === 'reschedule_appointment') {
    const assignments = await feasibilityDeps.assignmentRepo.findByAppointment(input.tenantId, appointment.id);
    proposedTechnicianId = assignments[0]?.technicianId ?? '';
  }

  // reassign/add_crew are meaningless without a target technician — reject at
  // creation rather than persisting an inbox item that can never execute
  // (the execution handlers require toTechnicianId/technicianId).
  if (
    (input.proposalType === 'reassign_appointment' || input.proposalType === 'add_crew_member') &&
    proposedTechnicianId === ''
  ) {
    return { kind: 'missing_technician', proposalType: input.proposalType };
  }

  // Removing a crew member can never create a conflict, so feasibility is not
  // run for it. We also skip when the appointment has no assigned technician
  // (an unassigned reschedule) — there is no calendar to check against. Every
  // other case checks the resolved technician's calendar before persisting so
  // the dispatcher sees blocking conflicts immediately.
  if (input.proposalType !== 'remove_crew_member' && proposedTechnicianId !== '') {
    const feasibility = await checkFeasibility(
      {
        tenantId: input.tenantId, appointment,
        proposedTechnicianId, proposedScheduledStart: proposedStart, proposedScheduledEnd: proposedEnd,
      },
      feasibilityDeps,
    );
    if (feasibility.blocking.length > 0) return { kind: 'infeasible', feasibility };
  }

  const proposal = createProposal({
    tenantId: input.tenantId,
    proposalType: input.proposalType,
    payload: input.payload as unknown as Record<string, unknown>,
    summary: input.summary ?? `${input.proposalType.replace(/_/g, ' ')} via dispatch`,
    createdBy: input.actorId,
  });
  const stored = await proposalRepo.create(proposal);
  return { kind: 'created', proposal: stored };
}
