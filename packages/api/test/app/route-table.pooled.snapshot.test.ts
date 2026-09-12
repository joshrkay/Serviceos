/**
 * Route-table snapshot for the POOLED mount graph.
 *
 * The sibling route-table.snapshot.test.ts boots without DATABASE_URL, which
 * is hermetic but not the widest graph: app.ts guards several mounts behind
 * `if (pool)`, so those routes — and `withTenantTransaction`, one of the
 * ordering-critical middlewares this refactor must not disturb — are absent
 * from that snapshot entirely. A decomposition could drop or reorder them
 * without the unpooled gate noticing.
 *
 * This file closes that gap. `src/db/pool` is mocked so `createPool()` returns
 * a stub that satisfies the Pool surface app.ts and the repositories use
 * (query/connect/end/on) without opening a socket. A real dummy DATABASE_URL
 * was rejected as an alternative: pg genuinely dials it, and the resulting
 * ECONNREFUSED surfaces as an unhandled rejection that would make this test
 * flaky in CI.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { collectRouteLayers, renderRouteTable, type RouteLayer } from './helpers/route-table';

/** Minimal stand-in for a pg Pool: resolves everything, connects to nothing. */
function makeStubPool(): unknown {
  const result = { rows: [], rowCount: 0, command: '', fields: [], oid: 0 };
  const client = {
    query: async () => result,
    release: () => undefined,
    on: () => client,
  };
  const pool = {
    query: async () => result,
    connect: async () => client,
    end: async () => undefined,
    on: () => pool,
    removeListener: () => pool,
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    // createCredentialResolver reads pool.options to build its LISTEN config.
    options: {
      connectionString: 'postgres://stub/stub',
      host: 'stub',
      port: 5432,
      database: 'stub',
      user: 'stub',
    },
  };
  return pool;
}

vi.mock('../../src/db/pool', () => ({
  createPool: () => makeStubPool(),
  createDirectPool: () => makeStubPool(),
}));

describe('app.ts route table — pooled mount graph', () => {
  let app: { gracefulDrain: (r: string) => Promise<void> };
  let layers: RouteLayer[];
  let prev: Record<string, string | undefined>;

  beforeAll(async () => {
    prev = {
      NODE_ENV: process.env.NODE_ENV,
      DATABASE_URL: process.env.DATABASE_URL,
      PROCESS_ROLE: process.env.PROCESS_ROLE,
      TWILIO_MEDIA_STREAMS_ENABLED: process.env.TWILIO_MEDIA_STREAMS_ENABLED,
      DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
    };
    process.env.NODE_ENV = 'test';
    // Any non-empty value: createPool is mocked, so this only flips the
    // `pool ? … : …` branches in app.ts.
    process.env.DATABASE_URL = 'postgres://stub/stub';
    delete process.env.PROCESS_ROLE;
    delete process.env.TWILIO_MEDIA_STREAMS_ENABLED;
    delete process.env.DEV_AUTH_BYPASS;

    const { createApp } = await import('../../src/app');
    const { resetConfig } = await import('../../src/shared/config');
    resetConfig();
    app = createApp() as never;
    layers = collectRouteLayers(app);
  });

  afterAll(async () => {
    // Guard: if boot threw, `app` is undefined and the real failure is in
    // beforeAll — don't mask it with a teardown TypeError.
    if (app) await app.gracefulDrain('test-cleanup');
    const { resetConfig } = await import('../../src/shared/config');
    resetConfig();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('matches the committed pooled route table', async () => {
    await expect(renderRouteTable(layers)).toMatchFileSnapshot(
      './__snapshots__/route-table-pooled.txt',
    );
  });

  it('mounts the routers that only exist when a pool is wired', () => {
    // These three are behind `if (pool)` in app.ts and are invisible to the
    // unpooled snapshot.
    const text = renderRouteTable(layers);
    for (const path of ['/api/interactions', '/api/admin/tenants', '/api/entity-aliases']) {
      expect(text, `${path} should mount when a pool is present`).toContain(path);
    }
  });

  it('keeps withTenantTransaction between the auth chain and the first /api route', () => {
    // withTenantTransaction(pool) is an anonymous closure, so it cannot be
    // found by name — but its POSITION is the contract: after
    // resolveAuthorization, before any /api route mount. Pinning the slot
    // catches a move even though the layer is unnamed.
    // Routers are recursed into rather than emitted, so /api/* mounts are not
    // depth-0 entries — compare on topLevelIndex, which every nested layer
    // inherits from its top-level ancestor.
    const auth = layers.find((l) => l.depth === 0 && l.name === 'resolveAuthorization');
    expect(auth, 'resolveAuthorization must stay mounted').toBeTruthy();
    const authIdx = auth!.topLevelIndex;

    const firstApiRouteIdx = Math.min(
      ...layers
        .filter(
          (l) =>
            l.kind === 'route' &&
            l.topLevelIndex > authIdx &&
            l.paths.some((p) => p.startsWith('/api/')),
        )
        .map((l) => l.topLevelIndex),
    );
    expect(Number.isFinite(firstApiRouteIdx)).toBe(true);
    expect(firstApiRouteIdx).toBeGreaterThan(authIdx);

    const between = layers.filter(
      (l) =>
        l.depth === 0 &&
        l.topLevelIndex > authIdx &&
        l.topLevelIndex < firstApiRouteIdx &&
        l.paths.includes('/api') &&
        l.name === '<anonymous>',
    );
    expect(
      between.length,
      'no anonymous /api middleware between resolveAuthorization and the first /api route — withTenantTransaction may have moved',
    ).toBeGreaterThan(0);
  });

  it('the unauthenticated /api surface does not widen when a pool is present', () => {
    // Every pool-gated mount sits BELOW requireAuth. If one ever lands above
    // it, this fails — the pooled graph must not expose more than the
    // unpooled allowlist already pins.
    const authIdx = layers.find(
      (l) => l.depth === 0 && l.name === 'requireAuth' && l.paths.includes('/api'),
    )!.topLevelIndex;
    const preAuthApi = [
      ...new Set(
        layers
          .filter(
            (l) =>
              l.topLevelIndex < authIdx &&
              l.paths.some((p) => p === '/api' || p.startsWith('/api/')),
          )
          .map((l) => `${l.kind === 'route' ? l.methods.join(',') : 'USE'} ${l.paths.join('|')}`),
      ),
    ];
    for (const path of ['/api/interactions', '/api/admin/tenants', '/api/entity-aliases']) {
      expect(preAuthApi.some((k) => k.includes(path))).toBe(false);
    }
  });
});
