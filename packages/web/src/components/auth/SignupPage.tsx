import { useEffect } from 'react';
import { SignUp, useAuth } from '@clerk/clerk-react';
import { Navigate } from 'react-router';
import { Zap } from 'lucide-react';
import { trackFunnel } from '../../lib/analytics';

export function SignupPage() {
  const { isLoaded, isSignedIn } = useAuth();
  // Funnel step between view_landing and signup_completed. Fires once when
  // the signup form mounts. No tenant/user yet — null context.
  useEffect(() => {
    trackFunnel('signup_started');
  }, []);
  if (isLoaded && isSignedIn) return <Navigate to="/" replace />;
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-6 pt-6">
        <span className="flex size-8 items-center justify-center rounded-xl bg-slate-900">
          <Zap size={15} className="text-white" />
        </span>
        <span className="text-slate-900 tracking-tight">Rivet</span>
      </div>

      {/* Clerk Sign-Up */}
      <div className="flex-1 flex items-center justify-center px-5 py-12">
        <SignUp
          signInUrl="/login"
          fallbackRedirectUrl="/onboarding"
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
