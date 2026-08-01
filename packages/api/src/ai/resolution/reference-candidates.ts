/**
 * B2 — reference→ID candidates for gated money proposals (see docs/plans/
 * 2026-07-17-001-feat-voice-transcript-and-agent-paths-plan.md, unit B2).
 *
 * The money task handlers (SendInvoiceTaskHandler / SendEstimateTaskHandler
 * in voice-extended-tasks.ts, InvoiceEditTaskHandler, EstimateEditTaskHandler)
 * gate a free-text invoice/estimate reference behind a flat
 * `missingFields: ['invoiceId'|'estimateId']`
 * entry — correctly, per each handler's own doc comment on why a
 * search-resolved id must never silently lift that gate (assistant.ts's
 * `dropUnverifiedIds` would strip it right back out on the chat surface,
 * reopening the doomed-approval bug the gate exists to close). But on its
 * own the gate is a dead end: the operator has no way to act on the card
 * except editing in a raw id.
 *
 * `candidatesForReference` reuses the SAME `findByTenant({ search, limit })`
 * ILIKE technique those handlers already run for single-match resolution —
 * just widened to a top-N list — and maps the results into the
 * `EntityCandidate` shape `proposals/resolve-entity.ts`'s annotate-only path
 * reads off `sourceContext.entityCandidates`. That lights up the EXISTING
 * one-tap AmbiguityPicker flow for a gate that previously offered nothing.
 *
 * This module NEVER touches the gate itself — it only produces a candidate
 * list for a caller to layer on top of `sourceContext`. Callers must keep
 * stamping the flat `missingFields` entry exactly as before.
 *
 * Failure-soft by construction: no repo dep, no reference, or a repo error
 * all resolve to `[]` so a hiccup here can never block proposal drafting —
 * the card just degrades to B1's plain Edit-field fallback.
 */
import type { Invoice, InvoiceRepository } from '../../invoices/invoice';
import type { Estimate, EstimateRepository } from '../../estimates/estimate';
import type { Job, JobRepository } from '../../jobs/job';
import type { EntityCandidate } from './entity-resolver';

/**
 * The reference kinds this module resolves candidates for. B7 adds `job`
 * (update_job's jobReference gate) alongside the original money kinds —
 * same ILIKE-search-to-candidate-list technique, no money involved.
 */
export type ReferenceCandidateKind = 'invoice' | 'estimate' | 'job';

export interface CandidatesForReferenceInput {
  tenantId: string;
  /** The free-text reference the operator/LLM produced ("INV-0042", "the Henderson invoice"). */
  reference: string | undefined;
  kind: ReferenceCandidateKind;
  invoiceRepo?: Pick<InvoiceRepository, 'findByTenant'>;
  estimateRepo?: Pick<EstimateRepository, 'findByTenant'>;
  /** B7 — jobRepo for kind: 'job' (update_job's jobReference gate). */
  jobRepo?: Pick<JobRepository, 'findByTenant'>;
  /** Result cap — defaults to 5 (a one-tap picker's practical list size). */
  limit?: number;
}

const DEFAULT_CANDIDATE_LIMIT = 5;

/** Trim a customer message down to a short hint fragment. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** `"<status>"` or `"<status> • <truncated customer message>"` when present. */
function hintFor(status: string, customerMessage: string | undefined): string {
  const trimmed = customerMessage?.trim();
  return trimmed ? `${status} • ${truncate(trimmed, 40)}` : status;
}

/**
 * Map already-fetched invoices to the `EntityCandidate` shape. Exported so a
 * caller that needs the full `Invoice` rows for its own purposes (not just
 * the id) can fetch ONCE and derive candidates from the same result set
 * instead of a second `candidatesForReference` round trip.
 */
export function mapInvoicesToCandidates(
  invoices: Array<Pick<Invoice, 'id' | 'invoiceNumber' | 'status' | 'customerMessage'>>,
): EntityCandidate[] {
  return invoices.map((invoice) => ({
    id: invoice.id,
    kind: 'invoice' as const,
    label: invoice.invoiceNumber,
    hint: hintFor(invoice.status, invoice.customerMessage),
    score: 1,
  }));
}

/** Estimate counterpart of `mapInvoicesToCandidates` — see its doc comment. */
export function mapEstimatesToCandidates(
  estimates: Array<Pick<Estimate, 'id' | 'estimateNumber' | 'status' | 'customerMessage'>>,
): EntityCandidate[] {
  return estimates.map((estimate) => ({
    id: estimate.id,
    kind: 'estimate' as const,
    label: estimate.estimateNumber,
    hint: hintFor(estimate.status, estimate.customerMessage),
    score: 1,
  }));
}

/**
 * B7 — job counterpart of `mapInvoicesToCandidates`. Jobs have no
 * `customerMessage`; `summary` (the job's one-line description) fills the
 * same hint role.
 */
export function mapJobsToCandidates(
  jobs: Array<Pick<Job, 'id' | 'jobNumber' | 'status' | 'summary'>>,
): EntityCandidate[] {
  return jobs.map((job) => ({
    id: job.id,
    kind: 'job' as const,
    label: job.jobNumber,
    hint: hintFor(job.status, job.summary),
    score: 1,
  }));
}

/**
 * Resolve a free-text invoice/estimate reference to a list of candidate
 * entities via the repo's existing ILIKE `search` option. Returns `[]` when:
 *   - the reference is empty/missing,
 *   - the matching repo dep wasn't supplied (deliberately optional — a repo
 *     hiccup or an un-wired dependency must never block proposal drafting),
 *   - the search errors, or
 *   - the search finds nothing.
 *
 * Never throws.
 */
export async function candidatesForReference(
  input: CandidatesForReferenceInput,
): Promise<EntityCandidate[]> {
  const { tenantId, reference, kind, invoiceRepo, estimateRepo, jobRepo, limit = DEFAULT_CANDIDATE_LIMIT } = input;

  if (typeof reference !== 'string' || reference.trim().length === 0) {
    return [];
  }
  const search = reference.trim();

  try {
    if (kind === 'invoice') {
      if (!invoiceRepo) return [];
      const matches = await invoiceRepo.findByTenant(tenantId, { search, limit });
      return mapInvoicesToCandidates(matches);
    }

    if (kind === 'estimate') {
      if (!estimateRepo) return [];
      const matches = await estimateRepo.findByTenant(tenantId, { search, limit });
      return mapEstimatesToCandidates(matches);
    }

    if (kind === 'job') {
      if (!jobRepo) return [];
      const matches = await jobRepo.findByTenant(tenantId, { search, limit });
      return mapJobsToCandidates(matches);
    }

    return [];
  } catch {
    // Failure-soft (see module doc comment): candidates are a UX nicety
    // layered on top of the gate, never load-bearing.
    return [];
  }
}
