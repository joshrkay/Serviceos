/**
 * Feature 5 — After-hours / overflow handling.
 *
 * Exercises the pure routing policy and the after-hours booking flag:
 *  - emergency dials on-call regardless of hour;
 *  - after-hours non-emergency → AI handles (ai_answering) or voicemail;
 *  - within-hours → human, unless every CSR seat is busy → AI overflow;
 *  - bookings made after hours are flagged for morning review.
 */
import { describe, it, expect } from 'vitest';
import { decideCallHandling, isAfterHoursBooking } from '../../src/voice/parity/overflow-router';
import type { BusinessHoursConfig } from '../../src/compliance/business-hours';

const schedule: BusinessHoursConfig = {
  timezone: 'America/New_York',
  schedule: [
    { dayOfWeek: 1, openTime: '08:00', closeTime: '17:00' },
    { dayOfWeek: 2, openTime: '08:00', closeTime: '17:00' },
    { dayOfWeek: 3, openTime: '08:00', closeTime: '17:00' },
    { dayOfWeek: 4, openTime: '08:00', closeTime: '17:00' },
    { dayOfWeek: 5, openTime: '08:00', closeTime: '17:00' },
  ],
};

describe('Feature 5 — after-hours / overflow', () => {
  it('emergency dials on-call regardless of business hours', () => {
    const afterHours = decideCallHandling({ withinBusinessHours: false, isEmergency: true });
    const inHours = decideCallHandling({ withinBusinessHours: true, isEmergency: true });
    expect(afterHours.mode).toBe('emergency_dial');
    expect(inHours.mode).toBe('emergency_dial');
  });

  it('after-hours booking call is AI-handled and flagged when ai_answering', () => {
    const d = decideCallHandling({
      withinBusinessHours: false,
      isEmergency: false,
      afterHoursVoiceMode: 'ai_answering',
    });
    expect(d.mode).toBe('ai_handles');
    expect(d.afterHours).toBe(true);
    expect(d.flagBookingAfterHours).toBe(true);
  });

  it('after-hours falls to voicemail when tenant did not opt into AI answering', () => {
    const d = decideCallHandling({
      withinBusinessHours: false,
      isEmergency: false,
      afterHoursVoiceMode: 'voicemail',
    });
    expect(d.mode).toBe('voicemail');
    expect(d.flagBookingAfterHours).toBe(false);
  });

  it('within hours routes to a human when a CSR seat is free', () => {
    const d = decideCallHandling({
      withinBusinessHours: true,
      isEmergency: false,
      csrSeats: 3,
      csrBusyCount: 1,
    });
    expect(d.mode).toBe('human');
  });

  it('within hours overflows to AI when every CSR seat is busy', () => {
    const d = decideCallHandling({
      withinBusinessHours: true,
      isEmergency: false,
      csrSeats: 2,
      csrBusyCount: 2,
    });
    expect(d.mode).toBe('ai_overflow');
    expect(d.flagBookingAfterHours).toBe(false);
  });

  it('flags a slot that starts outside business hours', () => {
    // 02:00 local (06:00Z, EDT) on a weekday — after hours.
    expect(isAfterHoursBooking(new Date('2026-06-09T06:00:00.000Z'), schedule)).toBe(true);
    // 10:00 local (14:00Z) on a weekday — open.
    expect(isAfterHoursBooking(new Date('2026-06-09T14:00:00.000Z'), schedule)).toBe(false);
  });

  it('fails open (not flagged) when no schedule is configured', () => {
    expect(isAfterHoursBooking(new Date('2026-06-09T06:00:00.000Z'), null)).toBe(false);
  });
});
