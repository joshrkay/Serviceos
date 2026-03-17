import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  ChevronRight, Building2, Users, Shield, Bell, Globe,
  CreditCard, Link, Zap, FileText, Sparkles, Copy, ExternalLink,
  MapPin, Check, Store, RefreshCw, TrendingUp, Mail,
} from 'lucide-react';
import { QuickBooksModal } from './QuickBooksModal';
import { SuppliersSheet } from '../jobs/SuppliersSheet';

export function SettingsPage() {
  const navigate = useNavigate();
  const [aiAuto, setAiAuto]         = useState(true);
  const [reminders, setReminders]   = useState(true);
  const [spanishMode, setSpanishMode] = useState(false);
  const [qbOpen, setQbOpen]         = useState(false);
  const [qbConnected, setQbConnected] = useState(false);
  const [suppliersOpen, setSuppliersOpen] = useState(false);
  const [copied, setCopied]         = useState(false);

  const intakeUrl = 'fieldly.app/intake/ortega-hvac';

  function copyIntakeUrl() {
    navigator.clipboard.writeText(`https://${intakeUrl}`).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const SECTIONS = [
    {
      title: 'Business',
      items: [
        { icon: Building2, label: 'Business profile',    description: 'Name, logo, address, phone',                      action: () => {} },
        { icon: Globe,     label: 'Language & region',   description: 'English / Español, timezone',                     action: () => {} },
        { icon: FileText,  label: 'Terminology',         description: 'Customize labels (e.g. "Quote" vs "Estimate")',    action: () => {} },
      ],
    },
    {
      title: 'Team',
      items: [
        { icon: Users,  label: 'Team members',        description: '3 active · Add or manage technicians', action: () => {} },
        { icon: Shield, label: 'Roles & permissions', description: 'Owner, Admin, Technician',             action: () => {} },
      ],
    },
    {
      title: 'AI & Automation',
      items: [
        { icon: Zap,      label: 'AI approval rules',               description: 'Set what the AI can apply automatically',    action: () => {} },
        { icon: Bell,     label: 'Reminders & follow-ups',          description: 'Auto-send thresholds and timing',             action: () => {} },
        { icon: FileText, label: 'Estimate & invoice templates',    description: 'Default line items, terms, expiry',           action: () => {} },
      ],
    },
    {
      title: 'Payments & billing',
      items: [
        { icon: CreditCard, label: 'Payment methods',        description: 'Card, ACH · Stripe connected',  action: () => {} },
        { icon: FileText,   label: 'Deposit rules',          description: 'Require deposit on estimates over $X', action: () => {} },
        { icon: CreditCard, label: 'Fieldly subscription',   description: 'Pro plan · $79/mo',             action: () => {} },
      ],
    },
    {
      title: 'Integrations',
      items: [
        {
          icon: Link,
          label: 'Calendar sync',
          description: 'Google Calendar connected',
          badge: { label: 'Connected', color: 'bg-green-100 text-green-700' },
          action: () => {},
        },
        {
          icon: Link,
          label: 'QuickBooks',
          description: qbConnected ? 'Connected · Ortega HVAC & Services' : 'Not connected · sync invoices & payments',
          badge: qbConnected
            ? { label: 'Connected', color: 'bg-green-100 text-green-700' }
            : { label: 'Connect', color: 'bg-blue-100 text-blue-700' },
          action: () => setQbOpen(true),
        },
        {
          icon: Link,
          label: 'Zapier',
          description: 'Not connected',
          action: () => {},
        },
      ],
    },
  ];

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-0" style={{ scrollbarWidth: 'thin' }}>
      <div className="p-4 md:p-6 max-w-2xl mx-auto">
        <h1 className="text-slate-900 mb-6">Settings</h1>

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
                  <p className="text-xs text-slate-400 mt-0.5">Your Fieldly learns and adapts over time</p>
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
          <span className="flex size-12 items-center justify-center rounded-xl bg-white/10 text-2xl shrink-0">🔧</span>
          <div className="flex-1 min-w-0">
            <p className="text-white">Ortega HVAC &amp; Services</p>
            <p className="text-xs text-slate-400 mt-0.5">HVAC · Plumbing · Painting · Austin, TX</p>
            <p className="text-xs text-slate-400 mt-0.5">Owner: Mike Ortega</p>
          </div>
          <button className="text-xs text-slate-400 hover:text-white transition-colors shrink-0">Edit</button>
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
              onClick={() => navigate('/intake')}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 transition-colors shrink-0"
            >
              <ExternalLink size={11} /> Preview
            </button>
          </div>
          <div className="px-4 py-3 bg-slate-50 flex items-center gap-3">
            <p className="flex-1 text-xs text-slate-500 truncate font-mono">{intakeUrl}</p>
            <button
              onClick={copyIntakeUrl}
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

        {/* Quick toggles */}
        <div className="rounded-xl bg-white border border-slate-200 divide-y divide-slate-100 mb-5">
          <div className="px-4 py-3">
            <p className="text-xs text-slate-400">Quick settings</p>
          </div>
          {[
            {
              label: 'AI auto-apply for internal updates',
              description: 'Let the assistant apply safe internal changes without asking',
              value: aiAuto, onChange: setAiAuto,
            },
            {
              label: 'Auto send appointment reminders',
              description: 'Text customers 2 hours before scheduled jobs',
              value: reminders, onChange: setReminders,
            },
            {
              label: 'Spanish language mode',
              description: 'Interface and customer communications in Español',
              value: spanishMode, onChange: setSpanishMode,
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
            onClick={() => navigate('/login')}
            className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 hover:bg-slate-50 transition-colors text-left"
          >
            Sign out
          </button>
          <p className="text-center text-xs text-slate-400">Fieldly v1.0 · © 2026</p>
        </div>
      </div>

      {/* QuickBooks modal */}
      {qbOpen && (
        <QuickBooksModal
          onClose={() => {
            setQbOpen(false);
            // In demo: treat dismiss as "connected" if they got past the connect step
            setQbConnected(true);
          }}
        />
      )}

      {/* Suppliers sheet */}
      {suppliersOpen && (
        <SuppliersSheet serviceType="HVAC" onClose={() => setSuppliersOpen(false)} />
      )}
    </div>
  );
}