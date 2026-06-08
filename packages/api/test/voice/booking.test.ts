/**
 * Feature 4 — Booking with real-time tech availability.
 *
 * Runs the REAL scheduling engine (findBookableSlots → isSlotFree → overlap
 * guard → after-hours flag) over the booking corpus, then asserts the parity
 * bar and the two hard rules:
 *  - booking_rate >= 0.75 over bookable fixtures (EN and ES, broken out);
 *  - never double-books, never books outside business hours;
 *  - a 100-calendar randomized stress test that the guards never let a
 *    colliding or out-of-hours slot through.
 */
import { describe, it, expect } from 'vitest';
import { loadBookingCorpus } from './_fixtures';
import {
  simulateBooking,
  bookingRate,
  type BookingFixtureInput,
} from '../../src/voice/parity/booking-simulator';
import type { Appointment } from '../../src/appointments/appointment';

const corpus = loadBookingCorpus();
const BOOKING_RATE_FLOOR = 0.75;

function toInput(f: (typeof corpus.fixtures)[number]): BookingFixtureInput {
  return {
    tenantId: corpus.tenantId,
    timezone: corpus.timezone,
    fromDate: f.fromDate,
    toDate: f.toDate,
    durationMin: f.durationMin,
    businessHours: corpus.businessHours,
    schedule: corpus.schedule,
    existingAppointments: f.existingAppointments,
    slotsToOffer: 2,
    now: corpus.now,
  };
}

describe('Feature 4 — booking with availability', () => {
  it('proposes at most two in-window slots and books the confirmed one', async () => {
    const f = corpus.fixtures.find((x) => x.name === 'empty-calendar-tue');
    expect(f).toBeDefined();
    const outcome = await simulateBooking(toInput(f!));
    expect(outcome.booked).toBe(true);
    expect(outcome.proposed.length).toBeGreaterThan(0);
    expect(outcome.proposed.length).toBeLessThanOrEqual(2);
    expect(outcome.chosen).toBeDefined();
  });

  it(`booking_rate over bookable fixtures is >= ${BOOKING_RATE_FLOOR}`, async () => {
    const bookable = corpus.fixtures.filter((f) => f.expectBookable).map(toInput);
    const report = await bookingRate(bookable);
    expect(report.rate).toBeGreaterThanOrEqual(BOOKING_RATE_FLOOR);
    expect(report.doubleBookings).toBe(0);
    expect(report.outOfHoursBookings).toBe(0);
  });

  it('English and Spanish booking rates are at parity (both >= floor)', async () => {
    for (const lang of ['en', 'es'] as const) {
      const subset = corpus.fixtures.filter((f) => f.expectBookable && f.language === lang).map(toInput);
      expect(subset.length).toBeGreaterThan(0);
      const report = await bookingRate(subset);
      expect(report.rate).toBeGreaterThanOrEqual(BOOKING_RATE_FLOOR);
    }
  });

  it('correctly declines when there is no availability or the window is past', async () => {
    const unbookable = corpus.fixtures.filter((f) => !f.expectBookable);
    expect(unbookable.length).toBeGreaterThan(0);
    for (const f of unbookable) {
      const outcome = await simulateBooking(toInput(f));
      expect(outcome.booked).toBe(false);
    }
  });

  it('never double-books or books out-of-hours across 100 randomized calendars', async () => {
    let rng = 1234567;
    const next = () => {
      // Deterministic LCG so failures reproduce.
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng / 0x7fffffff;
    };
    for (let i = 0; i < 100; i++) {
      const existing: Appointment[] = [];
      const apptCount = Math.floor(next() * 6);
      for (let j = 0; j < apptCount; j++) {
        // Random start between 08:00 and 16:00 local (12:00Z–20:00Z) on Tue.
        const startHourZ = 12 + Math.floor(next() * 8);
        const start = new Date(`2026-06-09T${String(startHourZ).padStart(2, '0')}:00:00.000Z`);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        existing.push({
          id: `r-${i}-${j}`,
          tenantId: corpus.tenantId,
          jobId: `job-r-${i}-${j}`,
          scheduledStart: start,
          scheduledEnd: end,
          timezone: corpus.timezone,
          status: 'scheduled',
          holdPendingApproval: false,
          createdBy: 'stress',
          createdAt: corpus.now,
          updatedAt: corpus.now,
        });
      }
      const outcome = await simulateBooking({
        tenantId: corpus.tenantId,
        timezone: corpus.timezone,
        fromDate: '2026-06-09',
        toDate: '2026-06-09',
        durationMin: 60,
        businessHours: corpus.businessHours,
        schedule: corpus.schedule,
        existingAppointments: existing,
        slotsToOffer: 2,
        now: corpus.now,
      });
      expect(outcome.doubleBooked).toBe(false);
      expect(outcome.outOfHours).toBe(false);
    }
  });
});
