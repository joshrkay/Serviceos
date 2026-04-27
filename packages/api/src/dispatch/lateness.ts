export type TechnicianProgressState = 'at_site' | 'left_site' | 'in_transit' | 'unknown';
export type AppointmentLatenessState = 'on_track' | 'at_risk' | 'late_prompt_required' | 'late_confirmed';
export type DelayBucketMinutes = 10 | 15 | 20 | 60;

export interface TechnicianPing {
  occurredAt: Date;
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  speedMps?: number;
  heading?: number;
}

export interface LocationCoordinates {
  latitude: number;
  longitude: number;
}

export interface DispatchLatenessConfig {
  geofenceRadiusMeters: number;
  minimumPingCount: number;
  minimumDwellMinutes: number;
  preThresholdRatio: number;
  latenessGraceMinutes: number;
  promptCooldownMinutes: number;
  noSignalUnknownAfterMinutes: number;
  maxAcceptedAccuracyMeters: number;
  transitionConsensusNumerator: number;
  transitionConsensusDenominator: number;
  maxPromptsPerAppointmentPerDay: number;
  promptEscalationTimeoutMinutes: number;
  minimumAutoNotifyConfidence: number;
}

export interface DispatchLatenessInput {
  scheduledStart: Date;
  scheduledEnd: Date;
  arrivalWindowStart?: Date;
  arrivalWindowEnd?: Date;
  technicianId?: string;
  pings: TechnicianPing[];
  serviceLocation: LocationCoordinates;
  now?: Date;
  expectedDurationBaselineMinutes?: number;
  previousLatenessState?: AppointmentLatenessState;
  lastPromptAt?: Date;
  promptsSentToday?: number;
  promptOutstandingSince?: Date;
  technicianDelayConfirmedAt?: Date;
  selectedDelayBucket?: DelayBucketMinutes;
}

export interface DispatchLatenessResult {
  progressState: TechnicianProgressState;
  latenessState: AppointmentLatenessState;
  expectedDurationMinutes: number;
  elapsedOnSiteMinutes: number;
  elapsedActiveServiceMinutes: number;
  promptRequired: boolean;
  promptSuppressedByCooldown: boolean;
  escalatedToDispatcher: boolean;
  autoNotifyCustomer: boolean;
  confidenceScore: number;
  confidenceBreakdown: {
    recency: number;
    accuracy: number;
    movementConsistency: number;
  };
  promptAudit: {
    filteredPingCount: number;
    totalPingCount: number;
    thresholdMinutes: number;
    elapsedOnSiteMinutes: number;
    confidenceScore: number;
    reason: string;
  };
  selectedDelayBucket?: DelayBucketMinutes;
}

const DEFAULT_CONFIG: DispatchLatenessConfig = {
  geofenceRadiusMeters: 120,
  minimumPingCount: 2,
  minimumDwellMinutes: 3,
  preThresholdRatio: 0.85,
  latenessGraceMinutes: 5,
  promptCooldownMinutes: 20,
  noSignalUnknownAfterMinutes: 15,
  maxAcceptedAccuracyMeters: 65,
  transitionConsensusNumerator: 2,
  transitionConsensusDenominator: 2,
  maxPromptsPerAppointmentPerDay: 3,
  promptEscalationTimeoutMinutes: 12,
  minimumAutoNotifyConfidence: 0.65,
};

interface PingWithDistance extends TechnicianPing {
  distanceMeters: number;
  inGeofence: boolean;
}

function toMinutes(ms: number): number {
  return Math.max(0, ms / 60000);
}

