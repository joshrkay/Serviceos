import { useState } from 'react';
import { useNavigate } from 'react-router';
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
  Invoice:    { color: 'text-primary',   bg: 'bg-primary/10',   border: 'border-primary/30',  icon: Receipt,         label: 'Invoice' },
  Estimate:   { color: 'text-primary', bg: 'bg-primary/10', border: 'border-primary/30',icon: Copy,            label: 'Estimate' },
  Schedule:   { color: 'text-warning',  bg: 'bg-warning/10',  border: 'border-warning/30', icon: Calendar,        label: 'Schedule' },
  'Follow-up':{ color: 'text-primary', bg: 'bg-primary/10', border: 'border-primary/30',icon: MessageCircle,   label: 'Follow-up' },
  Alert:      { color: 'text-destructive',    bg: 'bg-destructive/10',    border: 'border-destructive/30',   icon: AlertCircle,     label: 'Alert' },
  Duplicate:  { color: 'text-muted-foreground',  bg: 'bg-secondary',  border: 'border-border', icon: Copy,            label: 'Duplicate' },
  Customer:   { color: 'text-success',bg: 'bg-success/10',border: 'border-success/30',icon: UserPlus,       label: 'New customer' },
  // Clarification cards surface when the voice classifier couldn't
  // route a transcript. They're informational prompts (no Approve)
  // so the UI styling is softer than a mutation card.
  Clarification: { color: 'text-muted-foreground', bg: 'bg-secondary', border: 'border-border', icon: HelpCircle, label: 'Didn’t catch that' },
  Note:       { color: 'text-foreground',   bg: 'bg-secondary',   border: 'border-border',  icon: StickyNote,      label: 'Note' },
  Payment:    { color: 'text-success',  bg: 'bg-success/10',  border: 'border-success/30', icon: DollarSign,      label: 'Payment' },
  Send:       { color: 'text-primary',    bg: 'bg-primary/10',    border: 'border-primary/30',   icon: Send,            label: 'Send invoice' },
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

/**
 * Story 3.11 — deep-link an approved proposal to the entity it created.
 * `relatedId` carries the backend proposal's resultEntityId. We only link
 * types whose id maps to a real detail route; everything else returns null so
 * the card never renders a "View" button that goes nowhere.
 */
function entityRouteFor(type: ProposalType, relatedId: string): string | null {
  switch (type) {
    // 'Invoice' = a created invoice; 'Send' = an existing invoice being sent —
    // both carry an invoice id in relatedId.
    case 'Invoice':
    case 'Send':
      return `/invoices/${relatedId}`;
    case 'Estimate':
      return `/estimates/${relatedId}`;
    case 'Customer':
      return `/customers/${relatedId}`;
    // Payment/Schedule/Note/etc. have no unambiguous detail route here — no link.
    default:
      return null;
  }
}

interface ConfidenceDisplay {
  bar: string; track: string; width: string;
  label: string; labelColor: string;
}

// Coarse 2-tier config — the fallback when a proposal carries no
// `_meta` (legacy / non-AI proposals keyed by ProposalConfidence).
const CONFIDENCE_CONFIG: Record<ProposalConfidence, ConfidenceDisplay> = {
  High:   { bar: 'bg-success',  track: 'bg-success/10', width: 'w-full',   label: 'High confidence',     labelColor: 'text-success' },
  Medium: { bar: 'bg-warning',  track: 'bg-warning/10', width: 'w-3/5',    label: 'Review recommended',  labelColor: 'text-warning' },
};

// P2-035 (U2) — the 4-tier config sourced from `payload._meta.overallConfidence`.
// Preferred over the coarse bar above whenever a proposal carries `_meta`.
const CONFIDENCE_LEVEL_CONFIG: Record<ProposalConfidenceLevel, ConfidenceDisplay> = {
  high:     { bar: 'bg-success',  track: 'bg-success/10', width: 'w-full',   label: 'High confidence',     labelColor: 'text-success' },
  medium:   { bar: 'bg-warning',  track: 'bg-warning/10', width: 'w-3/5',    label: 'Review recommended',  labelColor: 'text-warning' },
  low:      { bar: 'bg-warning', track: 'bg-warning/10',width: 'w-2/5',    label: 'Low confidence',      labelColor: 'text-warning' },
  very_low: { bar: 'bg-destructive',    track: 'bg-destructive/10',   width: 'w-1/5',    label: 'Very low confidence', labelColor: 'text-destructive' },
};

