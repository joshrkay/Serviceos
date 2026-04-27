export type TechnicianProgressState = 'at_site' | 'left_site' | 'in_transit' | 'unknown';
export type AppointmentLatenessState = 'on_track' | 'at_risk' | 'late_prompt_required' | 'late_confirmed';
export type DelayBucketMinutes = 10 | 15 | 20 | 60;

export interface TechnicianPing {
  occurredAt: Date;
  latitude: number;
  longitude: number;
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
    if (lastPing.inGeofence && dwellMinutes >= config.minimumDwellMinutes) {
      return 'at_site';
    }
  }

  if (!lastPing.inGeofence && hasPriorOnsiteStreak(sortedPings, config.minimumPingCount)) {
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

  const expectedDurationMinutes = input.expectedDurationBaselineMinutes
    ?? toMinutes(input.scheduledEnd.getTime() - input.scheduledStart.getTime());

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

  const preThresholdMinutes = expectedDurationMinutes * config.preThresholdRatio;
  const promptThresholdMinutes = expectedDurationMinutes + config.latenessGraceMinutes;

  let latenessState: AppointmentLatenessState = 'on_track';
  let promptRequired = false;
  let promptSuppressedByCooldown = false;

  if (input.selectedDelayBucket !== undefined) {
    latenessState = 'late_confirmed';
  } else if (elapsedActiveServiceMinutes >= promptThresholdMinutes) {
    const cooldownActive = input.lastPromptAt
      ? toMinutes(now.getTime() - input.lastPromptAt.getTime()) < config.promptCooldownMinutes
      : false;

    if (cooldownActive) {
      latenessState = 'at_risk';
      promptSuppressedByCooldown = true;
    } else {
      latenessState = 'late_prompt_required';
      promptRequired = true;
    }
  } else if (elapsedActiveServiceMinutes >= preThresholdMinutes) {
    latenessState = 'at_risk';
  }

  return {
    progressState,
    latenessState,
    expectedDurationMinutes,
    elapsedOnSiteMinutes,
    elapsedActiveServiceMinutes,
    promptRequired,
    promptSuppressedByCooldown,
    selectedDelayBucket: input.selectedDelayBucket,
  };
}

export { DEFAULT_CONFIG as defaultDispatchLatenessConfig };
