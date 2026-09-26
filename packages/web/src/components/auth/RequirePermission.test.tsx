/**
 * #1280 — client route guards for money and settings routes.
 *
 * A technician (no invoices:view / estimates:view / settings:view) could open
 * /invoices, /invoices/new, /estimates/new, /settings, /settings/price-book by
 * URL and see the New Invoice / New Estimate job picker (every tenant job with
 * customer names + service addresses). The API refuses the writes (403); the
 * guard keeps the page from rendering at all, keyed on the same permission
 * strings Shell.tsx's nav filter uses.
 */
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const meState: { me: { permissions: string[] } | null; isLoading: boolean; error: Error | null } = {
  me: null,
  isLoading: false,
  error: null,
};

vi.mock('../../hooks/useMe', () => ({
  useMe: () => ({ me: meState.me, isLoading: meState.isLoading, error: meState.error }),
}));

import { RequirePermission } from './RequirePermission';
import { router } from '../../routes';

function renderGuarded(permission: string) {
  const memoryRouter = createMemoryRouter(
    [
      {
        path: '/',
        element: <RequirePermission permission={permission} />,
        children: [{ path: 'invoices/new', element: <div>Invoice form with job picker</div> }],
      },
    ],
    { initialEntries: ['/invoices/new'] },
  );
  return render(<RouterProvider router={memoryRouter} />);
}

describe('RequirePermission (#1280)', () => {
  beforeEach(() => {
    meState.me = null;
    meState.isLoading = false;
    meState.error = null;
  });

  it('blocks a technician (no invoices:view) from the invoice form', () => {
    meState.me = { permissions: ['jobs:view', 'customers:view'] };
    renderGuarded('invoices:view');
    expect(screen.queryByText('Invoice form with job picker')).toBeNull();
    expect(screen.getByTestId('route-forbidden')).toBeTruthy();
    expect(screen.getByText(/don.t have access/i)).toBeTruthy();
  });

  it('renders the page for a viewer holding the permission', () => {
    meState.me = { permissions: ['invoices:view'] };
    renderGuarded('invoices:view');
    expect(screen.getByText('Invoice form with job picker')).toBeTruthy();
  });

  it('renders nothing while /api/me is still loading (no flash of the form)', () => {
    meState.isLoading = true;
    renderGuarded('invoices:view');
    expect(screen.queryByText('Invoice form with job picker')).toBeNull();
    expect(screen.queryByTestId('route-forbidden')).toBeNull();
  });

  it('fails closed when /api/me could not be loaded', () => {
    meState.error = new Error('boom');
    renderGuarded('invoices:view');
    expect(screen.queryByText('Invoice form with job picker')).toBeNull();
    expect(screen.getByTestId('route-forbidden')).toBeTruthy();
  });
});

function flatten(routes: RouteObject[], ancestors: RouteObject[] = []): Array<{ route: RouteObject; ancestors: RouteObject[] }> {
  return routes.flatMap((route) => [
    { route, ancestors },
    ...(route.children ? flatten(route.children, [...ancestors, route]) : []),
  ]);
}

describe('router wiring (#1280)', () => {
  const all = flatten(router.routes as RouteObject[]);
  const requiredFor = (path: string): string | undefined => {
    const entry = all.find((e) => e.route.path === path);
    expect(entry, `expected a route for ${path}`).toBeDefined();
    const guard = entry!.ancestors.find(
      (a) => (a.handle as { requires?: string } | undefined)?.requires,
    );
    return (guard?.handle as { requires?: string } | undefined)?.requires;
  };

  it.each([
    ['invoices', 'invoices:view'],
    ['invoices/new', 'invoices:view'],
    ['invoices/:id', 'invoices:view'],
    ['reports/money', 'invoices:view'],
    ['reports/revenue-by-source', 'invoices:view'],
    ['estimates', 'estimates:view'],
    ['estimates/new', 'estimates:view'],
    ['estimates/:id', 'estimates:view'],
    ['settings', 'settings:view'],
    ['settings/price-book', 'settings:view'],
    ['settings/templates', 'settings:view'],
    ['settings/feedback', 'settings:view'],
    ['settings/language', 'settings:view'],
  ])('%s is guarded by %s', (path, permission) => {
    expect(requiredFor(path)).toBe(permission);
  });

  it.each(['jobs', 'customers', 'technician/day', 'comms-inbox', 'inbox'])(
    '%s stays open to technicians (field surfaces)',
    (path) => {
      expect(requiredFor(path)).toBeUndefined();
    },
  );
});
