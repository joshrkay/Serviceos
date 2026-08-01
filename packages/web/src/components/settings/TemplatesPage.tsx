import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useUser } from '@clerk/clerk-react';
import { formatCurrency as formatCents } from '../../utils/currency';
import {
  ArrowLeft, Sparkles, Check, X, ChevronRight, RefreshCw,
  FileText, MessageSquare, Receipt, Briefcase, Users, Zap,
  TrendingUp, Mail, Clock, RotateCcw, ArrowRight,
  Star, AlertCircle, BarChart2, Globe, CheckCircle2,
} from 'lucide-react';
import { apiFetch } from '../../utils/api-fetch';
import { useMe } from '../../hooks/useMe';
import { firstNameFromUser } from '../../utils/greeting';

// ─── Types ────────────────────────────────────────────────────────────────────
type SuggestionStatus = 'pending' | 'accepted' | 'skipped';
type TemplateKey = 'estimate' | 'invoice' | 'job_confirm' | 'followup' | 'parts' | 'comms_tone';

interface AISuggestion {
  id: string;
  templateKey: TemplateKey;
  title: string;
  before: string;
  after: string;
  reason: string;
  source: 'usage' | 'community' | 'feedback';
  tradeCount?: number;
  confidence: 'High' | 'Medium';
  status: SuggestionStatus;
}

interface Template {
  key: TemplateKey;
  label: string;
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
  description: string;
  seededFrom: string;
  lastRefined: string;
  refinementCount: number;
  preview: string;
  fields: { label: string; value: string }[];
}

interface DigestSettings {
  enabled: boolean;
  day: string;
  includeStats: boolean;
  includeAiSuggestions: boolean;
  includeCommunityTips: boolean;
}

// ─── Mock data ────────────────────────────────────────────────────────────────
const INITIAL_SUGGESTIONS: AISuggestion[] = [
  {
    id: 's1',
    templateKey: 'estimate',
    title: 'Add diagnostic fee line item by default',
    before: 'Estimate starts with Labor and Parts only',
    after: 'Estimate starts with: Diagnostic Fee ($85), then Labor, then Parts',
    reason: 'You\'ve manually added a diagnostic fee to 9 of your last 11 estimates. Rivet can add it automatically.',
    source: 'usage',
    confidence: 'High',
    status: 'pending',
  },
  {
    id: 's2',
    templateKey: 'job_confirm',
    title: 'Change confirmation tone to include arrival window',
    before: '"Your appointment is scheduled for [DATE] at [TIME]."',
    after: '"We\'ll be at [ADDRESS] between [TIME] and [TIME+1HR] on [DATE]. We\'ll text you 30 min before we arrive."',
    reason: '4 other HVAC businesses in Austin switched to arrival windows. Customer-reported satisfaction scores improved.',
    source: 'community',
    tradeCount: 4,
    confidence: 'High',
    status: 'pending',
  },
  {
    id: 's3',
    templateKey: 'followup',
    title: 'Shorten follow-up delay from 3 days to 1 day for "Estimate Sent"',
    before: 'Follow-up sent 3 days after estimate is sent',
    after: 'Follow-up sent 1 day after estimate is sent (if not viewed), 2 days after if viewed but not approved',
    reason: 'Based on your estimate approval data, leads that get a same-day follow-up convert 2× more often.',
    source: 'usage',
    confidence: 'Medium',
    status: 'pending',
  },
  {
    id: 's4',
    templateKey: 'parts',
    title: 'Add refrigerant R-410A to default HVAC parts list',
    before: 'HVAC estimates start with no default parts',
    after: 'HVAC estimates include: R-410A Refrigerant (up to 2 lbs) as a common line item option',
    reason: '67% of HVAC businesses on Rivet include refrigerant as a common estimate line item.',
    source: 'community',
    tradeCount: 67,
    confidence: 'Medium',
    status: 'pending',
  },
];

