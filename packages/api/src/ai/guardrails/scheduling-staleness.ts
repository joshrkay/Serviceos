import { Proposal } from '../../proposals/proposal';
import { Appointment } from '../../appointments/appointment';

export interface StalenessCheckResult {
  fresh: boolean;
  reasons: string[];
}

export function checkSchedulingProposalFreshness(
  proposal: Proposal,
  currentAppointment: Appointment,
  currentTechnicianId?: string | null,
): StalenessCheckResult {
  const reasons: string[] = [];

  if (!proposal.sourceContext) {
    return { fresh: true, reasons: [] };
  }

  const ctx = proposal.sourceContext;

  // Check if status changed
  if (ctx.status && ctx.status !== currentAppointment.status) {
    reasons.push(
      `Appointment status changed from '${ctx.status}' to '${currentAppointment.status}'`
    );
  }

  // Check if scheduled times changed
  if (ctx.scheduledStart) {
    const originalStart = new Date(ctx.scheduledStart as string).getTime();
    const currentStart = currentAppointment.scheduledStart.getTime();
    if (originalStart !== currentStart) {
      reasons.push('Appointment scheduledStart has changed');
    }
  }

  if (ctx.scheduledEnd) {
    const originalEnd = new Date(ctx.scheduledEnd as string).getTime();
    const currentEnd = currentAppointment.scheduledEnd.getTime();
    if (originalEnd !== currentEnd) {
      reasons.push('Appointment scheduledEnd has changed');
    }
  }

  // Check if technician changed
  if (ctx.technicianId !== undefined && ctx.technicianId !== currentTechnicianId) {
    reasons.push('Appointment technician assignment has changed');
  }

  return {
    fresh: reasons.length === 0,
    reasons,
  };
}

export function isSchedulingProposalType(proposalType: string): boolean {
  return [
    'reassign_appointment',
    'reschedule_appointment',
    'cancel_appointment',
  ].includes(proposalType);
}
