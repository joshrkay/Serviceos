import React from 'react';
import { reportError } from '../../lib/errorReporter';

/**
 * ErrorBoundary — top-level React error boundary for ServiceOS.
 *
 * Catches render errors anywhere in the descendant tree and shows a
 * user-friendly fallback UI with a "Reload page" button. Errors are
 * logged to console.error so they remain visible to dev/ops tooling.
 *
 * Story: P0-032
 */

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional override for the fallback UI. */
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Log without swallowing so dev tools can surface this locally.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] render error:', error, info);
    // ARCH-31 / OBS-43 — also report through the shared PostHog-backed
    // error reporter so a render error surfaces in production, not just a
    // devtools console no one is watching.
    reportError(error, 'error-boundary');
  }

  handleReload = (): void => {
    if (typeof window !== 'undefined' && window.location) {
      window.location.reload();
    }
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const errName = this.state.error?.name ?? 'Error';
      const errMessage =
        this.state.error?.message ?? 'An unexpected error occurred.';

      return (
        <div
          role="alert"
          aria-live="assertive"
          className="flex min-h-screen items-center justify-center bg-slate-50 p-6"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h1 className="text-lg font-semibold text-slate-900">
              Something went wrong
            </h1>
            <p className="mt-2 text-sm text-slate-600">
              The application encountered an unexpected error and could not
              continue. You can try reloading the page.
            </p>
            <div className="mt-3 rounded-md bg-slate-50 p-3 text-xs text-slate-500">
              <span className="font-medium text-slate-700">{errName}</span>
              {': '}
              <span>{errMessage}</span>
            </div>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={this.handleReload}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700"
              >
                Reload page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
