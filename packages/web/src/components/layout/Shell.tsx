import { useState, useEffect, useRef, useCallback, useContext } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, UNSAFE_DataRouterStateContext } from 'react-router';
import {
  Home, MessageSquare, Briefcase, Calendar,
  Users, FileText, Receipt, Settings, Zap, Bell, Layers, TrendingUp, LogOut,
  Wrench, Mail,
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
import {
  ActiveSessionsProvider,
  useActiveSessions,
} from '../../hooks/useActiveSessions';
import { UpgradeNudgeBanner } from '../onboarding/v2/UpgradeNudgeBanner';
import { ActivationCelebrationBanner } from '../onboarding/v2/ActivationCelebrationBanner';
import { WelcomeWalkthrough } from '../walkthrough/WelcomeWalkthrough';
import { WhatsNewModal } from '../walkthrough/WhatsNewModal';
import { PastDueBanner } from '../billing/PastDueBanner';
import { EscalationPanelHost } from '../dispatch/EscalationPanelHost';
import {
  usePendingProposals,
  type PendingProposalSummary,
} from '../../hooks/usePendingProposals';

interface NavItem {
  to: string;
  label: string;
  icon: typeof Home;
  /**
   * Permission required to see this item. Office/billing surfaces are tagged
   * so a viewer who lacks the permission (notably the technician role, which
   * holds no invoices/estimates/payments view) never sees the nav entry — in
   * ANY mode, including the supervisor default an unset technician falls back
   * to. The RBAC removal is the real gate; this keeps the UI consistent so a
   * tagged item never deep-links to a 403. Untagged items are always shown.
   */
  requires?: string;
}

/**
 * P12-002 — mode-aware navigation.
 *
 * "Reuse existing routes where they roughly fit" (per the dispatch
 * decision): the labels reflect the mode-specific framing while the
 * underlying routes remain the existing ones (e.g. `/assistant` is
 * "Sessions" in supervisor mode, `/technician/day` is "Today" in tech).
 *
 */
function getNav(mode: Mode): NavItem[] {
  switch (mode) {
    case 'tech':
      // Field view — stripped of office/billing surfaces (Epic 6 non-goal:
      // "do not expose office/billing surfaces to the technician role").
      return [
        { to: '/technician/day', label: 'Today',     icon: Wrench   },
        { to: '/jobs',           label: 'My jobs',   icon: Briefcase },
        { to: '/customers',      label: 'Customers', icon: Users    },
        { to: '/comms-inbox',    label: 'Messages',  icon: Mail     },
        { to: '/inbox',          label: 'Inbox',     icon: Bell     },
        { to: '/settings',       label: 'Settings',  icon: Settings, requires: 'settings:view' },
      ];
    case 'both':
      // Supervisor + field-tech power view. Trimmed to the calm core
      // (Assistant relabel; Dispatch/Inbox/Money dropped from the
      // sidebar — all still reachable by URL and via the logo badge).
      return [
        { to: '/assistant',      label: 'Assistant',    icon: MessageSquare },
        { to: '/technician/day', label: 'Today',        icon: Wrench        },
        { to: '/jobs',           label: 'My jobs',      icon: Briefcase     },
        { to: '/schedule',       label: 'Schedule',     icon: Calendar      },
        { to: '/customers',      label: 'Customers',    icon: Users         },
        { to: '/estimates',      label: 'Estimates',    icon: FileText, requires: 'estimates:view' },
        { to: '/invoices',       label: 'Invoices',     icon: Receipt, requires: 'invoices:view' },
        { to: '/settings',       label: 'Settings',     icon: Settings, requires: 'settings:view' },
      ];
    case 'supervisor':
    default:
      // The 10 Figma desktop items plus Messages (the unified comms inbox).
      // Dispatch, Inbox, and Money intentionally live off the sidebar to keep
      // the surface calm: Dispatch/Money are reachable by URL (and surfaced in
      // Schedule/Home), and pending approvals stay one click away via the
      // proposal badge on the Rivet logo, which links to /inbox.
      return [
        { to: '/',              label: 'Home',         icon: Home          },
        { to: '/assistant',     label: 'Assistant',    icon: MessageSquare },
        { to: '/jobs',          label: 'Jobs',         icon: Briefcase     },
        { to: '/schedule',      label: 'Schedule',     icon: Calendar      },
        { to: '/customers',     label: 'Customers',    icon: Users         },
        { to: '/comms-inbox',   label: 'Messages',     icon: Mail          },
        { to: '/leads',         label: 'Leads',        icon: TrendingUp    },
        { to: '/estimates',     label: 'Estimates',    icon: FileText, requires: 'estimates:view' },
        { to: '/invoices',      label: 'Invoices',     icon: Receipt, requires: 'invoices:view' },
        { to: '/interactions',  label: 'Interactions', icon: Layers        },
        { to: '/settings',      label: 'Settings',     icon: Settings, requires: 'settings:view' },
      ];
  }
}

function getBottomNav(mode: Mode): NavItem[] {
  switch (mode) {
    case 'tech':
      // Field view — no Money/Bills/Quotes (Epic 6 non-goal).
      return [
        { to: '/technician/day', label: 'Today',     icon: Wrench     },
        { to: '/jobs',           label: 'My jobs',   icon: Briefcase  },
        { to: '/customers',      label: 'Customers', icon: Users      },
        { to: '/comms-inbox',    label: 'Messages',  icon: Mail       },
        { to: '/inbox',          label: 'Inbox',     icon: Bell       },
      ];
    case 'both':
      return [
        { to: '/technician/day', label: 'Today',  icon: Wrench        },
        { to: '/inbox',          label: 'Inbox',  icon: Bell          },
        { to: '/reports/money',  label: 'Money',  icon: TrendingUp, requires: 'invoices:view' },
        { to: '/invoices',       label: 'Bills',  icon: Receipt, requires: 'invoices:view' },
        { to: '/assistant',      label: 'AI',     icon: MessageSquare },
      ];
    case 'supervisor':
    default:
      // Matches the Figma mobile bottom bar (6 items).
      return [
        { to: '/',           label: 'Home',      icon: Home          },
        { to: '/assistant',  label: 'AI',        icon: MessageSquare },
        { to: '/jobs',       label: 'Jobs',      icon: Briefcase     },
        { to: '/leads',      label: 'Leads',     icon: TrendingUp    },
        { to: '/customers',  label: 'Customers', icon: Users         },
        { to: '/invoices',   label: 'Invoices',  icon: Receipt, requires: 'invoices:view' },
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
  // The topbar (mobile) variant uses a short "Sup" label so all three
  // options fit a 320px-wide header; full names stay on aria-label.
  const options: ReadonlyArray<{ mode: Mode; label: string; fullLabel: string }> = [
    { mode: 'supervisor', label: variant === 'topbar' ? 'Sup' : 'Supervisor', fullLabel: 'Supervisor' },
    { mode: 'both',       label: 'Both', fullLabel: 'Both' },
    { mode: 'tech',       label: 'Tech', fullLabel: 'Tech' },
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

  // Touch targets: the topbar (mobile) variant must be >= 40px tall;
  // the sidebar variant matches the desktop nav density but keeps a
  // 40px minimum hit area too.
  const sizeClass = variant === 'sidebar'
    ? 'text-xs px-2 py-1 min-h-[40px]'
    : 'text-xs px-1.5 min-h-[40px]';

  return (
    <div
      role="radiogroup"
      aria-label="Operator mode"
      data-testid="mode-toggle"
      className="flex rounded-md border border-border bg-secondary overflow-hidden"
    >
      {options.map(({ mode, label, fullLabel }) => {
        const active = current === mode;
        const isPending = pending === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={fullLabel}
            data-mode-option={mode}
            disabled={pending !== null}
            onClick={() => handleClick(mode)}
            className={`${sizeClass} flex-1 transition-colors ${
              active
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
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
  // ActiveSessionsProvider singletonizes the supervisor-wall WS + the
  // /api/voice/sessions/active poller — `useActiveSessions()` is
  // called in both ShellInner and CompressedSessionStrip, and both
  // now read from the same provider instance instead of opening
  // duplicate connections per consumer.
  return (
    <ActiveSessionsProvider>
      <ShellInner />
    </ActiveSessionsProvider>
  );
}

function ShellInner() {
  const location = useLocation();
  // Route-level lazy() holds the transition while a page's chunk loads; the
  // data-router navigation state reports 'loading' during that window. Read it
  // from context (not useNavigation()) so Shell still renders when mounted in a
  // plain MemoryRouter — as component tests do — instead of throwing.
  const dataRouterState = useContext(UNSAFE_DataRouterStateContext);
  const isNavigating = dataRouterState?.navigation?.state === 'loading';
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
  const { sessions, pendingProposalCount: liveSessionPendingCount } = useActiveSessions();
  const navigate = useNavigate();

  // P2-033 — toast on each genuinely new pending proposal. Sonner's
  // action.onClick doesn't auto-navigate, so we drive it through
  // react-router's `navigate` to land on /inbox where the operator can
  // approve/reject. Callback is stable so the hook doesn't reset its
  // visibility-aware polling on every render.
  const handleNewProposal = useCallback(
    (proposal: PendingProposalSummary) => {
      toast.info(`New proposal: ${proposal.summary}`, {
        action: {
          label: 'Review',
          onClick: () => navigate('/inbox'),
        },
      });
    },
    [navigate],
  );

  const handleCriticalProposal = useCallback(
    (proposal: PendingProposalSummary) => {
      const expiry = proposal.expiresAt
        ? new Date(proposal.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : 'soon';
      toast.warning(`Hold expiring ${expiry}: ${proposal.summary}`, {
        action: {
          label: 'Review',
          onClick: () => navigate('/inbox'),
        },
      });
    },
    [navigate],
  );

  const {
    count: pendingProposalCount,
  } = usePendingProposals({
    enabled: isLoaded && Boolean(user),
    onNewProposal: handleNewProposal,
    onCriticalProposal: handleCriticalProposal,
  });

  // Prefer the live session feed when it's reporting (the supervisor
  // wall ships its own count); otherwise fall back to the polled
  // proposals total so the mode-switch modal sees the right number.
  const modeSwitchPendingCount = liveSessionPendingCount || pendingProposalCount;
  // Phase 12 — pending mode-switch confirmation. When a user clicks a
  // destination that requires a confirmation modal (supervisor→tech /
  // both→tech), we stash it here and render <ModeSwitchModal>. The
  // modal's onConfirm executes the actual switchMode.
  const [pendingMode, setPendingMode] = useState<Mode | null>(null);

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

  // Permission-gate nav items. Office/billing entries carry `requires`; a
  // viewer who lacks the permission (notably the technician role) never sees
  // them — in any mode, including the supervisor default an unset technician
  // falls back to. Untagged items are always shown.
  const grantedPermissions = new Set(me?.permissions ?? []);
  const visibleItems = (items: NavItem[]): NavItem[] =>
    items.filter((item) => !item.requires || grantedPermissions.has(item.requires));
  const nav = visibleItems(getNav(currentMode));
  const bottomNav = visibleItems(getBottomNav(currentMode));

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
    <div className="flex flex-col h-screen bg-background overflow-hidden">

      {/* Payment problem — renders only when the Stripe subscription is
          past_due. Blocking, not dismissible. */}
      <PastDueBanner />

      {/* Activation celebration — one-time "first real call" banner, fires
          when tenant_settings.activated_at is set (< 7 days, not dismissed). */}
      <ActivationCelebrationBanner />

      {/* §10 onboarding — early-upgrade nudge. Renders only when the
          30-minute trial threshold has fired (and onboarding is otherwise
          complete). */}
      <UpgradeNudgeBanner />

      {/* First-run product tour (new accounts) + what's-new changelog
          (existing users). Both portal to <body>; gated so a brand-new
          account sees only the welcome tour on day one. */}
      <WelcomeWalkthrough />
      <WhatsNewModal />

      <div className="flex flex-1 overflow-hidden">

      {/* Toast portal — mounted at the layout root so toasts surface
          across all authenticated pages. role="status"/role="alert" are
          applied per-toast by sonner internally. */}
      <Toaster richColors position="top-right" />

      {/* ── Desktop Sidebar ── */}
      <aside className="hidden md:flex flex-col w-56 shrink-0 bg-card border-r border-border z-10">
        {/* Logo */}
        <div className="flex items-center gap-2 px-5 pt-5 pb-4 border-b border-border">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary">
            <Zap size={14} className="text-primary-foreground" />
          </span>
          <span className="text-sm text-foreground tracking-tight">Rivet</span>
          {pendingProposalCount > 0 && (
            <NavLink
              to="/inbox"
              aria-label={`${pendingProposalCount} pending proposal${pendingProposalCount === 1 ? '' : 's'} — open inbox`}
              data-testid="pending-proposal-badge"
              className="ml-auto flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
              style={{ fontSize: 10 }}
            >
              {pendingProposalCount > 9 ? '9+' : pendingProposalCount}
            </NavLink>
          )}
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
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                <Icon size={16} className={active ? 'text-primary' : ''} />
                {label}
                {to === '/inbox' && pendingProposalCount > 0 && (
                  <span
                    className="ml-auto flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-primary text-primary-foreground px-1"
                    style={{ fontSize: 9 }}
                    data-testid="sidebar-inbox-badge"
                  >
                    {pendingProposalCount > 9 ? '9+' : pendingProposalCount}
                  </span>
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
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground text-xs">{initials}</span>
            <div className="min-w-0">
              <p className="text-xs text-foreground truncate">{displayName}</p>
              <p className="text-xs text-muted-foreground truncate">{roleLabel}</p>
            </div>
            <button
              onClick={() => signOut({ redirectUrl: '/login' })}
              className="ml-auto shrink-0 text-muted-foreground hover:text-foreground cursor-pointer"
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
        <div className="md:hidden flex items-center justify-between px-4 py-3 bg-card border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-lg bg-primary">
              <Zap size={12} className="text-primary-foreground" />
            </span>
            <span className="text-sm text-foreground">Rivet</span>
          </div>
          <div className="flex items-center gap-3">
            {showModeToggle && (
              <div className="w-36 sm:w-44">
                <ModeToggle
                  current={currentMode}
                  canFieldServe={canFieldServe}
                  onSwitch={handleModeRequest}
                  variant="topbar"
                />
              </div>
            )}
            <CameraButton variant="topbar" onOpen={() => setCameraOpen(true)} />
            {/* Mobile approvals entry point. The supervisor bottom bar
                mirrors the Figma 6 (no Inbox) and the logo proposal badge
                is desktop-only, so this Bell is the persistent mobile path
                to the approval queue — with the live pending count. */}
            <NavLink
              to="/inbox"
              aria-label={
                pendingProposalCount > 0
                  ? `${pendingProposalCount} pending proposal${pendingProposalCount === 1 ? '' : 's'} — open inbox`
                  : 'Open approval inbox'
              }
              data-testid="mobile-inbox-bell"
              className="relative flex items-center justify-center text-muted-foreground"
            >
              <Bell size={18} />
              {pendingProposalCount > 0 && (
                <span
                  data-testid="mobile-inbox-badge"
                  className="absolute -top-1.5 -right-1.5 flex size-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-primary-foreground"
                  style={{ fontSize: 9 }}
                >
                  {pendingProposalCount > 9 ? '9+' : pendingProposalCount}
                </span>
              )}
            </NavLink>
            <NavLink to="/settings" className="relative flex items-center justify-center">
              <span className={`flex size-7 items-center justify-center rounded-full text-xs transition-all ${
                location.pathname.startsWith('/settings')
                  ? 'bg-primary text-primary-foreground ring-2 ring-primary/30'
                  : 'bg-secondary text-secondary-foreground'
              }`}>{initials}</span>
              <span className={`absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full border border-card ${
                location.pathname.startsWith('/settings') ? 'bg-primary' : 'bg-muted-foreground'
              }`}>
                <Settings size={8} className="text-primary-foreground" />
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
        <div className="relative flex-1 overflow-hidden">
          {/* Lazy-route chunk is fetching — a thin top bar signals progress
              while the router keeps the prior page visible. */}
          {isNavigating && (
            <div
              className="absolute inset-x-0 top-0 z-20 h-0.5 animate-pulse bg-primary"
              role="status"
              aria-label="Loading page"
            />
          )}
          <Outlet />
        </div>

        {/* ── Mobile voice bar (in flow, above tab bar) ── */}
        <div className="md:hidden shrink-0">
          <VoiceBar ref={voiceBarRef} variant="mobile" />
        </div>

        {/* ── Mobile bottom tab bar (in flow, not fixed) ── */}
        <div className="md:hidden shrink-0 bg-card border-t border-border">
          <div className="flex">
            {bottomNav.map(({ to, label, icon: Icon }) => {
              const active = isExact(to);
              const showInboxBadge = to === '/inbox' && pendingProposalCount > 0;
              return (
                <NavLink
                  key={to}
                  to={to}
                  className={`relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 transition-colors ${
                    active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon size={18} />
                  {showInboxBadge && (
                    <span
                      className="absolute top-1 right-[calc(50%-18px)] flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground"
                      style={{ fontSize: 8 }}
                      data-testid="mobile-inbox-badge"
                    >
                      {pendingProposalCount > 9 ? '9+' : pendingProposalCount}
                    </span>
                  )}
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

      {/* F5 — escalation panel host. Renders floating overlays for
          dispatcher context when a call is transferred. Mounted at the
          layout root so panels surface across all authenticated pages. */}
      <EscalationPanelHost />

      {/* Phase 12 — mode-switch confirmation. Rendered at the layout
          root so it overlays everything. The modal owns its own
          presentation; we own the `switchMode` invocation on confirm. */}
      {pendingMode && me && (
        <ModeSwitchModal
          from={currentMode}
          to={pendingMode}
          activeSessionCount={sessions.length}
          pendingProposalCount={modeSwitchPendingCount}
          onConfirm={confirmPendingMode}
          onCancel={() => setPendingMode(null)}
        />
      )}

      </div>
    </div>
    </ErrorBoundary>
  );
}
