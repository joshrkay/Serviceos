import { describe, it, expect } from 'vitest';
import { formatAppointmentDurationLabel, calcMaterialsTotal } from './job-ui-math';
import type { MaterialItem } from '../types/job-ui';

describe('formatAppointmentDurationLabel', () => {
  // BUG C regression — the schedule card hardcoded "Est. 2–3 hours" regardless
  // of the real appointment window. The label must be derived from
  // scheduledStart → scheduledEnd (or omitted when unknown).
  it('derives a whole-hour label from the appointment window', () => {
    expect(
      formatAppointmentDurationLabel('2026-06-01T15:00:00Z', '2026-06-01T17:00:00Z'),
    ).toBe('Est. 2h');
  });

  it('includes minutes for a partial-hour window', () => {
    expect(
      formatAppointmentDurationLabel('2026-06-01T15:00:00Z', '2026-06-01T16:30:00Z'),
    ).toBe('Est. 1h 30m');
  });

  it('renders a sub-hour window in minutes only', () => {
    expect(
      formatAppointmentDurationLabel('2026-06-01T15:00:00Z', '2026-06-01T15:45:00Z'),
    ).toBe('Est. 45m');
  });

  it('is timezone-independent (measures elapsed instants, not wall clock)', () => {
    // Same two instants expressed with an offset render the same duration.
    expect(
      formatAppointmentDurationLabel('2026-06-01T08:00:00-07:00', '2026-06-01T10:00:00-07:00'),
    ).toBe('Est. 2h');
  });

  it('returns null when a bound is missing', () => {
    expect(formatAppointmentDurationLabel(null, '2026-06-01T17:00:00Z')).toBeNull();
    expect(formatAppointmentDurationLabel('2026-06-01T15:00:00Z', undefined)).toBeNull();
  });

  it('returns null for a non-positive or unparseable window', () => {
    expect(
      formatAppointmentDurationLabel('2026-06-01T17:00:00Z', '2026-06-01T15:00:00Z'),
    ).toBeNull();
    expect(formatAppointmentDurationLabel('not-a-date', '2026-06-01T15:00:00Z')).toBeNull();
  });
});

describe('calcMaterialsTotal', () => {
  it('sums qty * unitCost across materials', () => {
    const materials = [
      { id: 'm1', name: 'Filter', category: 'Part', qty: 2, unitCost: 10 },
      { id: 'm2', name: 'Coil', category: 'Part', qty: 1, unitCost: 50 },
    ] as unknown as MaterialItem[];
    expect(calcMaterialsTotal(materials)).toBe(70);
  });
});
