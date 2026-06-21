import { Link } from 'react-router';
import { Zap } from 'lucide-react';
import { Button } from '../ui/button';
import { track } from '../../lib/analytics';

/**
 * Shared marketing top-nav. Used by both the one-page LandingPage and the
 * standalone marketing routes (/features, /pricing, /about, /download) so
 * there is a single source of truth for the logo, nav links, and the
 * Log in / Start free trial CTAs.
 */
export function MarketingHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-xl bg-slate-900">
            <Zap size={15} className="text-white" />
          </span>
          <span className="text-base tracking-tight">Rivet</span>
        </Link>
        <nav className="hidden items-center gap-7 text-sm text-slate-600 md:flex">
          <Link to="/features" className="hover:text-slate-900">Features</Link>
          <Link to="/pricing" className="hover:text-slate-900">Pricing</Link>
          <Link to="/download" className="hover:text-slate-900">Get the app</Link>
        </nav>
        <div className="flex items-center gap-2">
          <Link to="/login">
            <Button variant="ghost" size="sm">Log in</Button>
          </Link>
          <Link
            to="/signup"
            onClick={() => track('landing_signup_clicked', { location: 'header' })}
          >
            <Button variant="primary" size="sm">Start free trial</Button>
          </Link>
        </div>
      </div>
    </header>
  );
}
