import { DateTime } from 'luxon';
import { AppointmentRepository } from '../appointments/appointment';
import { AssignmentRepository } from '../appointments/assignment';
import { WorkingHoursRepository } from '../availability/working-hours';
import { UnavailableBlockRepository } from '../availability/unavailable-block';
import { TenantSettings } from '../settings/settings';
import {
  DefaultAvailabilityFinder,
  OpenSlot,
  DEFAULT_BUFFER_MS,
} from '../ai/tasks/availability-finder';
import { isValidTimezone } from '../shared/timezone';

/**
 * Customer-facing slot search. Wraps the AI `AvailabilityFinder` so the
 * self-service booking portal and the AI booking agent compute open slots
 * with identical logic. The finder itself is business-hours-agnostic; this
 * layer constrains the search to per-day business windows in the tenant's
 * timezone, clamps to the technician's working hours and time-off when a
 * tech is named, and never offers slots in the past.
 *
 * Window instants are computed with luxon wall-clock math, NOT
 * `tzMidnight + hour * 3_600_000`: on a DST transition day the local day is
 * 23 or 25 hours long, so fixed-hour offsets from midnight place every
 * window an hour off. Nonexistent local times (02:30 on spring-forward day)
 * resolve deterministically forward per luxon semantics.
 */

export interface BusinessHours {
  /** Local opening hour, 0-23. */
  openHour: number;
  /** Local closing hour, 1-24. */
  closeHour: number;
}

/**
 * Tenant-configured per-day hours, as stored in
 * `tenant_settings.business_hours` (onboarding `BusinessHoursSchema`):
 * keys mon..sun, `null` (or absent) meaning closed that day.
 */
export type WeeklyBusinessHours = Record<
  string,
  { open: string; close: string } | null
>;

export const DEFAULT_BUSINESS_HOURS: BusinessHours = { openHour: 8, closeHour: 17 };

/**
 * Self-service booking horizons — how many days ahead a customer may book.
 * Priority-booking members (a membership perk, #6) get the extended horizon;
 * everyone else is capped at the standard one.
 */
export const STANDARD_BOOKING_HORIZON_DAYS = 14;
export const PRIORITY_BOOKING_HORIZON_DAYS = 60;

/**
 * Clamp a requested [from, to] booking window (YYYY-MM-DD) to a horizon of
 * `horizonDays` from today in the tenant timezone. Returns the effective
 * window, or null when `from` is already beyond the horizon (nothing is
 * bookable). Computed in the tenant tz so a near-midnight "now" can't shift the
 * cutoff by a day (an invalid tz falls back to UTC).
 */
export function clampBookingHorizon(
  from: string,
  to: string,
  horizonDays: number,
  now: Date,
  timezone: string,
): { from: string; to: string } | null {
  const maxDate = maxBookableYmd(now, horizonDays, timezone);
  if (from > maxDate) return null;
  return { from, to: to > maxDate ? maxDate : to };
}

/** Latest bookable calendar date (YYYY-MM-DD) = today-in-tz + horizonDays. */
function maxBookableYmd(now: Date, horizonDays: number, timezone: string): string {
  const tz = isValidTimezone(timezone) ? timezone : 'UTC';
  const [y, mo, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number);
  return new Date(Date.UTC(y, mo - 1, d + horizonDays)).toISOString().slice(0, 10);
}

/** Booking cadence — slots are offered on a 30-minute grid from business open. */
const GRANULARITY_MS = 30 * 60 * 1000;
const MAX_RANGE_DAYS = 21;
const MAX_SLOTS = 20;

/** luxon weekday (1=Mon..7=Sun) → tenant_settings.business_hours key. */
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
/** luxon weekday (1=Mon..7=Sun) → TechnicianWorkingHours.dayOfWeek (0=Sun..6=Sat). */
const LUXON_TO_DOW = [1, 2, 3, 4, 5, 6, 0] as const;

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function hhmmToMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

export interface DayWindow {
  openMinutes: number;
  closeMinutes: number;
}

/**
 * A weekly-hours object counts as configured when at least one day carries a
 * well-formed open<close window. `{}` (onboarding "not set") and all-null
 * shapes fall back to defaults rather than reading as "closed every day".
 */
