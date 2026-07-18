import { useEffect, useState, useRef, useCallback } from 'react';
import { isCaptureProposalType } from '@ai-service-os/shared';
import { useApiClient } from '../../lib/apiClient';
import { emitProposalsChanged, PROPOSALS_CHANGED } from '../../lib/proposal-events';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatInTenantTz } from '../../utils/formatInTenantTz';
import { useUndoableApproval, type ApproveResponseLike } from '../../hooks/useUndoableApproval';
import { UndoToast } from '../common/UndoToast';
import { ProposalChainCard, ChainRow } from './ProposalChainCard';
import { TierBreakdown, hasTierBreakdown } from './TierBreakdown';
import { AmbiguityPicker, type AmbiguityCandidate } from './AmbiguityPicker';

type Urgency = 'critical' | 'high' | 'normal' | 'low';

// U2 (P2-035) — the "what I wasn't sure about" signals that already ride to the
// inbox on the serialized proposal but were never rendered.
type ConfidenceLevel = 'high' | 'medium' | 'low' | 'very_low';
type PricingSource = 'catalog' | 'ambiguous' | 'uncatalogued' | 'manual';
// §6.4-B severity tier (same scale as voice triage) — set on MMS photo drafts.
type ProposalSeverity =
  | 'TIER_1_EVACUATE'
  | 'TIER_2_EMERGENCY_DISPATCH'
  | 'TIER_3_SAME_DAY_URGENT'
  | 'TIER_4_SCHEDULE';

interface ProposalMeta {
  overallConfidence?: ConfidenceLevel;
  severity?: ProposalSeverity;
  markers?: Array<{ path: string; reason: string }>;
  // UB-A3 — owner standing instructions the drafting AI applied (server-side
  // intersected with what was injected; ids are never model-invented).
  appliedStandingInstructions?: Array<{ id: string; text: string }>;
}

// §6.4-B (U5) — compact severity badge for the inbox review row. The inbox (not
// AIProposalCard) is where customer-MMS drafts are reviewed, so the urgency
// marker must surface here too. Mirrors the assistant-card badge.
const SEVERITY_CONFIG: Record<ProposalSeverity, { label: string; classes: string }> = {
  TIER_1_EVACUATE:           { label: 'Evacuate',        classes: 'border-destructive/40 bg-destructive/10 text-destructive' },
  TIER_2_EMERGENCY_DISPATCH: { label: 'Emergency',       classes: 'border-destructive/30 bg-destructive/10 text-destructive' },
  TIER_3_SAME_DAY_URGENT:    { label: 'Same-day urgent', classes: 'border-warning/30 bg-warning/10 text-warning' },
  TIER_4_SCHEDULE:           { label: 'Routine',         classes: 'border-border bg-secondary text-muted-foreground' },
};

interface LineItemView {
  id?: string;
  description?: string;
  pricingSource?: PricingSource;
  /** Per-unit price in integer cents (estimate payloads use `unitPrice`). */
  unitPrice?: number;
  // EE-1 good-better-best. The inbox serializes the full payload, so these
  // ride through already — the review card just needs to read them to show
  // the operator the tiers/add-ons they're approving.
  groupKey?: string;
  groupLabel?: string;
  isOptional?: boolean;
  isDefaultSelected?: boolean;
}

// B3 — update_invoice / update_estimate proposals carry `editActions`, not
// `lineItems`. An add/update action's `lineItem` is groundable the same way
// a draft line is (ai/resolution/edit-action-grounding.ts); `remove_line_item`
// actions carry no `lineItem` and are never flagged.
interface EditActionLineItemView {
  description?: string;
  pricingSource?: PricingSource;
}
interface EditActionView {
  type?: string;
  lineItem?: EditActionLineItemView;
}

// U8 (E9) — a candidate for an ambiguous entity reference ("which Bob?"). The
// voice clarification serializes these on the proposal; picking one re-drafts
// the original action with the chosen id.
interface EntityCandidateView {
  id: string;
  label?: string;
  hint?: string;
  kind?: string;
  score?: number;
}

