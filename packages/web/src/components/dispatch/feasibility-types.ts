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