// §6.4-B (U5) — severity badge config, keyed by the backend's urgency tier
// (`_meta.severity`). Same tier scale voice triage uses, so the owner sees one
// consistent urgency language across a voice call and a texted photo.
const SEVERITY_CONFIG: Record<ProposalSeverity, { label: string; classes: string }> = {
  TIER_1_EVACUATE:           { label: 'Evacuate',        classes: 'border-destructive/40 bg-destructive/10 text-destructive' },
  TIER_2_EMERGENCY_DISPATCH: { label: 'Emergency',       classes: 'border-destructive/30 bg-destructive/10 text-destructive' },
  TIER_3_SAME_DAY_URGENT:    { label: 'Same-day urgent', classes: 'border-warning/30 bg-warning/10 text-warning' },
  TIER_4_SCHEDULE:           { label: 'Routine',         classes: 'border-border bg-secondary text-muted-foreground' },
};

// P2-035 (U2) — per-line catalog-grounding badge styling. 'manual' is
// operator-entered, so it carries no badge (mapped to null below).
const PRICING_SOURCE_BADGE: Record<'catalog' | 'ambiguous' | 'uncatalogued', { label: string; classes: string }> = {
  catalog:      { label: 'From catalog',  classes: 'bg-success/10 text-success border-success/30' },
  ambiguous:    { label: 'Needs a pick',  classes: 'bg-warning/10 text-warning border-warning/30' },
  uncatalogued: { label: 'AI-estimated',  classes: 'bg-warning/10 text-warning border-warning/30' },
};

interface Props {
  proposal: AIProposal;
  /**
   * Invoked when the operator approves. May be async — the card awaits it
   * and treats a thrown error (or rejected promise) as a failure: the
   * optimistic "Approved" state is reverted and an error toast is shown.
   * This is the human-approval gate, so a failed call must NOT look like
   * success.
   */
  onApprove?: (edits?: Record<string, string>) => void | Promise<void>;
  /**
   * Invoked when the operator dismisses. May be async — a thrown error
   * (or rejected promise) reverts the optimistic "Rejected" state and
   * shows an error toast instead of silently faking the dismissal.
   */
  onReject?: () => void | Promise<void>;
}

