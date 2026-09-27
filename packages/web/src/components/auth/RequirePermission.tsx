import { NavLink, Outlet } from 'react-router';
import { useMe } from '../../hooks/useMe';

/**
 * #1280 — route-level permission guard (pathless layout route).
 *
 * Keyed on the SAME permission strings Shell.tsx's nav filter uses
 * (`invoices:view`, `estimates:view`, `settings:view`), so a viewer who never
 * sees a nav entry also can't reach its page by URL. The API's RBAC stays the
 * real gate; this keeps a technician from rendering office pages whose forms
 * (New Invoice / New Estimate) would list every tenant job's customer name and
 * service address in their job picker.
 *
 * - `/api/me` still loading → render nothing (no flash of the page).
 * - permission held → render the child route.
 * - permission missing, OR `/api/me` failed → fail closed with a short
 *   explanation and a way back to the field surfaces.
 */
export function RequirePermission({ permission }: { permission: string }) {
  const { me, isLoading } = useMe();

  if (!me && isLoading) return null;

  const granted = me?.permissions?.includes(permission) ?? false;
  if (granted) return <Outlet />;

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12 text-center" data-testid="route-forbidden">
      <h1 className="text-lg font-medium text-foreground">You don&apos;t have access to this page</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {me
          ? 'Your role doesn’t include it. Ask the account owner if you need it.'
          : 'We couldn’t confirm your access. Check your connection and reload the page.'}
      </p>
      <NavLink
        to="/"
        className="mt-6 inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm text-primary-foreground"
      >
        Go to home
      </NavLink>
    </div>
  );
}

/** Pathless layout-route components, one per guarded permission. `handle.requires`
 *  mirrors the prop so the route table is self-describing (routes tests read it). */
export function RequireInvoicesView() {
  return <RequirePermission permission="invoices:view" />;
}
export function RequireEstimatesView() {
  return <RequirePermission permission="estimates:view" />;
}
export function RequireSettingsView() {
  return <RequirePermission permission="settings:view" />;
}
