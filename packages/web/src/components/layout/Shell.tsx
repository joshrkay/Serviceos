import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import {
  Home, MessageSquare, Briefcase, Calendar,
  Users, FileText, Receipt, Settings, Zap, Bell, Layers, TrendingUp, LogOut,
  Wrench,
} from 'lucide-react';
import { useUser, useClerk } from '@clerk/clerk-react';
import { Toaster, toast } from 'sonner';
import { VoiceBar } from '../shared/VoiceBar';
import type { VoiceBarHandle } from '../shared/VoiceBar';
import { CameraCapture, CameraButton } from '../shared/CameraCapture';
import { ErrorBoundary } from './ErrorBoundary';
import { useMe, type Mode } from '../../hooks/useMe';
import {
  ModeSwitchModal,
  shouldShowModeSwitchModal,
} from '../mode/ModeSwitchModal';
import { CompressedSessionStrip } from '../sessions/CompressedSessionStrip';
import { useActiveSessions } from '../../hooks/useActiveSessions';

interface NavItem {
  to: string;
  label: string;
  icon: typeof Home;
}

/**
 * P12-002 — mode-aware navigation.
 *
 * "Reuse existing routes where they roughly fit" (per the dispatch
 * decision): the labels reflect the mode-specific framing while the
 * underlying routes remain the existing ones (e.g. `/assistant` is
 * "Sessions" in supervisor mode, `/technician/day` is "Today" in tech).
 *
 * Routes that don't yet exist (e.g. `/dispatch`) are deliberately
 * omitted — the supervisor wall + DispatchBoard wiring lands in a
 * separate story. Adding them here would 404 and we'd rather hide
 * them until they're real.
 */
function getNav(mode: Mode): NavItem[] {
  switch (mode) {
    case 'tech':
      return [
        { to: '/technician/day', label: 'Today',     icon: Wrench   },
        { to: '/jobs',           label: 'My jobs',   icon: Briefcase },
        { to: '/customers',      label: 'Customers', icon: Users    },
        { to: '/estimates',      label: 'Estimates', icon: FileText },
        { to: '/invoices',       label: 'Invoices',  icon: Receipt  },
        { to: '/settings',       label: 'Settings',  icon: Settings },
      ];
    case 'both':
      return [
        { to: '/assistant',      label: 'Sessions',     icon: MessageSquare },
        { to: '/technician/day', label: 'Today',        icon: Wrench        },
        { to: '/jobs',           label: 'My jobs',      icon: Briefcase     },
        { to: '/schedule',       label: 'Schedule',     icon: Calendar      },
        { to: '/customers',      label: 'Customers',    icon: Users         },
        { to: '/estimates',      label: 'Estimates',    icon: FileText      },
        { to: '/invoices',       label: 'Invoices',     icon: Receipt       },
        { to: '/settings',       label: 'Settings',     icon: Settings      },
      ];
    case 'supervisor':
    default:
      return [
        { to: '/',              label: 'Home',         icon: Home          },
        { to: '/assistant',     label: 'Sessions',     icon: MessageSquare },
        { to: '/jobs',          label: 'Jobs',         icon: Briefcase     },
        { to: '/schedule',      label: 'Schedule',     icon: Calendar      },
        { to: '/customers',     label: 'Customers',    icon: Users         },
        { to: '/leads',         label: 'Leads',        icon: TrendingUp    },
        { to: '/estimates',     label: 'Estimates',    icon: FileText      },
        { to: '/invoices',      label: 'Invoices',     icon: Receipt       },
        { to: '/interactions',  label: 'Interactions', icon: Layers        },
        { to: '/settings',      label: 'Settings',     icon: Settings      },
      ];
  }
}