export function hasConfiguredWeeklyHours(
  weekly: WeeklyBusinessHours | null | undefined,
): weekly is WeeklyBusinessHours {
  if (!weekly) return false;
  return Object.values(weekly).some(
    (w) =>
      w != null &&
      HHMM_RE.test(w.open) &&
      HHMM_RE.test(w.close) &&
      hhmmToMinutes(w.open) < hhmmToMinutes(w.close),
  );
}

/**
 * The business window for one calendar day, or null when the business is
 * closed that day. `weekly` wins when configured; otherwise the legacy
 * single open/close pair (or the 8–17 default) applies to every day.
 */
export function dayWindowFor(
  weekdayKey: (typeof WEEKDAY_KEYS)[number],
  weekly: WeeklyBusinessHours | null | undefined,
  pair: BusinessHours,
): DayWindow | null {
  if (hasConfiguredWeeklyHours(weekly)) {
    const w = weekly[weekdayKey];
    if (
      w == null ||
      !HHMM_RE.test(w.open) ||
      !HHMM_RE.test(w.close) ||
      hhmmToMinutes(w.open) >= hhmmToMinutes(w.close)
    ) {
      return null; // closed (or malformed entry — never guess a window)
    }
    return { openMinutes: hhmmToMinutes(w.open), closeMinutes: hhmmToMinutes(w.close) };
  }
  return { openMinutes: pair.openHour * 60, closeMinutes: pair.closeHour * 60 };
}

/**
 * Scheduling-relevant tenant configuration, extracted once so every caller
 * (dispatch route, public booking, portal, voice skill) consumes settings
 * through the same seam — this is the propagation path V17 pins.
 */
export interface TenantSchedulingConfig {
  timezone: string | null;
  weeklyHours: WeeklyBusinessHours | null;
  bufferMinutes: number | null;
}

export function schedulingConfigFromSettings(
  settings: Pick<TenantSettings, 'timezone' | 'businessHours' | 'jobBufferMinutes'> | null,
): TenantSchedulingConfig {
  return {
    timezone: settings?.timezone ?? null,
    weeklyHours: settings?.businessHours ?? null,
    bufferMinutes: settings?.jobBufferMinutes ?? null,
  };
}

