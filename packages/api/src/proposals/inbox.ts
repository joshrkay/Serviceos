import { Proposal } from './proposal';
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
