import { describe, it, expect, vi } from 'vitest';
import {
  lookupAvailability,
  describeSlots,
} from '../../../src/ai/skills/lookup-availability';
import type {
  AvailabilityFinder,
  FindOpenSlotsResult,
} from '../../../src/ai/tasks/availability-finder';

function stubFinder(result: FindOpenSlotsResult): AvailabilityFinder {
  return { find: vi.fn(async () => result) };
}

const tenantId = 'tenant-1';

describe('lookupAvailability', () => {
  const HOUR = 60 * 60 * 1000;
  const baseInput = {
    tenantId,
    searchFrom: new Date('2026-04-21T16:00:00Z'), // Tuesday 9am Pacific
    searchTo: new Date('2026-04-22T03:00:00Z'),
    durationMs: HOUR,
    timezone: 'America/Los_Angeles',
  };

  it('happy path — returns slots and a TTS message', async () => {
    const finder = stubFinder({
      ok: true,
      slots: [
        { start: new Date('2026-04-21T20:00:00Z'), end: new Date('2026-04-21T21:00:00Z') }, // 1pm PT
        { start: new Date('2026-04-21T22:00:00Z'), end: new Date('2026-04-21T23:00:00Z') }, // 3pm PT
      ],
    });

    const result = await lookupAvailability(baseInput, finder);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.slots.length).toBe(2);
    // Multi-slot phrasing — uses "or"
    expect(result.message).toContain('Tuesday at 1 PM');
    expect(result.message).toContain('Tuesday at 3 PM');
    expect(result.message).toContain('which works');
  });

  it('single-slot phrasing uses "does that work" instead of "which works"', async () => {
    const finder = stubFinder({
      ok: true,
      slots: [
        { start: new Date('2026-04-21T20:00:00Z'), end: new Date('2026-04-21T21:00:00Z') },
      ],
    });

    const result = await lookupAvailability(baseInput, finder);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.message).toContain('does that work');
    expect(result.message).not.toContain('which works');
  });

  it('no_slots — returns the empty-calendar fallback message', async () => {
    const finder = stubFinder({ ok: true, slots: [] });

    const result = await lookupAvailability(baseInput, finder);

    expect(result.status).toBe('no_slots');
    if (result.status !== 'no_slots') return;
    expect(result.message).toContain('not seeing any open slots');
  });

  it('unavailable — surfaces the finder failure reason', async () => {
    const finder = stubFinder({ ok: false, reason: 'connection reset' });

    const result = await lookupAvailability(baseInput, finder);

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('connection reset');
  });

  it('drops :00 from on-the-hour times to read naturally', async () => {
    expect(
      describeSlots(
        [
          { start: new Date('2026-04-21T20:00:00Z'), end: new Date('2026-04-21T21:00:00Z') },
        ],
        'America/Los_Angeles'
      )
    ).toBe('Tuesday at 1 PM');
  });

  it('keeps minutes for non-hour times', async () => {
    expect(
      describeSlots(
        [
          { start: new Date('2026-04-21T20:30:00Z'), end: new Date('2026-04-21T21:30:00Z') },
        ],
        'America/Los_Angeles'
      )
    ).toBe('Tuesday at 1:30 PM');
  });
});

describe('describeSlots', () => {
  const tz = 'America/Los_Angeles';

  it('one slot → bare label', () => {
    const out = describeSlots(
      [{ start: new Date('2026-04-21T20:00:00Z'), end: new Date('2026-04-21T21:00:00Z') }],
      tz
    );
    expect(out).toBe('Tuesday at 1 PM');
  });

  it('two slots → "X or Y"', () => {
    const out = describeSlots(
      [
        { start: new Date('2026-04-21T20:00:00Z'), end: new Date('2026-04-21T21:00:00Z') },
        { start: new Date('2026-04-21T22:00:00Z'), end: new Date('2026-04-21T23:00:00Z') },
      ],
      tz
    );
    expect(out).toBe('Tuesday at 1 PM or Tuesday at 3 PM');
  });

  it('three slots → "A, B, or C"', () => {
    const out = describeSlots(
      [
        { start: new Date('2026-04-21T20:00:00Z'), end: new Date('2026-04-21T21:00:00Z') },
        { start: new Date('2026-04-21T22:00:00Z'), end: new Date('2026-04-21T23:00:00Z') },
        { start: new Date('2026-04-22T16:00:00Z'), end: new Date('2026-04-22T17:00:00Z') },
      ],
      tz
    );
    expect(out).toBe('Tuesday at 1 PM, Tuesday at 3 PM, or Wednesday at 9 AM');
  });

  it('empty → empty string', () => {
    expect(describeSlots([], tz)).toBe('');
  });
});
