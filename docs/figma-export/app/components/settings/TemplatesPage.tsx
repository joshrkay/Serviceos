import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowLeft, Sparkles, Check, X, ChevronRight, RefreshCw,
  FileText, MessageSquare, Receipt, Briefcase, Users, Zap,
  TrendingUp, Mail, Clock, Edit3, RotateCcw, ArrowRight,
  Star, AlertCircle, BarChart2, Globe, CheckCircle2, Info,
} from 'lucide-react';

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
    reason: 'You\'ve manually added a diagnostic fee to 9 of your last 11 estimates. Fieldly can add it automatically.',
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
    reason: '67% of HVAC businesses on Fieldly include refrigerant as a common estimate line item.',
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
    description: 'How Fieldly writes messages to your customers on your behalf',
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
    { icon: BarChart2,  label: 'Fieldly\nwatches usage',       color: 'bg-blue-100   text-blue-600'   },
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
  onCustomize,
  onSkip,
}: {
  suggestion: AISuggestion;
  onAccept: () => void;
  onCustomize: () => void;
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
          onClick={onCustomize}
          className="flex-1 flex items-center justify-center gap-1.5 py-3 text-xs text-blue-600 hover:bg-blue-50 transition-colors"
        >
          <Edit3 size={12} /> Customize
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

function TemplateCard({
  template,
  hasPending,
  onClick,
}: {
  template: Template;
  hasPending: boolean;
  onClick: () => void;
}) {
  const Icon = template.icon;
  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-xl border border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm transition-all overflow-hidden group"
    >
      <div className="px-4 py-4">
        <div className="flex items-start gap-3 mb-2.5">
          <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${template.iconBg}`}>
            <Icon size={15} className={template.iconColor} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm text-slate-900">{template.label}</p>
              {hasPending && (
                <span className="flex size-2 rounded-full bg-blue-500 shrink-0 animate-pulse" />
              )}
            </div>
            <p className="text-xs text-slate-400 mt-0.5">{template.description}</p>
          </div>
          <ChevronRight size={14} className="text-slate-300 group-hover:text-slate-500 transition-colors shrink-0 mt-0.5" />
        </div>

        <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-xs text-slate-500 leading-relaxed">
          {template.preview}
        </div>
      </div>

      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-t border-slate-100">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-xs text-slate-400">
            <Sparkles size={10} className="text-indigo-400" />
            Seeded from {template.seededFrom}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-400">
            {template.refinementCount > 0
              ? `${template.refinementCount} refinements`
              : 'Not yet refined'}
          </span>
          <span className="text-xs text-slate-400">{template.lastRefined}</span>
        </div>
      </div>
    </button>
  );
}

function TemplateDetailModal({ template, onClose }: { template: Template; onClose: () => void }) {
  const [fields, setFields] = useState(template.fields);
  const [saved, setSaved]   = useState(false);

  function handleSave() {
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 1000);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 px-4 pb-0 md:pb-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-white rounded-t-3xl md:rounded-2xl shadow-2xl max-h-[85vh] overflow-y-auto"
        style={{ animation: 'sheetUp 0.25s ease' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-slate-100 sticky top-0 bg-white z-10">
          <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${template.iconBg}`}>
            <template.icon size={14} className={template.iconColor} />
          </span>
          <div className="flex-1">
            <p className="text-slate-900">{template.label}</p>
            <p className="text-xs text-slate-400 mt-0.5">Seeded from {template.seededFrom}</p>
          </div>
          <button onClick={onClose} className="flex size-8 items-center justify-center rounded-full hover:bg-slate-100 transition-colors">
            <X size={15} className="text-slate-500" />
          </button>
        </div>

        <div className="px-5 py-5 flex flex-col gap-4">
          <div className="rounded-xl bg-indigo-50 border border-indigo-100 px-4 py-3">
            <div className="flex items-start gap-2">
              <Info size={13} className="text-indigo-500 shrink-0 mt-0.5" />
              <p className="text-xs text-indigo-700 leading-relaxed">
                These values were set during onboarding and refined by Fieldly based on your usage.
                Edits here update your live templates immediately — the AI will use them as the new baseline.
              </p>
            </div>
          </div>

          {fields.map((field, i) => (
            <div key={field.label}>
              <label className="text-xs text-slate-500 mb-1.5 block">{field.label}</label>
              {field.value.length > 60 ? (
                <textarea
                  value={field.value}
                  onChange={e => {
                    const next = [...fields];
                    next[i] = { ...field, value: e.target.value };
                    setFields(next);
                  }}
                  rows={3}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all resize-none"
                />
              ) : (
                <input
                  value={field.value}
                  onChange={e => {
                    const next = [...fields];
                    next[i] = { ...field, value: e.target.value };
                    setFields(next);
                  }}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                />
              )}
            </div>
          ))}

          <div className="rounded-xl border border-dashed border-slate-200 px-4 py-3.5 flex items-center gap-3">
            <RotateCcw size={13} className="text-slate-400 shrink-0" />
            <p className="text-xs text-slate-500 flex-1">
              After saving, Fieldly will use these as the new baseline in the refinement loop.
            </p>
            <button className="text-xs text-slate-400 hover:text-slate-600 transition-colors shrink-0">
              Reset to defaults
            </button>
          </div>
        </div>

        <div className="px-5 pb-5 pt-0">
          <button
            onClick={handleSave}
            className={`w-full flex items-center justify-center gap-2 rounded-xl py-3.5 text-sm transition-all ${
              saved ? 'bg-green-600 text-white' : 'bg-slate-900 hover:bg-slate-800 text-white'
            }`}
          >
            {saved ? <><Check size={14} /> Saved</> : 'Save template'}
          </button>
        </div>
      </div>
      <style>{`@keyframes sheetUp { from { transform: translateY(40px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`}</style>
    </div>
  );
}

