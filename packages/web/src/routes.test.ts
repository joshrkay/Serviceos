import { describe, it, expect } from 'vitest';
import type { RouteObject } from 'react-router';
import { router } from './routes';

function flattenRoutes(routes: RouteObject[]): RouteObject[] {
  return routes.flatMap(route => [route, ...(route.children ? flattenRoutes(route.children) : [])]);
}

describe('router', () => {
  it('includes settings/price-book route', () => {
    const allRoutes = flattenRoutes(router.routes as RouteObject[]);

    expect(allRoutes.some(route => route.path === 'settings/price-book')).toBe(true);
  });
});