interface InboxProposalRow {
  proposal: {
    id: string;
    proposalType: string;
    summary: string;
    status: string;
    createdAt: string;
    expiresAt?: string;
    // Top-level 0–1 AI confidence (api proposal.ts:121). Drives the
    // "approve all eligible" gate; preferred over the rarely-stamped
    // payload._meta.overallConfidence string.
    confidenceScore?: number;
    // Multi-action chaining: present on proposals decomposed from one
    // utterance. The inbox serializes the full proposal, so these ride
    // through without an API change.
    chainId?: string;
    // The inbox serializes the FULL proposal, so payload (_meta + lineItems)
    // and sourceContext (ambiguous-line candidates) are already present — they
    // were just never read by the UI.
    payload?: {
      _meta?: ProposalMeta;
      lineItems?: LineItemView[];
      // B3 — edit-action lines on update_invoice / update_estimate proposals.
      editActions?: EditActionView[];
      // U8 (E9) — ambiguous entity candidates on a voice_clarification card.
      entityCandidates?: EntityCandidateView[];
    };
    sourceContext?: {
      catalogResolution?: Record<string, AmbiguityCandidate[]>;
      missingFields?: string[];
      entityCandidates?: EntityCandidateView[];
    } & Record<string, unknown>;
  };
  urgency: Urgency;
  reason?: string;
}

const CONFIDENCE_CONFIG: Record<
  ConfidenceLevel,
  { label: string; bar: string; track: string; width: string; labelColor: string }
> = {
  high: { label: 'High confidence', bar: 'bg-success', track: 'bg-success/10', width: 'w-full', labelColor: 'text-success' },
  medium: { label: 'Review recommended', bar: 'bg-warning', track: 'bg-warning/10', width: 'w-3/5', labelColor: 'text-warning' },
  low: { label: 'Low confidence', bar: 'bg-warning', track: 'bg-warning/10', width: 'w-2/5', labelColor: 'text-warning' },
  very_low: { label: 'Very low — needs review', bar: 'bg-destructive', track: 'bg-destructive/10', width: 'w-1/5', labelColor: 'text-destructive' },
};

const PRICING_SOURCE_BADGE: Record<PricingSource, { label: string; classes: string }> = {
  catalog: { label: 'Catalog price', classes: 'bg-success/10 text-success border-success/30' },
  ambiguous: { label: 'Needs a pick', classes: 'bg-warning/10 text-warning border-warning/30' },
  uncatalogued: { label: 'Not in catalog', classes: 'bg-warning/10 text-warning border-warning/30' },
  manual: { label: 'Manual price', classes: 'bg-secondary text-muted-foreground border-border' },
};

/**
 * A feed item is either a standalone proposal or a chain of linked
 * proposals (sharing a chainId). Chains render as one grouped card so a
 * multi-action voice request is approved together, in order.
 */
type FeedItem =
  | { kind: 'single'; row: InboxProposalRow }
  | { kind: 'chain'; chainId: string; rows: InboxProposalRow[]; sortKey: number };

/**
 * Group inbox rows into feed items: rows sharing a `chainId` collapse
 * into one chain item, preserving the server's urgency order via the
 * first-seen index as the chain's sort key. Standalone rows pass through
 * untouched, so the flag-off / single-action experience is unchanged.
 */
/**
 * Human label for an internal proposal-type id. The raw snake_case id
 * (`draft_estimate`) leaked into the card header verbatim (QA 2026-07-02).
 */
