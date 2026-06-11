import { useQuery } from '@tanstack/react-query';
import { NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { api, clearDevUserId, getDevUserId } from '../lib/api';

const NAV = [
  { to: '/inbox', label: 'Inbox', icon: '◉' },
  { to: '/schedule', label: 'Schedule', icon: '▦' },
  { to: '/money', label: 'Money', icon: '$' },
  { to: '/customers', label: 'Customers', icon: '☰' },
  { to: '/audit', label: 'Audit log', icon: '≡' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export default function Shell() {
  const navigate = useNavigate();
  const hasIdentity = Boolean(getDevUserId());
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const result = await api.me();
      if (result.status !== 200) throw new Error('unauthorized');
      return result.body;
    },
    enabled: hasIdentity,
  });

  if (!hasIdentity) return <Navigate to="/login" replace />;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 flex-col bg-stone-900 text-stone-100">
        <div className="px-5 py-6">
          <div className="text-xl font-bold tracking-tight">Rivet</div>
          <div className="mt-1 text-xs text-stone-400">
            {me.data ? me.data.tenant.name : '…'}
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  isActive ? 'bg-amber-500 font-semibold text-stone-900' : 'text-stone-300 hover:bg-stone-800'
                }`
              }
            >
              <span className="w-4 text-center">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-stone-800 px-5 py-4 text-xs text-stone-400">
          <div className="font-medium text-stone-200">{me.data?.name ?? ''}</div>
          <div>{me.data?.role ?? ''}</div>
          <button
            type="button"
            className="mt-2 text-stone-400 underline hover:text-stone-200"
            onClick={() => {
              clearDevUserId();
              navigate('/login');
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
