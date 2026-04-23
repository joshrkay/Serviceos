import { useState } from 'react';
import {
  Check, Pencil, X, Sparkles, ChevronDown, ChevronUp,
  Brain, Receipt, Calendar, MessageCircle, AlertCircle, Copy,
  ArrowUpRight, UserPlus, HelpCircle, StickyNote, DollarSign, Send,
} from 'lucide-react';
import type { AIProposal, ProposalType } from '../../data/mock-data';

const TYPE_CONFIG: Record<ProposalType, {
  color: string; bg: string; border: string;
  icon: React.ElementType; label: string;
}> = {
  Invoice:    { color: 'text-blue-700',   bg: 'bg-blue-50',   border: 'border-blue-200',  icon: Receipt,         label: 'Invoice' },
  Estimate:   { color: 'text-indigo-700', bg: 'bg-indigo-50', border: 'border-indigo-200',icon: Copy,            label: 'Estimate' },
  Schedule:   { color: 'text-amber-700',  bg: 'bg-amber-50',  border: 'border-amber-200', icon: Calendar,        label: 'Schedule' },
  'Follow-up':{ color: 'text-violet-700', bg: 'bg-violet-50', border: 'border-violet-200',icon: MessageCircle,   label: 'Follow-up' },
  Alert:      { color: 'text-red-700',    bg: 'bg-red-50',    border: 'border-red-200',   icon: AlertCircle,     label: 'Alert' },
  Duplicate:  { color: 'text-slate-600',  bg: 'bg-slate-50',  border: 'border-slate-200', icon: Copy,            label: 'Duplicate' },
  Customer:   { color: 'text-emerald-700',bg: 'bg-emerald-50',border: 'border-emerald-200',icon: UserPlus,       label: 'New customer' },
  // Clarification cards surface when the voice classifier couldn't
  // route a transcript. They're informational prompts (no Approve)
  // so the UI styling is softer than a mutation card.
  Clarification: { color: 'text-slate-600', bg: 'bg-slate-50', border: 'border-slate-200', icon: HelpCircle, label: 'Didn’t catch that' },
  Note:       { color: 'text-zinc-700',   bg: 'bg-zinc-50',   border: 'border-zinc-200',  icon: StickyNote,      label: 'Note' },
  Payment:    { color: 'text-green-700',  bg: 'bg-green-50',  border: 'border-green-200', icon: DollarSign,      label: 'Payment' },
  Send:       { color: 'text-sky-700',    bg: 'bg-sky-50',    border: 'border-sky-200',   icon: Send,            label: 'Send invoice' },
};

/**
 * Friendly labels for classifier intent names, used by the
 * "Did you mean?" chips on a Clarification card. When an intent
 * isn't listed here we show the raw identifier — never a blank chip.
 */
const INTENT_LABELS: Record<string, string> = {
  create_invoice: 'Create invoice',
  draft_estimate: 'Draft estimate',
  create_appointment: 'Schedule appointment',
  update_invoice: 'Update invoice',
  update_estimate: 'Update estimate',
  create_customer: 'Add customer',
  create_job: 'Create job',
  reschedule_appointment: 'Reschedule',
  cancel_appointment: 'Cancel appointment',
  reassign_appointment: 'Reassign',
  add_note: 'Add a note',
  send_invoice: 'Send invoice',
  record_payment: 'Record payment',
};

const CONFIDENCE_CONFIG = {
  High:   { bar: 'bg-green-500',  track: 'bg-green-100', width: 'w-full',   label: 'High confidence',     labelColor: 'text-green-700',  pct: '95%' },
  Medium: { bar: 'bg-amber-400',  track: 'bg-amber-100', width: 'w-3/5',    label: 'Review recommended',  labelColor: 'text-amber-700',  pct: '65%' },
};

interface Props {
  proposal: AIProposal;
  compact?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
}

