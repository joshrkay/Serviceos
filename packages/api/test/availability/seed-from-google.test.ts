import { describe, it, expect, vi } from 'vitest';
import {
  seedAvailabilityFromGoogle,
  makeGoogleFreeBusyFetcher,
} from '../../src/availability/seed-from-google';
import { fakeTenantPool } from '../helpers/fake-tenant-pool';

const TENANT = '3c9a7e1f-2b4d-4e6f-8a0b-1c2d3e4f5a6b';
const UPDATE = /^UPDATE tenant_settings SET availability_template/;

describe('seedAvailabilityFromGoogle', () => {
  it('pulls the next 7 days of free/busy and persists an availability template', async () => {
    const busy = [{ start: '2026-06-09T15:00:00Z', end: '2026-06-09T16:00:00Z' }];
    const freeBusy = vi.fn(
      async (_input: { accessToken: string; timeMin: string; timeMax: string; calendarId: string }) => ({ busy }),
    );
    const fake = fakeTenantPool();
    const now = new Date('2026-06-08T00:00:00Z');

    const res = await seedAvailabilityFromGoogle(
      { pool: fake.pool, freeBusy, accessToken: 'tok' },
      { tenantId: TENANT, now },
    );

    expect(res.busyCount).toBe(1);
    const fbArg = freeBusy.mock.calls[0][0];
    expect(fbArg.timeMin).toBe(now.toISOString());
    expect(fbArg.timeMax).toBe(new Date(now.getTime() + 7 * 86400000).toISOString());
    expect(fbArg.calendarId).toBe('primary');

    const [update] = fake.work();
    expect(update.sql).toMatch(UPDATE);
    expect(update.values?.[0]).toBe(TENANT);
    expect(JSON.parse(update.values?.[1] as string)).toMatchObject({ source: 'google', windowDays: 7, busy });
  });

  it('writes an empty template when the calendar has no busy blocks', async () => {
    const freeBusy = vi.fn(async () => ({ busy: [] }));
    const fake = fakeTenantPool();
    const res = await seedAvailabilityFromGoogle(
      { pool: fake.pool, freeBusy, accessToken: 'tok' },
      { tenantId: TENANT },
    );
    expect(res.busyCount).toBe(0);
    expect(res.template.busy).toEqual([]);
  });

  // Raw-pg audit 2026-10-23 §4 P2.5 — the UPDATE runs in a tenant session under
  // the RLS runtime role, not as a bare pool.query on the principal; the
  // free/busy fetch (network) happens before it, with no connection held.
  // Real Postgres: test/integration/availability-seed-tenant-context.test.ts.
  it('runs the UPDATE in one tenant session: BEGIN, the GUC + role, the UPDATE, COMMIT, on one checkout', async () => {
    const fake = fakeTenantPool();

    await seedAvailabilityFromGoogle(
      { pool: fake.pool, freeBusy: async () => ({ busy: [] }), accessToken: 'tok' },
      { tenantId: TENANT },
    );

    expect(fake.checkouts()).toBe(1);
    expect(fake.open()).toBe(0);
    const sql = fake.statements.map((s) => s.sql);
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toMatch(/set_config\('app\.current_tenant_id'/);
    expect(fake.statements[1].values).toEqual([TENANT]);
    expect(sql[2]).toMatch(UPDATE);
    expect(sql[3]).toBe('COMMIT');
    expect(sql).toHaveLength(4);
  });

  it('holds no connection across the free/busy fetch, and a failed fetch takes none at all', async () => {
    const fake = fakeTenantPool();
    let checkoutsDuringFetch = -1;

    await seedAvailabilityFromGoogle(
      {
        pool: fake.pool,
        freeBusy: async () => {
          checkoutsDuringFetch = fake.checkouts();
          return { busy: [] };
        },
        accessToken: 'tok',
      },
      { tenantId: TENANT },
    );
    await expect(
      seedAvailabilityFromGoogle(
        {
          pool: fake.pool,
          freeBusy: async () => {
            throw new Error('Google freeBusy failed (503)');
          },
          accessToken: 'tok',
        },
        { tenantId: TENANT },
      ),
    ).rejects.toThrow('Google freeBusy failed (503)');

    expect(checkoutsDuringFetch).toBe(0);
    expect(fake.checkouts()).toBe(1);
  });

  it('a failed UPDATE rolls the session back, releases the client and rethrows (the callback treats the seed as best-effort)', async () => {
    const fake = fakeTenantPool((sql) => {
      if (UPDATE.test(sql)) throw new Error('update failed');
      return undefined;
    });

    await expect(
      seedAvailabilityFromGoogle(
        { pool: fake.pool, freeBusy: async () => ({ busy: [] }), accessToken: 'tok' },
        { tenantId: TENANT },
      ),
    ).rejects.toThrow('update failed');

    expect(fake.statements.map((s) => s.sql)).toContain('ROLLBACK');
    expect(fake.statements.map((s) => s.sql)).not.toContain('COMMIT');
    expect(fake.open()).toBe(0);
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
