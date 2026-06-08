/**
 * Voice booking simulator (Feature 4).
 *
 * Exercises the REAL scheduling engine end-to-end for a single inbound booking,
 * so the corpus-level booking-rate and the "never double-book / never
 * out-of-hours" hard rules are measured against production code rather than a
 * mock:
 *
 *   1. `findBookableSlots` — open slots inside the caller's window + business
 *      hours (this is what the AI would read back to the caller).
 *   2. Offer the first N (default 2) as the verbal proposal.
 *   3. "Caller confirms the first slot" → re-verify with `isSlotFree` (the same
 *      race guard used at real book time).
 *   4. Overlap guard via `detectOverlappingAppointments` (any-tech sentinel).
 *   5. Flag the booked slot with `isAfterHoursBooking`.
 *
 * Pure given its inputs (injectable clock); no DB, no Twilio. The in-memory
 * appointment repo implements only what the finder/booker call.
 */

import {
  findBookableSlots,
  isSlotFree,
  type BusinessHours,
} from '../../scheduling/booking-availability';
import {
  Appointment,
  AppointmentRepository,
  AppointmentListOptions,
  AppointmentListResult,
} from '../../appointments/appointment';
import { detectOverlappingAppointments } from '../../dispatch/validation';
import { isAfterHoursBooking } from './overflow-router';
import type { BusinessHoursConfig } from '../../compliance/business-hours';
import type { OpenSlot } from '../../ai/tasks/availability-finder';

/** Sentinel technician id used to reuse the any-tech overlap check. */
const ANY_TECH = 'any-tech';

/**
 * Read-only in-memory appointment repo. `findBookableSlots` /`isSlotFree` only
 * call `findByDateRange`; the rest of the interface is implemented as the
 * minimum needed to satisfy the type (writes are unused by the read paths).
 */
export class InMemoryAppointmentRepo implements AppointmentRepository {
  private readonly rows: Appointment[];

  constructor(seed: Appointment[] = []) {
    this.rows = [...seed];
  }

  async create(appointment: Appointment): Promise<Appointment> {
    this.rows.push(appointment);
    return appointment;
  }

  async findById(tenantId: string, id: string): Promise<Appointment | null> {
    return this.rows.find((a) => a.tenantId === tenantId && a.id === id) ?? null;
  }

  async findByJob(tenantId: string, jobId: string): Promise<Appointment[]> {
    return this.rows.filter((a) => a.tenantId === tenantId && a.jobId === jobId);
  }

  async findByDateRange(tenantId: string, start: Date, end: Date): Promise<Appointment[]> {
    return this.rows.filter(
      (a) =>
        a.tenantId === tenantId &&
        a.scheduledStart.getTime() < end.getTime() &&
        a.scheduledEnd.getTime() > start.getTime(),
    );
  }

  async listWithMeta(
    tenantId: string,
    _options?: AppointmentListOptions,
  ): Promise<AppointmentListResult> {
    const data = this.rows.filter((a) => a.tenantId === tenantId);
    return { data, total: data.length };
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<Appointment>,
  ): Promise<Appointment | null> {
    const idx = this.rows.findIndex((a) => a.tenantId === tenantId && a.id === id);
    if (idx === -1) return null;
    this.rows[idx] = { ...this.rows[idx], ...updates };
    return this.rows[idx];
  }
}

export interface BookingFixtureInput {
  tenantId: string;
  /** IANA timezone the business operates in. */
  timezone: string;
  /** Inclusive caller window, YYYY-MM-DD. */
  fromDate: string;
  toDate: string;
  /** Requested duration in minutes. */
  durationMin: number;
  /** Business-hours window used by the slot finder (open/close hour, local). */
  businessHours: BusinessHours;
  /**
   * Full weekly schedule used to flag a booked slot as after-hours. Optional;
   * when omitted, a slot inside `businessHours` is never flagged.
   */
  schedule?: BusinessHoursConfig | null;
  /** Existing calendar state. */
  existingAppointments: Appointment[];
  /** How many slots to offer the caller. Defaults to 2 (parity spec). */
  slotsToOffer?: number;
  /** Injectable clock. */
  now?: Date;
}

