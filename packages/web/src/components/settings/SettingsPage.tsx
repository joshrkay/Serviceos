import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useClerk } from '@clerk/clerk-react';
import {
  ChevronRight, Building2, Users, Globe, Clock,
  CreditCard, Link, Zap, FileText, Sparkles, Copy, ExternalLink,
  MapPin, Check, Store, RefreshCw, TrendingUp, Mail, BookOpen, Star, Phone,
  Calendar, ClipboardList, SlidersHorizontal, Megaphone, ScrollText,
  MessageSquareQuote,
} from 'lucide-react';
import { toast } from 'sonner';
import { QuickBooksIntegrationSheet } from './QuickBooksIntegrationSheet';
import { fetchIntegrations, type AccountingIntegrationSummary } from '../../api/integrations';
import { SuppliersSheet } from '../jobs/SuppliersSheet';
import { apiFetch } from '../../utils/api-fetch';
import { useMe } from '../../hooks/useMe';
import { SupervisorBackupSection } from './SupervisorBackupSection';
import { BusinessProfileSheet } from './BusinessProfileSheet';
import { TechnicianPhoneSheet } from './TechnicianPhoneSheet';
import { TerminologySheet } from './TerminologySheet';
import { JobFormTemplatesSheet } from './JobFormTemplatesSheet';
import { JobCustomFieldsSheet } from './JobCustomFieldsSheet';
import { MarketingCampaignsSheet } from './MarketingCampaignsSheet';
import { CustomerGroupsSheet } from './CustomerGroupsSheet';
import { StandingInstructionsSheet } from './StandingInstructionsSheet';
import { BrandVoiceSheet } from './BrandVoiceSheet';
import { AIApprovalRulesSheet } from './AIApprovalRulesSheet';
import { DepositRulesSheet } from './DepositRulesSheet';
import { DiscountPolicySheet } from './DiscountPolicySheet';
import { TeamMembersSheet } from './TeamMembersSheet';
import { CalendarSyncSheet } from './CalendarSyncSheet';
import { PaymentMethodsSheet } from './PaymentMethodsSheet';
import { VerticalPacksSheet } from './VerticalPacksSheet';
import { CallRoutingSheet } from './CallRoutingSheet';
import { OperatorHoursSheet } from './OperatorHoursSheet';
import { DncListSheet } from './DncListSheet';
import {
  fetchLanguageSettings,
  updateLanguageSettings,
} from '../../api/settings';
import { businessInitial } from '../../utils/business-initial';

