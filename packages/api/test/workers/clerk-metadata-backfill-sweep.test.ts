/**
 * CLERK-META-2026-09-27 — unit tests for the Clerk metadata backfill sweep.
 *
 * The pool and Clerk API are both faked; no network, no DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { createLogger } from '../../src/logging/logger';
import {
  runClerkMetadataBackfillSweep,
  type ClerkMetadataBackfillSweepDeps,
} from '../../src/workers/clerk-metadata-backfill-sweep';
import type { SentryClient } from '../../src/monitoring/sentry';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const TENANT = '11111111-1111-1111-1111-111111111111';

interface FakeUser {
  clerk_user_id: string;
  tenant_id: string;
  role: string;
  created_at: Date;
}

const NOW = new Date('2026-09-27T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

/** In-memory Clerk: user id -> public_metadata. */
function makeClerkApi(initial: Record<string, Record<string, unknown>>, opts: { failPatch?: number; failGet?: number } = {}) {
  const store = new Map<string, Record<string, unknown>>(Object.entries(initial));
  const patches: Array<{ userId: string; body: unknown }> = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const userId = decodeURIComponent(String(url).split('/').pop()!);
    if (init?.method === 'PATCH') {
      if (opts.failPatch) {
        return { ok: false, status: opts.failPatch, text: async () => 'boom', json: async () => ({}) } as Response;
      }
      const body = JSON.parse(String(init.body));
      patches.push({ userId, body });
      const prev = store.get(userId) ?? {};
      store.set(userId, { ...prev, ...body.public_metadata });
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) } as Response;
    }
    if (opts.failGet) {
      return { ok: false, status: opts.failGet, text: async () => 'gone', json: async () => ({}) } as Response;
    }
    if (!store.has(userId)) {
      return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as Response;
    }
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ id: userId, public_metadata: store.get(userId) }),
    } as Response;
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, patches, store };
}

function makePool(rows: FakeUser[]): Pool {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM users')) {
        return { rows, rowCount: rows.length } as unknown as QueryResult;
      }
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    }),
  } as unknown as Pool;
}

function makeSentry() {
  return {
    captureMessage: vi.fn(() => 'event-id'),
    captureException: vi.fn(() => 'event-id'),
    setTag: vi.fn(),
    setUser: vi.fn(),
    startTransaction: vi.fn(() => ({ finish: vi.fn(), setStatus: vi.fn() })),
    withScope: vi.fn((cb) => cb({ setTag: vi.fn(), captureException: vi.fn(() => 'x') })),
  } as unknown as SentryClient;
}

function makeDeps(
  rows: FakeUser[],
  clerk: ReturnType<typeof makeClerkApi>,
  sentry = makeSentry(),
): { deps: ClerkMetadataBackfillSweepDeps; sentry: ReturnType<typeof makeSentry> } {
  return {
    sentry,
    deps: {
      pool: makePool(rows),
      secretKey: 'sk_test',
      logger,
      fetchFn: clerk.fetchFn,
      sentry,
      now: () => NOW,
    },
  };
}

const row = (overrides: Partial<FakeUser> = {}): FakeUser => ({
  clerk_user_id: 'user_1',
  tenant_id: TENANT,
  role: 'owner',
  created_at: hoursAgo(2),
  ...overrides,
});

describe('runClerkMetadataBackfillSweep', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('no-ops without a pool or secret key', async () => {
    const clerk = makeClerkApi({});
    const r1 = await runClerkMetadataBackfillSweep({
      pool: null, secretKey: 'sk', logger, fetchFn: clerk.fetchFn,
    });
    expect(r1).toEqual({ candidates: 0, inSync: 0, backfilled: 0, failed: 0 });
    const r2 = await runClerkMetadataBackfillSweep({
      pool: makePool([row()]), secretKey: '', logger, fetchFn: clerk.fetchFn,
    });
    expect(r2.candidates).toBe(0);
    expect(clerk.fetchFn).not.toHaveBeenCalled();
  });

  it('counts in-sync users without writing', async () => {
    const clerk = makeClerkApi({ user_1: { tenant_id: TENANT, role: 'owner' } });
    const { deps } = makeDeps([row()], clerk);
    const r = await runClerkMetadataBackfillSweep(deps);
    expect(r).toEqual({ candidates: 1, inSync: 1, backfilled: 0, failed: 0 });
    expect(clerk.patches).toHaveLength(0);
  });

  it('backfills a user whose metadata is missing tenant_id', async () => {
    const clerk = makeClerkApi({ user_1: {} });
    const { deps } = makeDeps([row()], clerk);
    const r = await runClerkMetadataBackfillSweep(deps);
    expect(r).toEqual({ candidates: 1, inSync: 0, backfilled: 1, failed: 0 });
    expect(clerk.patches).toHaveLength(1);
    expect(clerk.patches[0]).toEqual({
      userId: 'user_1',
      body: { public_metadata: { tenant_id: TENANT, role: 'owner' } },
    });
  });

  it('backfills a user whose metadata points at the wrong tenant', async () => {
    const clerk = makeClerkApi({ user_1: { tenant_id: 'stale-tenant' } });
    const { deps } = makeDeps([row()], clerk);
    const r = await runClerkMetadataBackfillSweep(deps);
    expect(r.backfilled).toBe(1);
    expect(clerk.store.get('user_1')).toMatchObject({ tenant_id: TENANT });
  });

  it('alerts Sentry on a persistent (old) failure, warns only on a young one', async () => {
    // Old user: PATCH 500s → persistent → Sentry alert.
    const clerkOld = makeClerkApi({ user_old: {} }, { failPatch: 500 });
    const sentryOld = makeSentry();
    const { deps: depsOld } = makeDeps(
      [row({ clerk_user_id: 'user_old', created_at: hoursAgo(48) })],
      clerkOld,
      sentryOld,
    );
    const rOld = await runClerkMetadataBackfillSweep(depsOld);
    expect(rOld.failed).toBe(1);
    expect(sentryOld.captureMessage).toHaveBeenCalledWith(
      'Clerk tenant metadata sync persistently failing',
      'error',
    );

    // Young user: same failure → warn only, no Sentry page.
    const clerkYoung = makeClerkApi({ user_young: {} }, { failPatch: 500 });
    const sentryYoung = makeSentry();
    const { deps: depsYoung } = makeDeps(
      [row({ clerk_user_id: 'user_young', created_at: hoursAgo(1) })],
      clerkYoung,
      sentryYoung,
    );
    const rYoung = await runClerkMetadataBackfillSweep(depsYoung);
    expect(rYoung.failed).toBe(1);
    expect(sentryYoung.captureMessage).not.toHaveBeenCalled();
  });

  it('treats a Clerk-side 404 (ghost user) as a failure, not a backfill', async () => {
    // User not in the fake Clerk at all → GET 404.
    const clerk = makeClerkApi({});
    const { deps } = makeDeps([row({ created_at: hoursAgo(48) })], clerk);
    const r = await runClerkMetadataBackfillSweep(deps);
    expect(r.failed).toBe(1);
    expect(r.backfilled).toBe(0);
    expect(clerk.patches).toHaveLength(0);
  });
});
