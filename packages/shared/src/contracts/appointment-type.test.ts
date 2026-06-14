import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { appointmentTypeSchema, APPOINTMENT_TYPES } from './appointment-type.js';
import { resolveDbCheckSet } from './db-check.js';

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

  it('stays in lockstep with the appointments.appointment_type DB CHECK', () => {
    // Same guard the status enums use: the Zod set and the DB CHECK must agree,
    // so a future drift fails CI instead of shipping.
    const here = dirname(fileURLToPath(import.meta.url));
    const schemaSource = readFileSync(
      resolve(here, '../../../api/src/db/schema.ts'),
      'utf8',
    );
    const dbSet = resolveDbCheckSet(schemaSource, 'appointments', 'appointment_type');
    expect([...dbSet].sort()).toEqual([...APPOINTMENT_TYPES].sort());
  });
});
