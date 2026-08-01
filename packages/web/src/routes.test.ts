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

  it('the authenticated root route wires ErrorBoundary on the outer (ProtectedRoute) layer', () => {
    const topLevel = router.routes as RouteObject[];
    const rootRoute = topLevel.find((r) => r.path === '/');
    expect(rootRoute, 'expected a `/` top-level route').toBeDefined();
    expect(routeUsesErrorElement(rootRoute!)).toBe(true);
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
