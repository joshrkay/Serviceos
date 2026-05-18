import { detectOverlappingAppointments } from '../dispatch/validation';
import {
  FeasibilityInput, FeasibilityDependencies, FeasibilityResult,
  FeasibilityIssue, TravelTimeSummary,
} from './feasibility-types';
import { Appointment } from '../appointments/appointment';

const WINDOW_MS = 24 * 60 * 60 * 1000;

async function loadTechnicianAppointmentsInWindow(
  deps: FeasibilityDependencies,
  tenantId: string,
  technicianId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<Array<Appointment & { technicianId: string }>> {
  const assignments = await deps.assignmentRepo.findByTechnician(tenantId, technicianId);
  const appts = await Promise.all(
    assignments.map((a) => deps.appointmentRepo.findById(tenantId, a.appointmentId)),
  );
  return appts
    .filter((a): a is Appointment => a !== null)
    .filter((a) => a.scheduledEnd > windowStart && a.scheduledStart < windowEnd)
    .map((a) => ({ ...a, technicianId }));
}

async function overlapIssues(
  input: FeasibilityInput,
  deps: FeasibilityDependencies,
): Promise<FeasibilityIssue[]> {
  const windowStart = new Date(input.proposedScheduledStart.getTime() - WINDOW_MS);
  const windowEnd = new Date(input.proposedScheduledEnd.getTime() + WINDOW_MS);
  const siblings = await loadTechnicianAppointmentsInWindow(
    deps, input.tenantId, input.proposedTechnicianId, windowStart, windowEnd,
  );
  const conflicts = detectOverlappingAppointments(
    input.proposedTechnicianId,
    input.proposedScheduledStart,
    input.proposedScheduledEnd,
    siblings,
    input.appointment.id,
  );
  return conflicts.map((c) => ({
    check: 'overlap' as const,
    severity: 'blocking' as const,
    message: c.message,
    conflictingEntityId: c.conflictingEntityId,
  }));
}

function partition(issues: FeasibilityIssue[], travelTime: TravelTimeSummary | null): FeasibilityResult {
  const blocking = issues.filter((i) => i.severity === 'blocking');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const info = issues.filter((i) => i.severity === 'info');
  return {
    feasible: blocking.length === 0,
    blocking, warnings, info,
    travelTime,
  };
}

export async function checkFeasibility(
  input: FeasibilityInput,
  deps: FeasibilityDependencies,
): Promise<FeasibilityResult> {
  const all = await overlapIssues(input, deps);
  return partition(all, null);
}
