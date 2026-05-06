'use client';

import { useClerk, useUser } from '@clerk/nextjs';
import { LogOut, User } from 'lucide-react';

export default function SettingsPage() {
  const { signOut } = useClerk();
  const { user } = useUser();

  return (
    <div className="flex-1 p-4 overflow-y-auto">
      <h1 className="text-lg font-semibold mb-4">Settings</h1>

      <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
        <div className="flex items-center gap-3 p-4">
          <div className="size-10 rounded-full bg-slate-800 text-white flex items-center justify-center">
            <User size={18} />
          </div>
          <div>
            <p className="text-sm font-medium">{user?.fullName || 'Contractor'}</p>
            <p className="text-xs text-slate-500">{user?.primaryEmailAddress?.emailAddress}</p>
          </div>
        </div>

        <button
          onClick={() => signOut({ redirectUrl: '/sign-in' })}
          className="w-full flex items-center gap-3 p-4 text-sm text-red-600 hover:bg-red-50 transition-colors"
        >
          <LogOut size={18} />
          Sign out
        </button>
      </div>

      <p className="text-xs text-slate-400 text-center mt-8">
        ServiceOS v0.1 — Sprint 1
      </p>
    </div>
  );
}
