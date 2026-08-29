import { describe, it, expect } from 'vitest';
import type { RouteObject } from 'react-router';
import { router } from './routes';
import { RouteErrorElement } from './components/layout/RouteErrorElement';

function flattenRoutes(routes: RouteObject[]): RouteObject[] {
  return routes.flatMap(route => [route, ...(route.children ? flattenRoutes(route.children) : [])]);
}

/** True when the route renders eagerly (a statically-imported component). */
function isEager(route: RouteObject): boolean {
  return (
    (route as { Component?: unknown }).Component !== undefined ||
    (route as { element?: unknown }).element !== undefined
  );
}

describe('router', () => {
  it('includes settings/price-book route', () => {
    const allRoutes = flattenRoutes(router.routes as RouteObject[]);

    expect(allRoutes.some(route => route.path === 'settings/price-book')).toBe(true);
  });

  // Code-splitting contract: non-critical pages must load via `lazy` (their own
  // chunk), while the hottest entry paths (`/` home index, `/login`) stay eager
  // so first paint doesn't pay an extra round-trip. A regression that re-adds an
  // eager `Component:` import for a heavy page would silently re-bloat the entry
  // bundle — this guards against that.
  it('non-critical pages are code-split via lazy()', () => {
    const allRoutes = flattenRoutes(router.routes as RouteObject[]);
    // A representative spread: list page, detail wrapper, settings, reports.
    for (const path of ['estimates', 'invoices', 'estimates/:id', 'settings', 'reports/money']) {
      const route = allRoutes.find(r => r.path === path);
      expect(route, `expected a route for ${path}`).toBeDefined();
      expect(typeof (route as { lazy?: unknown }).lazy, `${path} should be lazy`).toBe('function');
      expect(isEager(route!), `${path} should not be eagerly imported`).toBe(false);
    }
  });

  it('keeps the hottest entry paths eager (home index + /login)', () => {
    const allRoutes = flattenRoutes(router.routes as RouteObject[]);
    const indexHome = allRoutes.find(r => (r as { index?: boolean }).index === true);
    expect(indexHome, 'expected an index (home) route').toBeDefined();
    expect(isEager(indexHome!), 'home index should be eager').toBe(true);
    expect((indexHome as { lazy?: unknown }).lazy).toBeUndefined();

    const login = (router.routes as RouteObject[]).find(r => r.path === '/login');
    expect(login, 'expected /login top-level route').toBeDefined();
    expect(isEager(login!), '/login should be eager').toBe(true);
    expect((login as { lazy?: unknown }).lazy).toBeUndefined();
  });

  // Every top-level route needs an ErrorBoundary so an uncaught loader/render
  // throw doesn't degrade to a blank white page. Descendant errors bubble up
  // to the nearest ancestor with an ErrorBoundary, so attaching it once at
  // each top-level entry — including the `/` ProtectedRoute that wraps every
  // authenticated page — covers the full route tree.
  it('every top-level route has an ErrorBoundary wired', () => {
    const topLevel = router.routes as RouteObject[];
    const missing: string[] = [];
    for (const route of topLevel) {
      const hasErrorElement =
        (route as { ErrorBoundary?: unknown }).ErrorBoundary !== undefined ||
        (route as { errorElement?: unknown }).errorElement !== undefined;
      if (!hasErrorElement) missing.push(route.path ?? '<unknown>');
    }
    expect(missing, `top-level routes missing ErrorBoundary: ${missing.join(', ')}`).toEqual([]);
  });

  it('public customer-facing routes use RouteErrorElement specifically', () => {
    const topLevel = router.routes as RouteObject[];
    const publicPaths = ['/e/:id', '/pay/:id', '/intake', '/book', '/feedback/:token', '/portal/:token'];
    for (const path of publicPaths) {
      const route = topLevel.find((r) => r.path === path);
      expect(route, `expected top-level route ${path}`).toBeDefined();
      // createBrowserRouter normalizes the declared `ErrorBoundary`
      // (component) into an `errorElement` (React element). Either
      // shape implies the boundary is wired — we accept both and only
      // fail if the route has neither.
      expect(routeUsesErrorElement(route!), `${path} missing RouteErrorElement`).toBe(true);
    }
  });

  // The supervisor wall's CompressedSessionStrip NavLinks each live-session
  // mini-card to /sessions/:id — without this route those links dead-end on
  // a blank page. It must resolve INSIDE the auth-wrapped Shell tree (the
  // page reads the wall's ActiveSessionsProvider mounted by Shell).
  it('registers the focused live-session route (sessions/:id) inside the authed Shell', () => {
    const rootRoute = (router.routes as RouteObject[]).find(r => r.path === '/');
    expect(rootRoute, 'expected the `/` ProtectedRoute').toBeDefined();
    const shellRoute = rootRoute!.children?.find(r => r.path === '/');
    expect(shellRoute, 'expected the Shell child route').toBeDefined();
    const sessionRoute = shellRoute!.children?.find(r => r.path === 'sessions/:id');
    expect(sessionRoute, 'sessions/:id must be a Shell child (auth-wrapped)').toBeDefined();
    expect(typeof (sessionRoute as { lazy?: unknown }).lazy, 'sessions/:id should be lazy').toBe('function');
    expect(isEager(sessionRoute!), 'sessions/:id should not be eagerly imported').toBe(false);
  });

  it('the authenticated root route wires ErrorBoundary on the outer (ProtectedRoute) layer', () => {
    const topLevel = router.routes as RouteObject[];
    const rootRoute = topLevel.find((r) => r.path === '/');
    expect(rootRoute, 'expected a `/` top-level route').toBeDefined();
    expect(routeUsesErrorElement(rootRoute!)).toBe(true);
  });

  // The production bug this guards against: `/customers/new` had no route
  // of its own, so the literal "new" segment fell through to `customers/:id`
  // (CustomerDetail), which called GET /api/customers/new and got a 500
  // (the id isn't a UUID). A real, lazy-loaded customers/new route — declared
  // before customers/:id — fixes both the missing page and the false match.
  it('registers customers/new as its own lazy route, before customers/:id', () => {
    const allRoutes = flattenRoutes(router.routes as RouteObject[]);
    const createRoute = allRoutes.find((r) => r.path === 'customers/new');
    expect(createRoute, 'expected a customers/new route').toBeDefined();
    expect(typeof (createRoute as { lazy?: unknown }).lazy, 'customers/new should be lazy').toBe('function');
    expect(isEager(createRoute!), 'customers/new should not be eagerly imported').toBe(false);

    const rootRoute = (router.routes as RouteObject[]).find((r) => r.path === '/');
    const shellRoute = rootRoute!.children?.find((r) => r.path === '/');
    const siblings = shellRoute!.children ?? [];
    const newIdx = siblings.findIndex((r) => r.path === 'customers/new');
    const detailIdx = siblings.findIndex((r) => r.path === 'customers/:id');
    expect(newIdx, 'customers/new must be registered').toBeGreaterThanOrEqual(0);
    expect(detailIdx, 'customers/:id must be registered').toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeLessThan(detailIdx);
  });

  // #881 routes "Create a new invoice" voice/quick-action phrases to
  // /invoices/new — pin that the standalone create route exists and is
  // declared before invoices/:id so the literal "new" segment can't fall
  // through to the detail page (same class of bug as customers/new above).
  it('registers invoices/new as its own route, before invoices/:id', () => {
    const rootRoute = (router.routes as RouteObject[]).find((r) => r.path === '/');
    const shellRoute = rootRoute!.children?.find((r) => r.path === '/');
    const siblings = shellRoute!.children ?? [];
    const newIdx = siblings.findIndex((r) => r.path === 'invoices/new');
    const detailIdx = siblings.findIndex((r) => r.path === 'invoices/:id');
    expect(newIdx, 'invoices/new must be registered').toBeGreaterThanOrEqual(0);
    expect(detailIdx, 'invoices/:id must be registered').toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeLessThan(detailIdx);
  });
});

/**
 * True when `route` has either `ErrorBoundary` or `errorElement` configured
 * to render via `RouteErrorElement`. `createBrowserRouter` may normalize
 * the declared `ErrorBoundary: RouteErrorElement` (component) into an
 * `errorElement: <RouteErrorElement />` (React element), so both shapes
 * count.
 */
function routeUsesErrorElement(route: RouteObject): boolean {
  const eb = (route as { ErrorBoundary?: unknown }).ErrorBoundary;
  if (eb === RouteErrorElement) return true;
  const el = (route as { errorElement?: unknown }).errorElement;
  if (
    el !== undefined &&
    el !== null &&
    typeof el === 'object' &&
    'type' in (el as object) &&
    (el as { type: unknown }).type === RouteErrorElement
  ) {
    return true;
  }
  return false;
}