/** Local wall-clock minutes-of-day + calendar date for an instant in `tz`. */
function localMinutesOfDay(d: Date, tz: string): { minutes: number; ymd: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // some engines render midnight as 24:00
  return {
    minutes: hour * 60 + parseInt(get('minute'), 10),
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/**
 * True when [start, end) falls inside the tenant's business hours on a single
 * local day — the write-side twin of the windows `findBookableSlots` offers,
 * so a POST can only book what GET would offer. Uses the tenant's configured
 * per-day hours when present, falling back to DEFAULT_BUSINESS_HOURS.
 */
export function isWithinBusinessHours(
  start: Date,
  end: Date,
  timezone: string,
  weeklyHours: WeeklyBusinessHours | null | undefined,
): boolean {
  const tz = isValidTimezone(timezone) ? timezone : 'UTC';
  const s = localMinutesOfDay(start, tz);
  const e = localMinutesOfDay(end, tz);
  if (s.ymd !== e.ymd) return false; // must not span local days
  const day = DateTime.fromISO(s.ymd, { zone: tz });
  if (!day.isValid) return false;
  const window = dayWindowFor(
    WEEKDAY_KEYS[day.weekday - 1],
    weeklyHours ?? null,
    DEFAULT_BUSINESS_HOURS,
  );
  if (!window) return false; // closed that day
  return (
    s.minutes >= window.openMinutes &&
    e.minutes <= window.closeMinutes &&
    s.minutes < e.minutes
  );
}

/** Round `t` up to the next multiple of `granularityMs` measured from `anchor`. */
function snapUpFrom(t: number, anchor: number, granularityMs: number): number {
  if (t <= anchor) return anchor;
  const delta = t - anchor;
  const rem = delta % granularityMs;
  return rem === 0 ? t : t + (granularityMs - rem);
}

export interface BookableSlotsDeps {
  appointmentRepo: AppointmentRepository;
  assignmentRepo?: AssignmentRepository;
  /** When present and a technicianId is given, day windows clamp to the tech's hours. */
  workingHoursRepo?: WorkingHoursRepository;
  /** When present and a technicianId is given, the tech's time-off blocks the slot walk. */
  unavailableBlockRepo?: UnavailableBlockRepository;
}

export interface FindBookableSlotsInput {
  tenantId: string;
  /** Inclusive start day, YYYY-MM-DD. */
  fromDate: string;
  /** Inclusive end day, YYYY-MM-DD. */
  toDate: string;
  /** IANA timezone the business operates in; slots are clamped to its day. */
  timezone: string;
  durationMin: number;
  technicianId?: string;
  /** Legacy single open/close pair, applied to every day when `weeklyHours` is not configured. */
  businessHours?: BusinessHours;
  /** Tenant per-day hours (`tenant_settings.business_hours`). Wins over `businessHours`. */
  weeklyHours?: WeeklyBusinessHours | null;
  /** Tenant travel buffer (`tenant_settings.job_buffer_minutes`). Default 30. */
  bufferMinutes?: number | null;
  maxSlots?: number;
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * Where each input to the slot computation came from — surfaced so a cold
 * tenant's response can say "these are defaults, configure X" instead of
 * silently returning windows the tenant never chose (V18).
 */
export interface BookableSlotsConfigMeta {
  businessHoursSource: 'tenant' | 'default';
  bufferSource: 'tenant' | 'default';
  bufferMinutes: number;
  /** True when the named technician has active working-hours rows that clamped the windows. */
  technicianHoursApplied: boolean;
  /** True when the named technician's time-off blocks were subtracted. */
  technicianTimeOffApplied: boolean;
}

export interface FindBookableSlotsDetailedResult {
  slots: OpenSlot[];
  config: BookableSlotsConfigMeta;
}

function buildFinder(deps: BookableSlotsDeps): DefaultAvailabilityFinder {
  return new DefaultAvailabilityFinder({
    appointmentRepo: deps.appointmentRepo,
    assignmentRepo: deps.assignmentRepo,
  });
}

export async function findBookableSlots(
  deps: BookableSlotsDeps,
  input: FindBookableSlotsInput,
): Promise<OpenSlot[]> {
  return (await findBookableSlotsDetailed(deps, input)).slots;
}

export async function findBookableSlotsDetailed(
  deps: BookableSlotsDeps,
  input: FindBookableSlotsInput,
): Promise<FindBookableSlotsDetailedResult> {
  const tz = isValidTimezone(input.timezone) ? input.timezone : 'UTC';
  const durationMs = input.durationMin * 60 * 1000;
  const weeklyConfigured = hasConfiguredWeeklyHours(input.weeklyHours);
  const pair = input.businessHours ?? DEFAULT_BUSINESS_HOURS;
  const bufferMs =
    input.bufferMinutes != null && input.bufferMinutes >= 0
      ? input.bufferMinutes * 60 * 1000
      : DEFAULT_BUFFER_MS;

  const config: BookableSlotsConfigMeta = {
    businessHoursSource:
      weeklyConfigured || input.businessHours ? 'tenant' : 'default',
    bufferSource: input.bufferMinutes != null && input.bufferMinutes >= 0 ? 'tenant' : 'default',
    bufferMinutes: bufferMs / 60000,
    technicianHoursApplied: false,
    technicianTimeOffApplied: false,
  };

  if (durationMs <= 0) return { slots: [], config };
  const maxSlots = Math.max(1, Math.min(input.maxSlots ?? 6, MAX_SLOTS));
  const now = input.now ?? new Date();
  const finder = buildFinder(deps);

  // Technician constraints load once for the whole range.
  let techDayWindows: Map<number, DayWindow> | null = null; // key: dayOfWeek 0=Sun..6=Sat
  if (input.technicianId && deps.workingHoursRepo) {
    const rows = await deps.workingHoursRepo.findByTechnician(
      input.tenantId,
      input.technicianId,
    );
    const active = rows.filter((r) => r.isActive);
    // Zero active rows means the tenant doesn't model this tech's hours —
    // fall back to business hours rather than reading "never works".
    if (active.length > 0) {
      techDayWindows = new Map();
      for (const r of active) {
        techDayWindows.set(r.dayOfWeek, {
          openMinutes: hhmmToMinutes(r.startTime),
          closeMinutes: hhmmToMinutes(r.endTime),
        });
      }
      config.technicianHoursApplied = true;
    }
  }

  // Build the per-day search windows first (bounded), then query them in
  // parallel — sequential per-day round-trips add avoidable latency.
  const windows: { start: Date; end: Date }[] = [];
  let day = DateTime.fromISO(input.fromDate, { zone: tz });
  const lastDay = DateTime.fromISO(input.toDate, { zone: tz });
  if (!day.isValid || !lastDay.isValid) return { slots: [], config };
  let guard = 0;
  while (day.toMillis() <= lastDay.toMillis() && guard < MAX_RANGE_DAYS) {
    guard++;
    const weekdayKey = WEEKDAY_KEYS[day.weekday - 1];
    let window = dayWindowFor(weekdayKey, weeklyConfigured ? input.weeklyHours : null, pair);
    if (window && techDayWindows) {
      const techWindow = techDayWindows.get(LUXON_TO_DOW[day.weekday - 1]);
      if (!techWindow) {
        window = null; // tech modeled but not working this weekday
      } else {
        window = {
          openMinutes: Math.max(window.openMinutes, techWindow.openMinutes),
          closeMinutes: Math.min(window.closeMinutes, techWindow.closeMinutes),
        };
        if (window.openMinutes >= window.closeMinutes) window = null;
      }
    }
    if (window) {
      // Wall-clock → instant via luxon so DST transition days keep local
      // hours honest (a fixed-offset-from-midnight is an hour off there).
      const winStart = day
        .set({
          hour: Math.floor(window.openMinutes / 60),
          minute: window.openMinutes % 60,
          second: 0,
          millisecond: 0,
        })
        .toMillis();
      const winEnd = day
        .set({
          hour: Math.floor(window.closeMinutes / 60) % 24,
          minute: window.closeMinutes % 60,
          second: 0,
          millisecond: 0,
        })
        .plus({ days: window.closeMinutes >= 24 * 60 ? 1 : 0 })
        .toMillis();
      // Never offer a slot in the past, and keep the booking cadence clean by
      // snapping a clamped start up to the next grid boundary from open.
      const effectiveStart =
        winStart < now.getTime() ? snapUpFrom(now.getTime(), winStart, GRANULARITY_MS) : winStart;
      if (effectiveStart + durationMs <= winEnd) {
        windows.push({ start: new Date(effectiveStart), end: new Date(winEnd) });
      }
    }
    day = day.plus({ days: 1 });
  }

  if (windows.length === 0) return { slots: [], config };

  // Time-off blocks fetched once for the whole searched range.
  let extraBusy: { start: Date; end: Date }[] | undefined;
  if (input.technicianId && deps.unavailableBlockRepo) {
    const blocks = await deps.unavailableBlockRepo.findByTechnicianAndDateRange(
      input.tenantId,
      input.technicianId,
      windows[0].start,
      windows[windows.length - 1].end,
    );
    if (blocks.length > 0) {
      extraBusy = blocks.map((b) => ({ start: b.startTime, end: b.endTime }));
      config.technicianTimeOffApplied = true;
    }
  }

  const perWindow = await Promise.all(
    windows.map((w) =>
      finder.find({
        tenantId: input.tenantId,
        searchFrom: w.start,
        searchTo: w.end,
        durationMs,
        technicianId: input.technicianId,
        count: maxSlots,
        granularityMs: GRANULARITY_MS,
        bufferMs,
        extraBusy,
      }),
    ),
  );

  // Windows are already in chronological order; flatten and cap.
  const slots: OpenSlot[] = [];
  for (const result of perWindow) {
    if (result.ok) slots.push(...result.slots);
    if (slots.length >= maxSlots) break;
  }
  return { slots: slots.slice(0, maxSlots), config };
}

/**
 * Re-verify a specific slot is still open at book time. Guards against two
 * customers grabbing the same window between availability fetch and booking:
 * the first booking's hold makes the finder report the slot busy, so the
 * second `isSlotFree` returns false. Uses a zero buffer because we are
 * checking the literal slot the customer was already offered. This check is
 * advisory — the `no_double_booking` DB constraint is the authoritative
 * guard once a technician is assigned.
 */
export async function isSlotFree(
  deps: BookableSlotsDeps,
  input: { tenantId: string; start: Date; end: Date; technicianId?: string },
): Promise<boolean> {
  const durationMs = input.end.getTime() - input.start.getTime();
  if (durationMs <= 0) return false;
  const finder = buildFinder(deps);
  const result = await finder.find({
    tenantId: input.tenantId,
    searchFrom: input.start,
    searchTo: input.end,
    durationMs,
    technicianId: input.technicianId,
    count: 1,
    bufferMs: 0,
  });
  return result.ok && result.slots.length > 0 && result.slots[0].start.getTime() === input.start.getTime();
}
