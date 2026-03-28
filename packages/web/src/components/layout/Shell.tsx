import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import {
  Home, MessageSquare, Briefcase, Calendar,
  Users, FileText, Receipt, Settings, Zap, Bell, Layers, TrendingUp,
} from 'lucide-react';
import { VoiceBar } from '../shared/VoiceBar';
import type { VoiceBarHandle } from '../shared/VoiceBar';
import { CameraCapture, CameraButton } from '../shared/CameraCapture';

const NAV = [
  { to: '/',              label: 'Home',        icon: Home          },
  { to: '/assistant',     label: 'Assistant',   icon: MessageSquare },
  { to: '/jobs',          label: 'Jobs',        icon: Briefcase     },
  { to: '/schedule',      label: 'Schedule',    icon: Calendar      },
  { to: '/customers',     label: 'Customers',   icon: Users         },
  { to: '/leads',         label: 'Leads',       icon: TrendingUp    },
  { to: '/estimates',     label: 'Estimates',   icon: FileText      },
  { to: '/invoices',      label: 'Invoices',    icon: Receipt       },
  { to: '/interactions',  label: 'Interactions',icon: Layers        },
  { to: '/settings',      label: 'Settings',    icon: Settings      },
];

const BOTTOM_NAV = [
  { to: '/',           label: 'Home',      icon: Home          },
  { to: '/assistant',  label: 'AI',        icon: MessageSquare },
  { to: '/jobs',       label: 'Jobs',      icon: Briefcase     },
  { to: '/leads',      label: 'Leads',     icon: TrendingUp    },
  { to: '/customers',  label: 'Customers', icon: Users         },
  { to: '/invoices',   label: 'Invoices',  icon: Receipt       },
];

export function Shell() {
  const location = useLocation();
  const [cameraOpen, setCameraOpen] = useState(false);
  const voiceBarRef = useRef<VoiceBarHandle>(null);
  const isExact = (to: string) =>
    to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);

  // Global keyboard shortcut: press 'V' (outside input/textarea) to activate voice
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement).tagName;
        const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable;
        if (!isEditable) {
          e.preventDefault();
          voiceBarRef.current?.activate();
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">

      {/* ── Desktop Sidebar ── */}
      <aside className="hidden md:flex flex-col w-56 shrink-0 bg-white border-r border-slate-100 z-10">
        {/* Logo */}
        <div className="flex items-center gap-2 px-5 pt-5 pb-4 border-b border-slate-100">
          <span className="flex size-7 items-center justify-center rounded-lg bg-slate-900">
            <Zap size={14} className="text-white" />
          </span>
          <span className="text-sm text-slate-900 tracking-tight">Fieldly</span>
          <span
            className="ml-auto flex size-5 items-center justify-center rounded-full bg-blue-600 text-white"
            style={{ fontSize: 10 }}
          >3</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-2 px-2">
          {NAV.map(({ to, label, icon: Icon }) => {
            const active = isExact(to);
            return (
              <NavLink
                key={to}
                to={to}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 mb-0.5 text-sm transition-colors ${
                  active
                    ? 'bg-slate-100 text-slate-900'
                    : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
                }`}
              >
                <Icon size={16} className={active ? 'text-blue-600' : ''} />
                {label}
                {to === '/assistant' && (
                  <span className="ml-auto flex size-4 items-center justify-center rounded-full bg-blue-100 text-blue-700" style={{ fontSize: 9 }}>4</span>
                )}
                {to === '/invoices' && (
                  <span className="ml-auto flex size-4 items-center justify-center rounded-full bg-amber-100 text-amber-700" style={{ fontSize: 9 }}>2</span>
                )}
                {to === '/leads' && (
                  <span className="ml-auto flex size-4 items-center justify-center rounded-full bg-blue-100 text-blue-700" style={{ fontSize: 9 }}>5</span>
                )}
              </NavLink>
            );
          })}
        </nav>

        {/* Desktop voice bar — lives above user section */}
        <VoiceBar ref={voiceBarRef} variant="desktop" />

        {/* Desktop camera button */}
        <div className="px-2 pb-1">
          <CameraButton variant="sidebar" onOpen={() => setCameraOpen(true)} />
        </div>

        {/* User */}
        <div className="border-t border-slate-100 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-800 text-white text-xs">MO</span>
            <div className="min-w-0">
              <p className="text-xs text-slate-800 truncate">Mike Ortega</p>
              <p className="text-xs text-slate-400 truncate">Owner</p>
            </div>
            <Bell size={15} className="ml-auto shrink-0 text-slate-400 hover:text-slate-600 cursor-pointer" />
          </div>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Mobile top bar */}
        <div className="md:hidden flex items-center justify-between px-4 py-3 bg-white border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-lg bg-slate-900">
              <Zap size={12} className="text-white" />
            </span>
            <span className="text-sm text-slate-900">Fieldly</span>
          </div>
          <div className="flex items-center gap-3">
            <CameraButton variant="topbar" onOpen={() => setCameraOpen(true)} />
            <Bell size={18} className="text-slate-500" />
            <NavLink to="/settings" className="relative flex items-center justify-center">
              <span className={`flex size-7 items-center justify-center rounded-full text-xs transition-all ${
                location.pathname.startsWith('/settings')
                  ? 'bg-blue-600 text-white ring-2 ring-blue-200'
                  : 'bg-slate-800 text-white'
              }`}>MO</span>
              <span className={`absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full border border-white ${
                location.pathname.startsWith('/settings') ? 'bg-blue-600' : 'bg-slate-600'
              }`}>
                <Settings size={8} className="text-white" />
              </span>
            </NavLink>
          </div>
        </div>

        {/* Page (fills remaining space, scrolls internally) */}
        <div className="flex-1 overflow-hidden">
          <Outlet />
        </div>

        {/* ── Mobile voice bar (in flow, above tab bar) ── */}
        <div className="md:hidden shrink-0">
          <VoiceBar ref={voiceBarRef} variant="mobile" />
        </div>

        {/* ── Mobile bottom tab bar (in flow, not fixed) ── */}
        <div className="md:hidden shrink-0 bg-white border-t border-slate-200">
          <div className="flex">
            {BOTTOM_NAV.map(({ to, label, icon: Icon }) => {
              const active = isExact(to);
              return (
                <NavLink
                  key={to}
                  to={to}
                  className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 transition-colors ${
                    active ? 'text-blue-600' : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  <Icon size={18} />
                  <span style={{ fontSize: 9 }}>{label}</span>
                </NavLink>
              );
            })}
          </div>
        </div>

      </main>

      {/* Camera overlay */}
      {cameraOpen && (
        <CameraCapture onClose={() => setCameraOpen(false)} />
      )}

    </div>
  );
}