import {
  parseNaturalDatetime,
  resolveSchedulingEntities,
} from '../../../../src/ai/agents/customer-calling/entity-resolution';

// VOX-52 regression (PR #665 review): the resolver rewrite must still carry the
// classifier's free-text fields (reason, assigneeName, noteText, …) into refs —
// only the identity keys (customerId/jobId/appointmentId) are the resolver's
// authority and are never copied raw from the classifier.
describe('resolveSchedulingEntities — carries free-text classifier fields into refs', () => {
  it('preserves non-identity string entities, drops raw identity keys', async () => {
    const res = await resolveSchedulingEntities(undefined, 'tenant-1', 'reassign_appointment', {
      assigneeName: 'Maria',
      reason: 'customer requested a different tech',
      noteText: 'gate code is 1234',
      customerId: 'not-a-uuid-should-not-leak',
    });
    expect(res.status).toBe('resolved');
    expect(res.refs.assigneeName).toBe('Maria');
    expect(res.refs.reason).toBe('customer requested a different tech');
    expect(res.refs.noteText).toBe('gate code is 1234');
    // Identity keys are never trusted raw from the classifier.
    expect(res.refs.customerId).toBeUndefined();
  });

  it('does not overwrite a classifier-provided cancellation reason with the default', async () => {
    const res = await resolveSchedulingEntities(undefined, 'tenant-1', 'cancel_appointment', {
      reason: 'rescheduling to next week',
    });
    expect(res.refs.reason).toBe('rescheduling to next week');
  });
});

// QA-2026-06-05 (SCH-02/03) — deterministic NL datetime parsing for the
// calling agent's entity resolution. Fixed "now" so weekday math is stable.
describe('parseNaturalDatetime', () => {
  const now = new Date('2026-06-05T12:00:00Z'); // a Friday

  it('parses "next Tuesday at 2 PM"', () => {
    const w = parseNaturalDatetime('next Tuesday at 2 PM', now)!;
    const start = new Date(w.scheduledStart);
    expect(start.getUTCDay()).toBe(2); // Tuesday
    expect(start.getUTCHours()).toBe(14);
    expect(start.getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(w.scheduledEnd).getTime() - start.getTime()).toBe(60 * 60_000);
  });

  it('parses "tomorrow at 9:30 am"', () => {
    const w = parseNaturalDatetime('tomorrow at 9:30 am', now)!;
    const start = new Date(w.scheduledStart);
    expect(start.getUTCDate()).toBe(6);
    expect(start.getUTCHours()).toBe(9);
    expect(start.getUTCMinutes()).toBe(30);
  });

  it('bare weekday means the NEXT occurrence (never today)', () => {
    const w = parseNaturalDatetime('friday at 1 pm', now)!;
    const start = new Date(w.scheduledStart);
    expect(start.getUTCDay()).toBe(5);
    expect(start.getUTCDate()).toBe(12); // a week out, not today
  });

  it('time-only gets a future slot', () => {
    const w = parseNaturalDatetime('at 8 am', now)!;
    expect(new Date(w.scheduledStart).getTime()).toBeGreaterThan(now.getTime());
  });

  it('day-only defaults to a morning slot', () => {
    const w = parseNaturalDatetime('next monday', now)!;
    const start = new Date(w.scheduledStart);
    expect(start.getUTCDay()).toBe(1);
    expect(start.getUTCHours()).toBe(9);
  });

  it('returns undefined for unparseable text (never guesses)', () => {
    expect(parseNaturalDatetime('whenever works for you', now)).toBeUndefined();
    expect(parseNaturalDatetime('at 27 pm', now)).toBeUndefined();
  });

  it('12 am / 12 pm edge cases', () => {
    const noon = parseNaturalDatetime('tomorrow at 12 pm', now)!;
    expect(new Date(noon.scheduledStart).getUTCHours()).toBe(12);
    const midnight = parseNaturalDatetime('tomorrow at 12 am', now)!;
    expect(new Date(midnight.scheduledStart).getUTCHours()).toBe(0);
  });
});
