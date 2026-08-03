import { describe, it, expect } from 'vitest';
import {
  bookingSpeechForLane,
  spokenAutonomousBookConfirm,
  spokenBookingPendingOwner,
  spokenBookingDraftOnly,
  buildLaneInputFromSettings,
} from '../../../src/ai/voice-turn/inbound-booking-completion';

describe('inbound booking spoken outcomes (R6)', () => {
  it('eligible lane claims booked with confirmation SMS', () => {
    const line = spokenAutonomousBookConfirm('Tuesday at 2:00 PM');
    expect(line.toLowerCase()).toMatch(/booked/);
    expect(line.toLowerCase()).toMatch(/text|confirm/);
    expect(line.toLowerCase()).not.toMatch(/someone from our team will confirm/);
  });

  it('ineligible with time never claims final booking', () => {
    const line = spokenBookingPendingOwner('Tuesday at 2:00 PM');
    expect(line.toLowerCase()).toMatch(/reserved|team will confirm/);
    expect(line.toLowerCase()).not.toMatch(/you're booked/);
  });

  it('draft-only path is honest about pending human confirm', () => {
    const line = spokenBookingDraftOnly();
    expect(line.toLowerCase()).toMatch(/confirm/);
    expect(line.toLowerCase()).not.toMatch(/you're booked/);
  });

  it('bookingSpeechForLane routes by evaluation', () => {
    expect(
      bookingSpeechForLane({ eligible: true, threshold: 0.95 }, 'Friday at 10 AM'),
    ).toBe(spokenAutonomousBookConfirm('Friday at 10 AM'));
    expect(
      bookingSpeechForLane(
        { eligible: false, reason: 'tenant_not_opted_in' },
        'Friday at 10 AM',
      ),
    ).toBe(spokenBookingPendingOwner('Friday at 10 AM'));
    expect(bookingSpeechForLane(undefined, undefined)).toBe(spokenBookingDraftOnly());
  });
});

describe('buildLaneInputFromSettings', () => {
  const base = {
    holdExpiryAt: new Date(Date.now() + 60_000),
    now: new Date(),
    slotWithinBusinessHours: true,
    customerId: 'cust-1',
    confidenceScore: 0.97,
    payload: { appointmentId: 'appt-1' },
  };

  it('is ineligible when tenant has not opted in', () => {
    const eval_ = buildLaneInputFromSettings({
      ...base,
      settings: { enabled: false },
    });
    expect(eval_.eligible).toBe(false);
    if (!eval_.eligible) expect(eval_.reason).toBe('tenant_not_opted_in');
  });

  it('is eligible when tenant opted in and gates clear', () => {
    const eval_ = buildLaneInputFromSettings({
      ...base,
      settings: { enabled: true, threshold: 0.95 },
    });
    expect(eval_.eligible).toBe(true);
  });

  it('negotiation flag blocks the lane', () => {
    const eval_ = buildLaneInputFromSettings({
      ...base,
      settings: { enabled: true, threshold: 0.95 },
      negotiationFlagged: true,
    });
    expect(eval_.eligible).toBe(false);
    if (!eval_.eligible) expect(eval_.reason).toBe('session_flagged');
  });

  it('platform kill switch blocks before tenant opt-in', () => {
    const eval_ = buildLaneInputFromSettings({
      ...base,
      platformDisabled: true,
      settings: { enabled: true, threshold: 0.95 },
    });
    expect(eval_.eligible).toBe(false);
    if (!eval_.eligible) expect(eval_.reason).toBe('platform_disabled');
  });
});
