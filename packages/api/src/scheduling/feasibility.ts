import { detectOverlappingAppointments, detectAvailabilityConflicts } from '../dispatch/validation';
import {
  FeasibilityInput, FeasibilityDependencies, FeasibilityResult,
  FeasibilityIssue, TravelTimeSummary,
} from './feasibility-types';
import { Appointment } from '../appointments/appointment';
import { LatLng } from './travel-time/provider';

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

async function availabilityIssues(
  input: FeasibilityInput,
  deps: FeasibilityDependencies,
): Promise<FeasibilityIssue[]> {
  const dayOfWeek = input.proposedScheduledStart.getUTCDay();
  const wh = await deps.workingHoursRepo.findByTechnicianAndDay(
    input.tenantId, input.proposedTechnicianId, dayOfWeek,
  );
  const blocks = await deps.unavailableBlockRepo.findByTechnicianAndDateRange(
    input.tenantId, input.proposedTechnicianId,
    input.proposedScheduledStart, input.proposedScheduledEnd,
  );
  const conflicts = detectAvailabilityConflicts(
    input.proposedScheduledStart, input.proposedScheduledEnd,
    wh, blocks, deps.timezone ?? input.appointment.timezone ?? 'UTC',
  );
  return conflicts.map((c) => ({
    check: (c.type === 'outside_working_hours' ? 'working_hours' : 'unavailable_block') as FeasibilityIssue['check'],
    severity: 'warning' as const,
    message: c.message,
    conflictingEntityId: c.conflictingEntityId,
  }));
}

async function locationCoordsFor(
  deps: FeasibilityDependencies,
  tenantId: string,
  jobId: string,
): Promise<{ coords: LatLng | null }> {
  const job = await deps.jobRepo.findById(tenantId, jobId);
  const locationId = (job as any)?.locationId as string | undefined;
  if (!locationId) return { coords: null };
  const loc = await deps.locationRepo.findById(tenantId, locationId);
  const lat = (loc as any)?.latitude;
  const lng = (loc as any)?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return { coords: null };
  return { coords: { latitude: lat, longitude: lng } };
}

async function travelTimeIssues(
  input: FeasibilityInput,
  deps: FeasibilityDependencies,
): Promise<{ issues: FeasibilityIssue[]; summary: TravelTimeSummary }> {
  const windowStart = new Date(input.proposedScheduledStart.getTime() - WINDOW_MS);
  const windowEnd = new Date(input.proposedScheduledEnd.getTime() + WINDOW_MS);
  const siblings = (await loadTechnicianAppointmentsInWindow(
    deps, input.tenantId, input.proposedTechnicianId, windowStart, windowEnd,
  )).filter((a) => a.id !== input.appointment.id)
    .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());

  const prev = [...siblings].reverse().find((a) => a.scheduledEnd <= input.proposedScheduledStart) ?? null;
  const next = siblings.find((a) => a.scheduledStart >= input.proposedScheduledEnd) ?? null;

  const summary: TravelTimeSummary = {
    fromPrevSeconds: null, toNextSeconds: null,
    estimateSource: 'unknown', degraded: false,
  };
  const issues: FeasibilityIssue[] = [];
  if (!prev && !next) return { issues, summary };

  const target = await locationCoordsFor(deps, input.tenantId, input.appointment.jobId);

  for (const [neighbor, kind] of [
    [prev, 'fromPrev'] as const,
    [next, 'toNext'] as const,
  ]) {
    if (!neighbor) continue;
    const neighborCoords = await locationCoordsFor(deps, input.tenantId, neighbor.jobId);
    if (!target.coords || !neighborCoords.coords) {
      issues.push({
        check: 'travel_time' as const,
        severity: 'info' as const,
        message: 'Travel-time unverified — neighbor or target location is missing coordinates.',
        conflictingEntityId: neighbor.id,
        metadata: { reason: 'missing_coords', neighborAppointmentId: neighbor.id, kind },
      });
      continue;
    }
    const [origin, destination] = kind === 'fromPrev'
      ? [neighborCoords.coords, target.coords]
      : [target.coords, neighborCoords.coords];
    const departAt = kind === 'fromPrev' ? neighbor.scheduledEnd : input.proposedScheduledEnd;
    const est = await deps.travelTimeProvider.estimateDriveTime(origin, destination, departAt);
    summary.estimateSource = est.source;
    summary.degraded = summary.degraded || est.degraded;
    if (kind === 'fromPrev') {
      summary.fromPrevSeconds = est.seconds;
    } else {
      summary.toNextSeconds = est.seconds;
    }

    const gapSeconds = kind === 'fromPrev'
      ? Math.floor((input.proposedScheduledStart.getTime() - neighbor.scheduledEnd.getTime()) / 1000)
      : Math.floor((neighbor.scheduledStart.getTime() - input.proposedScheduledEnd.getTime()) / 1000);
    if (gapSeconds < est.seconds) {
      issues.push({
        check: 'travel_time' as const,
        severity: 'warning' as const,
        message: `Travel from ${kind === 'fromPrev' ? 'previous appointment' : 'this appointment'} requires ~${est.seconds}s but only ${gapSeconds}s available.`,
        conflictingEntityId: neighbor.id,
        metadata: { neighborAppointmentId: neighbor.id, gapSeconds, travelSeconds: est.seconds, source: est.source, kind },
      });
    }
  }
  return { issues, summary };
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
  const [overlap, availability, travel] = await Promise.all([
    overlapIssues(input, deps),
    availabilityIssues(input, deps),
    travelTimeIssues(input, deps),
  ]);
  return partition([...overlap, ...availability, ...travel.issues], travel.summary);
}
