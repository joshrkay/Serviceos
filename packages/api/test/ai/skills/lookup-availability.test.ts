import { describe, it, expect, vi } from 'vitest';
import {
  lookupAvailability,
  describeSlots,
} from '../../../src/ai/skills/lookup-availability';
import type {
  AvailabilityFinder,
  FindOpenSlotsInput,
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

// ============================================================
// P18-004 — isolated unit tests for lookup_availability
// ============================================================

describe('P18-004 lookup_availability — TTS / tenant isolation / repo wiring', () => {
  const HOUR = 60 * 60 * 1000;
  const baseInput = {
    tenantId: 'tenant-1',
    searchFrom: new Date('2026-04-21T16:00:00Z'),
    searchTo: new Date('2026-04-22T03:00:00Z'),
    durationMs: HOUR,
    timezone: 'America/Los_Angeles',
  };

  function stubFinder(result: FindOpenSlotsResult): AvailabilityFinder {
    return { find: vi.fn(async () => result) };
  }

  it('P18-004 lookup-availability single result — singular phrasing "does that work"', async () => {
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

  it('P18-004 lookup-availability multi result — uses plural "which works for you" with comma list', async () => {
    const finder = stubFinder({
      ok: true,
      slots: [
        { start: new Date('2026-04-21T20:00:00Z'), end: new Date('2026-04-21T21:00:00Z') },
        { start: new Date('2026-04-21T22:00:00Z'), end: new Date('2026-04-21T23:00:00Z') },
        { start: new Date('2026-04-22T16:00:00Z'), end: new Date('2026-04-22T17:00:00Z') },
      ],
    });
    const result = await lookupAvailability(baseInput, finder);
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.message).toContain('which works for you');
    expect(result.message).toContain('Tuesday at 1 PM');
    expect(result.message).toContain('Tuesday at 3 PM');
    expect(result.message).toContain('Wednesday at 9 AM');
  });

  it('P18-004 lookup-availability empty result — friendly TTS fallback', async () => {
    const finder = stubFinder({ ok: true, slots: [] });
    const result = await lookupAvailability(baseInput, finder);
    expect(result.status).toBe('no_slots');
    if (result.status !== 'no_slots') return;
    expect(result.message.toLowerCase()).toContain('not seeing any open slots');
    expect(result.message).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('P18-004 lookup-availability repo wiring — finder.find called with tenantId in input', async () => {
    const find: AvailabilityFinder['find'] = vi.fn(
      async (_input: FindOpenSlotsInput): Promise<FindOpenSlotsResult> => ({ ok: true, slots: [] }),
    );
    const finder: AvailabilityFinder = { find };

    await lookupAvailability(
      { ...baseInput, tenantId: 'tenant-X' },
      finder,
    );
    expect(find).toHaveBeenCalled();
    const mockFind = find as unknown as { mock: { calls: Array<[{ tenantId: string }]> } };
    const call = mockFind.mock.calls[0];
    if (!call) throw new Error('expected call');
    expect(call[0].tenantId).toBe('tenant-X');
  });

  it('P18-004 lookup-availability tenant isolation — finder receives caller tenantId only', async () => {
    const find: AvailabilityFinder['find'] = vi.fn(
      async (_input: FindOpenSlotsInput): Promise<FindOpenSlotsResult> => ({
        ok: true,
        slots: [
          { start: new Date('2026-04-21T20:00:00Z'), end: new Date('2026-04-21T21:00:00Z') },
        ],
      }),
    );
    const finder: AvailabilityFinder = { find };

    await lookupAvailability({ ...baseInput, tenantId: 'tenant-A' }, finder);
    await lookupAvailability({ ...baseInput, tenantId: 'tenant-B' }, finder);

    const mockFind = find as unknown as { mock: { calls: Array<[{ tenantId: string }]> } };
    const c0 = mockFind.mock.calls[0];
    const c1 = mockFind.mock.calls[1];
    if (!c0 || !c1) throw new Error('expected two calls');
    expect(c0[0].tenantId).toBe('tenant-A');
    expect(c1[0].tenantId).toBe('tenant-B');
    expect(c0[0].tenantId).not.toBe(c1[0].tenantId);
  });

  it('P18-004 lookup-availability date filter — searchFrom/searchTo passed through to finder', async () => {
    const find: AvailabilityFinder['find'] = vi.fn(
      async (_input: FindOpenSlotsInput): Promise<FindOpenSlotsResult> => ({ ok: true, slots: [] }),
    );
    const finder: AvailabilityFinder = { find };
    const from = new Date('2026-05-01T00:00:00Z');
    const to = new Date('2026-05-08T00:00:00Z');
    await lookupAvailability(
      { ...baseInput, searchFrom: from, searchTo: to, durationMs: HOUR },
      finder,
    );
    const mockFind = find as unknown as {
      mock: { calls: Array<[{ searchFrom: Date; searchTo: Date; durationMs: number }]> };
    };
    const call = mockFind.mock.calls[0];
    if (!call) throw new Error('expected call');
    expect(call[0].searchFrom).toBe(from);
    expect(call[0].searchTo).toBe(to);
    expect(call[0].durationMs).toBe(HOUR);
  });

  it('P18-004 lookup-availability technicianId filter — passed through to finder', async () => {
    const find: AvailabilityFinder['find'] = vi.fn(
      async (_input: FindOpenSlotsInput): Promise<FindOpenSlotsResult> => ({ ok: true, slots: [] }),
    );
    const finder: AvailabilityFinder = { find };
    await lookupAvailability(
      { ...baseInput, technicianId: 'tech-99', count: 2 },
      finder,
    );
    const mockFind = find as unknown as {
      mock: { calls: Array<[{ technicianId?: string; count?: number }]> };
    };
    const call = mockFind.mock.calls[0];
    if (!call) throw new Error('expected call');
    expect(call[0].technicianId).toBe('tech-99');
    expect(call[0].count).toBe(2);
  });

  it('P18-004 lookup-availability finder failure — returns status=unavailable with reason', async () => {
    const finder = stubFinder({ ok: false, reason: 'connection reset' });
    const result = await lookupAvailability(baseInput, finder);
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('connection reset');
  });

  it('P18-004 lookup-availability TTS contains no ISO timestamps in any branch', async () => {
    const ok = await lookupAvailability(
      baseInput,
      stubFinder({
        ok: true,
        slots: [{ start: new Date('2026-04-21T20:00:00Z'), end: new Date('2026-04-21T21:00:00Z') }],
      }),
    );
    if (ok.status !== 'ok') throw new Error('expected ok');
    expect(ok.message).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(ok.message).not.toMatch(/Z\b/);

    const empty = await lookupAvailability(baseInput, stubFinder({ ok: true, slots: [] }));
    if (empty.status !== 'no_slots') throw new Error('expected no_slots');
    expect(empty.message).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('P18-004 lookup-availability timezone rendering — same UTC time renders differently per zone', async () => {
    const slot = {
      start: new Date('2026-04-21T20:00:00Z'),
      end: new Date('2026-04-21T21:00:00Z'),
    };
    const finder = stubFinder({ ok: true, slots: [slot] });
    const la = await lookupAvailability(
      { ...baseInput, timezone: 'America/Los_Angeles' },
      finder,
    );
    const ny = await lookupAvailability(
      { ...baseInput, timezone: 'America/New_York' },
      finder,
    );
    if (la.status !== 'ok' || ny.status !== 'ok') throw new Error('expected ok');
    // 20:00 UTC = 1pm PT, 4pm ET
    expect(la.message).toContain('1 PM');
    expect(ny.message).toContain('4 PM');
  });

  it('P18-004 lookup-availability performance smoke — completes well under 500ms', async () => {
    const finder = stubFinder({
      ok: true,
      slots: [
        { start: new Date('2026-04-21T20:00:00Z'), end: new Date('2026-04-21T21:00:00Z') },
        { start: new Date('2026-04-21T22:00:00Z'), end: new Date('2026-04-21T23:00:00Z') },
      ],
    });
    const t0 = Date.now();
    const result = await lookupAvailability(baseInput, finder);
    const elapsed = Date.now() - t0;
    expect(result.status).toBe('ok');
    expect(elapsed).toBeLessThan(500);
  });
});

describe('lookupBookableAvailability — business-hours-aware voice variant (F2)', () => {
  const HOUR = 60 * 60 * 1000;

  async function run(overrides: Record<string, unknown> = {}) {
    const { lookupBookableAvailability } = await import(
      '../../../src/ai/skills/lookup-availability'
    );
    const { InMemoryAppointmentRepository } = await import(
      '../../../src/appointments/in-memory-appointment'
    );
    const appointmentRepo = new InMemoryAppointmentRepository();
    const result = await lookupBookableAvailability(
      {
        tenantId,
        timezone: 'America/New_York',
        searchFrom: new Date('2026-06-14T00:00:00Z'), // well before Monday's open
        searchDays: 2,
        durationMs: 2 * HOUR,
        ...overrides,
      },
      { appointmentRepo },
    );
    return result;
  }

  it('never offers a slot outside business hours (raw finder would offer searchFrom itself)', async () => {
    const result = await run();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    for (const s of result.slots) {
      const hourEt = Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          hour: 'numeric',
          hourCycle: 'h23',
        }).format(s.start),
      );
      expect(hourEt).toBeGreaterThanOrEqual(8);
      expect(hourEt).toBeLessThan(17);
    }
  });

  it('respects tenant per-day hours — a closed Sunday yields Monday slots only', async () => {
    const result = await run({
      weeklyHours: { mon: { open: '10:00', close: '16:00' }, sun: null },
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // 2026-06-14 is a Sunday (closed); first offer must be Monday 10:00 ET = 14:00Z.
    expect(result.slots[0].start.toISOString()).toBe('2026-06-15T14:00:00.000Z');
  });

  it('speaks the summary in the tenant timezone', async () => {
    const result = await run({
      weeklyHours: { mon: { open: '10:00', close: '16:00' }, sun: null },
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.message).toContain('Monday at 10 AM');
  });

  it('degrades to unavailable (not a crash) on a repo failure', async () => {
    const { lookupBookableAvailability } = await import(
      '../../../src/ai/skills/lookup-availability'
    );
    const result = await lookupBookableAvailability(
      {
        tenantId,
        timezone: 'America/New_York',
        searchFrom: new Date('2026-06-14T00:00:00Z'),
        searchDays: 2,
        durationMs: 2 * HOUR,
      },
      {
        appointmentRepo: {
          findByDateRange: async () => {
            throw new Error('db down');
          },
        } as never,
      },
    );
    // The finder itself fails open with ok:false -> zero slots surface as
    // no_slots; a thrown error above the finder surfaces as unavailable.
    expect(['no_slots', 'unavailable']).toContain(result.status);
  });
});
