/**
 * Route manifest — introspects a booted Express app into a stable, ordered
 * description of everything it will serve.
 *
 * Why this exists: createApp() is 6,143 lines that register 120 layers (83 of
 * them mounted routers) and wire 223 repositories. Any refactor of that
 * wiring — extracting per-domain registration modules, hoisting repository
 * construction into factories — can silently drop a mount, reorder
 * middleware, or move a route from behind `requireAuth` to in front of it.
 * None of those show up in a type check, and only some show up in route tests.
 *
 * The manifest captures the two things that matter and that a diff can check:
 *   1. Every mount, in registration order.
 *   2. Where each mount sits relative to the auth/tenancy middleware chain,
 *      expressed as an exposure class.
 *
 * Express 5 exposes the root router as `app.router` (Express 4 hid it as
 * `_router`); mount paths come from the registration-time stamp (#1555).
 */

import type express from 'express';
import { MOUNT_PATH } from './bootstrap/stamp-mount-paths';

/**
 * How a mount is reached from outside. Derived from the mount path, then
 * cross-checked against the middleware actually registered before it.
 */
export type ExposureClass =
  /** Behind verifyClerkSession + requireAuth — normal tenant API. */
  | 'authenticated'
  /** Signature-verified external callers (Stripe, Twilio, Vapi, …). */
  | 'webhook'
  /** Token-in-URL customer links (estimates, invoices, feedback). */
  | 'public-token'
  /** Deliberately open (health, static, docs). */
  | 'open';

export interface ManifestEntry {
  /** Mount path as registered, e.g. `/api/jobs`. */
  path: string;
  /**
   * `use` for a middleware or mounted router; otherwise the uppercased HTTP
   * methods of a directly-registered route.
   */
  methods: string[];
  /** Express layer name — router factory, middleware function, or `anonymous`. */
  handler: string;
  kind: 'middleware' | 'router' | 'route';
  exposure: ExposureClass;
  /** Route paths declared inside a mounted router, sorted for stability. */
  children?: string[];
}

export interface RouteManifest {
  entries: ManifestEntry[];
  counts: {
    total: number;
    routers: number;
    middleware: number;
    routes: number;
    byExposure: Record<ExposureClass, number>;
  };
  /**
   * Index of each auth/tenancy middleware in `entries`. A route mounted before
   * its guard is not protected by it, so these positions are the load-bearing
   * part of the snapshot.
   */
  guardPositions: Record<string, number[]>;
}

/**
 * Guards identifiable by layer name.
 *
 * Only these two survive introspection: `requireAuth` and
 * `resolveAuthorization` are passed to `app.use` as named function
 * references, so Express records the name. The rest of the chain
 * (`verifyClerkSession(secret)`, `devAuthBypass({…})`,
 * `withTenantTransaction(pool)`) are closures returned from factories, so
 * Express records `<anonymous>` and there is nothing to match on. Their
 * positions are pinned by the snapshot instead.
 */
export const GUARD_MIDDLEWARE = ['requireAuth', 'resolveAuthorization'] as const;

/**
 * The literal path a layer was mounted at (#1555).
 *
 * Express 5 keeps no decodable regexp on a layer, so the path is read from
 * the stamp bootstrap/stamp-mount-paths.ts writes at registration. A
 * path-less `use(fn)` reads as `/`; an array mount reads as its paths joined
 * with `|`; a parameterised mount reads literally (`/api/jobs/:id`).
 */
export function layerMountPath(layer: object): string {
  const path = (layer as Record<PropertyKey, unknown>)[MOUNT_PATH];
  if (Array.isArray(path)) return path.join('|');
  if (typeof path === 'string') return path;
  throw new Error(
    'Router layer has no stamped mount path — was bootstrap/stamp-mount-paths imported ' +
      'before the router was built?',
  );
}

/**
 * Whether `path` is covered by an `app.use(prefix, …)` mount.
 *
 * Mirrors Express's semantics exactly: a prefix matches itself and anything
 * below it, but NOT a sibling that merely shares a string prefix.
 * `app.use('/api', …)` runs for `/api` and `/api/jobs` but not for
 * `/api-docs` — verified against Express 4 rather than assumed.
 *
 * A naive `startsWith('/api')` labelled the Swagger UI at `/api-docs` as
 * `authenticated` even though it is mounted ahead of the auth chain and is
 * reachable without a session. Hiding an open surface behind an
 * authenticated label is the exact failure this manifest exists to prevent,
 * so the comparison has to be segment-aware.
 */
