import { describe, it, expect, vi } from 'vitest';
import {
  seedAvailabilityFromGoogle,
  makeGoogleFreeBusyFetcher,
} from '../../src/availability/seed-from-google';

describe('seedAvailabilityFromGoogle', () => {
  it('pulls the next 7 days of free/busy and persists an availability template', async () => {
    const busy = [{ start: '2026-06-09T15:00:00Z', end: '2026-06-09T16:00:00Z' }];
    const freeBusy = vi.fn(
      async (_input: { accessToken: string; timeMin: string; timeMax: string; calendarId: string }) => ({ busy }),
    );
    const updates: unknown[][] = [];
    const pool = {
      query: vi.fn(async (_sql: string, params: unknown[]) => {
        updates.push(params);
        return { rows: [], rowCount: 1 };
      }),
    };
    const now = new Date('2026-06-08T00:00:00Z');

    const res = await seedAvailabilityFromGoogle(
      { pool: pool as never, freeBusy, accessToken: 'tok' },
      { tenantId: 't1', now },
    );

    expect(res.busyCount).toBe(1);
    const fbArg = freeBusy.mock.calls[0][0];
    expect(fbArg.timeMin).toBe(now.toISOString());
    expect(fbArg.timeMax).toBe(new Date(now.getTime() + 7 * 86400000).toISOString());
    expect(fbArg.calendarId).toBe('primary');

    const stored = JSON.parse(updates[0][1] as string);
    expect(stored).toMatchObject({ source: 'google', windowDays: 7, busy });
    expect(updates[0][0]).toBe('t1');
  });

  it('writes an empty template when the calendar has no busy blocks', async () => {
    const freeBusy = vi.fn(async () => ({ busy: [] }));
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) };
    const res = await seedAvailabilityFromGoogle(
      { pool: pool as never, freeBusy, accessToken: 'tok' },
      { tenantId: 't1' },
    );
    expect(res.busyCount).toBe(0);
    expect(res.template.busy).toEqual([]);
  });

  it('makeGoogleFreeBusyFetcher posts to the freeBusy API and extracts busy blocks', async () => {
    const busy = [{ start: 'a', end: 'b' }];
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ calendars: { primary: { busy } } }),
        text: async () => '',
      }) as unknown as Response,
    );
    const fetcher = makeGoogleFreeBusyFetcher(fetchFn as unknown as typeof fetch);
    const res = await fetcher({ accessToken: 'tok', timeMin: 'x', timeMax: 'y', calendarId: 'primary' });
    expect(res.busy).toEqual(busy);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    expect(JSON.parse(init.body as string)).toMatchObject({ items: [{ id: 'primary' }] });
  });
});
