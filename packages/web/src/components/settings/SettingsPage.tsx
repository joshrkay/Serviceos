import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useClerk } from '@clerk/clerk-react';
import type { LucideIcon } from 'lucide-react';
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
import { GoogleBusinessSheet } from './GoogleBusinessSheet';
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
import {
  isCustomerMissing,
  parsePortalFailure,
  type BillingPortalFailure,
} from '../../utils/billing-error';
import { ONBOARDING_RERUN_PATH } from '../../utils/onboarding-rerun';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { ServiceAreaSheet, type ServiceAreaFields } from './ServiceAreaSheet';

type SettingsRowBadge = { label: string; color: string };

interface SettingsRowBase {
  icon: LucideIcon;
  label: string;
  description: string;
  badge?: SettingsRowBadge;
}

/**
 * Discriminated row shape (#877) so rows that fire live actions are
 * structurally — and therefore visually — distinct from rows that open
 * an in-app panel:
 * - `panel` (default): opens a sheet/page here — chevron affordance.
 * - `external`: hands the operator off to another site — external-link
 *   icon, gated behind a ConfirmDialog before anything fires.
 * - `toggle`: flips live state — rendered as an explicit switch
 *   (`role="switch"`), gated behind a ConfirmDialog; a plain click on
 *   the row body never fires the action.
 */
type SettingsRow =
  | (SettingsRowBase & { kind?: 'panel'; action: () => void })
  | (SettingsRowBase & { kind: 'external'; action: () => void })
  | (SettingsRowBase & { kind: 'toggle'; checked: boolean | null; onToggle: () => void });

interface SettingsSection {
  title: string;
  items: SettingsRow[];
}

/**
 * #1011 — Quick-settings switches that persist through `PUT /api/settings`.
 * Keyed by the local state name, valued by the API field, so the persist
 * helper builds `{ [field]: value }` from one table instead of a ternary that
 * has to grow a branch per toggle.
 */
const SETTINGS_TOGGLE_FIELDS = {
  aiAuto: 'autoApplyInternalUpdates',
  reminders: 'autoSendAppointmentReminders',
  // 9.6 — the daily digest switch (added by #1010), folded into the same table.
  digestEnabled: 'digestEnabled',
  thankYouSms: 'sendThankYouSms',
  reviewRequest: 'sendReviewRequest',
  weeklyFeedback: 'weeklyFeedbackEnabled',
  autonomousClose: 'autonomousCloseEnabled',
} as const;

type SettingsToggleField = keyof typeof SETTINGS_TOGGLE_FIELDS;

/** Integer cents → the dollars string the cap input edits. null renders empty. */
function centsToDollarInput(cents: number | null): string {
  if (cents === null) return '';
  return String(cents / 100);
}

/**
 * #1011 — the two per-tenant capabilities an owner may switch (rows 2.6, 2.7).
 * Deliberately a closed list mirroring the API's `z.enum` allowlist: the write
 * route refuses anything else, so an extra entry here would render a switch
 * that can only ever 400.
 */
const OWNER_CAPABILITIES = [
  {
    key: 'dropped_call_recovery',
    label: 'Text back callers who hang up',
    description:
      'If someone calls and hangs up before they reach anyone, send them a text so the lead is not lost.',
  },
  {
    key: 'voice_vulnerability_triage',
    label: 'Extra care for callers in distress',
    description:
      'Watch each call for signs a caller is distressed or at risk, and hand the call to a person sooner.',
  },
] as const;

type OwnerCapabilityKey = (typeof OWNER_CAPABILITIES)[number]['key'];

/** Mirrors the API response: the resolved value, who decided it, and whether it is ours to change. */
interface CapabilityState {
  enabled: boolean;
  source: 'tenant' | 'platform' | 'default';
  /**
   * The server's own answer to "would a PUT be refused?" — true only for a
   * platform row that is explicitly OFF. Do NOT re-derive this from `source`:
   * a platform row that is ON is a RAMP, not a freeze, and the owner may still
   * turn the capability off. `source === 'platform'` was the first predicate
   * here and it disabled the switch on a ramped-ON capability while claiming it
   * was turned off platform-wide.
   */
  platformFrozen?: boolean;
}