export function mountCovers(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Classifies a mount by which guard chain actually covers it.
 *
 * `/api/public/…` and `/api/public-payments` are checked before the plain
 * `/api` prefix on purpose: they are customer-facing, token-authenticated
 * surfaces that happen to live under the `/api` prefix, and they are mounted
 * ahead of the Clerk chain. Classifying them as `authenticated` would
 * misreport the app's real exposure.
 */
export function classifyExposure(path: string): ExposureClass {
  if (mountCovers('/public', path)) return 'public-token';
  if (mountCovers('/api/public', path)) return 'public-token';
  // A distinct sibling mount, not a child of /api/public.
  if (mountCovers('/api/public-payments', path)) return 'public-token';
  if (mountCovers('/webhooks', path)) return 'webhook';
  if (mountCovers('/api', path)) return 'authenticated';
  return 'open';
}

interface ExpressLayer {
  name?: string;
  route?: { path: string | string[]; methods: Record<string, boolean> };
  handle?: { stack?: ExpressLayer[] };
}

function layerChildren(layer: ExpressLayer): string[] | undefined {
  const stack = layer.handle?.stack;
  if (!stack) return undefined;
  const paths = new Set<string>();
  for (const sub of stack) {
    if (!sub.route) continue;
    const routePaths = Array.isArray(sub.route.path) ? sub.route.path : [sub.route.path];
    for (const p of routePaths) {
      const methods = Object.keys(sub.route.methods)
        .map((m) => m.toUpperCase())
        .sort()
        .join('|');
      paths.add(`${methods} ${p}`);
    }
  }
  return paths.size > 0 ? [...paths].sort() : undefined;
}

/**
 * Walks a booted app's router stack. Express's own `query` and `expressInit`
 * layers are skipped — they are framework internals, not application wiring.
 */
export function buildRouteManifest(app: express.Express): RouteManifest {
  const router = (app as unknown as { router?: { stack?: ExpressLayer[] } }).router;
  if (!router?.stack) {
    throw new Error(
      'Could not read the Express router stack (`app.router`). If Express was upgraded ' +
        'past 5.x, this walker needs updating.',
    );
  }

  const entries: ManifestEntry[] = [];
  for (const layer of router.stack) {
    const name = layer.name ?? 'anonymous';
    if (name === 'query' || name === 'expressInit') continue;

    if (layer.route) {
      const routePaths = Array.isArray(layer.route.path)
        ? layer.route.path
        : [layer.route.path];
      for (const p of routePaths) {
        entries.push({
          path: p,
          methods: Object.keys(layer.route.methods)
            .map((m) => m.toUpperCase())
            .sort(),
          handler: name,
          kind: 'route',
          exposure: classifyExposure(p),
        });
      }
      continue;
    }

    const path = layerMountPath(layer);
    const children = layerChildren(layer);
    entries.push({
      path,
      methods: ['use'],
      handler: name,
      kind: children ? 'router' : 'middleware',
      exposure: classifyExposure(path),
      ...(children ? { children } : {}),
    });
  }

  const byExposure: Record<ExposureClass, number> = {
    authenticated: 0,
    webhook: 0,
    'public-token': 0,
    open: 0,
  };
  for (const e of entries) byExposure[e.exposure] += 1;

  const guardPositions: Record<string, number[]> = {};
  for (const guard of GUARD_MIDDLEWARE) {
    const positions = entries
      .map((e, i) => (e.handler === guard ? i : -1))
      .filter((i) => i !== -1);
    if (positions.length > 0) guardPositions[guard] = positions;
  }

  return {
    entries,
    counts: {
      total: entries.length,
      routers: entries.filter((e) => e.kind === 'router').length,
      middleware: entries.filter((e) => e.kind === 'middleware').length,
      routes: entries.filter((e) => e.kind === 'route').length,
      byExposure,
    },
    guardPositions,
  };
}

/**
 * Renders the manifest as stable text for snapshotting. Deliberately not JSON:
 * a reviewer reading the diff should be able to see "this route moved above
 * requireAuth" without decoding brackets.
 */
export function formatManifest(manifest: RouteManifest): string {
  const lines: string[] = [];
  for (const [i, e] of manifest.entries.entries()) {
    const methods = e.methods.join(',');
    lines.push(
      `${String(i).padStart(3, '0')}  ${e.exposure.padEnd(13)} ${methods.padEnd(6)} ${e.path}    [${e.kind}: ${e.handler}]`,
    );
    for (const child of e.children ?? []) lines.push(`         └─ ${child}`);
  }
  return lines.join('\n');
}
