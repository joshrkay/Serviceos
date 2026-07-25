/**
 * Route-manifest characterization test.
 *
 * createApp() is ~6,100 lines that mount 111 routers and construct 164
 * repositories. The planned decomposition of that wiring into per-domain
 * registration modules can silently drop a mount, reorder middleware, or move
 * a route from behind `requireAuth` to in front of it — none of which a type
 * check catches.
 *
 * This test pins the shape so those changes show up as a reviewable diff.
 * The committed snapshot is NOT an assertion that the current layout is
 * correct; it records what it is today so that a change to it has to be
 * deliberate.
 *
 * The snapshot is written under test/app/__snapshots__/ by Vitest. To accept
 * an intentional change: `npx vitest run test/app/route-manifest.test.ts -u`
 * and review the diff carefully — especially any line whose exposure class
 * changed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  GUARD_MIDDLEWARE,
  buildRouteManifest,
  classifyExposure,
  decodeLayerPath,
  formatManifest,
  type RouteManifest,
} from '../../src/app-route-manifest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';

describe('decodeLayerPath', () => {
  it('decodes a path-less app.use as /', () => {
    const re = Object.assign(/^\/?(?=\/|$)/i, { fast_slash: true });
    expect(decodeLayerPath(re)).toBe('/');
  });

  it('decodes a single-segment mount', () => {
    expect(decodeLayerPath(/^\/api\/?(?=\/|$)/i)).toBe('/api');
  });

  it('decodes a multi-segment mount', () => {
    expect(decodeLayerPath(/^\/webhooks\/stripe\/?(?=\/|$)/i)).toBe(
      '/webhooks/stripe',
    );
  });

  it('decodes an exact-match route regexp', () => {
    expect(decodeLayerPath(/^\/health\/?$/i)).toBe('/health');
  });

  // Better to report a regexp than to guess a path that is not really there.
  it('reports a parameterised mount as dynamic rather than guessing', () => {
    const decoded = decodeLayerPath(/^\/api\/jobs\/(?:([^\/]+?))\/?(?=\/|$)/i);
    expect(decoded).toContain('dynamic');
  });
});

describe('classifyExposure', () => {
  it.each([
    ['/api/jobs', 'authenticated'],
    ['/api', 'authenticated'],
    ['/webhooks/stripe', 'webhook'],
    ['/public/estimates', 'public-token'],
    ['/', 'open'],
    ['/api-docs', 'authenticated'],
  ] as const)('classifies %s as %s', (path, expected) => {
    expect(classifyExposure(path)).toBe(expected);
  });
});

describe('createApp route manifest', () => {
  let app: AppWithLifecycle;
  let manifest: RouteManifest;
  let prev: Record<string, string | undefined>;

  beforeAll(() => {
    // Same hermetic boot as test/app/hermetic-dev-bypass.route.test.ts: no
    // Postgres, no Clerk instance, no AI key.
    prev = {
      NODE_ENV: process.env.NODE_ENV,
      DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
      DATABASE_URL: process.env.DATABASE_URL,
      AI_PROVIDER_API_KEY: process.env.AI_PROVIDER_API_KEY,
      CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY,
      PROCESS_ROLE: process.env.PROCESS_ROLE,
    };
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
    process.env.PROCESS_ROLE = 'web';
    delete process.env.DATABASE_URL;
    delete process.env.AI_PROVIDER_API_KEY;
    delete process.env.CLERK_PUBLISHABLE_KEY;
    resetConfig();
    app = createApp();
    manifest = buildRouteManifest(app);
  });

  afterAll(async () => {
    await app.gracefulDrain('test-cleanup');
    resetConfig();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('mounts a substantial number of layers', () => {
    // A floor, not an equality: this catches "the extraction dropped half the
    // app" without failing on every intentional single-route addition. The
    // exact layout is pinned by the snapshot below.
    expect(manifest.counts.total).toBeGreaterThan(90);
    expect(manifest.counts.routers).toBeGreaterThan(50);
  });

  it('registers every auth and tenancy guard', () => {
    // If a guard disappears from the chain entirely, everything downstream is
    // unprotected — and a route test for one endpoint would not notice.
    for (const guard of GUARD_MIDDLEWARE) {
      expect(
        Object.keys(manifest.guardPositions),
        `${guard} is not registered in the middleware chain`,
      ).toContain(guard);
    }
  });

  it('runs requireAuth before resolveAuthorization', () => {
    // resolveAuthorization loads the caller's role/permissions, so it is
    // meaningless before requireAuth has established who the caller is.
    // The rest of the chain (verifyClerkSession, devAuthBypass,
    // withTenantTransaction) is anonymous closures returned from factories, so
    // its ordering is pinned by the snapshot rather than asserted by name.
    expect(manifest.guardPositions.requireAuth[0]).toBeLessThan(
      manifest.guardPositions.resolveAuthorization[0],
    );
  });

  /**
   * The security-critical assertion.
   *
   * `requireAuth` is mounted at `/api`, so it runs for every `/api/*` request
   * registered AFTER it — and not at all for one registered before. Ten
   * `/api/*` routers are deliberately mounted ahead of it: OAuth callbacks,
   * telephony provider callbacks, and the customer-facing portal/booking/
   * payment surfaces, all of which authenticate by their own token or provider
   * signature rather than a Clerk session.
   *
   * That allowlist is pinned exactly. Adding an `/api` router above
   * `requireAuth` makes it reachable without a Clerk session, which is
   * occasionally correct and always worth a human decision — so it must fail
   * this test rather than merely change a snapshot line.
   */
  const EXPECTED_PRE_AUTH_API_ROUTERS = [
    '/api/public/portal',
    '/api/public/booking',
    '/api/public-payments',
    '/api/calendar-integrations',
    '/api/integrations',
    '/api/telephony',
    '/api/telephony',
    '/api/calls',
  ];

  it('mounts only the known allowlist of /api routers ahead of requireAuth', () => {
    const authAt = manifest.guardPositions.requireAuth[0];
    const preAuth = manifest.entries
      .filter(
        (e, i) => e.kind === 'router' && e.path.startsWith('/api') && i < authAt,
      )
      .map((e) => e.path);
    expect(preAuth).toEqual(EXPECTED_PRE_AUTH_API_ROUTERS);
  });

  it('mounts every other /api router behind requireAuth', () => {
    const authAt = manifest.guardPositions.requireAuth[0];
    const behind = manifest.entries.filter(
      (e, i) => e.kind === 'router' && e.path.startsWith('/api') && i > authAt,
    );
    // The bulk of the API — if this collapses, the extraction dropped mounts.
    expect(behind.length).toBeGreaterThan(60);
  });

  it('keeps webhook and public surfaces outside the /api guard chain', () => {
    // Express scopes middleware by mount path, so the /api chain never runs
    // for /webhooks/* or /public/*. Registration order relative to the guards
    // is therefore irrelevant for them — what matters is that they are not
    // under /api at all, which is what keeps provider callbacks and customer
    // links working without a Clerk session.
    const leaked = manifest.entries
      .filter((e) => e.exposure === 'webhook' && e.kind === 'router')
      .filter((e) => e.path.startsWith('/api'))
      .map((e) => e.path);
    expect(leaked).toEqual([]);
  });

  it('exposes no unexpected top-level exposure classes', () => {
    const classes = new Set(manifest.entries.map((e) => e.exposure));
    for (const c of classes) {
      expect(['authenticated', 'webhook', 'public-token', 'open']).toContain(c);
    }
  });

  // The characterization snapshot. Every mount, in order, with its exposure
  // class and the child routes of each mounted router.
  it('matches the committed route manifest', () => {
    expect(formatManifest(manifest)).toMatchSnapshot();
  });

  it('matches the committed layer counts', () => {
    expect(manifest.counts).toMatchSnapshot();
  });
});
