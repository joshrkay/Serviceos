import { useAuth } from '@clerk/clerk-react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { Zap } from 'lucide-react';

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

  return <Outlet />;
}
