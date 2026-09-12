/**
 * Route-table + middleware-order snapshot — the behavioural gate for the
 * app.ts decomposition.
 *
 * createApp() is ~6.1k lines in which construction and mounting are
 * interleaved, so any extraction risks silently reordering initialisation.
 * The three failure modes that would turn that into an outage are: a dropped
 * mount, a reordered middleware chain, and a route crossing the auth boundary.
 * Nothing in the suite caught any of them before this file.
 *
 * Two layers of protection here:
 *
 *  1. A full snapshot of every route and middleware layer, in registration
 *     order (`__snapshots__/route-table.txt`). A pure code MOVE cannot change
 *     it. Legitimate route additions will — review the diff, then update with
 *     `npx vitest run route-table -u`.
 *
 *  2. Explicit invariants that do not depend on reading the snapshot: the
 *     unauthenticated /api surface is pinned to an allowlist, and the body
 *     parsers / helmet ordering is asserted directly. These fail with a
 *     specific message rather than a wall of diff.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';
import { collectRouteLayers, renderRouteTable, type RouteLayer } from './helpers/route-table';

/**
 * The complete set of /api paths reachable WITHOUT authentication, because
 * they mount above the `requireAuth` line. Every entry is deliberate:
 * public-portal + booking links (token-scoped), Stripe-facing payment intents,
 * OAuth callbacks (state-verified), and Twilio webhooks (signature-verified).
 *
 * If a refactor moves an authenticated route above the auth line, it lands
 * here and this test fails by name. Adding an entry is a security decision.
 */
const UNAUTHENTICATED_API_SURFACE: readonly string[] = [
  'USE /api',
  'USE /api/health',
  'USE /api/public/portal/:token',
  'GET /api/public/portal/:token/customer',
  'GET /api/public/portal/:token/estimates',
  'GET /api/public/portal/:token/invoices',
  'GET /api/public/portal/:token/jobs',
  'GET /api/public/portal/:token/agreements',
  'GET /api/public/portal/:token/appointments',
  'POST /api/public/portal/:token/request-service',
  'GET /api/public/portal/:token/availability',
  'POST /api/public/portal/:token/book',
  'POST /api/public/portal/:token/appointments/:id/cancel',
  'POST /api/public/portal/:token/appointments/:id/reschedule',
  'POST /api/public/portal/:token/payment-methods/setup',
  'GET /api/public/portal/:token/payment-methods',
  'USE /api/public/booking',
  'GET /api/public/booking/:tenantId/availability',
  'POST /api/public/booking/:tenantId',
  'POST /api/public-payments/create-payment-intent',
  'GET /api/public-payments/status/:invoiceId',
  'GET /api/calendar-integrations/google/callback',
  'GET /api/integrations/quickbooks/callback',
  'GET /api/telephony/health',
  'USE /api/telephony',
  'POST /api/telephony/voicemail-status',
  'POST /api/telephony/recording',
  'POST /api/telephony/voice',
  'POST /api/telephony/voice/gather-fallback',
  'POST /api/telephony/gather',
  'POST /api/telephony/dial-result',
  'POST /api/telephony/callback-message',
  'GET /api/telephony/whisper/:escalationId',
  'POST /api/calls/bridge',
];

/** Stable key for a layer, used by the auth-surface assertion. */
function layerKey(l: RouteLayer): string {
  return `${l.kind === 'route' ? l.methods.join(',') : 'USE'} ${l.paths.join('|')}`;
}

/** True for /api and /api/... but not /api-docs. */
function isApiPath(p: string): boolean {
  return p === '/api' || p.startsWith('/api/');
}