function DigestModal({ settings, onChange, onClose }: {
  settings: DigestSettings;
  onChange: (s: DigestSettings) => void;
  onClose: () => void;
}) {
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
                    { key: 'includeAiSuggestions',   label: 'AI template suggestions',     desc: 'Refinements Fieldly noticed from your usage' },
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
                      <p className="text-xs text-white">Fieldly Weekly · Mar 10, 2026</p>
                      <p className="text-xs text-slate-400 mt-0.5">To: mike@ortegarv.com</p>
                    </div>
                  </div>

                  <div className="bg-white px-4 py-4 flex flex-col gap-3">
                    <p className="text-sm text-slate-900">Hey Mike 👋</p>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Here's your Fieldly summary for the week of March 4–10.
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
                          You added a diagnostic fee to 9 of 11 estimates this week. Want Fieldly to add it by default?
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

                    <p className="text-xs text-slate-400">— The Fieldly team</p>
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

// ─── Main Page ────────────────────────────────────────────────────────────────
export function TemplatesPage() {
  const navigate = useNavigate();
  const [suggestions, setSuggestions] = useState<AISuggestion[]>(INITIAL_SUGGESTIONS);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [digestOpen, setDigestOpen] = useState(false);
  const [digest, setDigest] = useState<DigestSettings>({
    enabled: true,
    day: 'Monday',
    includeStats: true,
    includeAiSuggestions: true,
    includeCommunityTips: true,
  });

  const pendingCount = suggestions.filter(s => s.status === 'pending').length;
  const jobsProcessed = 47;
  const nextRefinementJobs = 5;

  function accept(id: string) {
    setSuggestions(prev => prev.map(s => s.id === id ? { ...s, status: 'accepted' } : s));
  }
  function skip(id: string) {
    setSuggestions(prev => prev.map(s => s.id === id ? { ...s, status: 'skipped' } : s));
  }
  function customize(id: string) {
    const s = suggestions.find(x => x.id === id);
    if (s) {
      const t = TEMPLATES.find(t => t.key === s.templateKey);
      if (t) setSelectedTemplate(t);
    }
  }

  const pendingByTemplate = (key: TemplateKey) =>
    suggestions.some(s => s.templateKey === key && s.status === 'pending');

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
            Your templates are alive — they grow with your business.
          </p>
        </div>

        {/* ── How the loop works ── */}
        <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden mb-5">
          <div className="px-5 pt-5 pb-4">
            <div className="flex items-center gap-2 mb-3">
              <RefreshCw size={14} className="text-indigo-500" />
              <p className="text-sm text-slate-800">How your templates improve over time</p>
            </div>
            <LoopDiagram />
          </div>
          <div className="border-t border-slate-100 px-5 py-3 bg-slate-50 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-green-500" />
                <p className="text-xs text-slate-500">{jobsProcessed} jobs processed</p>
              </div>
              <div className="flex items-center gap-1.5">
                <Sparkles size={11} className="text-indigo-400" />
                <p className="text-xs text-slate-500">{pendingCount} suggestions waiting</p>
              </div>
            </div>
            <p className="text-xs text-slate-400">
              Next check after {nextRefinementJobs} more jobs
            </p>
          </div>
        </div>

        {/* ── AI Learning Status ── */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          {[
            { icon: Sparkles, label: 'Onboarding',   value: 'Complete',        color: 'text-green-600',  bg: 'bg-green-50  border-green-100'  },
            { icon: BarChart2, label: 'Jobs learned', value: `${jobsProcessed}`, color: 'text-blue-600',  bg: 'bg-blue-50   border-blue-100'   },
            { icon: Star,      label: 'Refinements',  value: `${TEMPLATES.reduce((s,t)=>s+t.refinementCount,0)}`, color: 'text-violet-600', bg: 'bg-violet-50 border-violet-100' },
          ].map(({ icon: Icon, label, value, color, bg }) => (
            <div key={label} className={`rounded-xl border px-3 py-3.5 ${bg}`}>
              <Icon size={13} className={`${color} mb-1.5`} />
              <p className={`${color}`}>{value}</p>
              <p className="text-xs text-slate-400 mt-0.5">{label}</p>
            </div>
          ))}
        </div>

        {/* ── Pending AI Suggestions ── */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <p className="text-sm text-slate-700">Suggested refinements</p>
              {pendingCount > 0 && (
                <span className="flex size-5 items-center justify-center rounded-full bg-blue-600 text-white" style={{ fontSize: 10 }}>
                  {pendingCount}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-blue-600 bg-blue-100 rounded-full px-2 py-0.5">From usage</span>
              <span className="text-xs text-amber-600 bg-amber-100 rounded-full px-2 py-0.5">From community</span>
            </div>
          </div>

          {pendingCount === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-8 text-center">
              <CheckCircle2 size={24} className="text-green-400 mx-auto mb-2" />
              <p className="text-sm text-slate-600">All caught up</p>
              <p className="text-xs text-slate-400 mt-1">New suggestions appear after {nextRefinementJobs} more jobs</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {suggestions.map(s => (
                <SuggestionCard
                  key={s.id}
                  suggestion={s}
                  onAccept={() => accept(s.id)}
                  onCustomize={() => customize(s.id)}
                  onSkip={() => skip(s.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Your Templates ── */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-slate-700">Your templates</p>
            <button
              onClick={() => navigate('/onboarding')}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 transition-colors"
            >
              <RotateCcw size={11} /> Re-run onboarding
            </button>
          </div>
          <div className="flex flex-col gap-3">
            {TEMPLATES.map(t => (
              <TemplateCard
                key={t.key}
                template={t}
                hasPending={pendingByTemplate(t.key)}
                onClick={() => setSelectedTemplate(t)}
              />
            ))}
          </div>
        </div>

        {/* ── Community Insights ── */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Globe size={14} className="text-slate-400" />
            <p className="text-sm text-slate-700">From businesses like yours</p>
            <span className="text-xs text-slate-400 bg-slate-100 rounded-full px-2 py-0.5">Anonymous · aggregated</span>
          </div>
          <div className="flex flex-col gap-3">
            {COMMUNITY_INSIGHTS.map((insight, i) => (
              <div key={i} className={`rounded-xl border px-4 py-4 ${insight.color}`}>
                <div className="flex items-start gap-3">
                  <span className="text-xl shrink-0 mt-0.5">{insight.icon}</span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs rounded-full bg-white/70 px-2 py-0.5 ${insight.textColor}`}>{insight.trade}</span>
                      <span className={`${insight.textColor}`}>{insight.stat}</span>
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">{insight.text}</p>
                    <button className={`mt-2 text-xs ${insight.textColor} hover:underline`}>
                      {insight.action} →
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-400 mt-2 px-1">
            Insights are shared anonymously across Fieldly tenants in the same trade. No identifying information is shared.
          </p>
        </div>

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
                <p className="text-sm text-slate-900">Weekly Fieldly Digest</p>
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
      {selectedTemplate && (
        <TemplateDetailModal template={selectedTemplate} onClose={() => setSelectedTemplate(null)} />
      )}
      {digestOpen && (
        <DigestModal settings={digest} onChange={setDigest} onClose={() => setDigestOpen(false)} />
      )}
    </div>
  );
}