const TEMPLATES: Template[] = [
  {
    key: 'estimate',
    label: 'Estimate template',
    icon: FileText,
    iconBg: 'bg-blue-100',
    iconColor: 'text-blue-600',
    description: 'Default line items, terms, validity period, and deposit rules',
    seededFrom: 'Onboarding · Step 3',
    lastRefined: '2 days ago',
    refinementCount: 3,
    preview: 'Diagnostic Fee · Labor · Parts · 30-day validity · 25% deposit on jobs over $500',
    fields: [
      { label: 'Opening line',        value: 'Here\'s your estimate for [SERVICE] at [ADDRESS].' },
      { label: 'Default validity',    value: '30 days' },
      { label: 'Deposit rule',        value: '25% required on jobs over $500' },
      { label: 'Terms note',          value: 'Payment due within 15 days of completion.' },
    ],
  },
  {
    key: 'invoice',
    label: 'Invoice template',
    icon: Receipt,
    iconBg: 'bg-amber-100',
    iconColor: 'text-amber-600',
    description: 'Payment terms, late fee language, and send-by preference',
    seededFrom: 'Onboarding · Step 3',
    lastRefined: '5 days ago',
    refinementCount: 1,
    preview: 'Net-15 · 1.5% late fee after 30 days · SMS + email send',
    fields: [
      { label: 'Payment terms',       value: 'Net 15 days' },
      { label: 'Late fee',            value: '1.5% per month after 30 days' },
      { label: 'Send method',         value: 'SMS first, email backup' },
      { label: 'Closing message',     value: 'Thank you for choosing Ortega Services!' },
    ],
  },
  {
    key: 'job_confirm',
    label: 'Job confirmation',
    icon: Briefcase,
    iconBg: 'bg-green-100',
    iconColor: 'text-green-600',
    description: 'Customer-facing message sent when a job is scheduled',
    seededFrom: 'Onboarding · Step 4',
    lastRefined: 'Today',
    refinementCount: 2,
    preview: 'Scheduled confirmation · tech name · arrival time · address',
    fields: [
      { label: 'Message',             value: 'Your appointment is scheduled for [DATE] at [TIME]. [TECH] will be your technician.' },
      { label: 'Send via',            value: 'SMS' },
      { label: 'Reminder',            value: '2 hours before appointment' },
    ],
  },
  {
    key: 'followup',
    label: 'Follow-up cadence',
    icon: MessageSquare,
    iconBg: 'bg-violet-100',
    iconColor: 'text-violet-600',
    description: 'Timing and tone for estimate follow-ups and re-engagement',
    seededFrom: 'Onboarding · Step 5',
    lastRefined: '1 week ago',
    refinementCount: 0,
    preview: 'Day 3 if not viewed · Day 5 if viewed · Day 14 re-engage',
    fields: [
      { label: 'First follow-up',     value: '3 days after estimate sent (if not viewed)' },
      { label: 'Second follow-up',    value: '5 days if viewed but not approved' },
      { label: 'Re-engage',           value: '14 days — "Still interested?" message' },
      { label: 'Tone',                value: 'Friendly, no pressure' },
    ],
  },
  {
    key: 'parts',
    label: 'Parts & materials defaults',
    icon: Zap,
    iconBg: 'bg-slate-100',
    iconColor: 'text-slate-600',
    description: 'Common parts pre-loaded per service type to speed up estimates',
    seededFrom: 'Onboarding · Step 3',
    lastRefined: '3 days ago',
    refinementCount: 4,
    preview: 'HVAC: 7 parts · Plumbing: 5 parts · Painting: 4 materials',
    fields: [
      { label: 'HVAC defaults',       value: 'Capacitor, Contactor, Filter, Refrigerant, Thermostat, Coil cleaner, Blower motor' },
      { label: 'Plumbing defaults',   value: 'Shut-off valve, P-trap, Wax ring, Supply line, Cartridge' },
      { label: 'Painting defaults',   value: 'Primer, Paint (gal), Tape, Drop cloth' },
    ],
  },
  {
    key: 'comms_tone',
    label: 'Communication tone',
    icon: Users,
    iconBg: 'bg-rose-100',
    iconColor: 'text-rose-600',
    description: 'How Rivet writes messages to your customers on your behalf',
    seededFrom: 'Onboarding · Step 2',
    lastRefined: 'Never',
    refinementCount: 0,
    preview: 'Professional · Warm · First-name basis · No jargon',
    fields: [
      { label: 'Style',               value: 'Professional but warm' },
      { label: 'Address customers by',value: 'First name' },
      { label: 'Avoid',               value: 'Technical jargon, slang' },
      { label: 'Signature',           value: '— Mike @ Ortega Services' },
    ],
  },
];