export function SettingsPage() {
  const navigate = useNavigate();
  const { signOut } = useClerk();
  const { me } = useMe();
  // Tier 4 — Quick toggles: load from backend on mount, persist on
  // toggle. aiAuto + reminders live on /api/settings (migration 075).
  // spanishMode derives from /api/settings/language (P11-002).
  const [aiAuto, setAiAuto]         = useState(false);
  const [reminders, setReminders]   = useState(true);
  const [spanishMode, setSpanishMode] = useState(false);
  const [businessName, setBusinessName] = useState<string | null>(null);
  const [voiceAgentLive, setVoiceAgentLive] = useState<boolean | null>(null);
  // Surface a failure to load the main /api/settings document instead of
  // silently swallowing it (which left the page showing stale defaults with
  // no signal that the user's real preferences never loaded).
  const [settingsLoadError, setSettingsLoadError] = useState(false);
  const [settingsReloadNonce, setSettingsReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/settings');
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(`GET /api/settings ${res.status}`);
        }
        const data = (await res.json()) as {
          autoApplyInternalUpdates?: boolean;
          autoSendAppointmentReminders?: boolean;
          businessName?: string;
          googleReviewUrl?: string | null;
          yelpReviewUrl?: string | null;
        };
        if (typeof data.autoApplyInternalUpdates === 'boolean') {
          setAiAuto(data.autoApplyInternalUpdates);
        }
        if (typeof data.autoSendAppointmentReminders === 'boolean') {
          setReminders(data.autoSendAppointmentReminders);
        }
        if (typeof data.businessName === 'string' && data.businessName.trim()) {
          setBusinessName(data.businessName.trim());
        }
        if (typeof data.googleReviewUrl === 'string') {
          setGoogleReviewUrl(data.googleReviewUrl);
        }
        if (typeof data.yelpReviewUrl === 'string') {
          setYelpReviewUrl(data.yelpReviewUrl);
        }
        setSettingsLoadError(false);
      } catch {
        if (cancelled) return;
        setSettingsLoadError(true);
        toast.error('Could not load your settings', {
          action: {
            label: 'Retry',
            onClick: () => setSettingsReloadNonce((n) => n + 1),
          },
        });
      }
      try {
        const statusRes = await apiFetch('/api/onboarding/status');
        if (cancelled) return;
        if (!statusRes.ok) {
          // Soft-fail: keep Settings usable; don't leave the AI phone
          // answering row stuck on "Loading…" forever.
          setVoiceAgentLive(false);
          return;
        }
        const status = (await statusRes.json()) as { voiceAgentLive?: boolean };
        setVoiceAgentLive(status.voiceAgentLive ?? false);
      } catch {
        // Settings still usable when onboarding status unavailable.
      }
    })();
    (async () => {
      try {
        const lang = await fetchLanguageSettings();
        if (cancelled) return;
        setSpanishMode(lang.defaultLanguage === 'es');
      } catch {
        /* language settings missing — default to English */
      }
    })();
    (async () => {
      try {
        const rows = await fetchIntegrations();
        if (cancelled) return;
        setQbIntegration(rows.find((r) => r.provider === 'quickbooks') ?? null);
      } catch {
        /* integrations unavailable — QuickBooks row stays disconnected */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsReloadNonce]);

  async function refreshQuickBooksIntegration() {
    try {
      const rows = await fetchIntegrations();
      setQbIntegration(rows.find((r) => r.provider === 'quickbooks') ?? null);
    } catch {
      setQbIntegration(null);
    }
  }

  async function persistToggle(field: 'aiAuto' | 'reminders' | 'spanishMode', value: boolean) {
    if (field === 'spanishMode') {
      try {
        await updateLanguageSettings({ defaultLanguage: value ? 'es' : 'en' });
      } catch {
        toast.error('Could not save language preference');
        setSpanishMode(!value); // revert
      }
      return;
    }
    const body =
      field === 'aiAuto'
        ? { autoApplyInternalUpdates: value }
        : { autoSendAppointmentReminders: value };
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`PUT /api/settings ${res.status}`);
    } catch {
      toast.error('Could not save preference');
      // revert on failure
      if (field === 'aiAuto') setAiAuto(!value);
      else setReminders(!value);
    }
  }

  function toggleAiAuto(value: boolean) {
    setAiAuto(value);
    void persistToggle('aiAuto', value);
  }
  function toggleReminders(value: boolean) {
    setReminders(value);
    void persistToggle('reminders', value);
  }
  function toggleSpanishMode(value: boolean) {
    setSpanishMode(value);
    void persistToggle('spanishMode', value);
  }
  const [qbOpen, setQbOpen] = useState(false);
  const [qbIntegration, setQbIntegration] = useState<AccountingIntegrationSummary | null>(null);
  const qbConnected = qbIntegration?.status === 'active';
  const [suppliersOpen, setSuppliersOpen] = useState(false);
  const [businessProfileOpen, setBusinessProfileOpen] = useState(false);
  const [technicianPhoneOpen, setTechnicianPhoneOpen] = useState(false);
  const [terminologyOpen, setTerminologyOpen] = useState(false);
  const [jobFormsOpen, setJobFormsOpen] = useState(false);
  const [jobCustomFieldsOpen, setJobCustomFieldsOpen] = useState(false);
  const [marketingOpen, setMarketingOpen] = useState(false);
  const [customerGroupsOpen, setCustomerGroupsOpen] = useState(false);
  const [standingInstructionsOpen, setStandingInstructionsOpen] = useState(false);
  const [brandVoiceOpen, setBrandVoiceOpen] = useState(false);
  const [aiRulesOpen, setAiRulesOpen] = useState(false);
  const [depositRulesOpen, setDepositRulesOpen] = useState(false);
  const [discountPolicyOpen, setDiscountPolicyOpen] = useState(false);
  const [teamMembersOpen, setTeamMembersOpen] = useState(false);
  const [calendarSyncOpen, setCalendarSyncOpen] = useState(false);
  const [paymentMethodsOpen, setPaymentMethodsOpen] = useState(false);
  const [verticalPacksOpen, setVerticalPacksOpen] = useState(false);
  const [callRoutingOpen, setCallRoutingOpen] = useState(false);
  const [dncListOpen, setDncListOpen] = useState(false);
  const [operatorHoursOpen, setOperatorHoursOpen] = useState(false);
  // Tier 4 (Calendar sync — PR 1). Auto-open the sheet + toast when
  // the user lands back here from Google's OAuth redirect. The
  // server-side callback redirects to /settings?calendar_connected=1
  // on success or ?calendar_error=<reason> when Google rejects /
  // user declines (PR 320 review — Gemini).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const isConnected = params.get('calendar_connected') === '1';
    const connectionError = params.get('calendar_error');
    // Tier 4 (Payment methods — PR 1). Operator returns from Stripe
    // Connect onboarding to /settings?stripe_connect=1. Auto-open
    // the sheet so they see the freshly-mirrored status.
    const stripeReturned = params.get('stripe_connect') === '1';
    const quickbooksConnected = params.get('quickbooks_connected') === '1';
    const quickbooksError = params.get('quickbooks_error');

    let needsUrlUpdate = false;
    if (isConnected || connectionError) {
      setCalendarSyncOpen(true);
      if (connectionError) {
        toast.error(`Calendar connection failed: ${connectionError}`);
      }
      needsUrlUpdate = true;
    }
    if (stripeReturned) {
      setPaymentMethodsOpen(true);
      needsUrlUpdate = true;
    }
    if (quickbooksConnected || quickbooksError) {
      setQbOpen(true);
      if (quickbooksConnected) {
        toast.success('QuickBooks connected');
        void refreshQuickBooksIntegration();
      } else if (quickbooksError) {
        toast.error(`QuickBooks connection failed: ${quickbooksError}`);
      }
      needsUrlUpdate = true;
    }
    if (needsUrlUpdate) {
      // Strip the params so a refresh doesn't re-open / re-toast.
      params.delete('calendar_connected');
      params.delete('calendar_error');
      params.delete('stripe_connect');
      params.delete('quickbooks_connected');
      params.delete('quickbooks_error');
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`;
      window.history.replaceState(null, '', next);
    }
  }, []);
  const [copied, setCopied]         = useState(false);
  const [bookingCopied, setBookingCopied] = useState(false);
  const [googleReviewUrl, setGoogleReviewUrl] = useState('');
  const [yelpReviewUrl, setYelpReviewUrl]     = useState('');
  const [savingReviews, setSavingReviews]     = useState(false);
  const [reviewsSaved, setReviewsSaved]       = useState(false);
  const [reviewsError, setReviewsError]       = useState('');

  /**
   * Tier 4 (Subscription — Rivet billing). POST /api/billing/portal-session
   * and redirect the operator to the Stripe-hosted portal where they can
   * manage card, plan, view invoices, etc. Returns to /settings on close.
   */
  async function openBillingPortal() {
    try {
      const returnUrl = `${window.location.origin}/settings`;
      const res = await apiFetch('/api/billing/portal-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnUrl }),
      });
      if (res.status === 503) {
        toast.error('Subscription billing is not configured for this tenant');
        return;
      }
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = typeof body?.message === 'string' ? body.message : '';
        } catch {
          /* non-JSON */
        }
        throw new Error(detail || `Portal failed (${res.status})`);
      }
      const data = (await res.json()) as { url: string };
      window.location.assign(data.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not open billing portal';
      toast.error(msg);
    }
  }

  async function saveReviewUrls() {
    setSavingReviews(true);
    setReviewsError('');
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ googleReviewUrl, yelpReviewUrl }),
      });
      if (!res.ok) {
        setReviewsError('Could not save. Please try again.');
        return;
      }
      setReviewsSaved(true);
      setTimeout(() => setReviewsSaved(false), 2000);
    } catch {
      setReviewsError('Network error. Please try again.');
    } finally {
      setSavingReviews(false);
    }
  }

  const intakePath = useMemo(() => {
    if (!me?.tenant_id) return null;
    return `/intake?t=${me.tenant_id}`;
  }, [me?.tenant_id]);

  const intakeUrlDisplay = useMemo(() => {
    if (!intakePath) return 'Sign in to generate your intake link';
    if (typeof window === 'undefined') return intakePath;
    return `${window.location.host}${intakePath}`;
  }, [intakePath]);

  const intakeUrlAbsolute = useMemo(() => {
    if (!intakePath) return '';
    if (typeof window === 'undefined') return intakePath;
    return `${window.location.origin}${intakePath}`;
  }, [intakePath]);

  function copyIntakeUrl() {
    if (!intakeUrlAbsolute) return;
    navigator.clipboard.writeText(intakeUrlAbsolute).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const bookingPath = useMemo(() => {
    if (!me?.tenant_id) return null;
    return `/book?t=${me.tenant_id}`;
  }, [me?.tenant_id]);

  const bookingUrlDisplay = useMemo(() => {
    if (!bookingPath) return 'Sign in to generate your booking link';
    if (typeof window === 'undefined') return bookingPath;
    return `${window.location.host}${bookingPath}`;
  }, [bookingPath]);

  const bookingUrlAbsolute = useMemo(() => {
    if (!bookingPath) return '';
    if (typeof window === 'undefined') return bookingPath;
    return `${window.location.origin}${bookingPath}`;
  }, [bookingPath]);

  function copyBookingUrl() {
    if (!bookingUrlAbsolute) return;
    navigator.clipboard.writeText(bookingUrlAbsolute).catch(() => {});
    setBookingCopied(true);
    setTimeout(() => setBookingCopied(false), 2000);
  }

  const SECTIONS = [
    {
      title: 'Business',
      items: [
        { icon: Building2, label: 'Business profile',    description: 'Name, phone, email, timezone',                   action: () => setBusinessProfileOpen(true) },
        { icon: Phone,     label: 'On-call phone',       description: 'The number escalations ring when you are on call',     action: () => setTechnicianPhoneOpen(true) },
        { icon: Globe,     label: 'Language & region',   description: 'English / Español · Voice + customer messages', action: () => navigate('/settings/language') },
        { icon: FileText,  label: 'Terminology',         description: 'Customize labels (e.g. "Quote" vs "Estimate")',    action: () => setTerminologyOpen(true) },
        { icon: Users,     label: 'Customer groups',     description: 'Named segments you can target with campaigns',     action: () => setCustomerGroupsOpen(true) },
        { icon: BookOpen,  label: 'Price book',          description: 'Services, parts & materials with set prices',          action: () => navigate('/settings/price-book') },
        { icon: Zap,       label: 'Vertical packs',      description: 'Activate HVAC, Plumbing, or other service verticals',  action: () => setVerticalPacksOpen(true) },
      ],
    },
    {
      title: 'Team',
      items: [
        { icon: Users,  label: 'Team members',        description: 'View the roster and roles', action: () => setTeamMembersOpen(true) },
      ],
    },
    {
      title: 'AI & Automation',
      items: [
        {
          icon: Phone,
          label: 'AI phone answering',
          description:
            voiceAgentLive === null
              ? 'Loading…'
              : voiceAgentLive
                ? 'On — inbound calls use the AI assistant'
                : 'Off — callers hear voicemail until you turn this on',
          action: () => {
            void (async () => {
              if (voiceAgentLive === null) return;
              const path = voiceAgentLive ? '/api/voice/pause' : '/api/voice/go-live';
              const res = await apiFetch(path, { method: 'POST' });
              if (!res.ok) {
                toast.error('Could not update AI phone answering');
                return;
              }
              const body = (await res.json()) as { voiceAgentLive: boolean };
              setVoiceAgentLive(body.voiceAgentLive);
              toast.success(body.voiceAgentLive ? 'AI phone answering is on' : 'AI phone answering is off');
            })();
          },
        },
        { icon: Zap,      label: 'AI approval rules',               description: 'Set what the AI can apply automatically',    action: () => setAiRulesOpen(true) },
        { icon: ScrollText, label: 'Standing instructions',         description: 'Rules the AI follows on every draft ("always add a trip fee")', action: () => setStandingInstructionsOpen(true) },
        // N-011 — gated behind the brand_voice_configurator flag (default off).
        ...(me?.brand_voice_configurator_enabled
          ? [{ icon: MessageSquareQuote, label: 'Brand voice', description: 'How the AI sounds in every customer message — register, sign-off, banned phrases', action: () => setBrandVoiceOpen(true) }]
          : []),
        { icon: FileText, label: 'Estimate & invoice templates',    description: 'Default line items, terms, expiry',           action: () => navigate('/settings/templates') },
        { icon: ClipboardList, label: 'Forms & checklists',         description: 'Reusable job forms your team fills out on site', action: () => setJobFormsOpen(true) },
        { icon: SlidersHorizontal, label: 'Job custom fields',      description: 'Extra fields on every job (PO #, permit #, gate code)', action: () => setJobCustomFieldsOpen(true) },
        { icon: Clock,    label: 'Operator hours',                  description: 'Business hours for after-hours call routing', action: () => setOperatorHoursOpen(true) },
        { icon: Zap,      label: 'Call routing & handoff',          description: 'Channels, triggers, and after-hours behavior', action: () => setCallRoutingOpen(true) },
        { icon: Zap,      label: 'Do-Not-Call list',                description: 'Numbers blocked from outbound calls (TCPA / DNC)', action: () => setDncListOpen(true) },
      ],
    },
    {
      title: 'Customer experience',
      items: [
        { icon: Star, label: 'Feedback & reviews', description: 'Average rating, distribution, and recent comments', action: () => navigate('/settings/feedback') },
        { icon: Megaphone, label: 'Email campaigns', description: 'Send promos & announcements to customer segments', action: () => setMarketingOpen(true) },
      ],
    },
    {
      title: 'Payments & billing',
      items: [
        { icon: CreditCard, label: 'Payment methods',        description: 'Connect Stripe to accept card + ACH', action: () => setPaymentMethodsOpen(true) },
        { icon: FileText,   label: 'Deposit rules',          description: 'Require deposit on estimates over $X', action: () => setDepositRulesOpen(true) },
        { icon: FileText,   label: 'Discount policy',        description: 'Bounds for AI-proposed discounts', action: () => setDiscountPolicyOpen(true) },
        { icon: CreditCard, label: 'Rivet subscription',   description: 'Manage card, plan, invoices', action: () => openBillingPortal() },
      ],
    },
    {
      title: 'Integrations',
      items: [
        {
          icon: Link,
          label: 'Calendar sync',
          description: 'Connect Google Calendar to your account',
          action: () => setCalendarSyncOpen(true),
        },
        {
          icon: Link,
          label: 'QuickBooks',
          description: qbConnected
            ? `Connected · QBO company ${qbIntegration?.realmId ?? ''}`
            : 'Not connected · sync invoices & payments',
          badge: qbConnected
            ? { label: 'Connected', color: 'bg-green-100 text-green-700' }
            : { label: 'Connect', color: 'bg-blue-100 text-blue-700' },
          action: () => setQbOpen(true),
        },
      ],
    },
  ];

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-0" style={{ scrollbarWidth: 'thin' }}>
      <div className="p-4 md:p-6 max-w-2xl mx-auto">
        <h1 className="text-slate-900 mb-6">Settings</h1>

        {settingsLoadError && (
          <div
            data-testid="settings-load-error"
            role="alert"
            className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3.5"
          >
            <p className="text-sm text-red-700">
              We couldn’t load your settings. Your current preferences may not be shown.
            </p>
            <button
              type="button"
              onClick={() => setSettingsReloadNonce((n) => n + 1)}
              data-testid="settings-load-retry"
              className="shrink-0 rounded-lg bg-red-600 px-3 py-2 text-sm text-white hover:bg-red-700"
            >
              Retry
            </button>
          </div>
        )}

        {/* Onboarding re-run banner */}
        <button
          onClick={() => navigate('/onboarding')}
          className="w-full flex items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3.5 mb-5 text-left hover:bg-indigo-100 transition-colors group"
        >
          <div className="flex size-9 items-center justify-center rounded-xl bg-indigo-600 shrink-0">
            <Sparkles size={16} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-indigo-800">Re-run setup assistant</p>
            <p className="text-xs text-indigo-500 mt-0.5">Review your terminology, automations, and preferences</p>
          </div>
          <ChevronRight size={14} className="text-indigo-400 group-hover:text-indigo-600 transition-colors shrink-0" />
        </button>

        {/* ── Templates & Customization — hero entry point ── */}
        <button
          onClick={() => navigate('/settings/templates')}
          className="w-full rounded-2xl border border-slate-200 bg-white overflow-hidden hover:border-slate-300 hover:shadow-sm transition-all mb-5 text-left group"
        >
          {/* Top gradient bar */}
          <div className="h-1.5 w-full bg-gradient-to-r from-indigo-400 via-blue-500 to-violet-400" />
          <div className="px-5 py-4">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="flex items-center gap-2.5">
                <span className="flex size-9 items-center justify-center rounded-xl bg-slate-900 shrink-0">
                  <RefreshCw size={15} className="text-white" />
                </span>
                <div>
                  <p className="text-sm text-slate-900">Templates &amp; Customization</p>
                  <p className="text-xs text-slate-400 mt-0.5">Your Rivet learns and adapts over time</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="flex size-2 rounded-full bg-blue-500 animate-pulse" />
                <span className="text-xs text-blue-600">4 suggestions</span>
              </div>
            </div>

            {/* Mini loop visualization */}
            <div className="flex items-center gap-1 overflow-hidden text-xs text-slate-400">
              {[
                { icon: Sparkles,   label: 'Onboarding seeds' },
                { icon: TrendingUp, label: 'Usage watched'     },
                { icon: Zap,        label: 'AI refines'        },
                { icon: Check,      label: 'You approve'       },
                { icon: RefreshCw,  label: 'Repeats'           },
              ].map(({ icon: Icon, label }, i) => (
                <div key={label} className="flex items-center gap-1 shrink-0">
                  <div className="flex items-center gap-1 bg-slate-50 rounded-lg px-2 py-1">
                    <Icon size={10} className="text-slate-500" />
                    <span style={{ fontSize: 10 }}>{label}</span>
                  </div>
                  {i < 4 && <span className="text-slate-300">›</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-5 py-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                <Mail size={11} className="text-violet-500" />
                <p className="text-xs text-slate-500">Weekly digest: <span className="text-slate-700">On · Monday</span></p>
              </div>
              <div className="flex items-center gap-1.5">
                <Globe size={11} className="text-amber-500" />
                <p className="text-xs text-slate-500">Community tips: <span className="text-slate-700">On</span></p>
              </div>
            </div>
            <ChevronRight size={13} className="text-slate-300 group-hover:text-slate-500 transition-colors" />
          </div>
        </button>

        {/* Business card */}
        <div className="rounded-2xl bg-slate-900 text-white px-5 py-5 mb-6 flex items-center gap-4">
          <span className="flex size-12 items-center justify-center rounded-xl bg-white/10 text-lg font-medium shrink-0">
            {businessInitial(businessName)}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-white">{businessName ?? 'Your business'}</p>
            <p className="text-xs text-slate-400 mt-0.5">
              {me?.role ? me.role.charAt(0).toUpperCase() + me.role.slice(1) : 'Owner'}
            </p>
          </div>
          <button
            onClick={() => setBusinessProfileOpen(true)}
            className="text-xs text-slate-400 hover:text-white transition-colors shrink-0"
          >
            Edit
          </button>
        </div>

        {/* Customer Intake Form — featured card */}
        <div className="rounded-xl bg-white border border-slate-200 overflow-hidden mb-5">
          <div className="flex items-center gap-3 px-4 py-3.5 border-b border-slate-100">
            <span className="flex size-7 items-center justify-center rounded-lg bg-blue-100 shrink-0">
              <FileText size={14} className="text-blue-600" />
            </span>
            <div className="flex-1">
              <p className="text-sm text-slate-800">Customer intake form</p>
              <p className="text-xs text-slate-400 mt-0.5">Share this link so customers can request service</p>
            </div>
            <button
              onClick={() => intakePath && navigate(intakePath)}
              disabled={!intakePath}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 transition-colors shrink-0 disabled:opacity-40"
            >
              <ExternalLink size={11} /> Preview
            </button>
          </div>
          <div className="px-4 py-3 bg-slate-50 flex items-center gap-3">
            <p className="flex-1 text-xs text-slate-500 truncate font-mono">{intakeUrlDisplay}</p>
            <button
              onClick={copyIntakeUrl}
              disabled={!intakeUrlAbsolute}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-all shrink-0 ${
                copied
                  ? 'bg-green-100 text-green-700'
                  : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'
              }`}
            >
              {copied ? <><Check size={11} /> Copied!</> : <><Copy size={11} /> Copy link</>}
            </button>
          </div>
          <div className="px-4 py-3 border-t border-slate-100">
            <p className="text-xs text-slate-400">
              New leads from this form appear in your <button onClick={() => navigate('/leads')} className="text-blue-600 hover:underline">Lead Pipeline</button> automatically.
            </p>
          </div>
        </div>

        {/* Online Booking — featured card */}
        <div className="rounded-xl bg-white border border-slate-200 overflow-hidden mb-5">
          <div className="flex items-center gap-3 px-4 py-3.5 border-b border-slate-100">
            <span className="flex size-7 items-center justify-center rounded-lg bg-blue-100 shrink-0">
              <Calendar size={14} className="text-blue-600" />
            </span>
            <div className="flex-1">
              <p className="text-sm text-slate-800">Online booking link</p>
              <p className="text-xs text-slate-400 mt-0.5">Let customers self-schedule a real time slot — paste into Google Business or your site</p>
            </div>
            <button
              onClick={() => bookingPath && navigate(bookingPath)}
              disabled={!bookingPath}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 transition-colors shrink-0 disabled:opacity-40"
            >
              <ExternalLink size={11} /> Preview
            </button>
          </div>
          <div className="px-4 py-3 bg-slate-50 flex items-center gap-3">
            <p className="flex-1 text-xs text-slate-500 truncate font-mono">{bookingUrlDisplay}</p>
            <button
              onClick={copyBookingUrl}
              disabled={!bookingUrlAbsolute}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-all shrink-0 ${
                bookingCopied
                  ? 'bg-green-100 text-green-700'
                  : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'
              }`}
            >
              {bookingCopied ? <><Check size={11} /> Copied!</> : <><Copy size={11} /> Copy link</>}
            </button>
          </div>
          <div className="px-4 py-3 border-t border-slate-100">
            <p className="text-xs text-slate-400">
              Bookings arrive as a held appointment plus an approval in your <button onClick={() => navigate('/assistant')} className="text-blue-600 hover:underline">approval queue</button> — nothing is confirmed without you.
            </p>
          </div>
        </div>

        {/* Quick toggles */}
        <div className="rounded-xl bg-white border border-slate-200 divide-y divide-slate-100 mb-5">
          <div className="px-4 py-3">
            <p className="text-xs text-slate-400">Quick settings</p>
          </div>
          {[
            {
              label: 'AI auto-apply for internal updates',
              description: 'Let the assistant apply safe internal changes without asking',
              value: aiAuto, onChange: toggleAiAuto,
            },
            {
              label: 'Auto send appointment reminders',
              description: 'Text customers 2 hours before scheduled jobs',
              value: reminders, onChange: toggleReminders,
            },
            {
              label: 'Spanish language mode',
              description: 'Customer messages & AI phone calls in Español',
              value: spanishMode, onChange: toggleSpanishMode,
            },
          ].map(({ label, description, value, onChange }) => (
            <div key={label} className="flex items-start justify-between gap-3 px-4 py-3.5">
              <div>
                <p className="text-sm text-slate-800">{label}</p>
                <p className="text-xs text-slate-400 mt-0.5">{description}</p>
              </div>
              <button
                onClick={() => onChange(!value)}
                className={`relative shrink-0 mt-0.5 inline-flex h-5 w-9 items-center rounded-full transition-colors ${value ? 'bg-blue-600' : 'bg-slate-200'}`}
              >
                <span className={`inline-block size-4 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </button>
            </div>
          ))}
        </div>

        {/* Reviews section */}
        <div className="mb-4">
          <p className="text-xs text-slate-400 mb-2 px-1">REVIEWS</p>
          <div className="rounded-xl bg-white border border-slate-200 px-4 py-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="flex size-7 items-center justify-center rounded-lg bg-amber-100">
                <Star size={14} className="text-amber-600" />
              </span>
              <div>
                <p className="text-sm text-slate-800">Public review links</p>
                <p className="text-xs text-slate-400 mt-0.5">Shown to happy customers after they leave feedback</p>
              </div>
            </div>

            <label htmlFor="google-review-url" className="block mt-3">
              <span className="text-sm text-slate-700">Google Review URL</span>
              <input
                id="google-review-url"
                type="url"
                value={googleReviewUrl}
                onChange={e => setGoogleReviewUrl(e.target.value)}
                placeholder="https://g.page/r/..."
                className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
              />
              <span className="block text-xs text-slate-400 mt-1">
                Customers with a 4+ rating will see a button linking here.
              </span>
            </label>

            <label htmlFor="yelp-review-url" className="block mt-4">
              <span className="text-sm text-slate-700">Yelp Review URL</span>
              <input
                id="yelp-review-url"
                type="url"
                value={yelpReviewUrl}
                onChange={e => setYelpReviewUrl(e.target.value)}
                placeholder="https://www.yelp.com/biz/..."
                className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
              />
              <span className="block text-xs text-slate-400 mt-1">
                Customers with a 4+ rating will see a button linking here.
              </span>
            </label>

            {reviewsError && (
              <p className="mt-3 text-sm text-red-600">{reviewsError}</p>
            )}

            <div className="mt-4 flex items-center justify-end gap-2">
              {reviewsSaved && (
                <span className="flex items-center gap-1 text-xs text-green-700 bg-green-100 rounded-full px-2 py-0.5">
                  <Check size={11} /> Saved
                </span>
              )}
              <button
                type="button"
                onClick={saveReviewUrls}
                disabled={savingReviews}
                className="rounded-xl bg-slate-900 text-white text-sm px-4 py-2 hover:bg-slate-700 active:scale-[0.98] transition disabled:opacity-50"
              >
                {savingReviews ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>

        {/* Settings sections */}
        {SECTIONS.map(section => (
          <div key={section.title} className="mb-4">
            <p className="text-xs text-slate-400 mb-2 px-1">{section.title.toUpperCase()}</p>
            <div className="rounded-xl bg-white border border-slate-200 divide-y divide-slate-100 overflow-hidden">
              {section.items.map(({ icon: Icon, label, description, action, badge }: any) => (
                <button
                  key={label}
                  onClick={action}
                  className="flex items-center gap-3 w-full px-4 py-3.5 text-left hover:bg-slate-50 transition-colors"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-slate-100">
                    <Icon size={14} className="text-slate-500" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-800">{label}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{description}</p>
                  </div>
                  {badge && (
                    <span className={`shrink-0 text-xs rounded-full px-2 py-0.5 ${badge.color}`}>{badge.label}</span>
                  )}
                  <ChevronRight size={14} className="shrink-0 text-slate-300" />
                </button>
              ))}
            </div>
          </div>
        ))}

        {/* Resources section — gives SuppliersSheet its user story */}
        <div className="mb-4">
          <p className="text-xs text-slate-400 mb-2 px-1">RESOURCES</p>
          <div className="rounded-xl bg-white border border-slate-200 divide-y divide-slate-100 overflow-hidden">
            <button
              onClick={() => setSuppliersOpen(true)}
              className="flex items-center gap-3 w-full px-4 py-3.5 text-left hover:bg-slate-50 transition-colors"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-100">
                <Store size={14} className="text-amber-600" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-800">Local suppliers</p>
                <p className="text-xs text-slate-400 mt-0.5">Nearby hardware stores & HVAC/plumbing wholesalers</p>
              </div>
              <ChevronRight size={14} className="shrink-0 text-slate-300" />
            </button>
            <button
              className="flex items-center gap-3 w-full px-4 py-3.5 text-left hover:bg-slate-50 transition-colors"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-slate-100">
                <MapPin size={14} className="text-slate-500" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-800">Service area</p>
                <p className="text-xs text-slate-400 mt-0.5">Austin & surrounding areas · ~30 mi radius</p>
              </div>
              <ChevronRight size={14} className="shrink-0 text-slate-300" />
            </button>
          </div>
          <p className="text-xs text-slate-400 mt-2 px-1">
            Suppliers shown in the <span className="text-slate-600">Materials &amp; Parts</span> section on every job — techs can find parts nearby with one tap.
          </p>
        </div>

        {/* Sign out */}
        <div className="mt-4 flex flex-col gap-2">
          <button
            onClick={() => signOut({ redirectUrl: '/login' })}
            className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 hover:bg-slate-50 transition-colors text-left"
          >
            Sign out
          </button>
          <p className="text-center text-xs text-slate-400">Rivet v1.0 · © 2026</p>
        </div>
      </div>

      {qbOpen && (
        <QuickBooksIntegrationSheet
          onClose={() => setQbOpen(false)}
          onConnectionChange={() => void refreshQuickBooksIntegration()}
        />
      )}

      {/* P12-005-fe — Supervisor backup + unsupervised routing.
          Owner-only; the backend PUT /api/settings already enforces
          the same rule via the existing settings:update permission,
          so this gate is a UX nicety. Mounted only when role==='owner'
          to avoid rendering disabled UI for dispatchers/techs. */}
      {me?.role === 'owner' && (
        <div className="px-4 md:px-6 pb-6">
          <SupervisorBackupSection
            initialBackupUserId={me.backup_supervisor_user_id ?? null}
            initialRouting={me.unsupervised_proposal_routing}
          />
        </div>
      )}

      {/* Suppliers sheet */}
      {suppliersOpen && (
        <SuppliersSheet serviceType="HVAC" onClose={() => setSuppliersOpen(false)} />
      )}

      {/* Business profile sheet — closes the first of the 13 settings stubs. */}
      {businessProfileOpen && (
        <BusinessProfileSheet
          onClose={() => setBusinessProfileOpen(false)}
          onSaved={(fields) => setBusinessName(fields.businessName)}
        />
      )}

      {/* On-call phone — the technician's own escalation number (users.mobile_number). */}
      {technicianPhoneOpen && (
        <TechnicianPhoneSheet onClose={() => setTechnicianPhoneOpen(false)} />
      )}

      {/* Terminology sheet — entity-label overrides (Quote vs Estimate, etc.) */}
      {jobFormsOpen && (
        <JobFormTemplatesSheet onClose={() => setJobFormsOpen(false)} />
      )}
      {jobCustomFieldsOpen && (
        <JobCustomFieldsSheet onClose={() => setJobCustomFieldsOpen(false)} />
      )}
      {marketingOpen && (
        <MarketingCampaignsSheet onClose={() => setMarketingOpen(false)} />
      )}
      {customerGroupsOpen && (
        <CustomerGroupsSheet onClose={() => setCustomerGroupsOpen(false)} />
      )}
      {brandVoiceOpen && me?.brand_voice_configurator_enabled && (
        <BrandVoiceSheet onClose={() => setBrandVoiceOpen(false)} />
      )}
      {standingInstructionsOpen && (
        <StandingInstructionsSheet onClose={() => setStandingInstructionsOpen(false)} />
      )}
      {terminologyOpen && (
        <TerminologySheet onClose={() => setTerminologyOpen(false)} />
      )}

      {/* AI approval rules sheet — per-mode auto-approve threshold overrides. */}
      {aiRulesOpen && (
        <AIApprovalRulesSheet onClose={() => setAiRulesOpen(false)} />
      )}

      {/* Discount policy sheet — AI auto-propose cap + floor + catalog grounding. */}
      {discountPolicyOpen && (
        <DiscountPolicySheet onClose={() => setDiscountPolicyOpen(false)} />
      )}

      {/* Deposit rules sheet — strategy + amount + optional threshold. */}
      {depositRulesOpen && (
        <DepositRulesSheet onClose={() => setDepositRulesOpen(false)} />
      )}

      {/* Team members sheet — roster + role editing (PR 1 + PR 2).
          Owner-only edit affordances; backend re-enforces via
          users:edit_role. */}
      {teamMembersOpen && (
        <TeamMembersSheet
          onClose={() => setTeamMembersOpen(false)}
          canEditRoles={me?.role === 'owner'}
        />
      )}

      {/* Calendar sync sheet — Google OAuth connect/disconnect (PR 1). */}
      {calendarSyncOpen && (
        <CalendarSyncSheet onClose={() => setCalendarSyncOpen(false)} />
      )}

      {/* Payment methods sheet — Stripe Connect onboarding (PR 1). */}
      {paymentMethodsOpen && (
        <PaymentMethodsSheet onClose={() => setPaymentMethodsOpen(false)} />
      )}

      {/* Vertical packs sheet — activate HVAC / Plumbing / other service verticals. */}
      {verticalPacksOpen && (
        <VerticalPacksSheet onClose={() => setVerticalPacksOpen(false)} />
      )}

      {/* Call routing & handoff sheet — channels, triggers, AI sentiment gate. */}
      <CallRoutingSheet
        open={callRoutingOpen}
        onOpenChange={setCallRoutingOpen}
      />
      <OperatorHoursSheet
        open={operatorHoursOpen}
        onOpenChange={setOperatorHoursOpen}
      />
      <DncListSheet
        open={dncListOpen}
        onOpenChange={setDncListOpen}
      />
    </div>
  );
}
