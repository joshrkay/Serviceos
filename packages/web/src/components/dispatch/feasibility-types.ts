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
 * 4.9 / issue #1001 — mirrors the API's `SkillConstraintStatus`. Optional
 * here (and only here) because an older API build returns responses without
 * it; the API type itself never omits the field.
 */
export type SkillConstraintStatus = 'none_configured' | 'evaluated' | 'not_evaluated';

export interface FeasibilityResult {
  feasible: boolean;
  blocking: FeasibilityIssue[];
  warnings: FeasibilityIssue[];
  info: FeasibilityIssue[];
  travelTime: TravelTimeSummary | null;
  skillConstraints?: SkillConstraintStatus;
}