function getDistanceMeters(a: LocationCoordinates, b: LocationCoordinates): number {
  const earthRadiusM = 6371000;
  const degToRad = Math.PI / 180;
  const lat1 = a.latitude * degToRad;
  const lat2 = b.latitude * degToRad;
  const dLat = (b.latitude - a.latitude) * degToRad;
  const dLon = (b.longitude - a.longitude) * degToRad;

  const haversine =
    Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  return 2 * earthRadiusM * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function findMostRecentOnsiteStreak(
  sortedPings: PingWithDistance[],
  minimumPingCount: number,
): { start: Date; end: Date; count: number } | undefined {
  let endIndex = -1;
  for (let i = sortedPings.length - 1; i >= 0; i -= 1) {
    if (sortedPings[i].inGeofence) {
      endIndex = i;
      break;
    }
  }

  if (endIndex < 0) {
    return undefined;
  }

  let startIndex = endIndex;
  while (startIndex > 0 && sortedPings[startIndex - 1].inGeofence) {
    startIndex -= 1;
  }

  const count = endIndex - startIndex + 1;
  if (count < minimumPingCount) {
    return undefined;
  }

  return {
    start: sortedPings[startIndex].occurredAt,
    end: sortedPings[endIndex].occurredAt,
    count,
  };
}

function hasPriorOnsiteStreak(sortedPings: PingWithDistance[], minimumPingCount: number): boolean {
  let streak = 0;
  for (const ping of sortedPings) {
    if (ping.inGeofence) {
      streak += 1;
      if (streak >= minimumPingCount) {
        return true;
      }
    } else {
      streak = 0;
    }
  }

  return false;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function hasTransitionConsensus(
  sortedPings: PingWithDistance[],
  config: DispatchLatenessConfig,
  expectedInGeofence: boolean,
): boolean {
  const denominator = Math.max(1, config.transitionConsensusDenominator);
  const numerator = Math.min(Math.max(1, config.transitionConsensusNumerator), denominator);
  const recent = sortedPings.slice(-denominator);
  if (recent.length < numerator) {
    return false;
  }

  const matching = recent.filter((ping) => ping.inGeofence === expectedInGeofence).length;
  return matching >= numerator;
}

function computeConfidence(
  sortedPings: PingWithDistance[],
  now: Date,
  config: DispatchLatenessConfig,
): DispatchLatenessResult['confidenceBreakdown'] & { score: number } {
  if (sortedPings.length === 0) {
    return { recency: 0, accuracy: 0, movementConsistency: 0, score: 0 };
  }

  const lastPing = sortedPings[sortedPings.length - 1];
  const ageMinutes = toMinutes(now.getTime() - lastPing.occurredAt.getTime());
  const recency = clamp01(1 - (ageMinutes / Math.max(1, config.noSignalUnknownAfterMinutes)));

  const accuracySamples = sortedPings.filter((p) => p.accuracyMeters != null).slice(-5);
  const accuracy = accuracySamples.length === 0
    ? 0.5
    : clamp01(
      1 - (accuracySamples.reduce((sum, ping) => sum + (ping.accuracyMeters ?? config.maxAcceptedAccuracyMeters), 0)
      / accuracySamples.length
      / Math.max(1, config.maxAcceptedAccuracyMeters)),
    );

  const recent = sortedPings.slice(-5);
  let consistentPairs = 0;
  let totalPairs = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1];
    const current = recent[i];
    totalPairs += 1;
    if ((prev.inGeofence && current.inGeofence) || (!prev.inGeofence && !current.inGeofence)) {
      consistentPairs += 1;
    }
  }
  const movementConsistency = totalPairs === 0 ? 0.5 : consistentPairs / totalPairs;
  const score = clamp01((recency * 0.45) + (accuracy * 0.35) + (movementConsistency * 0.2));

  return { recency, accuracy, movementConsistency, score };
}

function resolveProgressState(
  input: DispatchLatenessInput,
  config: DispatchLatenessConfig,
  sortedPings: PingWithDistance[],
  onsiteStreak: { start: Date; end: Date; count: number } | undefined,
  now: Date,
): TechnicianProgressState {
  if (!input.technicianId) {
    return 'unknown';
  }

  if (sortedPings.length < config.minimumPingCount) {
    return 'unknown';
  }

  const lastPing = sortedPings[sortedPings.length - 1];
  if (toMinutes(now.getTime() - lastPing.occurredAt.getTime()) > config.noSignalUnknownAfterMinutes) {
    return 'unknown';
  }

  if (onsiteStreak) {
    const dwellMinutes = toMinutes(onsiteStreak.end.getTime() - onsiteStreak.start.getTime());
    if (
      lastPing.inGeofence
      && dwellMinutes >= config.minimumDwellMinutes
      && hasTransitionConsensus(sortedPings, config, true)
    ) {
      return 'at_site';
    }
  }

  if (
    !lastPing.inGeofence
    && hasPriorOnsiteStreak(sortedPings, config.minimumPingCount)
    && hasTransitionConsensus(sortedPings, config, false)
  ) {
    return 'left_site';
  }

  return 'in_transit';
}

function resolveServiceClockStart(input: DispatchLatenessInput): Date {
  if (input.arrivalWindowStart) {
    return input.arrivalWindowStart;
  }

  return input.scheduledStart;
}

