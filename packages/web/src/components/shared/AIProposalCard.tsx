import { useState } from 'react';
import { toast } from 'sonner';
import {
  Check, Pencil, X, Sparkles, ChevronDown, ChevronUp,
  Brain, Receipt, Calendar, MessageCircle, AlertCircle, Copy,
  ArrowUpRight, UserPlus, HelpCircle, StickyNote, DollarSign, Send,
} from 'lucide-react';
import type {
  AIProposal,
  ProposalType,
  ProposalConfidence,
  ProposalConfidenceLevel,
  ProposalSeverity,
} from '../../data/mock-data';

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

interface ConfidenceDisplay {
  bar: string; track: string; width: string;
  label: string; labelColor: string;
}

// Coarse 2-tier config — the fallback when a proposal carries no
// `_meta` (legacy / non-AI proposals keyed by ProposalConfidence).
const CONFIDENCE_CONFIG: Record<ProposalConfidence, ConfidenceDisplay> = {
  High:   { bar: 'bg-green-500',  track: 'bg-green-100', width: 'w-full',   label: 'High confidence',     labelColor: 'text-green-700' },
  Medium: { bar: 'bg-amber-400',  track: 'bg-amber-100', width: 'w-3/5',    label: 'Review recommended',  labelColor: 'text-amber-700' },
};

// P2-035 (U2) — the 4-tier config sourced from `payload._meta.overallConfidence`.
// Preferred over the coarse bar above whenever a proposal carries `_meta`.
const CONFIDENCE_LEVEL_CONFIG: Record<ProposalConfidenceLevel, ConfidenceDisplay> = {
  high:     { bar: 'bg-green-500',  track: 'bg-green-100', width: 'w-full',   label: 'High confidence',     labelColor: 'text-green-700' },
  medium:   { bar: 'bg-amber-400',  track: 'bg-amber-100', width: 'w-3/5',    label: 'Review recommended',  labelColor: 'text-amber-700' },
  low:      { bar: 'bg-orange-500', track: 'bg-orange-100',width: 'w-2/5',    label: 'Low confidence',      labelColor: 'text-orange-700' },
  very_low: { bar: 'bg-red-500',    track: 'bg-red-100',   width: 'w-1/5',    label: 'Very low confidence', labelColor: 'text-red-700' },
};

// §6.4-B (U5) — severity badge config, keyed by the backend's urgency tier
// (`_meta.severity`). Same tier scale voice triage uses, so the owner sees one
// consistent urgency language across a voice call and a texted photo.
const SEVERITY_CONFIG: Record<ProposalSeverity, { label: string; classes: string }> = {
  TIER_1_EVACUATE:           { label: 'Evacuate',        classes: 'border-red-300 bg-red-100 text-red-800' },
  TIER_2_EMERGENCY_DISPATCH: { label: 'Emergency',       classes: 'border-red-200 bg-red-50 text-red-700' },
  TIER_3_SAME_DAY_URGENT:    { label: 'Same-day urgent', classes: 'border-amber-200 bg-amber-50 text-amber-700' },
  TIER_4_SCHEDULE:           { label: 'Routine',         classes: 'border-slate-200 bg-slate-100 text-slate-600' },
};

// P2-035 (U2) — per-line catalog-grounding badge styling. 'manual' is
// operator-entered, so it carries no badge (mapped to null below).
const PRICING_SOURCE_BADGE: Record<'catalog' | 'ambiguous' | 'uncatalogued', { label: string; classes: string }> = {
  catalog:      { label: 'From catalog',  classes: 'bg-green-50 text-green-700 border-green-200' },
  ambiguous:    { label: 'Needs a pick',  classes: 'bg-amber-50 text-amber-800 border-amber-200' },
  uncatalogued: { label: 'AI-estimated',  classes: 'bg-orange-50 text-orange-700 border-orange-200' },
};

interface Props {
  proposal: AIProposal;
  compact?: boolean;
  /**
   * Invoked when the operator approves. May be async — the card awaits it
   * and treats a thrown error (or rejected promise) as a failure: the
   * optimistic "Approved" state is reverted and an error toast is shown.
   * This is the human-approval gate, so a failed call must NOT look like
   * success.
   */
  onApprove?: () => void | Promise<void>;
  /**
   * Invoked when the operator dismisses. May be async — a thrown error
   * (or rejected promise) reverts the optimistic "Rejected" state and
   * shows an error toast instead of silently faking the dismissal.
   */
  onReject?: () => void | Promise<void>;
}

