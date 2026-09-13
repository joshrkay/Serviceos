import { detectOverlappingAppointments, detectAvailabilityConflicts } from '../dispatch/validation';
import {
  FeasibilityInput, FeasibilityDependencies, FeasibilityResult,
  FeasibilityIssue, TravelTimeSummary,
} from './feasibility-types';
import { Appointment } from '../appointments/appointment';
import { getDayOfWeekInTimezone } from '../appointments/time';
import { localDateKey } from '../shared/timezone';
import { LatLng } from './travel-time/provider';

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * #909/A11 (2026-08-31 live sweep) — every per-technician check below reads
 * `proposedTechnicianId` as a real id (assignmentRepo.findByTechnician,
 * workingHoursRepo.findByTechnician, unavailableBlockRepo.
 * findByTechnicianAndDateRange, skillMatcher.skillsForTechnician all bind it
 * into a `uuid`-typed query parameter). `checkFeasibility` narrows to this
 * type ONCE, at its own top, and only calls these four with the narrowed
 * value — see `checkFeasibility`'s doc comment for why the guard lives
 * there rather than in each function.
 */
type TechnicianScopedInput = FeasibilityInput & { proposedTechnicianId: string };

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
  input: TechnicianScopedInput,
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
  input: TechnicianScopedInput,
  deps: FeasibilityDependencies,
): Promise<FeasibilityIssue[]> {
  const timezone = deps.timezone ?? input.appointment.timezone ?? 'UTC';
  const dayOfWeek = getDayOfWeekInTimezone(input.proposedScheduledStart, timezone);
  // All rows, not just this day's: a tech modeled Mon–Fri proposed for a
  // Sunday slot has NO row that day — findByTechnicianAndDay returned null
  // and the old code read that as "no conflict". Modeled-but-off-day is a
  // working-hours violation (contract #12/#13: available for full window).
  const allRows = (
    await deps.workingHoursRepo.findByTechnician(input.tenantId, input.proposedTechnicianId)
  ).filter((r) => r.isActive);
  const wh = allRows.find((r) => r.dayOfWeek === dayOfWeek) ?? null;
  const blocks = await deps.unavailableBlockRepo.findByTechnicianAndDateRange(
    input.tenantId, input.proposedTechnicianId,
    input.proposedScheduledStart, input.proposedScheduledEnd,
  );
  const conflicts = detectAvailabilityConflicts(
    input.proposedScheduledStart, input.proposedScheduledEnd,
    wh, blocks, timezone,
  );
  // Contract #12/#13 preconditions ("tech available for full window") make
  // these BLOCKING, not advisory. Enforced only against what the tenant
  // modeled: zero working-hours rows = unconstrained; zero blocks = no PTO.
  const issues: FeasibilityIssue[] = conflicts.map((c) => ({
    check: (c.type === 'outside_working_hours' ? 'working_hours' : 'unavailable_block') as FeasibilityIssue['check'],
    severity: 'blocking' as const,
    message: c.message,
    conflictingEntityId: c.conflictingEntityId,
  }));
  if (allRows.length > 0 && !wh) {
    issues.push({
      check: 'working_hours',
      severity: 'blocking',
      message: 'Technician is not scheduled to work on this day',
    });
  }
  // detectAvailabilityConflicts compares minutes-of-day only, so a window
  // crossing local midnight would slip past a single day's row. A modeled
  // tech's shift never spans local days.
  if (
    allRows.length > 0 &&
    localDateKey(input.proposedScheduledStart, timezone) !==
      localDateKey(input.proposedScheduledEnd, timezone)
  ) {
    issues.push({
      check: 'working_hours',
      severity: 'blocking',
      message: 'Proposed window spans multiple local days — outside working hours',
    });
  }
  return issues;
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

async function skillMatchIssues(
  input: TechnicianScopedInput,
  deps: FeasibilityDependencies,
): Promise<FeasibilityIssue[]> {
  const required = await deps.skillMatcher.requiredSkillsForJob(input.tenantId, input.appointment.jobId);
  if (required.length === 0) return [];
  const held = await deps.skillMatcher.skillsForTechnician(input.tenantId, input.proposedTechnicianId);
  const missing = required.filter((s) => !held.includes(s));
  if (missing.length === 0) return [];
  // Contract #12/#13: "holds required skill for service type if skills are
  // modeled" is a precondition → blocking. Vacuously clean while the wired
  // matcher is the stub (requiredSkillsForJob returns []); the moment a real
  // skills model lands, this gate enforces it with no further change.
  return [{
    check: 'skill_match' as const,
    severity: 'blocking' as const,
    message: `Technician is missing required skill(s): ${missing.join(', ')}`,
    metadata: { missingSkills: missing },
  }];
}

async function travelTimeIssues(
  input: TechnicianScopedInput,
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
  // #909/A11 (2026-08-31 live sweep) — an unassigned appointment (no
  // technician has ever been assigned — e.g. RescheduleAppointmentExecution
  // Handler's `proposedTechnicianId` fallback when `findByAppointment`
  // returns no primary assignment) has no per-technician calendar to check
  // feasibility against. Skip ALL FOUR checks below rather than let '' —
  // or now, `undefined` — reach a `uuid`-typed repo query
  // (`invalid input syntax for type uuid: ""`, Postgres 22P02); `create-
  // scheduling.ts`'s own draft-time call already reached this same
  // conclusion independently ("skip when the appointment has no assigned
  // technician — there is no calendar to check against"). `feasible: true`
  // is correct here, not a degraded/unknown state: there being no
  // technician assigned yet is not itself a blocking scheduling conflict.
  if (!input.proposedTechnicianId) {
    return partition([], null);
  }
  const scoped: TechnicianScopedInput = { ...input, proposedTechnicianId: input.proposedTechnicianId };
  const [overlap, availability, travel, skill] = await Promise.all([
    overlapIssues(scoped, deps),
    availabilityIssues(scoped, deps),
    travelTimeIssues(scoped, deps),
    skillMatchIssues(scoped, deps),
  ]);
  return partition([...overlap, ...availability, ...travel.issues, ...skill], travel.summary);
}