export function SettingsPage() {
  const navigate = useNavigate();
  const { signOut } = useClerk();
  const { me } = useMe();
  // Quick toggles: load from backend on mount, persist on
  // toggle. aiAuto + reminders live on /api/settings (migration 075).
  // spanishMode derives from /api/settings/language (P11-002).
  const [aiAuto, setAiAuto]         = useState(false);
  const [reminders, setReminders]   = useState(true);
  // 9.6 — digestEnabled/digestTime/digestChannel are already accepted by
  // PUT /api/settings and mapped by PgSettingsRepository (RV-063); the gap
  // was purely "no client control" (map #995 correction). Toggle-only for
  // now — this page has no existing time/channel picker pattern to mirror,
  // so digestTime/digestChannel stay server defaults until one exists.
  const [digestEnabled, setDigestEnabledState] = useState(false);
  // 8.3/8.11 — revenue-cluster settings: already accepted by PUT
  // /api/settings and referenced by zero UI (map #995 correction). Pure UI
  // over an already-accepted contract — the diff below is toggles + tests
  // only, no change to what any of these four flags DO.
  const [autoInvoiceOnCompletion, setAutoInvoiceOnCompletionState] = useState(false);
  const [billLaborFromTimeEntries, setBillLaborFromTimeEntriesState] = useState(false);
  const [batchInvoiceEnabled, setBatchInvoiceEnabledState] = useState(false);
  const [milestoneBillingEnabled, setMilestoneBillingEnabledState] = useState(false);
  const [spanishMode, setSpanishMode] = useState(false);
  // #1011 — five settings that `updateSettingsSchema` used to STRIP, so a
  // PUT returned 200 and changed nothing. They had no control on any surface;
  // these are it. Initial values mirror the column defaults so the switch is
  // not lying about live state during the first paint (send_thank_you_sms and
  // send_review_request are NOT NULL DEFAULT TRUE; weekly_feedback_enabled is
  // opt-OUT; autonomous_close_enabled defaults FALSE).
  const [thankYouSms, setThankYouSms] = useState(true);
  const [reviewRequest, setReviewRequest] = useState(true);
  const [weeklyFeedback, setWeeklyFeedback] = useState(true);
  const [autonomousClose, setAutonomousClose] = useState(false);
  // The cap is money: held as integer CENTS (the repo invariant) and edited as
  // a dollars string so a half-typed value never round-trips through a float.
  const [closeCapCents, setCloseCapCents] = useState<number | null>(null);
  const [closeCapInput, setCloseCapInput] = useState('');
  const [businessName, setBusinessName] = useState<string | null>(null);
  // #874 — live service-area data for the RESOURCES row (null until the
  // settings document loads; the subtitle must never show made-up data).
  const [serviceArea, setServiceArea] = useState<ServiceAreaFields | null>(null);
  const [voiceAgentLive, setVoiceAgentLive] = useState<boolean | null>(null);
  // #877 — live actions are confirm-gated: which voice transition is
  // awaiting confirmation (null = no dialog), and in-flight markers so
  // the dialogs can't be double-submitted or dismissed mid-request.
  const [confirmVoiceAction, setConfirmVoiceAction] = useState<'pause' | 'go-live' | null>(null);
  const [voicePending, setVoicePending] = useState(false);
  const [confirmPortalOpen, setConfirmPortalOpen] = useState(false);
  const [portalPending, setPortalPending] = useState(false);
  // #873 — a failed portal-session POST renders a persistent, actionable
  // alert (the server's reason, e.g. "saved Stripe customer no longer
  // exists — contact support to re-link billing"), not a transient toast.
  const [billingPortalError, setBillingPortalError] = useState<BillingPortalFailure | null>(null);
  // Surface a failure to load the main /api/settings document instead of
  // silently swallowing it (which left the page showing stale defaults with
  // no signal that the user's real preferences never loaded).
  const [settingsLoadError, setSettingsLoadError] = useState(false);
  const [settingsReloadNonce, setSettingsReloadNonce] = useState(0);
  // #1011 — per-tenant capabilities (rows 2.6 / 2.7). `null` means the API said
  // they are unconfigured (503, the in-memory boot) — the block is then hidden
  // entirely rather than rendering switches that cannot persist.
  const [capabilities, setCapabilities] = useState<Record<string, CapabilityState> | null>(null);

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
          digestEnabled?: boolean;
          autoInvoiceOnCompletion?: boolean;
          billLaborFromTimeEntries?: boolean;
          batchInvoiceEnabled?: boolean;
          milestoneBillingEnabled?: boolean;
          businessName?: string;
          googleReviewUrl?: string | null;
          yelpReviewUrl?: string | null;
          serviceAreaText?: string | null;
          serviceAreaRadius?: number | null;
          serviceAreaZips?: string[] | null;
          sendThankYouSms?: boolean;
          sendReviewRequest?: boolean;
          weeklyFeedbackEnabled?: boolean;
          autonomousCloseEnabled?: boolean;
          autonomousCloseMaxCents?: number | null;
        };
        if (typeof data.autoApplyInternalUpdates === 'boolean') {
          setAiAuto(data.autoApplyInternalUpdates);
        }
        if (typeof data.autoSendAppointmentReminders === 'boolean') {
          setReminders(data.autoSendAppointmentReminders);
        }
        if (typeof data.digestEnabled === 'boolean') {
          setDigestEnabledState(data.digestEnabled);
        }
        if (typeof data.autoInvoiceOnCompletion === 'boolean') {
          setAutoInvoiceOnCompletionState(data.autoInvoiceOnCompletion);
        }
        if (typeof data.billLaborFromTimeEntries === 'boolean') {
          setBillLaborFromTimeEntriesState(data.billLaborFromTimeEntries);
        }
        if (typeof data.batchInvoiceEnabled === 'boolean') {
          setBatchInvoiceEnabledState(data.batchInvoiceEnabled);
        }
        if (typeof data.milestoneBillingEnabled === 'boolean') {
          setMilestoneBillingEnabledState(data.milestoneBillingEnabled);
        }
        // #1011 — hydrate the five owner toggles.
        if (typeof data.sendThankYouSms === 'boolean') setThankYouSms(data.sendThankYouSms);
        if (typeof data.sendReviewRequest === 'boolean') setReviewRequest(data.sendReviewRequest);
        if (typeof data.weeklyFeedbackEnabled === 'boolean') {
          setWeeklyFeedback(data.weeklyFeedbackEnabled);
        }
        if (typeof data.autonomousCloseEnabled === 'boolean') {
          setAutonomousClose(data.autonomousCloseEnabled);
        }
        if (typeof data.autonomousCloseMaxCents === 'number') {
          setCloseCapCents(data.autonomousCloseMaxCents);
          setCloseCapInput(centsToDollarInput(data.autonomousCloseMaxCents));
        } else if (data.autonomousCloseMaxCents === null) {
          setCloseCapCents(null);
          setCloseCapInput('');
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
        setServiceArea({
          serviceAreaText: data.serviceAreaText ?? '',
          serviceAreaRadius: typeof data.serviceAreaRadius === 'number' ? data.serviceAreaRadius : null,
          serviceAreaZips: data.serviceAreaZips ?? [],
        });
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
    // #1011 — capabilities load independently: a 503 (no database wired) must
    // leave the rest of Settings fully usable.
    (async () => {
      try {
        const res = await apiFetch('/api/settings/capabilities');
        if (cancelled) return;
        if (!res.ok) {
          setCapabilities(null);
          return;
        }
        setCapabilities((await res.json()) as Record<string, CapabilityState>);
      } catch {
        if (!cancelled) setCapabilities(null);
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

  async function persistToggle(field: SettingsToggleField | 'spanishMode', value: boolean) {
    if (field === 'spanishMode') {
      try {
        await updateLanguageSettings({ defaultLanguage: value ? 'es' : 'en' });
      } catch {
        toast.error('Could not save language preference');
        setSpanishMode(!value); // revert
      }
      return;
    }
    const body = { [SETTINGS_TOGGLE_FIELDS[field]]: value };
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
      TOGGLE_SETTERS[field](!value);
    }
  }

  // One setter per toggle so a failed PUT reverts the switch the operator
  // actually flipped (a switch that stays ON after a failed save is the
  // silent-200 defect #1011 exists to remove, moved into the client).
  const TOGGLE_SETTERS: Record<SettingsToggleField, (v: boolean) => void> = {
    aiAuto: setAiAuto,
    reminders: setReminders,
    digestEnabled: setDigestEnabledState,
    thankYouSms: setThankYouSms,
    reviewRequest: setReviewRequest,
    weeklyFeedback: setWeeklyFeedback,
    autonomousClose: setAutonomousClose,
  };

  function toggleSetting(field: SettingsToggleField, value: boolean) {
    TOGGLE_SETTERS[field](value);
    void persistToggle(field, value);
  }
  function toggleAiAuto(value: boolean) {
    toggleSetting('aiAuto', value);
  }
  function toggleReminders(value: boolean) {
    toggleSetting('reminders', value);
  }
  function toggleSpanishMode(value: boolean) {
    setSpanishMode(value);
    void persistToggle('spanishMode', value);
  }
  function toggleDigestEnabled(value: boolean) {
    toggleSetting('digestEnabled', value);
  }

  /**
   * 8.3/8.11 — shared persist path for the four revenue-cluster booleans.
   * Each writes `{ [field]: value }` through the same PUT /api/settings
   * every other quick-toggle uses; `setLocal` flips the optimistic UI state
   * and reverts it on failure, mirroring persistToggle's contract.
   *
   * Kept distinct from `persistToggle` on purpose: these four live in the
   * Payments & billing section and pass their own setter, rather than being
   * keyed off the SETTINGS_TOGGLE_FIELDS table the Quick-settings switches use.
   */
  async function persistBillingToggle(
    field: 'autoInvoiceOnCompletion' | 'billLaborFromTimeEntries' | 'batchInvoiceEnabled' | 'milestoneBillingEnabled',
    value: boolean,
    setLocal: (v: boolean) => void,
  ) {
    setLocal(value);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) throw new Error(`PUT /api/settings ${res.status}`);
    } catch {
      toast.error('Could not save preference');
      setLocal(!value);
    }
  }
  function toggleAutoInvoiceOnCompletion() {
    void persistBillingToggle('autoInvoiceOnCompletion', !autoInvoiceOnCompletion, setAutoInvoiceOnCompletionState);
  }
  function toggleBillLaborFromTimeEntries() {
    void persistBillingToggle('billLaborFromTimeEntries', !billLaborFromTimeEntries, setBillLaborFromTimeEntriesState);
  }
  function toggleBatchInvoiceEnabled() {
    void persistBillingToggle('batchInvoiceEnabled', !batchInvoiceEnabled, setBatchInvoiceEnabledState);
  }
  function toggleMilestoneBillingEnabled() {
    void persistBillingToggle('milestoneBillingEnabled', !milestoneBillingEnabled, setMilestoneBillingEnabledState);
  }

  /**
   * #1011 — commit the close cap. Empty clears it (explicit `null`, which the
   * API maps to a SQL NULL); anything else persists integer CENTS. Sent on its
   * OWN — the server refuses a payload that enables the lane and nulls the cap
   * in the same request, and this field never carries the enabled bit.
   */
  async function commitCloseCap() {
    const raw = closeCapInput.trim();
    let next: number | null;
    if (raw === '') {
      next = null;
    } else {
      const dollars = Number(raw);
      if (!Number.isFinite(dollars) || dollars < 0) {
        toast.error('Enter a dollar amount, or leave it empty for no cap');
        setCloseCapInput(centsToDollarInput(closeCapCents));
        return;
      }
      next = Math.round(dollars * 100);
    }
    if (next === closeCapCents) return;
    const previous = closeCapCents;
    setCloseCapCents(next);
    setCloseCapInput(centsToDollarInput(next));
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autonomousCloseMaxCents: next }),
      });
      if (!res.ok) throw new Error(`PUT /api/settings ${res.status}`);
    } catch {
      toast.error('Could not save preference');
      setCloseCapCents(previous);
      setCloseCapInput(centsToDollarInput(previous));
    }
  }

  /**
   * #1011 — flip one per-tenant capability. Same shape as `persistToggle`:
   * optimistic, reverted with a toast on failure. A platform-frozen capability
   * is never sent — the server answers 409 and the switch is disabled, so this
   * is belt-and-braces against a click landing on a stale render.
   */
  async function toggleCapability(key: OwnerCapabilityKey, value: boolean) {
    const previous = capabilities?.[key];
    if (!previous || previous.platformFrozen === true) return;

    setCapabilities((prev) =>
      prev
        ? { ...prev, [key]: { enabled: value, source: 'tenant', platformFrozen: false } }
        : prev,
    );
    try {
      const res = await apiFetch(`/api/settings/capabilities/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: value }),
      });
      if (!res.ok) throw new Error(`PUT /api/settings/capabilities/${key} ${res.status}`);
      // Trust the server's RESOLVED state over the optimistic one: the write is
      // an override and the value that matters is what the gate will read.
      const resolved = (await res.json()) as {
        enabled?: boolean;
        source?: CapabilityState['source'];
        platformFrozen?: boolean;
      };
      if (typeof resolved.enabled === 'boolean') {
        setCapabilities((prev) =>
          prev
            ? {
                ...prev,
                [key]: {
                  enabled: resolved.enabled!,
                  source: resolved.source ?? 'tenant',
                  platformFrozen: resolved.platformFrozen ?? false,
                },
              }
            : prev,
        );
      }
    } catch {
      toast.error('Could not save preference');
      setCapabilities((prev) => (prev ? { ...prev, [key]: previous } : prev));
    }
  }
  const [qbOpen, setQbOpen] = useState(false);
  const [qbIntegration, setQbIntegration] = useState<AccountingIntegrationSummary | null>(null);
  const qbConnected = qbIntegration?.status === 'active';
  const [suppliersOpen, setSuppliersOpen] = useState(false);
  const [serviceAreaOpen, setServiceAreaOpen] = useState(false);
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
  const [googleBusinessOpen, setGoogleBusinessOpen] = useState(false);
  const [paymentMethodsOpen, setPaymentMethodsOpen] = useState(false);
  const [verticalPacksOpen, setVerticalPacksOpen] = useState(false);
  const [callRoutingOpen, setCallRoutingOpen] = useState(false);
  const [dncListOpen, setDncListOpen] = useState(false);
  const [operatorHoursOpen, setOperatorHoursOpen] = useState(false);
  // Calendar sync OAuth return: auto-open the sheet + toast when
  // the user lands back here from Google's OAuth redirect. The
  // server-side callback redirects to /settings?calendar_connected=1
  // on success or ?calendar_error=<reason> when Google rejects /
  // user declines (PR 320 review — Gemini).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const isConnected = params.get('calendar_connected') === '1';
    const connectionError = params.get('calendar_error');
    // Payment methods OAuth return: operator returns from Stripe
    // Connect onboarding to /settings?stripe_connect=1. Auto-open
    // the sheet so they see the freshly-mirrored status.
    const stripeReturned = params.get('stripe_connect') === '1';
    const quickbooksConnected = params.get('quickbooks_connected') === '1';
    const quickbooksError = params.get('quickbooks_error');
    // Google Business OAuth return (review monitoring): the API callback
    // redirects to /settings?googlebusiness_connected=1 on success or
    // ?googlebusiness_error=<reason> when Google rejects / user declines.
    const googleBusinessConnected = params.get('googlebusiness_connected') === '1';
    const googleBusinessError = params.get('googlebusiness_error');

    let needsUrlUpdate = false;
    if (isConnected || connectionError) {
      setCalendarSyncOpen(true);
      if (connectionError) {
        toast.error(`Calendar connection failed: ${connectionError}`);
      }
      needsUrlUpdate = true;
    }
    if (googleBusinessConnected || googleBusinessError) {
      setGoogleBusinessOpen(true);
      if (googleBusinessConnected) {
        toast.success('Google Business connected');
      } else if (googleBusinessError) {
        toast.error(`Google Business connection failed: ${googleBusinessError}`);
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
      params.delete('googlebusiness_connected');
      params.delete('googlebusiness_error');
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
   * Rivet billing portal — POST /api/billing/portal-session
   * and redirect the operator to the Stripe-hosted portal where they can
   * manage card, plan, view invoices, etc. Returns to /settings on close.
   */
  async function openBillingPortal() {
    setBillingPortalError(null);
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
        // #873 — surface the server's structured reason as a persistent
        // alert instead of discarding it into a transient generic toast.
        setBillingPortalError(await parsePortalFailure(res));
        return;
      }
      const data = (await res.json()) as { url: string };
      window.location.assign(data.url);
    } catch {
      setBillingPortalError({
        message: 'Could not open the billing portal — check your connection and try again.',
      });
    }
  }

  /** Confirmed portal open (#877): runs the portal handoff behind its dialog. */
  async function confirmOpenBillingPortal() {
    setPortalPending(true);
    try {
      await openBillingPortal();
    } finally {
      setPortalPending(false);
      setConfirmPortalOpen(false);
    }
  }

  /**
   * #877 — the switch never fires the POST directly; it only raises the
   * matching ConfirmDialog. The POST happens in performVoiceToggle after
   * an explicit confirm.
   */
  function requestVoiceToggle() {
    if (voiceAgentLive === null || voicePending) return;
    setConfirmVoiceAction(voiceAgentLive ? 'pause' : 'go-live');
  }

  async function performVoiceToggle() {
    const action = confirmVoiceAction;
    if (action === null) return;
    setVoicePending(true);
    try {
      const path = action === 'pause' ? '/api/voice/pause' : '/api/voice/go-live';
      const res = await apiFetch(path, { method: 'POST' });
      if (!res.ok) {
        let code = '';
        try {
          const body = (await res.json()) as { error?: string };
          if (typeof body?.error === 'string') code = body.error;
        } catch {
          /* non-JSON body */
        }
        // /go-live returns 402 BILLING_REQUIRED when the subscription
        // doesn't cover voice — say so instead of a mystery failure.
        if (res.status === 402 || code === 'BILLING_REQUIRED') {
          toast.error(
            'Turning on AI phone answering requires an active subscription — manage your plan under Rivet subscription.',
          );
        } else {
          toast.error('Could not update AI phone answering');
        }
        return;
      }
      const body = (await res.json()) as { voiceAgentLive: boolean };
      setVoiceAgentLive(body.voiceAgentLive);
      toast.success(body.voiceAgentLive ? 'AI phone answering is on' : 'AI phone answering is off');
    } catch {
      toast.error('Could not update AI phone answering');
    } finally {
      setVoicePending(false);
      setConfirmVoiceAction(null);
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

  // #874 — the Service area row subtitle renders live tenant data (the
  // old hardcoded "Austin & surrounding areas" string was never real and
  // is what made a Phoenix tenant's settings claim Austin).
  const serviceAreaSubtitle = (() => {
    if (!serviceArea) return 'Where you work — travel range and ZIP codes';
    const parts: string[] = [];
    if (serviceArea.serviceAreaText) {
      parts.push(serviceArea.serviceAreaText);
      if (serviceArea.serviceAreaRadius) {
        parts.push(`~${serviceArea.serviceAreaRadius} mi radius`);
      }
    }
    if (serviceArea.serviceAreaZips.length > 0) {
      const n = serviceArea.serviceAreaZips.length;
      parts.push(`${n} ZIP ${n === 1 ? 'code' : 'codes'}`);
    }
    return parts.length > 0 ? parts.join(' · ') : 'Not set — add where you work';
  })();

  const SECTIONS: SettingsSection[] = [
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
          kind: 'toggle',
          icon: Phone,
          label: 'AI phone answering',
          description:
            voiceAgentLive === null
              ? 'Loading…'
              : voiceAgentLive
                ? 'Inbound calls are answered by the AI assistant'
                : 'Callers hear voicemail until you turn this on',
          badge:
            voiceAgentLive === null
              ? undefined
              : voiceAgentLive
                ? { label: 'On', color: 'bg-green-100 text-green-700' }
                : { label: 'Off', color: 'bg-slate-100 text-slate-600' },
          checked: voiceAgentLive,
          onToggle: requestVoiceToggle,
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
        // 8.3/8.11 — already-accepted PUT /api/settings booleans, no client
        // control before this. UI + persistence only — none of these four
        // change what the underlying automation does.
        {
          kind: 'toggle',
          icon: FileText,
          label: 'Auto-draft invoice on completion',
          description: 'Draft an invoice for your approval when a job is marked complete',
          checked: autoInvoiceOnCompletion,
          onToggle: toggleAutoInvoiceOnCompletion,
        },
        {
          kind: 'toggle',
          icon: Clock,
          label: 'Bill labor from time entries',
          description: 'Recompute labor cost on auto-drafted invoices from logged time',
          checked: billLaborFromTimeEntries,
          onToggle: toggleBillLaborFromTimeEntries,
        },
        {
          kind: 'toggle',
          icon: FileText,
          label: 'Daily batch invoicing',
          description: 'Include eligible jobs in the daily batch-invoice sweep',
          checked: batchInvoiceEnabled,
          onToggle: toggleBatchInvoiceEnabled,
        },
        {
          kind: 'toggle',
          icon: FileText,
          label: 'Milestone billing',
          description: 'Automatically draft a numbered invoice at each completed billing milestone. No approval step: the plan was approved when the schedule was created.',
          checked: milestoneBillingEnabled,
          onToggle: toggleMilestoneBillingEnabled,
        },
        { kind: 'external', icon: CreditCard, label: 'Rivet subscription',   description: 'Manage card, plan, invoices in the Stripe billing portal', action: () => setConfirmPortalOpen(true) },
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
          icon: Star,
          label: 'Google Business reviews',
          description: 'Monitor reviews & draft replies for your approval',
          action: () => setGoogleBusinessOpen(true),
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

        {/* #873 — billing portal failure: persistent + actionable. When the
            saved Stripe customer is GONE (details.reason from the API), a
            retry can never succeed — render re-link guidance instead of a
            futile "Try again". */}
        {billingPortalError && (
          <div
            data-testid="billing-portal-error"
            role="alert"
            className="mb-5 flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3.5"
          >
            {isCustomerMissing(billingPortalError) ? (
              <div className="text-sm text-red-700" data-testid="billing-portal-relink">
                <p>
                  The saved Stripe billing record for this account no longer exists, so the
                  billing portal can&rsquo;t open. The account owner needs to contact support to
                  re-link billing — retrying won&rsquo;t help until then.
                </p>
                {billingPortalError.stripeCustomerId && (
                  <p className="mt-1 text-xs text-red-600">
                    Stale billing record:{' '}
                    <code className="font-mono" data-testid="billing-portal-stale-id">
                      {billingPortalError.stripeCustomerId}
                    </code>
                  </p>
                )}
              </div>
            ) : (
              <>
                <p className="text-sm text-red-700">{billingPortalError.message}</p>
                <button
                  type="button"
                  onClick={() => void openBillingPortal()}
                  data-testid="billing-portal-retry"
                  className="shrink-0 min-h-11 rounded-lg bg-red-600 px-3 py-2 text-sm text-white hover:bg-red-700"
                >
                  Try again
                </button>
              </>
            )}
          </div>
        )}

        {/* Onboarding re-run banner — the rerun param tells OnboardingShell
            this is an explicit re-run so its completion gate lets it
            through (#875). */}
        <button
          onClick={() => navigate(ONBOARDING_RERUN_PATH)}
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
            {
              label: 'Daily digest',
              description: 'One text at the end of the day summarizing what happened',
              value: digestEnabled, onChange: toggleDigestEnabled,
            },
            // #1011 — the post-job customer SMS pair. Both columns ship ON, and
            // until now a tenant who asked to stop texting their customers got
            // a 200 and kept texting them.
            {
              label: 'Thank-you text after every job',
              description: 'Text the customer a thank-you about 2 hours after the job is marked done',
              value: thankYouSms, onChange: (v: boolean) => toggleSetting('thankYouSms', v),
            },
            {
              label: 'Review request after every job',
              description: 'Ask the customer for a public review a day after the job is marked done',
              value: reviewRequest, onChange: (v: boolean) => toggleSetting('reviewRequest', v),
            },
            {
              label: 'Weekly summary email',
              description: 'A weekly recap of your ratings and customer feedback, emailed to you',
              value: weeklyFeedback, onChange: (v: boolean) => toggleSetting('weeklyFeedback', v),
            },
            // #1011 / D-019 — this column is NOT an autonomous-close switch any
            // more. D-019 revoked system approval outright; all it decides today
            // is whether a phone-confirmed quote is staged as ONE owner-approval
            // chain (booking + estimate together) or as a separate estimate+send
            // chain with the hold released. The copy must therefore describe the
            // approval shape and must never imply anything happens unattended.
            // TODO(#1011 §E.4): final label + column rename are Josh's product
            // call — `autonomous_close_enabled` is now a misnomer for what it does.
            {
              label: 'One approval for phone-quoted work',
              description:
                'When a caller agrees to a quote on the phone, hold the slot and send you a single approval covering the booking and the estimate. Nothing is scheduled or sent until you approve it.',
              value: autonomousClose, onChange: (v: boolean) => toggleSetting('autonomousClose', v),
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
          {/* #1011 — the spend bound on the row above. Money is integer cents
              on the wire; this field edits dollars. Empty means no cap. */}
          <div className="flex items-start justify-between gap-3 px-4 py-3.5">
            <label htmlFor="autonomous-close-cap" className="block">
              <span className="text-sm text-slate-800">Largest quote that can use that single approval</span>
              <span className="block text-xs text-slate-400 mt-0.5">
                Quotes above this still reach you — just as separate approvals. Leave empty for no limit.
              </span>
            </label>
            <div className="flex shrink-0 items-center gap-1">
              <span className="text-sm text-slate-400">$</span>
              <input
                id="autonomous-close-cap"
                data-testid="autonomous-close-cap"
                type="text"
                inputMode="decimal"
                value={closeCapInput}
                onChange={(e) => setCloseCapInput(e.target.value)}
                onBlur={() => void commitCloseCap()}
                placeholder="No limit"
                className="w-28 min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
              />
            </div>
          </div>
        </div>

        {/* #1011 — per-tenant capabilities (rows 2.6 / 2.7). Hidden entirely
            when the API reports them unconfigured: a switch that cannot
            persist is worse than no switch. */}
        {capabilities && (
          <div className="rounded-xl bg-white border border-slate-200 divide-y divide-slate-100 mb-5">
            <div className="px-4 py-3">
              <p className="text-xs text-slate-400">Capabilities</p>
            </div>
            {OWNER_CAPABILITIES.map(({ key, label, description }) => {
              const state = capabilities[key] ?? {
                enabled: false,
                source: 'default' as const,
                platformFrozen: false,
              };
              // The SERVER's answer, not a re-derivation: a platform row that
              // is ON is a ramp the owner may still switch off.
              const frozen = state.platformFrozen === true;
              return (
                <div key={key} className="flex items-start justify-between gap-3 px-4 py-3.5">
                  <div>
                    <p className="text-sm text-slate-800">{label}</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {description}
                      {frozen && ' Currently turned off platform-wide, so this cannot be changed here.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={state.enabled}
                    aria-label={label}
                    disabled={frozen}
                    onClick={() => void toggleCapability(key, !state.enabled)}
                    className={`relative shrink-0 mt-0.5 inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      state.enabled ? 'bg-blue-600' : 'bg-slate-200'
                    } ${frozen ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <span
                      className={`inline-block size-4 rounded-full bg-white shadow transition-transform ${
                        state.enabled ? 'translate-x-4' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        )}

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
              {section.items.map((item) => {
                const { icon: Icon, label, description, badge } = item;
                const iconAndText = (
                  <>
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
                  </>
                );
                if (item.kind === 'toggle') {
                  // Live-state row (#877): an explicit switch, not a
                  // chevron row — the row body itself is inert.
                  return (
                    <div key={label} className="flex items-center gap-3 w-full min-h-11 px-4 py-3.5 text-left">
                      {iconAndText}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={item.checked === true}
                        aria-label={label}
                        disabled={item.checked === null}
                        onClick={item.onToggle}
                        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center disabled:opacity-40"
                      >
                        <span
                          aria-hidden="true"
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${item.checked ? 'bg-blue-600' : 'bg-slate-200'}`}
                        >
                          <span className={`inline-block size-4 rounded-full bg-white shadow transition-transform ${item.checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
                        </span>
                      </button>
                    </div>
                  );
                }
                return (
                  <button
                    key={label}
                    onClick={item.action}
                    className="flex items-center gap-3 w-full min-h-11 px-4 py-3.5 text-left hover:bg-slate-50 transition-colors"
                  >
                    {iconAndText}
                    {item.kind === 'external' ? (
                      // Leaves the app (#877) — external-link, not chevron.
                      <ExternalLink size={14} className="shrink-0 text-slate-300" />
                    ) : (
                      <ChevronRight size={14} className="shrink-0 text-slate-300" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {/* Resources section — gives SuppliersSheet its user story */}
        <div className="mb-4">
          <p className="text-xs text-slate-400 mb-2 px-1">RESOURCES</p>
          <div className="rounded-xl bg-white border border-slate-200 divide-y divide-slate-100 overflow-hidden">
            <button
              onClick={() => setSuppliersOpen(true)}
              className="flex items-center gap-3 w-full min-h-11 px-4 py-3.5 text-left hover:bg-slate-50 transition-colors"
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
              onClick={() => setServiceAreaOpen(true)}
              className="flex items-center gap-3 w-full min-h-11 px-4 py-3.5 text-left hover:bg-slate-50 transition-colors"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-slate-100">
                <MapPin size={14} className="text-slate-500" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-800">Service area</p>
                <p className="text-xs text-slate-400 mt-0.5">{serviceAreaSubtitle}</p>
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

      {/* Service area sheet (#874) */}
      {serviceAreaOpen && (
        <ServiceAreaSheet
          onClose={() => setServiceAreaOpen(false)}
          onSaved={(fields) => setServiceArea(fields)}
        />
      )}

      {/* Business profile sheet */}
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
      {googleBusinessOpen && (
        <GoogleBusinessSheet onClose={() => setGoogleBusinessOpen(false)} />
      )}
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

      {/* #877 — confirm-gates for the two live-action rows. */}
      <ConfirmDialog
        open={confirmVoiceAction !== null}
        title={
          confirmVoiceAction === 'pause'
            ? 'Turn off AI phone answering?'
            : 'Turn on AI phone answering?'
        }
        description={
          confirmVoiceAction === 'pause'
            ? 'Callers will hear voicemail until you turn it back on.'
            : 'The AI assistant will start answering your inbound calls right away.'
        }
        confirmLabel={confirmVoiceAction === 'pause' ? 'Turn off' : 'Turn on'}
        tone={confirmVoiceAction === 'pause' ? 'danger' : 'default'}
        busy={voicePending}
        onConfirm={() => void performVoiceToggle()}
        onCancel={() => setConfirmVoiceAction(null)}
      />
      <ConfirmDialog
        open={confirmPortalOpen}
        title="Open the Stripe billing portal?"
        description="You'll leave Rivet to manage your card, plan, and invoices on Stripe, and return here when you close the portal."
        confirmLabel="Open billing portal"
        busy={portalPending}
        onConfirm={() => void confirmOpenBillingPortal()}
        onCancel={() => setConfirmPortalOpen(false)}
      />
    </div>
  );
}
