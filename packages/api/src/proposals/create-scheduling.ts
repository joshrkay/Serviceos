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
  | { kind: 'not_found'; entity: 'appointment' };

export interface CreateSchedulingInput {
  tenantId: string;
  actorId: string;
  proposalType: 'reschedule_appointment' | 'reassign_appointment';
  payload: {
    appointmentId: string;
    newScheduledStart?: string;
    newScheduledEnd?: string;
    toTechnicianId?: string;
    fromTechnicianId?: string;
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
  const proposedTechnicianId = input.payload.toTechnicianId ?? input.payload.fromTechnicianId ?? '';

  const feasibility = await checkFeasibility(
    {
      tenantId: input.tenantId, appointment,
      proposedTechnicianId, proposedScheduledStart: proposedStart, proposedScheduledEnd: proposedEnd,
    },
    feasibilityDeps,
  );
  if (feasibility.blocking.length > 0) return { kind: 'infeasible', feasibility };

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
