import { describe, expect, it } from 'vitest';
import { appointmentTypeSchema, APPOINTMENT_TYPES } from './appointment-type.js';

describe('appointmentTypeSchema', () => {
  it('accepts each canonical visit kind', () => {
    for (const t of ['estimate', 'repair', 'install', 'maintenance', 'diagnostic']) {
      expect(appointmentTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it('is exactly the five canonical types (locks the DB CHECK in lockstep)', () => {
    expect([...APPOINTMENT_TYPES].sort()).toEqual([
      'diagnostic',
      'estimate',
      'install',
      'maintenance',
      'repair',
    ]);
  });

  it('rejects values outside the set — emergency, empty, or wrong-case', () => {
    // "emergency" is intentionally excluded (urgency is a trust-tier concern).
    expect(appointmentTypeSchema.safeParse('emergency').success).toBe(false);
    expect(appointmentTypeSchema.safeParse('').success).toBe(false);
    expect(appointmentTypeSchema.safeParse('Repair').success).toBe(false);
  });
});
