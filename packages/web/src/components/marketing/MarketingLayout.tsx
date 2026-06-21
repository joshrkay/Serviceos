import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router';
import { MarketingHeader } from './MarketingHeader';
import { MarketingFooter } from './MarketingFooter';

/**
 * Public layout for the standalone marketing routes (/features, /pricing,
 * /about, /download, /privacy, /terms). Wraps each page in the shared
 * header/footer and scrolls to top on navigation so deep links don't land
 * mid-page. Rendered as a router layout route (outside ProtectedRoute) so
 * the pages are reachable signed-out and signed-in.
 */
export function MarketingLayout() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <MarketingHeader />
      <main>
        <Outlet />
      </main>
      <MarketingFooter />
    </div>
  );
}