export function AIProposalCard({ proposal, compact, onApprove, onReject }: Props) {
  const [status,       setStatus]       = useState<'Pending' | 'Approved' | 'Rejected'>(proposal.status);
  const [showReason,   setShowReason]   = useState(false);
  const [editing,      setEditing]      = useState(false);
  const [fieldValues,  setFieldValues]  = useState<Record<string, string>>(
    Object.fromEntries((proposal.editFields ?? []).map(f => [f.key, f.value]))
  );

  const cfg   = TYPE_CONFIG[proposal.type] ?? TYPE_CONFIG.Alert;
  const Icon  = cfg.icon;
  const conf  = CONFIDENCE_CONFIG[proposal.confidence];

  // ── Approved ──────────────────────────────────────────────────
  if (status === 'Approved') {
    return (
      <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 flex items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-green-500 shadow-sm">
          <Check size={14} className="text-white" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-green-900">{proposal.title}</p>
          <p className="text-xs text-green-600 mt-0.5">Applied successfully</p>
        </div>
        {proposal.relatedId && (
          <button className="flex items-center gap-1 text-xs text-green-700 hover:text-green-900 transition-colors shrink-0">
            View <ArrowUpRight size={11} />
          </button>
        )}
      </div>
    );
  }

  // ── Rejected ──────────────────────────────────────────────────
  if (status === 'Rejected') {
    return (
      <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 flex items-center gap-3 opacity-60">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-200">
          <X size={12} className="text-slate-500" />
        </span>
        <p className="text-sm text-slate-400 italic">{proposal.title} — dismissed</p>
      </div>
    );
  }

  // ── Editing ───────────────────────────────────────────────────
  if (editing && proposal.editFields) {
    return (
      <div className={`rounded-xl border ${cfg.border} overflow-hidden`}>
        <div className={`px-4 py-3 ${cfg.bg} flex items-center gap-2`}>
          <Icon size={13} className={cfg.color} />
          <span className={`text-xs ${cfg.color}`}>Edit {cfg.label}</span>
        </div>
        <div className="bg-white px-4 py-3">
          <div className="flex flex-col gap-3 mb-4">
            {proposal.editFields.map(field => (
              <div key={field.key}>
                <label className="block text-xs text-slate-500 mb-1">{field.label}</label>
                <input
                  value={fieldValues[field.key] ?? field.value}
                  onChange={e => setFieldValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none focus:border-blue-400 focus:bg-white transition-colors"
                />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setStatus('Approved'); setEditing(false); onApprove?.(); }}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs text-white hover:bg-blue-700 transition-colors"
            >
              <Check size={12} /> Save & apply
            </button>
            <button
              onClick={() => setEditing(false)}
              className="px-4 py-2 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Pending ───────────────────────────────────────────────────
  return (
    <div className={`rounded-xl border ${cfg.border} overflow-hidden`} style={{ animation: 'fadeSlideIn 0.2s ease' }}>
      {/* Header strip */}
      <div className={`flex items-center justify-between px-4 py-2.5 ${cfg.bg}`}>
        <div className="flex items-center gap-1.5">
          <Icon size={12} className={cfg.color} />
          <span className={`text-xs ${cfg.color}`}>{cfg.label}</span>
        </div>

        {/* Confidence badge */}
        <div className="flex items-center gap-1.5">
          <div className={`w-16 h-1.5 rounded-full overflow-hidden ${conf.track}`}>
            <div className={`h-full rounded-full ${conf.bar} ${conf.width}`} />
          </div>
          <span className={`text-xs ${conf.labelColor}`}>{conf.label}</span>
        </div>
      </div>

      {/* Body */}
      <div className="bg-white px-4 py-3">
        <div className="flex items-start gap-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-100 mt-0.5">
            <Sparkles size={11} className="text-blue-500" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-slate-900">{proposal.title}</p>
            <p className="text-sm text-slate-500 mt-1">{proposal.summary}</p>

            {/* Impact tag */}
            {proposal.impact && (
              <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1">
                <span className="text-xs text-slate-600">{proposal.impact}</span>
              </div>
            )}

            {/* Screen-tap badge for money / comms / irreversible proposals.
                When voiceApprovable === false, we make it explicit that
                voice "yes" is not sufficient here. */}
            {proposal.voiceApprovable === false && (
              <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-2.5 py-1">
                <span className="text-xs text-amber-700">Tap to confirm on screen</span>
              </div>
            )}

            {/* Missing-fields prompt. Approve is blocked until the
                operator fills each listed field via Edit. The task
                handler populates this when it couldn't extract a
                required field from the transcript. */}
            {proposal.missingFields && proposal.missingFields.length > 0 && (
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="text-xs text-amber-900">
                  Needs: {proposal.missingFields.join(', ')}
                </p>
                <p className="text-xs text-amber-700 mt-0.5">Tap Edit to fill before approval.</p>
              </div>
            )}

            {/* "Did you mean?" suggestion chips on Clarification cards.
                Clicking a chip would re-emit with that intent — wired in
                a follow-up slice. For now the chips are display-only so
                the operator knows what the classifier considered. */}
            {proposal.type === 'Clarification' && proposal.suggestedIntents && proposal.suggestedIntents.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className="text-xs text-slate-500 mr-1">Did you mean:</span>
                {proposal.suggestedIntents.map((intent) => (
                  <span
                    key={intent}
                    className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs text-slate-700"
                  >
                    {INTENT_LABELS[intent] ?? intent}
                  </span>
                ))}
              </div>
            )}

            {/* Reasoning toggle */}
            {(proposal.explanation || proposal.reasoning) && (
              <button
                onClick={() => setShowReason(v => !v)}
                className="flex items-center gap-1.5 mt-2.5 text-xs text-slate-400 hover:text-slate-600 transition-colors"
              >
                <Brain size={11} />
                {showReason ? 'Hide reasoning' : 'Why this suggestion?'}
                {showReason ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              </button>
            )}

            {showReason && (
              <div className="mt-2 rounded-lg bg-slate-50 border border-slate-100 px-3 py-2.5" style={{ animation: 'fadeSlideIn 0.15s ease' }}>
                {proposal.reasoning ? (
                  <ul className="flex flex-col gap-1">
                    {proposal.reasoning.map((r, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-slate-500">
                        <span className="shrink-0 mt-0.5 size-1 rounded-full bg-slate-400 mt-1.5" />
                        {r}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-500">{proposal.explanation}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Actions. Clarification cards get only Dismiss — they are
          informational prompts, not mutations, and have no
          execution handler behind them. For real proposals,
          Approve is disabled when there are unfilled missingFields
          so the operator is forced through the Edit flow. */}
      <div className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/80 px-4 py-2.5">
        {proposal.type !== 'Clarification' && (
          <button
            onClick={() => { setStatus('Approved'); onApprove?.(); }}
            disabled={Boolean(proposal.missingFields && proposal.missingFields.length > 0)}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs text-white hover:bg-blue-700 active:bg-blue-800 transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            <Check size={12} /> Approve
          </button>
        )}

        {proposal.editFields && proposal.editFields.length > 0 && (
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs text-slate-700 hover:bg-slate-50 transition-colors"
          >
            <Pencil size={12} /> Edit
          </button>
        )}

        <button
          onClick={() => { setStatus('Rejected'); onReject?.(); }}
          className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
        >
          <X size={12} /> Dismiss
        </button>
      </div>

      <style>{`@keyframes fadeSlideIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }`}</style>
    </div>
  );
}