export interface BookingOutcome {
  /** Whether a slot was successfully offered, confirmed, and verified free. */
  booked: boolean;
  /** Slots proposed to the caller (≤ slotsToOffer). */
  proposed: OpenSlot[];
  /** The slot the caller confirmed, when booked. */
  chosen?: OpenSlot;
  /** True if the confirmed slot collides with an active appointment (a bug). */
  doubleBooked: boolean;
  /** True if the confirmed slot starts outside business hours (a bug). */
  outOfHours: boolean;
  /** Why a booking did not happen, when `booked` is false. */
  reason?: 'no_slots_offered' | 'slot_taken' | 'double_book_blocked' | 'out_of_hours_blocked';
}

/**
 * Run one booking against the real engine. Returns a structured outcome; the
 * hard rules ("never double-book", "never out-of-hours") are enforced here by
 * refusing to book a slot that fails either guard, and surfaced via
 * `doubleBooked` / `outOfHours` so a test can assert they are always false.
 */
export async function simulateBooking(input: BookingFixtureInput): Promise<BookingOutcome> {
  const repo = new InMemoryAppointmentRepo(input.existingAppointments);
  const slotsToOffer = Math.max(1, input.slotsToOffer ?? 2);

  const open = await findBookableSlots(
    { appointmentRepo: repo },
    {
      tenantId: input.tenantId,
      fromDate: input.fromDate,
      toDate: input.toDate,
      timezone: input.timezone,
      durationMin: input.durationMin,
      businessHours: input.businessHours,
      maxSlots: slotsToOffer,
      now: input.now,
    },
  );

  const proposed = open.slice(0, slotsToOffer);
  if (proposed.length === 0) {
    return { booked: false, proposed, doubleBooked: false, outOfHours: false, reason: 'no_slots_offered' };
  }

  // Caller confirms the first offered slot.
  const chosen = proposed[0];

  // Race guard — identical to real book time.
  const stillFree = await isSlotFree(
    { appointmentRepo: repo },
    { tenantId: input.tenantId, start: chosen.start, end: chosen.end },
  );
  if (!stillFree) {
    return { booked: false, proposed, doubleBooked: false, outOfHours: false, reason: 'slot_taken' };
  }

  // Hard rule 1 — never double-book. Reuse the production overlap detector with
  // an any-tech sentinel so the chosen slot is compared against every active
  // appointment in the tenant.
  const overlaps = detectOverlappingAppointments(
    ANY_TECH,
    chosen.start,
    chosen.end,
    input.existingAppointments.map((a) => ({
      id: a.id,
      technicianId: ANY_TECH,
      scheduledStart: a.scheduledStart,
      scheduledEnd: a.scheduledEnd,
      status: a.status,
    })),
  );
  if (overlaps.length > 0) {
    return { booked: false, proposed, doubleBooked: true, outOfHours: false, reason: 'double_book_blocked' };
  }

  // Hard rule 2 — never book outside business hours.
  const outOfHours = isAfterHoursBooking(chosen.start, input.schedule ?? null);
  if (outOfHours) {
    return { booked: false, proposed, doubleBooked: false, outOfHours: true, reason: 'out_of_hours_blocked' };
  }

  return { booked: true, proposed, chosen, doubleBooked: false, outOfHours: false };
}

/** Aggregate booking-rate over a corpus of fixtures. */
export interface BookingRateReport {
  total: number;
  booked: number;
  rate: number;
  doubleBookings: number;
  outOfHoursBookings: number;
}

export async function bookingRate(fixtures: BookingFixtureInput[]): Promise<BookingRateReport> {
  let booked = 0;
  let doubleBookings = 0;
  let outOfHoursBookings = 0;
  for (const f of fixtures) {
    const outcome = await simulateBooking(f);
    if (outcome.booked) booked++;
    if (outcome.doubleBooked) doubleBookings++;
    if (outcome.outOfHours) outOfHoursBookings++;
  }
  return {
    total: fixtures.length,
    booked,
    rate: fixtures.length === 0 ? 0 : booked / fixtures.length,
    doubleBookings,
    outOfHoursBookings,
  };
}
