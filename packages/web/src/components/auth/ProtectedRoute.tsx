import { useAuth } from '@clerk/clerk-react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { Zap } from 'lucide-react';
import { useOnboardingStatus } from '../../hooks/useOnboardingStatus';
import { LandingPage } from '../landing/LandingPage';

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
    // Public marketing page at "/" — every other protected path bounces to login.
    if (location.pathname === '/') return <LandingPage />;
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <OnboardingGuard />;
}

/**
 * §10 onboarding completion guard. Redirects to /onboarding whenever the
 * tenant has incomplete steps and is trying to view any other authed route.
 * Status is polled at 30s so completion elsewhere (or a webhook-driven step
 * flip) unblocks soon.
 */
function OnboardingGuard() {
  const location = useLocation();
  const { data, isLoading } = useOnboardingStatus(30_000, true);

  // While loading, render outlet — letting the user see the app one render
  // late is preferable to blocking the whole shell on a status fetch.
  if (isLoading || !data) return <Outlet />;

  const onboardingBypassPrefixes = ['/onboarding', '/inbox', '/reports/money'];
  const allowedDuringSetup = onboardingBypassPrefixes.some((prefix) =>
    location.pathname.startsWith(prefix),
  );

  if (!data.isComplete && !allowedDuringSetup) {
    return <Navigate to="/onboarding" replace />;
  }

  return <Outlet />;
}