function humanizeProposalType(proposalType: string): string {
  const words = proposalType.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function groupIntoFeed(rows: InboxProposalRow[]): FeedItem[] {
  const items: FeedItem[] = [];
  const chainItemByid = new Map<string, Extract<FeedItem, { kind: 'chain' }>>();

  rows.forEach((row, index) => {
    const chainId = row.proposal.chainId;
    if (!chainId) {
      items.push({ kind: 'single', row });
      return;
    }
    const existing = chainItemByid.get(chainId);
    if (existing) {
      existing.rows.push(row);
      return;
    }
    const chainItem: Extract<FeedItem, { kind: 'chain' }> = {
      kind: 'chain',
      chainId,
      rows: [row],
      sortKey: index,
    };
    chainItemByid.set(chainId, chainItem);
    items.push(chainItem);
  });

  return items;
}

function holdExpiryLine(row: InboxProposalRow, timezone: string): string | null {
  if (row.proposal.proposalType !== 'create_booking' || !row.proposal.expiresAt) {
    return null;
  }
  const at = new Date(row.proposal.expiresAt);
  if (Number.isNaN(at.getTime())) return null;
  return `Hold expires ${formatInTenantTz(at, timezone, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

interface InboxSummary {
  totalCount: number;
  criticalCount: number;
  highCount: number;
  normalCount: number;
  lowCount: number;
  truncated: boolean;
}

// §5.5 — an expired schedule proposal card the operator can re-propose.
interface ExpiredCard {
  id: string;
  proposalType: string;
  summary: string;
  status: string;
  expiresAt?: string;
  createdAt: string;
}

// Journey QA 2026-07-02 (bug 10) — an approved proposal whose execution
// failed. Previously these vanished from the inbox with no trace; the card
// surfaces the server's executionError so the operator knows the approval
// didn't land.
interface FailedCard {
  id: string;
  proposalType: string;
  summary: string;
  status: string;
  executionError?: string;
  failedAt?: string;
}

interface InboxResponse {
  data: InboxProposalRow[];
  summary: InboxSummary;
  expired?: ExpiredCard[];
  failed?: FailedCard[];
}

/** Per-id outcome of POST /api/proposals/approve-batch (mirrors the API's
 *  BatchApproveResult). The server re-validates each id, so an ineligible or
 *  blocked proposal lands in `failed` instead of failing the whole batch. */
interface BatchApproveResult {
  approved: string[];
  failed: { id: string; reason: string }[];
}

/**
 * Numeric confidence used by the "approve all eligible" gate. Prefer the
 * top-level `confidenceScore` (api proposal.ts:121); fall back to the
 * coarse `_meta.overallConfidence` string ONLY when there's no numeric score
 * (an explicit 'high' means the model graded it ≥0.8). Absent confidence is
 * treated as 0 — never swept into a bulk approval.
 */
function batchConfidence(proposal: InboxProposalRow['proposal']): number {
  return (
    proposal.confidenceScore ??
    (proposal.payload?._meta?.overallConfidence === 'high' ? 1 : 0)
  );
}

/**
 * One-tap "approve all eligible" gate: capture-class action lane AND numeric
 * confidence ≥0.8 (matches the API's getConfidenceLevel 'high' boundary).
 * Money / customer-comms / irreversible proposals — and anything below 0.8 —
 * are excluded; they must be reviewed individually (CLAUDE.md "Never
 * auto-execute"). The server re-checks every id on approve, so this is the
 * client-side affordance, not the authority.
 */
function isBatchEligibleRow(row: InboxProposalRow): boolean {
  return (
    isCaptureProposalType(row.proposal.proposalType) &&
    batchConfidence(row.proposal) >= 0.8
  );
}

const URGENCY_BADGE: Record<Urgency, { label: string; classes: string }> = {
  critical: { label: 'Critical', classes: 'bg-destructive/10 text-destructive border-destructive/30' },
  high: { label: 'High', classes: 'bg-warning/10 text-warning border-warning/30' },
  normal: { label: 'Normal', classes: 'bg-secondary text-foreground border-border' },
  low: { label: 'Low', classes: 'bg-secondary text-muted-foreground border-border' },
};

/**
 * U2 (P2-035) — renders the per-proposal trust signals the backend already
 * sends: the 4-tier confidence bar, per-line pricing-source badges, free-text
 * markers, and a one-tap picker for each ambiguous catalog line. Returns null
 * when a proposal carries none of these (the common, fully-grounded case), so
 * simple proposals look exactly as before.
 */
function ProposalMarkers({
  row,
  onResolveLine,
  onResolveEntity,
}: {
  row: InboxProposalRow;
  onResolveLine: (proposalId: string, lineIndex: number, catalogItemId: string) => Promise<void>;
  onResolveEntity: (proposalId: string, candidateId: string) => Promise<void>;
}) {
  const meta = row.proposal.payload?._meta;
  const conf = meta?.overallConfidence ? CONFIDENCE_CONFIG[meta.overallConfidence] : null;
  const lineItems = row.proposal.payload?.lineItems ?? [];
  // B3 — update_invoice / update_estimate proposals carry editActions
  // instead of lineItems; they share the SAME sourceContext.catalogResolution
  // map (keyed by index) since a proposal is one shape or the other, never
  // both.
  const editActions = row.proposal.payload?.editActions ?? [];
  const catalogResolution = row.proposal.sourceContext?.catalogResolution ?? {};
  const markers = meta?.markers ?? [];
  const severity = meta?.severity;
  // UB-A3 — "Standing instruction applied" chips.
  const appliedInstructions = meta?.appliedStandingInstructions ?? [];
  const flagged = lineItems
    .map((li, idx) => ({ li, idx }))
    .filter(({ li }) => li.pricingSource && li.pricingSource !== 'catalog');
  // B3 — ambiguous/price-conflict edit-action lines with a recorded
  // candidate set get the same one-tap picker draft lines already have.
  const flaggedEditActions = editActions
    .map((a, idx) => ({ li: a.lineItem, idx }))
    .filter(
      ({ li, idx }) =>
        li?.pricingSource === 'ambiguous' && (catalogResolution[String(idx)]?.length ?? 0) > 0,
    );

  // EE-1 — good-better-best tiers/add-ons the operator is approving (rendered
  // read-only via the shared TierBreakdown; the customer selects on the public
  // estimate).
  const hasSelectable = hasTierBreakdown(lineItems);

  // U8 (E9) — ambiguous entity candidates ("which Bob?") on a
  // voice_clarification card. Read from the payload (where the voice emitter
  // writes them), falling back to sourceContext.
  const entityCandidates: EntityCandidateView[] =
    row.proposal.proposalType === 'voice_clarification'
      ? (row.proposal.payload?.entityCandidates ??
          row.proposal.sourceContext?.entityCandidates ??
          [])
      : [];

  if (
    !conf &&
    flagged.length === 0 &&
    flaggedEditActions.length === 0 &&
    markers.length === 0 &&
    !severity &&
    appliedInstructions.length === 0 &&
    entityCandidates.length === 0 &&
    !hasSelectable
  )
    return null;

  return (
    <div className="mt-2 space-y-1.5" data-testid="proposal-markers">
      {conf && (
        <div className="flex items-center gap-1.5" data-testid="confidence-signal">
          <div className={`h-1.5 w-16 overflow-hidden rounded-full ${conf.track}`}>
            <div className={`h-full rounded-full ${conf.bar} ${conf.width}`} />
          </div>
          <span className={`text-xs ${conf.labelColor}`}>{conf.label}</span>
        </div>
      )}

      {severity && SEVERITY_CONFIG[severity] && (
        <span
          data-testid="severity-badge"
          className={`inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${SEVERITY_CONFIG[severity].classes}`}
        >
          {SEVERITY_CONFIG[severity].label}
        </span>
      )}

      {flagged.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {flagged.map(({ li, idx }) => {
            const badge = PRICING_SOURCE_BADGE[li.pricingSource as PricingSource];
            return (
              <span
                key={li.id ?? idx}
                data-testid="pricing-source-badge"
                className={`inline-flex max-w-full items-center truncate rounded-full border px-1.5 py-0.5 text-[10px] ${badge.classes}`}
              >
                {badge.label}
                {li.description ? `: ${li.description}` : ''}
              </span>
            );
          })}
        </div>
      )}

      {/* EE-1 — good-better-best tiers/add-ons, so the operator sees the
          choices they approve. Read-only; the customer selects on the public
          estimate. Shared with the chained-proposal card. */}
      <TierBreakdown lineItems={lineItems} />

      {markers.map((m, i) => (
        <p key={`${m.path}-${i}`} className="text-xs text-muted-foreground">
          {m.reason}
        </p>
      ))}

      {/* UB-A3 — passive chip per owner standing instruction the draft applied. */}
      {appliedInstructions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {appliedInstructions.map((si) => (
            <span
              key={si.id}
              data-testid="standing-instruction-chip"
              className="inline-flex max-w-full items-center truncate rounded-full border border-border bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              Standing instruction applied: {si.text}
            </span>
          ))}
        </div>
      )}

      {flagged
        .filter(
          ({ li, idx }) =>
            li.pricingSource === 'ambiguous' &&
            (catalogResolution[String(idx)]?.length ?? 0) > 0,
        )
        .map(({ li, idx }) => (
          <AmbiguityPicker
            key={`picker-${li.id ?? idx}`}
            lineDescription={li.description ?? `Line ${idx + 1}`}
            candidates={catalogResolution[String(idx)]}
            onPick={(catalogItemId) => onResolveLine(row.proposal.id, idx, catalogItemId)}
          />
        ))}

      {/* B3 — one-tap picker for an ambiguous / price-conflicting editAction
          line (update_invoice / update_estimate). Same resolve-line POST as
          the lineItems picker above — the server branches on
          Array.isArray(payload.editActions) to know which shape to patch. */}
      {flaggedEditActions.map(({ li, idx }) => (
        <AmbiguityPicker
          key={`edit-action-picker-${idx}`}
          lineDescription={li?.description ?? `Line ${idx + 1}`}
          candidates={catalogResolution[String(idx)]}
          onPick={(catalogItemId) => onResolveLine(row.proposal.id, idx, catalogItemId)}
        />
      ))}

      {/* U8 (E9) — entity disambiguation picker. Picking a candidate re-drafts
          the original action with the chosen id instead of discarding it. */}
      {entityCandidates.length > 0 && (
        <AmbiguityPicker
          lineDescription={
            typeof row.proposal.sourceContext?.entityReference === 'string'
              ? (row.proposal.sourceContext.entityReference as string)
              : 'the reference'
          }
          candidates={entityCandidates.map((c) => ({
            id: c.id,
            label: c.label ?? c.id,
            ...(c.hint ? { hint: c.hint } : {}),
            score: c.score ?? 0,
          }))}
          onPick={(candidateId) => onResolveEntity(row.proposal.id, candidateId)}
        />
      )}
    </div>
  );
}

export function InboxPage() {
  const apiFetch = useApiClient();
  const tz = useTenantTimezone();
  const [rows, setRows] = useState<InboxProposalRow[]>([]);
  const [summary, setSummary] = useState<InboxSummary | null>(null);
  const [expired, setExpired] = useState<ExpiredCard[]>([]);
  const [failed, setFailed] = useState<FailedCard[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // D5 / Finding 2 — approval-undo toast, now driven by the SERVER's undo
  // window via the shared hook (the countdown is anchored to `undoExpiresAt`,
  // so the tail the approve round-trip already ate is never offered).
  const undoToast = useUndoableApproval({
    requestUndo: (proposalId) =>
      apiFetch(`/api/proposals/${proposalId}/undo`, { method: 'POST' }),
    // Refresh the inbox to show the undone proposal (background — keep rows).
    onUndone: () => emitProposalsChanged(),
    onError: (message) => setError(message),
  });

  const hasLoadedRef = useRef(false);
  const loadInbox = useCallback(
    async (opts?: { background?: boolean }) => {
      const background = opts?.background === true && hasLoadedRef.current;
      if (!background) {
        setIsLoading(true);
        setError(null);
      }
      try {
        const res = await apiFetch('/api/proposals/inbox');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as InboxResponse;
        hasLoadedRef.current = true;
        setRows(body.data);
        setSummary(body.summary);
        setExpired(body.expired ?? []);
        setFailed(body.failed ?? []);
        setError(null);
      } catch (err) {
        if (background) return;
        setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!background) setIsLoading(false);
      }
    },
    [apiFetch],
  );

  useEffect(() => {
    void loadInbox({ background: hasLoadedRef.current });
  }, [loadInbox]);

  // Live sync: when another surface (assistant, SMS one-tap, dispatch)
  // mutates proposals, refresh without flashing the loading copy.
  useEffect(() => {
    const onChanged = () => void loadInbox({ background: true });
    window.addEventListener(PROPOSALS_CHANGED, onChanged);
    return () => window.removeEventListener(PROPOSALS_CHANGED, onChanged);
  }, [loadInbox]);

  async function actOnProposal(id: string, action: 'approve' | 'reject'): Promise<void> {
    const removed = rows.find((r) => r.proposal.id === id);
    setRows((prev) => prev.filter((r) => r.proposal.id !== id));
    try {
      const res = await apiFetch(`/api/proposals/${id}/${action}`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      emitProposalsChanged();
      // D5 / Finding 2 — show the undo toast for approvals, anchored to the
      // server's real undo window (approvedAt / undoExpiresAt ride the approve
      // response) rather than a fresh client 5s that ignores round-trip latency.
      if (action === 'approve' && removed) {
        const body = (await res.json().catch(() => null)) as ApproveResponseLike | null;
        undoToast.start({ proposalId: id, summary: removed.proposal.summary, response: body });
      }
    } catch (err) {
      if (removed) setRows((prev) => [removed, ...prev]);
      setError(err instanceof Error ? err.message : `${action} failed`);
    }
  }

  /**
   * §5.5 — re-propose an expired schedule card: POSTs to the re-propose
   * endpoint, which mints a fresh draft (new 48h clock). Optimistically removes
   * the expired card; restores it on failure. The new draft appears in the
   * pending feed on the next poll / refresh.
   */
  async function repropose(id: string): Promise<void> {
    const removed = expired.find((c) => c.id === id);
    setExpired((prev) => prev.filter((c) => c.id !== id));
    try {
      const res = await apiFetch(`/api/proposals/${id}/re-propose`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setError(null);
      emitProposalsChanged();
    } catch (err) {
      if (removed) setExpired((prev) => [removed, ...prev]);
      setError(err instanceof Error ? err.message : 'Re-propose failed');
    }
  }

  /**
   * U2 — resolve an ambiguous catalog line to one of its candidates. POSTs to
   * the resolve-line endpoint (which patches the draft and may move it to
   * ready_for_review, but NEVER approves), then merges the returned proposal
   * back into the row so the picker disappears and the price shows as grounded.
   */
  async function resolveLine(
    proposalId: string,
    lineIndex: number,
    catalogItemId: string,
  ): Promise<void> {
    const res = await apiFetch(`/api/proposals/${proposalId}/resolve-line`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineIndex, catalogItemId }),
    });
    if (!res.ok) {
      setError(`Couldn't resolve that line (HTTP ${res.status})`);
      throw new Error(`HTTP ${res.status}`);
    }
    const updated = (await res.json()) as InboxProposalRow['proposal'];
    setError(null); // a prior failure shouldn't keep showing after a success
    setRows((prev) =>
      prev.map((r) =>
        r.proposal.id === proposalId
          ? { ...r, proposal: { ...r.proposal, ...updated } }
          : r,
      ),
    );
    emitProposalsChanged();
  }

  /**
   * U8 (E9) — resolve an ambiguous entity reference ("which Bob?") to one of
   * its candidates. POSTs to the resolve-entity endpoint (which re-drafts the
   * original action with the chosen id and moves it to ready_for_review, but
   * NEVER approves), then merges the returned proposal so the picker disappears
   * and the re-drafted action surfaces for review.
   */
  async function resolveEntity(proposalId: string, candidateId: string): Promise<void> {
    const res = await apiFetch(`/api/proposals/${proposalId}/resolve-entity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateId }),
    });
    if (!res.ok) {
      setError(`Couldn't resolve that reference (HTTP ${res.status})`);
      throw new Error(`HTTP ${res.status}`);
    }
    const updated = (await res.json()) as InboxProposalRow['proposal'];
    setError(null);
    setRows((prev) =>
      prev.map((r) =>
        r.proposal.id === proposalId
          ? { ...r, proposal: { ...r.proposal, ...updated } }
          : r,
      ),
    );
    emitProposalsChanged();
  }

  /**
   * Approve a whole chain in one tap via the batch-approve endpoint.
   * Optimistically removes every member; restores them on failure. The
   * backend executes them in dependency order (a dependent can't run
   * until its parent has), so a single batch approval is safe.
   */
  async function approveChain(ids: string[]): Promise<void> {
    const idSet = new Set(ids);
    const removed = rows.filter((r) => idSet.has(r.proposal.id));
    setRows((prev) => prev.filter((r) => !idSet.has(r.proposal.id)));
    try {
      const res = await apiFetch('/api/proposals/approve-batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposalIds: ids }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      emitProposalsChanged();
    } catch (err) {
      if (removed.length > 0) setRows((prev) => [...removed, ...prev]);
      setError(err instanceof Error ? err.message : 'Approve all failed');
    }
  }

  /**
   * "Approve all eligible" — one POST to the batch endpoint for every
   * capture-class, high-confidence proposal. Unlike `approveChain`, this reads
   * the per-id `{ approved, failed }` result: a partial failure restores ONLY
   * the still-pending (failed) rows and leaves the approved ones gone, so a
   * single blocked proposal doesn't bounce the whole batch back into the feed.
   * A transport error (non-2xx) restores everything, like the per-row path.
   */
  async function approveEligible(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const removed = rows.filter((r) => idSet.has(r.proposal.id));
    setRows((prev) => prev.filter((r) => !idSet.has(r.proposal.id)));
    try {
      const res = await apiFetch('/api/proposals/approve-batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposalIds: ids }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = (await res.json()) as BatchApproveResult;
      const failedIds = new Set(result.failed.map((f) => f.id));
      if (failedIds.size > 0) {
        const restore = removed.filter((r) => failedIds.has(r.proposal.id));
        setRows((prev) => [...restore, ...prev]);
        setError(
          `${failedIds.size} couldn't be approved and ${
            failedIds.size === 1 ? 'is' : 'are'
          } still waiting.`,
        );
      } else {
        setError(null);
      }
      emitProposalsChanged();
    } catch (err) {
      if (removed.length > 0) setRows((prev) => [...removed, ...prev]);
      setError(err instanceof Error ? err.message : 'Approve all failed');
    }
  }

  /**
   * Reject every member of a chain. There is no batch-reject endpoint —
   * a chain that shouldn't proceed is rejected member-by-member. Done
   * sequentially so a mid-chain failure surfaces and the rest are still
   * attempted.
   */
  async function rejectChain(ids: string[]): Promise<void> {
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      await actOnProposal(id, 'reject');
    }
  }

  const feed = groupIntoFeed(rows);
  const eligible = rows.filter(isBatchEligibleRow);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-6 md:py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-foreground">Inbox</h1>
          <p className="text-sm text-muted-foreground">
            Proposals waiting for your approval, urgency-sorted.
          </p>
          {summary && summary.totalCount > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {summary.totalCount} waiting
              {summary.criticalCount > 0 && ` · ${summary.criticalCount} urgent`}
              {summary.truncated && ' (showing first 100)'}
            </p>
          )}
        </div>

        {isLoading && rows.length === 0 && expired.length === 0 && failed.length === 0 && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {!isLoading && !error && rows.length === 0 && expired.length === 0 && failed.length === 0 && (
          <div className="rounded-xl border border-border bg-card px-6 py-12 text-center">
            <p className="text-sm text-foreground font-medium">Nothing waiting.</p>
            <p className="text-xs text-muted-foreground mt-1">
              When the voice agent or the system needs your approval, it'll show up here.
            </p>
          </div>
        )}

        {/* One-tap "approve all eligible" — only the capture-class,
            high-confidence lane. Money / comms / irreversible and
            anything below high confidence are deliberately excluded and
            still require an individual tap (CLAUDE.md "Never auto-execute"). */}
        {eligible.length > 0 && (
          <div
            data-testid="approve-all-eligible"
            className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3"
          >
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {eligible.length} high-confidence
              </span>{' '}
              eligible for one-tap approval. Money, messages, and irreversible
              actions are excluded.
            </p>
            <button
              type="button"
              onClick={() => approveEligible(eligible.map((r) => r.proposal.id))}
              className="min-h-11 shrink-0 rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              Approve all {eligible.length}
            </button>
          </div>
        )}

        <ul className="space-y-2">
          {feed.map((item) => {
            if (item.kind === 'chain') {
              return (
                <ProposalChainCard
                  key={`chain-${item.chainId}`}
                  rows={item.rows as ChainRow[]}
                  onApproveChain={approveChain}
                  onRejectChain={rejectChain}
                />
              );
            }
            const { row } = item;
            const badge = URGENCY_BADGE[row.urgency];
            return (
              <li
                key={row.proposal.id}
                data-testid="inbox-row"
                className="rounded-xl border border-border bg-card px-4 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${badge.classes}`}>
                        {badge.label}
                      </span>
                      <span className="text-xs text-muted-foreground">{humanizeProposalType(row.proposal.proposalType)}</span>
                    </div>
                    <p className="text-sm text-foreground font-medium truncate">{row.proposal.summary}</p>
                    {holdExpiryLine(row, tz) && (
                      <p className="text-xs text-warning mt-0.5">{holdExpiryLine(row, tz)}</p>
                    )}
                    {row.reason && <p className="text-xs text-muted-foreground mt-0.5">{row.reason}</p>}
                    <ProposalMarkers row={row} onResolveLine={resolveLine} onResolveEntity={resolveEntity} />
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => actOnProposal(row.proposal.id, 'reject')}
                      className="rounded-lg border border-border bg-card text-foreground text-sm px-3 py-1.5 hover:bg-secondary"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => actOnProposal(row.proposal.id, 'approve')}
                      className="rounded-lg bg-primary text-primary-foreground text-sm px-3 py-1.5 hover:bg-primary/90"
                    >
                      Approve
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        {/* Journey QA 2026-07-02 (bug 10) — approvals that failed to execute.
            Without this section an approved-then-failed proposal silently
            vanished; the card shows the server's executionError. */}
        {failed.length > 0 && (
          <div className="mt-8" data-testid="failed-section">
            <h2 className="text-sm font-semibold text-foreground mb-2">
              Approved but failed to execute
            </h2>
            <ul className="space-y-2">
              {failed.map((card) => (
                <li
                  key={card.id}
                  data-testid="failed-row"
                  className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-destructive/30 bg-destructive/10 text-destructive">
                      Failed
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {humanizeProposalType(card.proposalType)}
                    </span>
                  </div>
                  <p className="text-sm text-foreground font-medium truncate">{card.summary}</p>
                  {card.executionError && (
                    <p className="text-xs text-destructive mt-0.5" data-testid="execution-error">
                      {card.executionError}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* §5.5 — expired schedule proposal cards, clearly marked and re-proposable. */}
        {expired.length > 0 && (
          <div className="mt-8" data-testid="expired-section">
            <h2 className="text-sm font-semibold text-foreground mb-2">Expired schedule proposals</h2>
            <ul className="space-y-2">
              {expired.map((card) => (
                <li
                  key={card.id}
                  data-testid="expired-row"
                  className="rounded-xl border border-border bg-secondary px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-secondary text-muted-foreground border-border">
                          Expired
                        </span>
                        <span className="text-xs text-muted-foreground">{humanizeProposalType(card.proposalType)}</span>
                      </div>
                      <p className="text-sm text-foreground font-medium truncate">{card.summary}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => repropose(card.id)}
                      className="rounded-lg border border-border bg-card text-foreground text-sm px-3 py-1.5 hover:bg-secondary shrink-0"
                    >
                      Re-propose
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* D5 / Finding 2 — undo toast, server-window-driven via useUndoableApproval. */}
      {undoToast.isActive && (
        <UndoToast
          summary={undoToast.summary}
          remainingMs={undoToast.remainingMs}
          windowMs={undoToast.windowMs}
          onUndo={() => void undoToast.undo()}
          onDismiss={undoToast.dismiss}
        />
      )}
    </div>
  );
}
