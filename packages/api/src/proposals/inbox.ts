import { Proposal, ProposalRepository } from './proposal';
import { PrioritizedProposal, prioritizeProposals } from './prioritization';

/**
 * Inbox response shape for `GET /api/proposals/inbox`. Wraps the
 * already-built `prioritizeProposals` with a server-side cap and
 * per-tier counts so the operator's inbox UI can render a "12 critical"
 * pill without a second query. Pure function — caller fetches the raw
 * proposals from the repo and hands them in.
 */
export interface InboxSummary {
  totalCount: number;
  criticalCount: number;
  highCount: number;
  normalCount: number;
  lowCount: number;
  /** True when `data.length < totalCount`. */
  truncated: boolean;
}

export interface InboxPayload {
  data: PrioritizedProposal[];
  summary: InboxSummary;
}

export function buildInboxPayload(proposals: Proposal[], cap: number): InboxPayload {
  const prioritized = prioritizeProposals(proposals);
  const summary: InboxSummary = {
    totalCount: prioritized.length,
    criticalCount: 0,
    highCount: 0,
    normalCount: 0,
    lowCount: 0,
    truncated: prioritized.length > cap,
  };
  for (const p of prioritized) {
    if (p.urgency === 'critical') summary.criticalCount++;
    else if (p.urgency === 'high') summary.highCount++;
    else if (p.urgency === 'normal') summary.normalCount++;
    else summary.lowCount++;
  }
  return { data: prioritized.slice(0, cap), summary };
}

/**
 * RV-011 — overnight events query. What happened on the proposal queue
 * since a timestamp (typically "yesterday 6pm tenant-local"): proposals
 * CREATED, EXECUTED, or FAILED at/after `since`. Powers the morning
 * "what's my day look like?" voice overview (RV-010).
 *
 * Buckets are not mutually exclusive — a proposal created AND executed
 * overnight appears in both `created` and `executed`; `totalCount` is
 * the count of DISTINCT proposals across buckets.
 *
 * Timestamp semantics:
 *  - created  → `createdAt >= since` (any status).
 *  - executed → status 'executed' with `executedAt >= since`
 *               (falls back to `updatedAt` for historical rows that
 *               predate the executedAt stamp).
 *  - failed   → status 'execution_failed' with `updatedAt >= since` —
 *               there is no dedicated failure timestamp, and
 *               'execution_failed' is terminal, so `updatedAt` is the
 *               failure-time approximation (same convention the digest
 *               uses for completed jobs).
 *
 * Composition style matches the rest of this file: the repo provides
 * the tenant-scoped rows (`findByTenant`), and the tenant predicate is
 * ALSO applied explicitly here as defense in depth — a repo bug can
 * never leak another tenant's proposals into the spoken overview.
 */
export interface OvernightEvents {
  created: Proposal[];
  executed: Proposal[];
  failed: Proposal[];
  /** Distinct proposals across the three buckets. */
  totalCount: number;
}

function executedTime(p: Proposal): Date {
  return p.executedAt ?? p.updatedAt;
}

export async function listSince(
  repo: ProposalRepository,
  tenantId: string,
  since: Date,
): Promise<OvernightEvents> {
  const all = (await repo.findByTenant(tenantId)).filter(
    // Explicit tenant predicate — defense in depth on top of the repo's scoping.
    (p) => p.tenantId === tenantId,
  );
  const cutoff = since.getTime();

  const created = all
    .filter((p) => p.createdAt.getTime() >= cutoff)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const executed = all
    .filter((p) => p.status === 'executed' && executedTime(p).getTime() >= cutoff)
    .sort((a, b) => executedTime(a).getTime() - executedTime(b).getTime());

  const failed = all
    .filter((p) => p.status === 'execution_failed' && p.updatedAt.getTime() >= cutoff)
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());

  const distinct = new Set<string>();
  for (const p of [...created, ...executed, ...failed]) distinct.add(p.id);

  return { created, executed, failed, totalCount: distinct.size };
}