export function AIProposalCard({ proposal, onApprove, onReject }: Props) {
  const navigate = useNavigate();
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
  const runApprove = async (onDone?: () => void, edits?: Record<string, string>) => {
    if (isApproving) return;
    const prevStatus = status;
    setStatus('Approved');
    setIsApproving(true);
    onDone?.();
    try {
      // Forward the operator's edits so "Save & apply" actually applies them
      // — previously fieldValues was read only by the inputs and never sent,
      // so every edit was silently discarded and the original payload approved.
      await onApprove?.(edits);
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
  // UB-A3 — "Standing instruction applied" chips.
  const appliedInstructions = proposal.meta?.appliedStandingInstructions ?? [];

  // ── Approved ──────────────────────────────────────────────────
  if (status === 'Approved') {
    return (
      <div className="rounded-xl border border-success/30 bg-success/10 px-4 py-3 flex items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-success shadow-sm">
          <Check size={14} className="text-primary-foreground" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-success">{proposal.title}</p>
          <p className="text-xs text-success mt-0.5">Applied successfully</p>
        </div>
        {proposal.relatedId && entityRouteFor(proposal.type, proposal.relatedId) && (
          <button
            type="button"
            onClick={() => navigate(entityRouteFor(proposal.type, proposal.relatedId!)!)}
            className="flex items-center gap-1 min-h-11 px-2 -my-1 text-xs text-success hover:text-success transition-colors shrink-0"
          >
            View <ArrowUpRight size={11} />
          </button>
        )}
      </div>
    );
  }

  // ── Rejected ──────────────────────────────────────────────────
  if (status === 'Rejected') {
    return (
      <div className="rounded-xl border border-border bg-secondary px-4 py-3 flex items-center gap-3 opacity-60">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary">
          <X size={12} className="text-muted-foreground" />
        </span>
        <p className="text-sm text-muted-foreground italic">{proposal.title} — dismissed</p>
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
        <div className="bg-card px-4 py-3">
          <div className="flex flex-col gap-3 mb-4">
            {proposal.editFields.map(field => (
              <div key={field.key}>
                <label className="block text-xs text-muted-foreground mb-1">{field.label}</label>
                <input
                  value={fieldValues[field.key] ?? field.value}
                  onChange={e => setFieldValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:bg-card transition-colors"
                />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { void runApprove(() => setEditing(false), fieldValues); }}
              disabled={isApproving}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:bg-muted disabled:cursor-not-allowed"
            >
              <Check size={12} /> {isApproving ? 'Applying…' : 'Save & apply'}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="px-4 py-2 rounded-lg border border-border text-xs text-muted-foreground hover:bg-secondary transition-colors"
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
      <div className="bg-card px-4 py-3">
        <div className="flex items-start gap-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary mt-0.5">
            <Sparkles size={11} className="text-primary" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-foreground">{proposal.title}</p>
            <p className="text-sm text-muted-foreground mt-1">{proposal.summary}</p>

            {/* Impact tag */}
            {proposal.impact && (
              <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1">
                <span className="text-xs text-muted-foreground">{proposal.impact}</span>
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

            {/* UB-A3 — passive chip per owner standing instruction the
                draft applied (from `_meta.appliedStandingInstructions`,
                server-side intersected with what was injected). */}
            {appliedInstructions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5" data-testid="standing-instruction-chips">
                {appliedInstructions.map((si) => (
                  <span
                    key={si.id}
                    data-testid="standing-instruction-chip"
                    className="inline-flex max-w-full items-center truncate rounded-full border border-border bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                  >
                    Standing instruction applied: {si.text}
                  </span>
                ))}
              </div>
            )}

            {/* P2-035 (U2) — "what I wasn't sure about" callouts from
                `_meta.markers`. Each marker explains a low-certainty
                field (uncatalogued price, ambiguous catalog match). */}
            {markers.length > 0 && (
              <div
                className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2"
                data-testid="confidence-markers"
              >
                <p className="text-xs font-medium text-warning">What I wasn’t sure about</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {markers.map((m, i) => (
                    <li key={`${m.path}-${i}`} className="text-xs text-warning">
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
              <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-warning/10 border border-warning/30 px-2.5 py-1">
                <span className="text-xs text-warning">Tap to confirm on screen</span>
              </div>
            )}

            {/* Missing-fields prompt. Approve is blocked until the
                operator fills each listed field via Edit. The task
                handler populates this when it couldn't extract a
                required field from the transcript. */}
            {proposal.missingFields && proposal.missingFields.length > 0 && (
              <div className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
                <p className="text-xs text-warning">
                  Needs: {proposal.missingFields.join(', ')}
                </p>
                <p className="text-xs text-warning mt-0.5">Tap Edit to fill before approval.</p>
              </div>
            )}

            {/* "Did you mean?" suggestion chips on Clarification cards.
                Clicking a chip would re-emit with that intent — wired in
                a follow-up slice. For now the chips are display-only so
                the operator knows what the classifier considered. */}
            {proposal.type === 'Clarification' && proposal.suggestedIntents && proposal.suggestedIntents.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className="text-xs text-muted-foreground mr-1">Did you mean:</span>
                {proposal.suggestedIntents.map((intent) => (
                  <span
                    key={intent}
                    className="inline-flex items-center rounded-full border border-border bg-card px-2.5 py-0.5 text-xs text-foreground"
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
                className="flex items-center gap-1.5 mt-2.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Brain size={11} />
                {showReason ? 'Hide reasoning' : 'Why this suggestion?'}
                {showReason ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              </button>
            )}

            {showReason && (
              <div className="mt-2 rounded-lg bg-secondary border border-border px-3 py-2.5" style={{ animation: 'fadeSlideIn 0.15s ease' }}>
                {proposal.reasoning ? (
                  <ul className="flex flex-col gap-1">
                    {proposal.reasoning.map((r, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                        <span className="shrink-0 mt-0.5 size-1 rounded-full bg-muted-foreground mt-1.5" />
                        {r}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">{proposal.explanation}</p>
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
      <div className="flex items-center gap-2 border-t border-border bg-secondary/80 px-4 py-2.5">
        {proposal.type !== 'Clarification' && (
          <button
            onClick={() => { void runApprove(); }}
            disabled={isApproving || Boolean(proposal.missingFields && proposal.missingFields.length > 0)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs text-primary-foreground hover:bg-primary/90 active:bg-primary/80 transition-colors disabled:bg-muted disabled:cursor-not-allowed"
          >
            <Check size={12} /> {isApproving ? 'Applying…' : 'Approve'}
          </button>
        )}

        {proposal.editFields && proposal.editFields.length > 0 && (
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2 text-xs text-foreground hover:bg-secondary transition-colors"
          >
            <Pencil size={12} /> Edit
          </button>
        )}

        <button
          onClick={() => { void runReject(); }}
          className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <X size={12} /> Dismiss
        </button>
      </div>

      <style>{`@keyframes fadeSlideIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }`}</style>
    </div>
  );
}