export function AIProposalCard({ proposal, compact, onApprove, onReject }: Props) {
  const [status,       setStatus]       = useState<'Pending' | 'Approved' | 'Rejected'>(proposal.status);
  const [showReason,   setShowReason]   = useState(false);
  const [editing,      setEditing]      = useState(false);
  const [isApproving,  setIsApproving]  = useState(false);
  const [fieldValues,  setFieldValues]  = useState<Record<string, string>>(
    Object.fromEntries((proposal.editFields ?? []).map(f => [f.key, f.value]))
  );

  // Optimistically flip to Approved, then await the handler. On failure
  // revert to the prior state and surface a toast — never leave a failed
  // approval showing "Applied successfully".
  const runApprove = async (onDone?: () => void) => {
    if (isApproving) return;
    const prevStatus = status;
    setStatus('Approved');
    setIsApproving(true);
    onDone?.();
    try {
      await onApprove?.();
    } catch {
      setStatus(prevStatus);
      toast.error('Couldn’t apply this suggestion. Please try again.');
    } finally {
      setIsApproving(false);
    }
  };

  // Mirror runApprove for dismissals: optimistic flip, revert + toast on
  // failure so a failed server-side rejection never looks like success.
  const runReject = async () => {
    const prevStatus = status;
    setStatus('Rejected');
    try {
      await onReject?.();
    } catch {
      setStatus(prevStatus);
      toast.error('Couldn’t dismiss this suggestion. Please try again.');
    }
  };

  const cfg   = TYPE_CONFIG[proposal.type] ?? TYPE_CONFIG.Alert;
  const Icon  = cfg.icon;
  // P2-035 (U2) — prefer the backend's 4-tier `_meta.overallConfidence`
  // when present; otherwise fall back to the coarse 2-tier bar so legacy
  // proposals (and any with a malformed/absent level) never crash.
  const metaLevel = proposal.meta?.overallConfidence;
  const conf =
    (metaLevel && CONFIDENCE_LEVEL_CONFIG[metaLevel]) ||
    CONFIDENCE_CONFIG[proposal.confidence] ||
    CONFIDENCE_CONFIG.Medium;
  // Per-line catalog-grounding badges (skip 'manual' — operator-entered).
  const pricingBadges = (proposal.lineItems ?? [])
    .map((li) => li.pricingSource)
    .filter(
      (s): s is 'catalog' | 'ambiguous' | 'uncatalogued' =>
        s === 'catalog' || s === 'ambiguous' || s === 'uncatalogued',
    );
  const markers = proposal.meta?.markers ?? [];
  const severity = proposal.meta?.severity;

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
              onClick={() => { void runApprove(() => setEditing(false)); }}
              disabled={isApproving}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs text-white hover:bg-blue-700 transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              <Check size={12} /> {isApproving ? 'Applying…' : 'Save & apply'}
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

            {/* §6.4-B severity marker (U5) — urgency of the visible problem,
                from `_meta.severity` (same tier scale as voice triage). Set on
                MMS photo drafts; absent → not rendered. */}
            {severity && SEVERITY_CONFIG[severity] && (
              <div
                className={`mt-2 ml-2 inline-flex items-center gap-1 rounded-full border px-2.5 py-1 ${SEVERITY_CONFIG[severity].classes}`}
                data-testid="severity-badge"
              >
                <span className="text-xs font-medium">{SEVERITY_CONFIG[severity].label}</span>
              </div>
            )}

            {/* P2-035 (U2) — per-line catalog-grounding badges. Shows
                WHERE each line's price came from (catalog-resolved vs
                AI-estimated vs needs-a-pick). 'manual' lines are
                operator-entered and intentionally not badged. */}
            {pricingBadges.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5" data-testid="pricing-source-badges">
                {pricingBadges.map((source, i) => {
                  const badge = PRICING_SOURCE_BADGE[source];
                  return (
                    <span
                      key={`${source}-${i}`}
                      data-testid={`pricing-source-${source}`}
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${badge.classes}`}
                    >
                      {badge.label}
                    </span>
                  );
                })}
              </div>
            )}

            {/* P2-035 (U2) — "what I wasn't sure about" callouts from
                `_meta.markers`. Each marker explains a low-certainty
                field (uncatalogued price, ambiguous catalog match). */}
            {markers.length > 0 && (
              <div
                className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
                data-testid="confidence-markers"
              >
                <p className="text-xs font-medium text-amber-900">What I wasn’t sure about</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {markers.map((m, i) => (
                    <li key={`${m.path}-${i}`} className="text-xs text-amber-800">
                      {m.reason}
                    </li>
                  ))}
                </ul>
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
            onClick={() => { void runApprove(); }}
            disabled={isApproving || Boolean(proposal.missingFields && proposal.missingFields.length > 0)}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs text-white hover:bg-blue-700 active:bg-blue-800 transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            <Check size={12} /> {isApproving ? 'Applying…' : 'Approve'}
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
          onClick={() => { void runReject(); }}
          className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
        >
          <X size={12} /> Dismiss
        </button>
      </div>

      <style>{`@keyframes fadeSlideIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }`}</style>
    </div>
  );
}
