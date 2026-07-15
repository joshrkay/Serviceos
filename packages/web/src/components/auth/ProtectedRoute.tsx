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
 * Soft onboarding gate: CRM unlocks once business identity is saved
 * (name + hours + rate). Remaining steps (phone, billing, AI check,
 * test call) stay available on /onboarding and are soft-nudged — they
 * must not hard-block the product when Stripe/Twilio are still pending.
 * Status is polled at 30s so a save elsewhere unblocks soon.
 */
function OnboardingGuard() {
  const location = useLocation();
  const { data, isLoading } = useOnboardingStatus(30_000, true);

  // While loading, render outlet — letting the user see the app one render
  // late is preferable to blocking the whole shell on a status fetch.
  if (isLoading || !data) return <Outlet />;

  if (location.pathname.startsWith('/onboarding')) {
    return <Outlet />;
  }

  const identityDone = data.steps.some(
    (step) => step.id === 'identity' && step.status === 'done',
  );

  if (!identityDone) {
    return <Navigate to="/onboarding" replace />;
  }

  return <Outlet />;
}
