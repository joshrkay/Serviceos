import { Appointment, AppointmentRepository } from '../appointments/appointment';
import { AssignmentRepository } from '../appointments/assignment';
import { JobRepository } from '../jobs/job';
import { LocationRepository } from '../locations/location';
import { WorkingHoursRepository } from '../availability/working-hours';
import { UnavailableBlockRepository } from '../availability/unavailable-block';
import { TravelTimeProvider } from './travel-time/provider';
import { SkillMatcher } from './skill-matcher';

export type FeasibilitySeverity = 'blocking' | 'warning' | 'info';

export type FeasibilityCheck =
  | 'overlap'
  | 'working_hours'
  | 'unavailable_block'
  | 'travel_time'
  | 'skill_match';

export interface FeasibilityIssue {
  check: FeasibilityCheck;
  severity: FeasibilitySeverity;
  message: string;
  conflictingEntityId?: string;
  metadata?: Record<string, unknown>;
}

export interface TravelTimeSummary {
  fromPrevSeconds: number | null;
  toNextSeconds: number | null;
  estimateSource: 'google' | 'haversine' | 'unknown';
  degraded: boolean;
}

/**
 * 4.9 / issue #1001 — why the skill gate was clean.
 *
 * The wired `SkillMatcher` is `StubSkillMatcher`, whose `requiredSkillsForJob`
 * returns `[]`. Before this field existed, that empty list produced no issue
 * and no trace, so a feasibility report could not be distinguished from one
 * where a real skills model had been consulted and matched: an empty skill
 * list read as "always feasible". These three values keep the report honest
 * without building skills-based assignment (explicitly out of scope, #1001):
 *
 *  - `none_configured` — the check RAN and the tenant models no required
 *    skills for this job. Feasible on the skill axis, but only vacuously.
 *  - `evaluated` — the check ran against a non-empty required-skill list;
 *    a mismatch is reported as a blocking `skill_match` issue.
 *  - `not_evaluated` — the check never ran (no technician to check, see
 *    `checkFeasibility`'s #909/A11 guard), so nothing about skills is known.
 */
export type SkillConstraintStatus = 'none_configured' | 'evaluated' | 'not_evaluated';

export interface FeasibilityResult {
  feasible: boolean;
  blocking: FeasibilityIssue[];
  warnings: FeasibilityIssue[];
  info: FeasibilityIssue[];
  travelTime: TravelTimeSummary | null;
  /** 4.9 / #1001 — never omitted: silence is exactly what this field fixes. */
  skillConstraints: SkillConstraintStatus;
}

export interface FeasibilityInput {
  tenantId: string;
  /** Pre-loaded by the caller — never re-fetched inside the composer. Closes a TOCTOU window. */
  appointment: Appointment;
  /**
   * uuid-or-absent (#935/#947 doctrine) — NOT `''`. An unassigned
   * appointment (e.g. a reschedule of an appointment nobody has been
   * dispatched to yet) has no technician calendar to check feasibility
   * against; `checkFeasibility` skips every per-technician check when this
   * is absent rather than let an empty string reach a `uuid`-typed repo
   * query (see that function's own doc comment — #909/A11 live sweep).
   */
  proposedTechnicianId: string | undefined;
  proposedScheduledStart: Date;
  proposedScheduledEnd: Date;
}

export interface FeasibilityDependencies {
  assignmentRepo: AssignmentRepository;
  appointmentRepo: AppointmentRepository;
  jobRepo: JobRepository;
  locationRepo: LocationRepository;
  workingHoursRepo: WorkingHoursRepository;
  unavailableBlockRepo: UnavailableBlockRepository;
  travelTimeProvider: TravelTimeProvider;
  skillMatcher: SkillMatcher;
  timezone?: string;
  clock?: () => Date;
}