function getBottomNav(mode: Mode): NavItem[] {
  switch (mode) {
    case 'tech':
      return [
        { to: '/technician/day', label: 'Today',     icon: Wrench   },
        { to: '/jobs',           label: 'Jobs',      icon: Briefcase },
        { to: '/customers',      label: 'Customers', icon: Users    },
        { to: '/invoices',       label: 'Invoices',  icon: Receipt  },
      ];
    case 'both':
      return [
        { to: '/assistant',      label: 'Sessions',  icon: MessageSquare },
        { to: '/technician/day', label: 'Today',     icon: Wrench        },
        { to: '/jobs',           label: 'Jobs',      icon: Briefcase     },
        { to: '/customers',      label: 'Customers', icon: Users         },
        { to: '/invoices',       label: 'Invoices',  icon: Receipt       },
      ];
    case 'supervisor':
    default:
      return [
        { to: '/',           label: 'Home',      icon: Home          },
        { to: '/assistant',  label: 'AI',        icon: MessageSquare },
        { to: '/jobs',       label: 'Jobs',      icon: Briefcase     },
        { to: '/leads',      label: 'Leads',     icon: TrendingUp    },
        { to: '/customers',  label: 'Customers', icon: Users         },
        { to: '/invoices',   label: 'Invoices',  icon: Receipt       },
      ];
  }
}

function getInitials(fullName: string | null, email: string | null | undefined): string {
  if (fullName) {
    const parts = fullName.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0][0].toUpperCase();
  }
  if (email) return email[0].toUpperCase();
  return '?';
}

