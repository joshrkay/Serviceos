/**
 * Appointment state-machine validation.
 *
 * Asserts both the predicate (isValidAppointmentTransition) and the
 * assertion form (assertValidAppointmentTransition) against the full
 * cross-product of AppointmentStatus values. Tightening or loosening the
 * lifecycle requires updating both the map and these tables.
 */

import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../src/shared/errors';
import { AppointmentStatus } from '../../src/appointments/appointment';
import {
  VALID_APPOINTMENT_TRANSITIONS,
  assertValidAppointmentTransition,
  isValidAppointmentTransition,
  isTerminalAppointmentStatus,
} from '../../src/appointments/appointment-lifecycle';

const ALL_STATUSES: AppointmentStatus[] = [
  'scheduled', 'confirmed', 'in_progress', 'completed', 'canceled', 'no_show',
];

describe('isValidAppointmentTransition — happy paths', () => {
  it.each<[AppointmentStatus, AppointmentStatus]>([
    ['scheduled', 'confirmed'],
    ['scheduled', 'in_progress'],
    ['scheduled', 'canceled'],
    ['scheduled', 'no_show'],
    ['confirmed', 'scheduled'],
    ['confirmed', 'in_progress'],
    ['confirmed', 'canceled'],
    ['confirmed', 'no_show'],
    ['in_progress', 'completed'],
    ['in_progress', 'canceled'],
    ['no_show', 'scheduled'],
  ])('accepts %s → %s', (from, to) => {
    expect(isValidAppointmentTransition(from, to)).toBe(true);
  });
});

describe('isValidAppointmentTransition — self-transitions', () => {
  it.each(ALL_STATUSES)('treats %s → %s as a no-op (allowed)', (status) => {
    expect(isValidAppointmentTransition(status, status)).toBe(true);
  });
});

describe('isValidAppointmentTransition — rejected paths', () => {
  it.each<[AppointmentStatus, AppointmentStatus]>([
    // completed is terminal — nothing transitions out
    ['completed', 'scheduled'],
    ['completed', 'confirmed'],
    ['completed', 'in_progress'],
    ['completed', 'canceled'],
    ['completed', 'no_show'],
    // canceled is terminal — re-engaging means a new appointment
    ['canceled', 'scheduled'],
    ['canceled', 'confirmed'],
    ['canceled', 'in_progress'],
    ['canceled', 'completed'],
    ['canceled', 'no_show'],
    // can't skip from scheduled/confirmed to completed without in_progress
    ['scheduled', 'completed'],
    ['confirmed', 'completed'],
    // in_progress can't go back to scheduled/confirmed/no_show
    ['in_progress', 'scheduled'],
    ['in_progress', 'confirmed'],
    ['in_progress', 'no_show'],
    // no_show only reopens to scheduled
    ['no_show', 'confirmed'],
    ['no_show', 'in_progress'],
    ['no_show', 'completed'],
    ['no_show', 'canceled'],
  ])('rejects %s → %s', (from, to) => {
    expect(isValidAppointmentTransition(from, to)).toBe(false);
  });
});

describe('assertValidAppointmentTransition', () => {
  it('returns void for an allowed transition', () => {
    expect(() => assertValidAppointmentTransition('scheduled', 'confirmed')).not.toThrow();
  });

  it('throws ValidationError (400) for a disallowed transition', () => {
    let caught: unknown;
    try {
      assertValidAppointmentTransition('completed', 'scheduled');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).statusCode).toBe(400);
  });

  it('error message names the from→to pair and the allowed set', () => {
    try {
      assertValidAppointmentTransition('scheduled', 'completed');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('scheduled');
      expect((e as Error).message).toContain('completed');
      expect((e as Error).message).toContain('Allowed from scheduled');
    }
  });

  it('reports the terminal sentinel when source has no outgoing edges', () => {
    try {
      assertValidAppointmentTransition('completed', 'in_progress');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('<terminal state>');
    }
  });
});

describe('isTerminalAppointmentStatus', () => {
  it('flags completed and canceled as terminal', () => {
    expect(isTerminalAppointmentStatus('completed')).toBe(true);
    expect(isTerminalAppointmentStatus('canceled')).toBe(true);
  });

  it('non-terminal statuses are not flagged', () => {
    expect(isTerminalAppointmentStatus('scheduled')).toBe(false);
    expect(isTerminalAppointmentStatus('confirmed')).toBe(false);
    expect(isTerminalAppointmentStatus('in_progress')).toBe(false);
    expect(isTerminalAppointmentStatus('no_show')).toBe(false);
  });
});

describe('VALID_APPOINTMENT_TRANSITIONS shape', () => {
  it('has an entry for every AppointmentStatus (DB CHECK parity)', () => {
    const keys = Object.keys(VALID_APPOINTMENT_TRANSITIONS).sort();
    expect(keys).toEqual([...ALL_STATUSES].sort());
  });

  it('only emits known statuses on the right-hand side', () => {
    const known = new Set<string>(ALL_STATUSES);
    for (const [from, targets] of Object.entries(VALID_APPOINTMENT_TRANSITIONS)) {
      for (const t of targets) {
        expect(known.has(t), `${from} → ${t} references an unknown status`).toBe(true);
        expect(t, `${from} should not list itself as an explicit transition`).not.toBe(from);
      }
    }
  });
});