export function computeDispatchLateness(
  input: DispatchLatenessInput,
  tenantConfig?: Partial<DispatchLatenessConfig>,
): DispatchLatenessResult {
  const config = { ...DEFAULT_CONFIG, ...tenantConfig };
  const now = input.now ?? new Date();

  const sortedPings: PingWithDistance[] = [...input.pings]
    .filter((ping) => ping.accuracyMeters == null || ping.accuracyMeters <= config.maxAcceptedAccuracyMeters)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    .map((ping) => {
      const distanceMeters = getDistanceMeters(
        { latitude: ping.latitude, longitude: ping.longitude },
        input.serviceLocation,
      );
      return {
        ...ping,
        distanceMeters,
        inGeofence: distanceMeters <= config.geofenceRadiusMeters,
      };
    });

  const onsiteStreak = findMostRecentOnsiteStreak(sortedPings, config.minimumPingCount);
  const progressState = resolveProgressState(input, config, sortedPings, onsiteStreak, now);
  const confidence = computeConfidence(sortedPings, now, config);

  const expectedDurationMinutes = input.expectedDurationBaselineMinutes
    ?? toMinutes(input.scheduledEnd.getTime() - input.scheduledStart.getTime());
  const boundedExpectedDurationMinutes = Math.max(1, expectedDurationMinutes);

  const elapsedOnSiteMinutes = onsiteStreak
    ? toMinutes((progressState === 'at_site' ? now : onsiteStreak.end).getTime() - onsiteStreak.start.getTime())
    : 0;
  const serviceClockStart = resolveServiceClockStart(input);
  const activeOnSiteStart = onsiteStreak && onsiteStreak.start > serviceClockStart
    ? onsiteStreak.start
    : serviceClockStart;
  const elapsedActiveServiceMinutes = onsiteStreak
    ? toMinutes((progressState === 'at_site' ? now : onsiteStreak.end).getTime() - activeOnSiteStart.getTime())
    : 0;

  const preThresholdMinutes = boundedExpectedDurationMinutes * config.preThresholdRatio;
  const promptThresholdMinutes = boundedExpectedDurationMinutes + config.latenessGraceMinutes;

  let latenessState: AppointmentLatenessState = 'on_track';
  let promptRequired = false;
  let promptSuppressedByCooldown = false;
  let escalatedToDispatcher = false;
  let promptReason = 'no_prompt';

  if (input.selectedDelayBucket !== undefined) {
    latenessState = 'late_confirmed';
    promptReason = 'technician_confirmed_delay_bucket';
  } else if (elapsedOnSiteMinutes >= promptThresholdMinutes) {
    const promptsSentToday = input.promptsSentToday ?? 0;
    const maxPromptsReached = promptsSentToday >= config.maxPromptsPerAppointmentPerDay;
    const cooldownActive = input.lastPromptAt
      ? toMinutes(now.getTime() - input.lastPromptAt.getTime()) < config.promptCooldownMinutes
      : false;
    const worsenedSinceLastPrompt = Boolean(
      input.lastPromptAt && toMinutes(now.getTime() - input.lastPromptAt.getTime()) > 10,
    );

    if (maxPromptsReached) {
      latenessState = 'at_risk';
      promptSuppressedByCooldown = true;
      promptReason = 'prompt_limit_reached';
    } else if (cooldownActive && !worsenedSinceLastPrompt) {
      latenessState = 'at_risk';
      promptSuppressedByCooldown = true;
      promptReason = 'cooldown_active';
    } else {
      latenessState = 'late_prompt_required';
      promptRequired = true;
      promptReason = worsenedSinceLastPrompt ? 'lateness_worsened' : 'threshold_breached';
    }
  } else if (elapsedActiveServiceMinutes >= preThresholdMinutes) {
    latenessState = 'at_risk';
    promptReason = 'pre_threshold_at_risk';
  }

  if (
    elapsedOnSiteMinutes >= promptThresholdMinutes
    && input.promptOutstandingSince
    && !input.technicianDelayConfirmedAt
    && toMinutes(now.getTime() - input.promptOutstandingSince.getTime()) >= config.promptEscalationTimeoutMinutes
  ) {
    escalatedToDispatcher = true;
    promptRequired = false;
    promptSuppressedByCooldown = true;
    promptReason = 'escalated_to_dispatcher_timeout';
  }

  const autoNotifyCustomer = latenessState === 'late_confirmed'
    || (latenessState === 'late_prompt_required' && confidence.score >= config.minimumAutoNotifyConfidence);

  return {
    progressState,
    latenessState,
    expectedDurationMinutes,
    elapsedOnSiteMinutes,
    elapsedActiveServiceMinutes,
    promptRequired,
    promptSuppressedByCooldown,
    escalatedToDispatcher,
    autoNotifyCustomer,
    confidenceScore: confidence.score,
    confidenceBreakdown: {
      recency: confidence.recency,
      accuracy: confidence.accuracy,
      movementConsistency: confidence.movementConsistency,
    },
    promptAudit: {
      filteredPingCount: sortedPings.length,
      totalPingCount: input.pings.length,
      thresholdMinutes: promptThresholdMinutes,
      elapsedOnSiteMinutes,
      confidenceScore: confidence.score,
      reason: promptReason,
    },
    selectedDelayBucket: input.selectedDelayBucket,
  };
}

export { DEFAULT_CONFIG as defaultDispatchLatenessConfig };