function formatRoleLabel(role: string | undefined): string {
  if (!role) return '';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

interface ModeToggleProps {
  current: Mode;
  canFieldServe: boolean;
  onSwitch: (next: Mode) => Promise<void>;
  variant: 'sidebar' | 'topbar';
}

/**
 * Three-way segmented control: Supervisor / Tech / Both.
 *
 * Visible only when `canFieldServe || role === 'owner'`. When the user
 * is locked to a single mode (e.g. a dispatcher with can_field_serve=false)
 * the parent omits the toggle entirely — we don't render a disabled
 * single-option control. The mode flip is async and may throw; we
 * surface server errors via `toast.error` so the user knows why the
 * UI didn't change.
 */
function ModeToggle({ current, onSwitch, variant }: ModeToggleProps) {
  const [pending, setPending] = useState<Mode | null>(null);
  const options: ReadonlyArray<{ mode: Mode; label: string }> = [
    { mode: 'supervisor', label: 'Supervisor' },
    { mode: 'both',       label: 'Both' },
    { mode: 'tech',       label: 'Tech' },
  ];

  const handleClick = async (target: Mode) => {
    if (target === current || pending !== null) return;
    setPending(target);
    try {
      await onSwitch(target);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Mode switch failed';
      toast.error(message);
    } finally {
      setPending(null);
    }
  };

  const sizeClass = variant === 'sidebar'
    ? 'text-xs px-2 py-1'
    : 'text-xs px-2 py-1';

  return (
    <div
      role="radiogroup"
      aria-label="Operator mode"
      data-testid="mode-toggle"
      className="flex rounded-md border border-slate-200 bg-slate-50 overflow-hidden"
    >
      {options.map(({ mode, label }) => {
        const active = current === mode;
        const isPending = pending === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            data-mode-option={mode}
            disabled={pending !== null}
            onClick={() => handleClick(mode)}
            className={`${sizeClass} flex-1 transition-colors ${
              active
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            } ${isPending ? 'opacity-60' : ''}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

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
  const { isLoaded, user } = useUser();
  const { signOut } = useClerk();
  const { me, switchMode } = useMe();
  const { sessions, pendingProposalCount } = useActiveSessions();
  // Phase 12 — pending mode-switch confirmation. When a user clicks a
  // destination that requires a confirmation modal (supervisor→tech /
  // both→tech), we stash it here and render <ModeSwitchModal>. The
  // modal's onConfirm executes the actual switchMode.
  const [pendingMode, setPendingMode] = useState<Mode | null>(null);

  const isExact = (to: string) =>
    to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);

  // Phase 12 — reflect the active mode on document.body so global CSS,
  // analytics, and outer overlays can target it without prop drilling.
  useEffect(() => {
    if (!me) {
      document.body.removeAttribute('data-mode');
      return;
    }
    document.body.setAttribute('data-mode', me.current_mode);
    return () => {
      document.body.removeAttribute('data-mode');
    };
  }, [me?.current_mode]);

  if (!isLoaded) return null;

  const displayName = user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? '';
  const initials = getInitials(user?.fullName ?? null, user?.primaryEmailAddress?.emailAddress);

  const currentMode: Mode = me?.current_mode ?? 'supervisor';
  const canFieldServe = me?.can_field_serve ?? false;
  const role = me?.role;
  const isOwner = role === 'owner';
  const showModeToggle = isOwner || canFieldServe;
  const roleLabel = formatRoleLabel(role) || 'Owner';

  const nav = getNav(currentMode);
  const bottomNav = getBottomNav(currentMode);

  // The mode toggle calls this; if the destination crosses out of
  // supervisor coverage, we surface the confirmation modal instead of
  // performing the switch immediately. Otherwise we delegate to the
  // hook directly. Errors propagate to the toggle's local catch which
  // surfaces a sonner toast.
  const handleModeRequest = async (target: Mode) => {
    if (shouldShowModeSwitchModal(currentMode, target)) {
      setPendingMode(target);
      return;
    }
    await switchMode(target);
  };

  const confirmPendingMode = async () => {
    const target = pendingMode;
    if (!target) return;
    setPendingMode(null);
    try {
      await switchMode(target);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Mode switch failed';
      toast.error(message);
    }
  };

  return (
    <ErrorBoundary>
    <div className="flex h-screen bg-slate-50 overflow-hidden">

      {/* Toast portal — mounted at the layout root so toasts surface
          across all authenticated pages. role="status"/role="alert" are
          applied per-toast by sonner internally. */}
      <Toaster richColors position="top-right" />

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
          {nav.map(({ to, label, icon: Icon }) => {
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

        {/* Mode toggle — only for users who can switch (owner or
            dispatcher w/ can_field_serve). Hidden entirely otherwise so
            tech-only / CSR-only users never see a non-actionable control. */}
        {showModeToggle && (
          <div className="px-3 pb-2">
            <ModeToggle
              current={currentMode}
              canFieldServe={canFieldServe}
              onSwitch={handleModeRequest}
              variant="sidebar"
            />
          </div>
        )}

        {/* User */}
        <div className="border-t border-slate-100 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-800 text-white text-xs">{initials}</span>
            <div className="min-w-0">
              <p className="text-xs text-slate-800 truncate">{displayName}</p>
              <p className="text-xs text-slate-400 truncate">{roleLabel}</p>
            </div>
            <button
              onClick={() => signOut({ redirectUrl: '/login' })}
              className="ml-auto shrink-0 text-slate-400 hover:text-slate-600 cursor-pointer"
              title="Sign out"
            >
              <LogOut size={15} />
            </button>
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
            {showModeToggle && (
              <div className="hidden sm:block w-44">
                <ModeToggle
                  current={currentMode}
                  canFieldServe={canFieldServe}
                  onSwitch={handleModeRequest}
                  variant="topbar"
                />
              </div>
            )}
            <CameraButton variant="topbar" onOpen={() => setCameraOpen(true)} />
            <Bell size={18} className="text-slate-500" />
            <NavLink to="/settings" className="relative flex items-center justify-center">
              <span className={`flex size-7 items-center justify-center rounded-full text-xs transition-all ${
                location.pathname.startsWith('/settings')
                  ? 'bg-blue-600 text-white ring-2 ring-blue-200'
                  : 'bg-slate-800 text-white'
              }`}>{initials}</span>
              <span className={`absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full border border-white ${
                location.pathname.startsWith('/settings') ? 'bg-blue-600' : 'bg-slate-600'
              }`}>
                <Settings size={8} className="text-white" />
              </span>
            </NavLink>
          </div>
        </div>

        {/* Phase 12 — compressed session strip is only visible in 'both'
            mode. In supervisor mode the operator sees the full wall;
            in tech mode the operator should not be distracted by the
            wall at all. */}
        {currentMode === 'both' && <CompressedSessionStrip />}

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
            {bottomNav.map(({ to, label, icon: Icon }) => {
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

      {/* Phase 12 — mode-switch confirmation. Rendered at the layout
          root so it overlays everything. The modal owns its own
          presentation; we own the `switchMode` invocation on confirm. */}
      {pendingMode && me && (
        <ModeSwitchModal
          from={currentMode}
          to={pendingMode}
          activeSessionCount={sessions.length}
          pendingProposalCount={pendingProposalCount}
          onConfirm={confirmPendingMode}
          onCancel={() => setPendingMode(null)}
        />
      )}

    </div>
    </ErrorBoundary>
  );
}
