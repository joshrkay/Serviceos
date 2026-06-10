import { SignIn, useAuth } from '@clerk/clerk-react';
import { Navigate, useLocation, useSearchParams } from 'react-router';
import { Zap } from 'lucide-react';

export type LocationState = { from?: { pathname?: string; search?: string; hash?: string } } | null;

/** True if `path` is a safe in-app destination — an absolute path that is not
 *  protocol-relative (`//host`). Guards against open-redirect. */
function isSafeInternalPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//');
}

export function extractFromPath(state: LocationState): string {
  const from = state?.from;
  if (!from?.pathname) return '/';
  // Block external URLs — only accept in-app paths (start with '/' but not '//').
  if (!isSafeInternalPath(from.pathname)) return '/';
  return `${from.pathname}${from.search ?? ''}${from.hash ?? ''}`;
}

/**
 * Resolve the post-login destination. The API client's 401 handler does a
 * full-page redirect to `/login?redirect=<encoded path>`, so the `?redirect=`
 * query param is authoritative when present; react-router's
 * `location.state.from` (set by ProtectedRoute) is the fallback.
 */
export function resolveRedirectTarget(
  redirectParam: string | null,
  state: LocationState,
): string {
  if (redirectParam) {
    let decoded = '';
    try {
      decoded = decodeURIComponent(redirectParam);
    } catch {
      // Malformed encoding — fall through to the state-based fallback.
      decoded = '';
    }
    if (decoded && isSafeInternalPath(decoded)) return decoded;
  }
  return extractFromPath(state);
}

export function LoginPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const redirectTarget = resolveRedirectTarget(
    searchParams.get('redirect'),
    location.state as LocationState,
  );
  if (isLoaded && isSignedIn) return <Navigate to={redirectTarget} replace />;
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-6 pt-6">
        <span className="flex size-8 items-center justify-center rounded-xl bg-slate-900">
          <Zap size={15} className="text-white" />
        </span>
        <span className="text-slate-900 tracking-tight">Rivet</span>
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
          &copy; 2026 Rivet &middot; Privacy &middot; Terms
        </p>
      </div>
    </div>
  );
}
