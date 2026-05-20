import { useAuth } from '@clerk/clerk-react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { Zap } from 'lucide-react';
import { useOnboardingStatus } from '../../hooks/useOnboardingStatus';
import { isOnboardingV2Enabled } from '../../lib/runtimeConfig';

export function ProtectedRoute() {
  const { isLoaded, isSignedIn } = useAuth();
  const location = useLocation();

  if (!isLoaded) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-slate-900">
            <Zap size={18} className="text-white" />
          </span>
          <div className="h-1 w-24 rounded-full bg-slate-200 overflow-hidden">
            <div className="h-full w-1/2 rounded-full bg-slate-600 animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (!isSignedIn) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <OnboardingGuard />;
}

/**
 * §10 onboarding completion guard. Only active when the v2 flag is on.
 * Redirects to /onboarding whenever the tenant has incomplete steps and
 * is trying to view any other authed route. Status is polled at 30s so
 * completion elsewhere (or a webhook-driven step flip) unblocks soon.
 */
function OnboardingGuard() {
  const location = useLocation();
  const onboardingV2 = isOnboardingV2Enabled();
  const { data, isLoading } = useOnboardingStatus(30_000, onboardingV2);

  // Flag off → never gate (preserves legacy behavior).
  if (!onboardingV2) return <Outlet />;

  // While loading, render outlet — letting the user see the app one render
  // late is preferable to blocking the whole shell on a status fetch.
  if (isLoading || !data) return <Outlet />;

  if (!data.isComplete && !location.pathname.startsWith('/onboarding')) {
    return <Navigate to="/onboarding" replace />;
  }

  return <Outlet />;
}
