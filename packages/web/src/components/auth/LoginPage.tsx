import { SignIn, useAuth } from '@clerk/clerk-react';
import { Navigate, useLocation } from 'react-router';
import { Zap } from 'lucide-react';

export type LocationState = { from?: { pathname?: string; search?: string; hash?: string } } | null;

export function extractFromPath(state: LocationState): string {
  const from = state?.from;
  if (!from?.pathname) return '/';
  // Block external URLs — only accept in-app paths (start with '/' but not '//').
  if (!from.pathname.startsWith('/') || from.pathname.startsWith('//')) return '/';
  return `${from.pathname}${from.search ?? ''}${from.hash ?? ''}`;
}

export function LoginPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const location = useLocation();
  const redirectTarget = extractFromPath(location.state as LocationState);
  if (isLoaded && isSignedIn) return <Navigate to={redirectTarget} replace />;
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-6 pt-6">
        <span className="flex size-8 items-center justify-center rounded-xl bg-slate-900">
          <Zap size={15} className="text-white" />
        </span>
        <span className="text-slate-900 tracking-tight">Fieldly</span>
      </div>

      {/* Clerk Sign-In */}
      <div className="flex-1 flex items-center justify-center px-5 py-12">
        <SignIn
          signUpUrl="/signup"
          fallbackRedirectUrl={redirectTarget}
          appearance={{
            elements: {
              rootBox: 'w-full max-w-sm',
              card: 'shadow-none border-0 bg-transparent',
            },
          }}
        />
      </div>

      {/* Footer */}
      <div className="px-6 pb-6 text-center">
        <p className="text-xs text-slate-300">
          &copy; 2026 Fieldly &middot; Privacy &middot; Terms
        </p>
      </div>
    </div>
  );
}