const COMMUNITY_INSIGHTS = [
  {
    icon: '❄️',
    trade: 'HVAC',
    stat: '57%',
    text: 'of HVAC businesses added a diagnostic fee line item this quarter',
    action: 'Add to your estimate template',
    color: 'bg-blue-50 border-blue-100',
    textColor: 'text-blue-700',
  },
  {
    icon: '🔧',
    trade: 'Plumbing',
    stat: '2×',
    text: 'faster estimate approval when payment link is included in the estimate itself',
    action: 'Enable in invoice settings',
    color: 'bg-cyan-50 border-cyan-100',
    textColor: 'text-cyan-700',
  },
  {
    icon: '🎨',
    trade: 'Painting',
    stat: '4 in 5',
    text: 'painting customers want a color/brand reference in the estimate description',
    action: 'Add to painting template',
    color: 'bg-violet-50 border-violet-100',
    textColor: 'text-violet-700',
  },
  {
    icon: '📍',
    trade: 'Austin area',
    stat: '↑ 34%',
    text: 'more callbacks when confirmation message includes tech\'s first name and photo',
    action: 'Update job confirmation',
    color: 'bg-amber-50 border-amber-100',
    textColor: 'text-amber-700',
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function LoopDiagram() {
  const steps = [
    { icon: Sparkles,   label: 'Onboarding\nseeds templates',  color: 'bg-indigo-100 text-indigo-600' },
    { icon: BarChart2,  label: 'Rivet\nwatches usage',       color: 'bg-blue-100   text-blue-600'   },
    { icon: Zap,        label: 'AI proposes\nrefinements',      color: 'bg-violet-100 text-violet-600' },
    { icon: Check,      label: 'You accept\nor tweak',          color: 'bg-green-100  text-green-600'  },
    { icon: RefreshCw,  label: 'Templates\nimprove',            color: 'bg-slate-100  text-slate-600'  },
  ];
  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-1">
      {steps.map(({ icon: Icon, label, color }, i) => (
        <div key={label} className="flex items-center gap-1 shrink-0">
          <div className="flex flex-col items-center gap-1.5">
            <span className={`flex size-9 items-center justify-center rounded-full ${color}`}>
              <Icon size={15} />
            </span>
            <p className="text-xs text-slate-500 text-center whitespace-pre-line leading-tight" style={{ fontSize: 10 }}>
              {label}
            </p>
          </div>
          {i < steps.length - 1 && (
            <ArrowRight size={11} className="text-slate-300 shrink-0 mb-3 mx-0.5" />
          )}
        </div>
      ))}
      {/* Loop-back arrow indicator */}
      <div className="flex items-center gap-1 shrink-0 ml-1">
        <RotateCcw size={12} className="text-indigo-400" />
        <p style={{ fontSize: 9 }} className="text-indigo-400">repeats</p>
      </div>
    </div>
  );
}

function SuggestionCard({
  suggestion,
  onAccept,
  onSkip,
}: {
  suggestion: AISuggestion;
  onAccept: () => void;
  onSkip: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const sourceLabel =
    suggestion.source === 'usage'     ? 'From your usage patterns' :
    suggestion.source === 'community' ? `From ${suggestion.tradeCount}+ similar businesses` :
    'From your feedback';
  const sourceBg =
    suggestion.source === 'usage'     ? 'bg-blue-100 text-blue-700' :
    suggestion.source === 'community' ? 'bg-amber-100 text-amber-700' :
    'bg-green-100 text-green-700';

  if (suggestion.status === 'accepted') {
    return (
      <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3.5 flex items-center gap-3">
        <CheckCircle2 size={16} className="text-green-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-green-800">{suggestion.title}</p>
          <p className="text-xs text-green-600 mt-0.5">Applied to template</p>
        </div>
      </div>
    );
  }

  if (suggestion.status === 'skipped') {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 flex items-center gap-3 opacity-60">
        <X size={14} className="text-slate-400 shrink-0" />
        <p className="text-sm text-slate-500 line-through">{suggestion.title}</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3 mb-2">
          <p className="text-sm text-slate-900">{suggestion.title}</p>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className={`text-xs rounded-full px-2 py-0.5 ${sourceBg}`}>{sourceLabel}</span>
            <span className={`text-xs rounded-full px-2 py-0.5 ${
              suggestion.confidence === 'High' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'
            }`}>{suggestion.confidence}</span>
          </div>
        </div>
        <p className="text-xs text-slate-500 leading-relaxed">{suggestion.reason}</p>

        {/* Before / after */}
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 mt-2 transition-colors"
        >
          {expanded ? 'Hide' : 'See'} what changes
          <ChevronRight size={11} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>

        {expanded && (
          <div className="mt-3 flex flex-col gap-2">
            <div className="rounded-lg bg-red-50 border border-red-100 px-3 py-2.5">
              <p className="text-xs text-red-600 mb-1">Current</p>
              <p className="text-xs text-slate-600 leading-relaxed">{suggestion.before}</p>
            </div>
            <div className="rounded-lg bg-green-50 border border-green-100 px-3 py-2.5">
              <p className="text-xs text-green-600 mb-1">Proposed</p>
              <p className="text-xs text-slate-600 leading-relaxed">{suggestion.after}</p>
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex border-t border-slate-100 divide-x divide-slate-100">
        <button
          onClick={onAccept}
          className="flex-1 flex items-center justify-center gap-1.5 py-3 text-xs text-green-700 hover:bg-green-50 transition-colors"
        >
          <Check size={12} /> Apply
        </button>
        <button
          onClick={onSkip}
          className="flex-1 flex items-center justify-center gap-1.5 py-3 text-xs text-slate-400 hover:bg-slate-50 transition-colors"
        >
          <X size={12} /> Skip
        </button>
      </div>
    </div>
  );
}

function DigestModal({ settings, onChange, onClose }: {
  settings: DigestSettings;
  onChange: (s: DigestSettings) => void;
  onClose: () => void;
}) {
  const { user } = useUser();
  const ownerFirstName = firstNameFromUser(
    user?.fullName,
    user?.primaryEmailAddress?.emailAddress,
  );
  const ownerEmail = user?.primaryEmailAddress?.emailAddress ?? 'you@yourbusiness.com';
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 px-4 pb-0 md:pb-4" onClick={onClose}>
      <div
        className="w-full max-w-md bg-white rounded-t-3xl md:rounded-2xl shadow-2xl max-h-[85vh] overflow-y-auto"
        style={{ animation: 'sheetUp 0.25s ease' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-slate-100">
          <span className="flex size-9 items-center justify-center rounded-xl bg-violet-100 shrink-0">
            <Mail size={15} className="text-violet-600" />
          </span>
          <div className="flex-1">
            <p className="text-slate-900">Weekly Digest</p>
            <p className="text-xs text-slate-400 mt-0.5">Your business + community suggestions</p>
          </div>
          <button onClick={onClose} className="flex size-8 items-center justify-center rounded-full hover:bg-slate-100">
            <X size={15} className="text-slate-500" />
          </button>
        </div>

        <div className="px-5 py-5 flex flex-col gap-5">
          {/* Master toggle */}
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3.5">
            <div>
              <p className="text-sm text-slate-800">Send weekly digest</p>
              <p className="text-xs text-slate-400 mt-0.5">Email summary every week</p>
            </div>
            <button
              onClick={() => onChange({ ...settings, enabled: !settings.enabled })}
              className={`relative flex h-6 w-11 cursor-pointer rounded-full transition-colors duration-200 ${settings.enabled ? 'bg-slate-900' : 'bg-slate-200'}`}
            >
              <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${settings.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>

          {settings.enabled && (
            <>
              {/* Day picker */}
              <div>
                <p className="text-xs text-slate-500 mb-2.5">Send on</p>
                <div className="flex flex-wrap gap-2">
                  {DAYS.map(d => (
                    <button
                      key={d}
                      onClick={() => onChange({ ...settings, day: d })}
                      className={`rounded-lg px-3 py-2 text-xs transition-colors ${
                        settings.day === d
                          ? 'bg-slate-900 text-white'
                          : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              {/* What's included */}
              <div>
                <p className="text-xs text-slate-500 mb-2.5">Include in digest</p>
                <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100 overflow-hidden">
                  {[
                    { key: 'includeStats',           label: 'Your week in numbers',        desc: 'Jobs completed, revenue, estimates sent' },
                    { key: 'includeAiSuggestions',   label: 'AI template suggestions',     desc: 'Refinements Rivet noticed from your usage' },
                    { key: 'includeCommunityTips',   label: 'Tips from similar businesses',desc: 'Anonymous insights from HVAC, plumbing & painting trades' },
                  ].map(({ key, label, desc }) => (
                    <div key={key} className="flex items-center justify-between px-4 py-3.5">
                      <div>
                        <p className="text-sm text-slate-800">{label}</p>
                        <p className="text-xs text-slate-400 mt-0.5">{desc}</p>
                      </div>
                      <button
                        onClick={() => onChange({ ...settings, [key]: !settings[key as keyof DigestSettings] })}
                        className={`relative flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ml-4 ${settings[key as keyof DigestSettings] ? 'bg-slate-900' : 'bg-slate-200'}`}
                      >
                        <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${settings[key as keyof DigestSettings] ? 'translate-x-5' : 'translate-x-0'}`} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Preview email */}
              <div>
                <p className="text-xs text-slate-500 mb-2.5">Preview this week's digest</p>
                <div className="rounded-xl border border-slate-200 overflow-hidden">
                  {/* Email chrome */}
                  <div className="bg-slate-800 px-4 py-3 flex items-center gap-2.5">
                    <div className="flex size-7 items-center justify-center rounded-full bg-white/10">
                      <Zap size={12} className="text-white" />
                    </div>
                    <div>
                      <p className="text-xs text-white">Rivet Weekly · Mar 10, 2026</p>
                      <p className="text-xs text-slate-400 mt-0.5">To: {ownerEmail}</p>
                    </div>
                  </div>

                  <div className="bg-white px-4 py-4 flex flex-col gap-3">
                    <p className="text-sm text-slate-900">Hey {ownerFirstName} 👋</p>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Here's your Rivet summary for the week of March 4–10.
                    </p>

                    {settings.includeStats && (
                      <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
                        <p className="text-xs text-slate-500 mb-2">This week</p>
                        <div className="grid grid-cols-3 gap-2">
                          {[
                            { v: '6', l: 'jobs done' },
                            { v: '$4,820', l: 'invoiced' },
                            { v: '3', l: 'estimates sent' },
                          ].map(({ v, l }) => (
                            <div key={l} className="text-center">
                              <p className="text-slate-900" style={{ fontSize: '0.95rem' }}>{v}</p>
                              <p className="text-xs text-slate-400 mt-0.5">{l}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {settings.includeAiSuggestions && (
                      <div className="rounded-lg bg-blue-50 border border-blue-100 p-3">
                        <p className="text-xs text-blue-600 mb-1.5 flex items-center gap-1">
                          <Sparkles size={10} /> AI noticed
                        </p>
                        <p className="text-xs text-slate-600">
                          You added a diagnostic fee to 9 of 11 estimates this week. Want Rivet to add it by default?
                        </p>
                        <div className="flex gap-2 mt-2">
                          <button className="text-xs bg-blue-600 text-white rounded-md px-2.5 py-1">Yes, add it</button>
                          <button className="text-xs border border-slate-200 rounded-md px-2.5 py-1 text-slate-500">Skip</button>
                        </div>
                      </div>
                    )}

                    {settings.includeCommunityTips && (
                      <div className="rounded-lg bg-amber-50 border border-amber-100 p-3">
                        <p className="text-xs text-amber-600 mb-1.5 flex items-center gap-1">
                          <Globe size={10} /> From HVAC businesses like yours
                        </p>
                        <p className="text-xs text-slate-600">
                          4 Austin-area HVAC companies switched to arrival-window confirmations. Customers love it.
                        </p>
                      </div>
                    )}

                    <p className="text-xs text-slate-400">— The Rivet team</p>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── P4-014 — Live templates section ──────────────────────────────────────────
/**
 * Real backend-driven view of estimate templates. Lives alongside the
 * existing AI-suggestions / mock-template UI rather than replacing it
 * (the surrounding page is currently a marketing layout with hard-coded
 * fields that don't map to the live `EstimateTemplate` schema). This
 * section is the one place where an owner can actually see and edit
 * persisted templates today.
 *
 * Filtering: `/api/settings.activeVerticalPacks` drives which vertical(s)
 * we ask `/api/templates?verticalType=...` about. When a tenant has no
 * active packs we render the activation nudge instead of a misleading
 * empty list.
 *
 * Wording-only edit: the spec deliberately scopes the edit affordance to
 * `defaultCustomerMessage`. Touching `lineItemTemplates` would change the
 * structural meaning of a template; that lives behind a separate flow we
 * haven't built yet, so the line-item view here is read-only.
 *
 * Exported for unit testing in TemplatesPage.live.test.tsx.
 */
interface LiveEstimateTemplate {
  id: string;
  tenantId: string;
  verticalType: string;
  categoryId: string;
  name: string;
  description?: string;
  lineItemTemplates: {
    description: string;
    category: string;
    defaultQuantity: number;
    defaultUnitPriceCents: number;
    taxable: boolean;
    sortOrder: number;
    isOptional: boolean;
  }[];
  defaultDiscountCents: number;
  defaultTaxRateBps: number;
  defaultCustomerMessage?: string;
  isActive: boolean;
  usageCount: number;
  updatedAt: string | Date;
}

interface LiveSettingsResponse {
  activeVerticalPacks?: string[];
}


export function LiveTemplateDetailModal({
  template,
  canEdit,
  onClose,
  onSaved,
}: {
  template: LiveEstimateTemplate;
  canEdit: boolean;
  onClose: () => void;
  onSaved: (next: LiveEstimateTemplate) => void;
}) {
  const [message, setMessage] = useState(template.defaultCustomerMessage ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/templates/${template.id}`, {
        method: 'PUT',
        body: JSON.stringify({ defaultCustomerMessage: message }),
      });
      if (!res.ok) throw new Error(`Save failed (HTTP ${res.status})`);
      const next = (await res.json()) as LiveEstimateTemplate;
      setSaving(false);
      onSaved(next);
      onClose();
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 px-4 pb-0 md:pb-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-white rounded-t-3xl md:rounded-2xl shadow-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-slate-100 sticky top-0 bg-white z-10">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-100">
            <FileText size={14} className="text-blue-600" />
          </span>
          <div className="flex-1">
            <p className="text-slate-900">{template.name}</p>
            <p className="text-xs text-slate-400 mt-0.5">
              {template.verticalType.toUpperCase()} · used {template.usageCount} {template.usageCount === 1 ? 'time' : 'times'}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close template detail"
            className="flex size-8 items-center justify-center rounded-full hover:bg-slate-100 transition-colors"
          >
            <X size={15} className="text-slate-500" />
          </button>
        </div>

        <div className="px-5 py-5 flex flex-col gap-4">
          {template.description && (
            <p className="text-sm text-slate-600 leading-relaxed">{template.description}</p>
          )}

          {/* Line items — read-only preview. Structure edits are intentionally out of scope. */}
          <div>
            <p className="text-xs text-slate-500 mb-2">Line items</p>
            <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
              {template.lineItemTemplates.length === 0 ? (
                <div className="px-4 py-3 text-sm text-slate-400">No line items defined.</div>
              ) : (
                template.lineItemTemplates.map((li, i) => (
                  <div key={i} className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-800 truncate">{li.description}</p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {li.category} · qty {li.defaultQuantity}
                        {li.isOptional ? ' · optional' : ''}
                      </p>
                    </div>
                    <p className="text-sm text-slate-700 shrink-0">
                      {formatCents(li.defaultUnitPriceCents)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <label htmlFor="template-customer-message" className="text-xs text-slate-500 mb-1.5 block">
              Customer message (wording)
            </label>
            <textarea
              id="template-customer-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={!canEdit}
              rows={4}
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-500"
            />
            {!canEdit && (
              <p className="text-xs text-slate-400 mt-1.5">
                You don’t have permission to edit template wording.
              </p>
            )}
          </div>

          {error && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
              {error}
            </div>
          )}
        </div>

        {canEdit && (
          <div className="px-5 pb-5 pt-0">
            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full flex items-center justify-center gap-2 rounded-xl py-3.5 text-sm bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white"
            >
              {saving ? 'Saving...' : 'Save wording'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function LiveTemplatesSection() {
  const { me } = useMe();
  // Gate template-wording edits on the real backend permission (estimates:update),
  // not on role === 'owner'. Dispatchers hold estimates:update and must be able
  // to edit template copy; technicians do not and stay read-only.
  const canEdit = (me?.permissions ?? []).includes('estimates:update');
  const [templates, setTemplates] = useState<LiveEstimateTemplate[] | null>(null);
  const [activePacks, setActivePacks] = useState<string[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LiveEstimateTemplate | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const settingsRes = await apiFetch('/api/settings');
        if (!settingsRes.ok) throw new Error(`Settings load failed (HTTP ${settingsRes.status})`);
        const settings = (await settingsRes.json()) as LiveSettingsResponse;
        const packs = (settings.activeVerticalPacks ?? []).filter(
          (p): p is 'hvac' | 'plumbing' => p === 'hvac' || p === 'plumbing',
        );
        if (cancelled) return;
        setActivePacks(packs);

        if (packs.length === 0) {
          setTemplates([]);
          setIsLoading(false);
          return;
        }

        // Fetch templates per active vertical in parallel. We dedupe by id
        // afterwards in case a template is registered against multiple
        // verticals (rare today but the endpoint contract allows it).
        const responses = await Promise.all(
          packs.map((vertical) =>
            apiFetch(`/api/templates?verticalType=${vertical}`).then(async (r) => {
              if (!r.ok) throw new Error(`Templates load failed (HTTP ${r.status})`);
              return (await r.json()) as LiveEstimateTemplate[];
            }),
          ),
        );
        if (cancelled) return;
        const byId = new Map<string, LiveEstimateTemplate>();
        for (const list of responses) {
          for (const t of list) byId.set(t.id, t);
        }
        // Most-recently used first — see exit criteria: "Show which templates
        // were used most recently." Falls back to updatedAt when usage is tied.
        const merged = Array.from(byId.values()).sort((a, b) => {
          if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        });
        setTemplates(merged);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load templates');
        setTemplates([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleSaved(next: LiveEstimateTemplate) {
    setTemplates((prev) =>
      prev ? prev.map((t) => (t.id === next.id ? next : t)) : prev,
    );
  }

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-slate-700">Live templates</p>
        {activePacks && activePacks.length > 0 && (
          <div className="flex items-center gap-1.5">
            {activePacks.map((p) => (
              <span
                key={p}
                className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5 uppercase tracking-wide"
              >
                {p}
              </span>
            ))}
          </div>
        )}
      </div>

      {isLoading && (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">
          Loading templates…
        </div>
      )}

      {!isLoading && error && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      {!isLoading && !error && templates && templates.length === 0 && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-6 text-center">
          <p className="text-sm text-slate-600">
            {activePacks && activePacks.length === 0
              ? 'No vertical pack is active. Activate a pack to seed templates.'
              : 'No templates yet for your active verticals.'}
          </p>
        </div>
      )}

      {!isLoading && !error && templates && templates.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {templates.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelected(t)}
              className="w-full text-left rounded-xl border border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm transition-all px-4 py-3.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-900 truncate">{t.name}</p>
                  <p className="text-xs text-slate-400 mt-0.5 truncate">
                    {t.lineItemTemplates.length} line {t.lineItemTemplates.length === 1 ? 'item' : 'items'}
                    {t.description ? ` · ${t.description}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs bg-slate-100 text-slate-500 rounded-full px-2 py-0.5 uppercase">
                    {t.verticalType}
                  </span>
                  <span className="text-xs text-slate-400">
                    used {t.usageCount}×
                  </span>
                  <ChevronRight size={14} className="text-slate-300" />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <LiveTemplateDetailModal
          template={selected}
          canEdit={canEdit}
          onClose={() => setSelected(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
// D2: Removed fabricated AI suggestions, stats, and community insights.
// Only the LiveTemplatesSection (backend-backed) and the weekly-digest
// control are shown; unbacked "coming soon" placeholders were removed.
export function TemplatesPage() {
  const navigate = useNavigate();
  const [digestOpen, setDigestOpen] = useState(false);
  const [digest, setDigest] = useState<DigestSettings>({
    enabled: true,
    day: 'Monday',
    includeStats: true,
    includeAiSuggestions: true,
    includeCommunityTips: true,
  });

  return (
    <div className="h-full overflow-y-auto pb-24 md:pb-8" style={{ scrollbarWidth: 'thin' }}>
      <div className="max-w-2xl mx-auto px-4 md:px-6 py-5">

        {/* Back */}
        <button
          onClick={() => navigate('/settings')}
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors mb-5"
        >
          <ArrowLeft size={15} /> Settings
        </button>

        {/* Title */}
        <div className="mb-6">
          <h1 className="text-slate-900" style={{ fontSize: '1.2rem' }}>Templates & Customization</h1>
          <p className="text-sm text-slate-400 mt-1">
            Configure your business templates for estimates, invoices, and communications.
          </p>
        </div>

        {/* ── P4-014 — Live templates (backend-backed). This is the real,
            backend-persisted template editor. ── */}
        <LiveTemplatesSection />

        {/* ── Weekly Digest ── */}
        <div className="mb-6">
          <p className="text-sm text-slate-700 mb-3">Weekly digest</p>
          <button
            onClick={() => setDigestOpen(true)}
            className="w-full flex items-center gap-4 rounded-xl bg-white border border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all px-4 py-4 text-left group"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-100">
              <Mail size={16} className="text-violet-600" />
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm text-slate-900">Weekly Rivet Digest</p>
                {digest.enabled && (
                  <span className="text-xs bg-green-100 text-green-700 rounded-full px-2 py-0.5">On · {digest.day}</span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {digest.enabled
                  ? 'Your stats, AI suggestions, and community tips — every week'
                  : 'Enable to get weekly summaries and template suggestions'}
              </p>
            </div>
            <ChevronRight size={14} className="text-slate-300 group-hover:text-slate-500 transition-colors shrink-0" />
          </button>

          <div className="mt-2 rounded-xl border border-dashed border-slate-200 px-4 py-3">
            <p className="text-xs text-slate-500 leading-relaxed">
              <span className="text-slate-700">How feedback flows back: </span>
              Each digest asks one focused question about your experience.
              Your responses — and those from similar trades — directly inform the next round of template refinement suggestions.
            </p>
          </div>
        </div>

        {/* ── Onboarding re-run prompt ── */}
        <button
          onClick={() => navigate('/onboarding')}
          className="w-full flex items-center gap-4 rounded-xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-left hover:bg-indigo-100 transition-colors group"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600">
            <Sparkles size={16} className="text-white" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-indigo-800">Re-run your setup conversation</p>
            <p className="text-xs text-indigo-500 mt-0.5">
              Walk through onboarding again to update your terminology, preferences, and template seeds
            </p>
          </div>
          <ChevronRight size={14} className="text-indigo-400 group-hover:text-indigo-600 transition-colors shrink-0" />
        </button>

      </div>

      {/* Modals */}
      {digestOpen && (
        <DigestModal settings={digest} onChange={setDigest} onClose={() => setDigestOpen(false)} />
      )}
    </div>
  );
}
