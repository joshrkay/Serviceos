import React from 'react';
import { useRouteError, isRouteErrorResponse, useNavigate } from 'react-router';
import { reportSafeError } from '../../lib/errorReporter';

/**
 * Router-level error element.
 *
 * React Router catches loader / action / render errors thrown by descendants
 * and routes them to the nearest `errorElement` on the matching route. Without
 * an errorElement, the user sees a blank white page; with one, they see this
 * fallback (and can recover with "Try again" / "Go back").
 *
 * Why this is separate from `ErrorBoundary` (components/layout/ErrorBoundary):
 * `ErrorBoundary` is a React class component that catches render errors
 * anywhere in its descendant tree via `getDerivedStateFromError`. It does NOT
 * catch errors thrown from React Router loaders/actions or from the
 * non-component code paths the router invokes (data routes, etc). This
 * component fills that second hole — it consumes the router's `useRouteError`
 * and renders the same visual shape.
 *
 * Public-pages note: the customer-facing /e/:id, /pay/:id, /intake,
 * /feedback/:token, and /portal/:token routes each get this element
 * directly. The authenticated branch (/ → ProtectedRoute → Shell → …) gets it
 * once at the outermost level — descendant errors bubble up to it.
 */
export function RouteErrorElement(): React.ReactElement {
  const error = useRouteError();
  const navigate = useNavigate();

  // Disambiguate the three shapes React Router can hand us:
  //   1. RouteErrorResponse — thrown by a loader/action via `throw new Response(...)`
  //      or `throw json(...)`. Carries `status` and `statusText`.
  //   2. Error instance — a render-time throw inside a child component.
  //   3. Anything else — unusual, log it for surface in dev tooling.
  let title = 'Something went wrong';
  let detail = 'The application encountered an unexpected error and could not continue.';
  let errName = 'Error';
  let errMessage = '';

  if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText || 'Error'}`;
    detail =
      error.status === 404
        ? "The page you're looking for doesn't exist or was moved."
        : 'The server returned an error while loading this page.';
    errName = `HTTP ${error.status}`;
    errMessage = typeof error.data === 'string' ? error.data : '';
  } else if (error instanceof Error) {
    errName = error.name || 'Error';
    errMessage = error.message || '';
  } else if (error !== undefined && error !== null) {
    // eslint-disable-next-line no-console
    console.error('[RouteErrorElement] unexpected error shape:', error);
    errMessage = String(error);
  }

  // ARCH-31 / OBS-43 — report through the shared PostHog-backed error
  // reporter (see ErrorBoundary for the render-error counterpart). Router
  // loader/action errors and non-Error throws never reach
  // ErrorBoundary.componentDidCatch, so without this they were invisible in
  // production. We report the already-computed display-safe errName /
  // errMessage (not the raw `error`) so a RouteErrorResponse's `.data` —
  // which may echo a server response body — goes through the same
  // redaction + truncation as every other capture site before it leaves
  // the device. Runs once per distinct error object, not on every
  // re-render (e.g. the "Try again" / "Go back" buttons).
  React.useEffect(() => {
    if (error !== undefined && error !== null) {
      reportSafeError(errName, errMessage, 'route-error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  const handleReload = (): void => {
    if (typeof window !== 'undefined' && window.location) {
      window.location.reload();
    }
  };

  const handleBack = (): void => {
    // Try to go back; if there's no history (deep-link landing), fall back home.
    if (typeof window !== 'undefined' && window.history.length > 1) {
      navigate(-1);
    } else {
      navigate('/', { replace: true });
    }
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex min-h-screen items-center justify-center bg-slate-50 p-6"
      data-testid="route-error-element"
    >
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
        <p className="mt-2 text-sm text-slate-600">{detail}</p>
        {(errName || errMessage) && (
          <div className="mt-3 rounded-md bg-slate-50 p-3 text-xs text-slate-500">
            <span className="font-medium text-slate-700">{errName}</span>
            {errMessage ? (
              <>
                {': '}
                <span>{errMessage}</span>
              </>
            ) : null}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={handleBack}
            className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            Go back
          </button>
          <button
            type="button"
            onClick={handleReload}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
