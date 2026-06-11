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

export interface FeasibilityResult {
  feasible: boolean;
  blocking: FeasibilityIssue[];
  warnings: FeasibilityIssue[];
  info: FeasibilityIssue[];
  travelTime: TravelTimeSummary | null;
}

export interface FeasibilityInput {
  tenantId: string;
  /** Pre-loaded by the caller — never re-fetched inside the composer. Closes a TOCTOU window. */
  appointment: Appointment;
  proposedTechnicianId: string;
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
