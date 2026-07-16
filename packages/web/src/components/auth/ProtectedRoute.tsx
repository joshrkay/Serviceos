import { useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { Zap } from 'lucide-react';
import { useOnboardingStatus } from '../../hooks/useOnboardingStatus';

/**
 * Canonical marketing site. The public landing/marketing pages moved off the
 * app domain to their own standalone site, so a signed-out visitor who lands
 * on the app root is forwarded there rather than shown an in-app landing page.
 */
const MARKETING_SITE_URL = 'https://therivetapp.com';

export function ProtectedRoute() {
  const { isLoaded, isSignedIn } = useAuth();
  const location = useLocation();

  if (!isLoaded) {
    return <BrandLoader />;
  }

  if (!isSignedIn) {
    // The app domain is product-only now. Signed-out visitors to the root go
    // to the marketing site; every other protected path bounces to login.
    if (location.pathname === '/') return <MarketingRedirect />;
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <OnboardingGuard />;
}

/** Brand loader shown while Clerk hydrates and during the marketing hop. */
function BrandLoader() {
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

/**
 * Hard-redirect to the standalone marketing site. `replace()` keeps the app
 * root off the history stack so the browser back button doesn't bounce the
 * visitor straight back into this redirect.
 */
function MarketingRedirect() {
  useEffect(() => {
    // Carry the query string across so campaign / attribution params
    // (utm_*, gclid, …) reach the marketing site — this redirect is the only
    // root experience for signed-out app-domain traffic. The server-side
    // redirects preserve the query the same way (the server never sees the
    // fragment, so we match that and leave the hash off).
    window.location.replace(`${MARKETING_SITE_URL}${window.location.search}`);
  }, []);
  return <BrandLoader />;
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