describe('app.ts route table + middleware order', () => {
  let app: AppWithLifecycle;
  let layers: RouteLayer[];
  let prev: Record<string, string | undefined>;

  beforeAll(() => {
    // Pin every input the mount graph branches on, so the snapshot is a
    // function of the source alone and not of ambient env.
    prev = {
      NODE_ENV: process.env.NODE_ENV,
      DATABASE_URL: process.env.DATABASE_URL,
      PROCESS_ROLE: process.env.PROCESS_ROLE,
      TWILIO_MEDIA_STREAMS_ENABLED: process.env.TWILIO_MEDIA_STREAMS_ENABLED,
      DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
    };
    process.env.NODE_ENV = 'test';
    // Unset PROCESS_ROLE => role 'all' => the widest mount graph.
    delete process.env.PROCESS_ROLE;
    delete process.env.DATABASE_URL;
    delete process.env.TWILIO_MEDIA_STREAMS_ENABLED;
    delete process.env.DEV_AUTH_BYPASS;
    resetConfig();
    app = createApp();
    layers = collectRouteLayers(app);
  });

  afterAll(async () => {
    await app.gracefulDrain('test-cleanup');
    resetConfig();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('matches the committed route table', async () => {
    // A refactor that only moves code cannot change this file.
    await expect(renderRouteTable(layers)).toMatchFileSnapshot(
      './__snapshots__/route-table.txt',
    );
  });

  it('mounts a non-trivial number of routes (guards against a silent empty walk)', () => {
    const routes = layers.filter((l) => l.kind === 'route');
    expect(routes.length).toBeGreaterThan(300);
  });

  describe('auth boundary', () => {
    const authIndex = (ls: RouteLayer[]): number => {
      const l = ls.find(
        (x) => x.depth === 0 && x.name === 'requireAuth' && x.paths.includes('/api'),
      );
      if (!l) throw new Error('requireAuth is no longer mounted at /api on the root app');
      return l.topLevelIndex;
    };

    it('requireAuth is followed by resolveAuthorization on /api', () => {
      const idx = authIndex(layers);
      const next = layers.find(
        (l) => l.depth === 0 && l.name === 'resolveAuthorization' && l.paths.includes('/api'),
      );
      expect(next, 'resolveAuthorization must stay mounted at /api').toBeTruthy();
      expect(next!.topLevelIndex).toBeGreaterThan(idx);
    });

    it('the unauthenticated /api surface matches the allowlist exactly', () => {
      const idx = authIndex(layers);
      const actual = [
        ...new Set(
          layers
            .filter((l) => l.topLevelIndex < idx && l.paths.some(isApiPath))
            .map(layerKey),
        ),
      ];
      // Sorted compare: order within the pre-auth block is not the contract,
      // membership is. Ordering is covered by the snapshot.
      expect([...actual].sort()).toEqual([...UNAUTHENTICATED_API_SURFACE].sort());
    });

    it('representative authenticated routes mount below the auth line', () => {
      const idx = authIndex(layers);
      for (const path of ['/api/customers', '/api/jobs', '/api/invoices', '/api/estimates']) {
        const found = layers.filter((l) => l.paths.some((p) => p.startsWith(path)));
        expect(found.length, `${path} should be mounted`).toBeGreaterThan(0);
        for (const l of found) {
          expect(l.topLevelIndex, `${path} must stay behind requireAuth`).toBeGreaterThan(idx);
        }
      }
    });
  });

  describe('body-parser and security-header ordering', () => {
    // Subsumes the string-index assertions in
    // test/webhooks/webhook-raw-body-order.route.test.ts, but against the real
    // mount graph rather than the source text.
    const topLevel = (): RouteLayer[] => layers.filter((l) => l.depth === 0);
    const indexOfName = (name: string): number =>
      topLevel().findIndex((l) => l.name === name);

    it('every webhook raw/urlencoded parser is registered before the global JSON parser', () => {
      const json = indexOfName('jsonParser');
      expect(json).toBeGreaterThan(-1);
      const rawLayers = topLevel().filter(
        (l, i) => i < json && /^(rawParser|urlencodedParser)$/.test(l.name),
      );
      // Signature verification needs the unparsed body; express.json() would
      // consume it first if it were mounted above these.
      expect(rawLayers.length).toBe(6);
      for (const l of rawLayers) {
        expect(l.paths.every((p) => p.startsWith('/webhooks/'))).toBe(true);
      }
      const anyRawAfterJson = topLevel().some(
        (l, i) => i > json && /^(rawParser|urlencodedParser)$/.test(l.name),
      );
      expect(anyRawAfterJson, 'a raw parser moved below express.json()').toBe(false);
    });

    it('helmet is mounted, and swagger stays above it (pre-existing, deliberate)', () => {
      const helmet = indexOfName('helmetMiddleware');
      const swagger = indexOfName('swaggerInitFn');
      expect(helmet).toBeGreaterThan(-1);
      expect(swagger).toBeGreaterThan(-1);
      // Documented quirk: /api-docs (and the SPA static mount) ship without
      // helmet headers. Pinned so the decomposition cannot change it silently
      // in either direction.
      expect(swagger).toBeLessThan(helmet);
    });

    it('cors is mounted directly after helmet', () => {
      expect(indexOfName('corsMiddleware')).toBe(indexOfName('helmetMiddleware') + 1);
    });
  });
});
