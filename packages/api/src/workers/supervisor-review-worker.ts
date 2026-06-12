/**
 * Rivet P2 F-1 — Supervisor advisory annotator (async half).
 *
 * Mirrors the P0-009 cross-tenant sweep pattern (daily-digest /
 * estimate-reminder workers): app.ts drives `runSupervisorAnnotationSweep`
 * on a 1-minute setInterval behind the leader advisory lock
 * (SWEEP_LOCK.supervisorAnnotate = 590012); one tenant's failure is
 * logged and swallowed so the loop keeps going.
 *
 * Per tenant (gated by the 'supervisor_agent' flag when wired): recent
 * ready_for_review proposals lacking `payload._meta.supervisorAnnotation`
 * each get ONE gateway call (taskType 'supervisor_annotate', cheap model
 * per routing-config) producing {riskSummary, flags}. The result is
 * written into the payload via the proposal repo's `update` path —
 * NEVER a status change, NEVER through approveProposal. Any LLM /
 * parse / write failure skips that proposal silently (advisory note;
 * the human reviewer sees the proposal either way and a later sweep
 * retries while the proposal stays in the recency window).
 *
 * PII discipline: the prompt carries the proposal type, action class,
 * operator-facing summary, headline amount and confidence — not the raw
 * payload.
 */
import type { LLMRequest, LLMResponse } from '../ai/gateway/gateway';
import {
  actionClassForProposalType,
  type Proposal,
  type ProposalRepository,
} from '../proposals/proposal';
import { payloadHeadlineCents } from '../proposals/payload-money';
import {
  hasSupervisorAnnotation,
  payloadWithSupervisorAnnotation,
  type SupervisorAnnotation,
} from '../proposals/supervisor/marker';

/** app.ts sweep cadence. */
export const SUPERVISOR_ANNOTATE_SWEEP_INTERVAL_MS = 60 * 1000;
export const SUPERVISOR_ANNOTATE_TASK_TYPE = 'supervisor_annotate';

/** Only proposals created inside this window are annotated (default 24h). */
const DEFAULT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Per-tenant per-sweep budget so one busy tenant can't starve the tick. */
const DEFAULT_MAX_PER_TENANT = 10;
const MAX_RISK_SUMMARY_CHARS = 500;
const MAX_FLAGS = 10;

interface AnnotatorLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Structural slice of the LLM gateway — mock-friendly. */
export interface AnnotatorGateway {
  complete(request: LLMRequest): Promise<LLMResponse>;
}

export interface SupervisorAnnotationSweepDeps {
  listTenantIds: () => Promise<string[]>;
  proposalRepo: Pick<ProposalRepository, 'findByStatus' | 'findById' | 'update'>;
  gateway: AnnotatorGateway;
  /** Per-tenant 'supervisor_agent' flag gate; absent → all tenants swept. */
  isEnabledForTenant?: (tenantId: string) => Promise<boolean>;
  logger: AnnotatorLogger;
  now?: () => Date;
  recentWindowMs?: number;
  maxPerTenantPerSweep?: number;
}

export interface SupervisorAnnotationSweepResult {
  tenantsSwept: number;
  annotated: number;
  skipped: number;
  failures: number;
}

/** Parse + bound the model output; null on any shape violation. */
export function parseAnnotationResponse(content: string): Omit<SupervisorAnnotation, 'annotatedAt'> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const riskSummary = (parsed as Record<string, unknown>).riskSummary;
  const flags = (parsed as Record<string, unknown>).flags;
  if (typeof riskSummary !== 'string' || riskSummary.trim().length === 0) return null;
  if (!Array.isArray(flags) || !flags.every((f): f is string => typeof f === 'string')) {
    return null;
  }
  return {
    riskSummary: riskSummary.trim().slice(0, MAX_RISK_SUMMARY_CHARS),
    flags: flags.slice(0, MAX_FLAGS),
  };
}

function annotationPrompt(proposal: Proposal): string {
  const amountCents = payloadHeadlineCents(proposal.payload);
  return JSON.stringify({
    proposalType: proposal.proposalType,
    actionClass: actionClassForProposalType(proposal.proposalType),
    summary: proposal.summary,
    amountCents,
    confidenceScore: proposal.confidenceScore ?? null,
    createdAt: proposal.createdAt.toISOString(),
  });
}

async function annotateProposal(
  deps: SupervisorAnnotationSweepDeps,
  proposal: Proposal,
  now: Date,
): Promise<boolean> {
  const response = await deps.gateway.complete({
    taskType: SUPERVISOR_ANNOTATE_TASK_TYPE,
    responseFormat: 'json',
    tenantId: proposal.tenantId,
    messages: [
      {
        role: 'user',
        content:
          'Annotate this pending proposal for the human reviewer:\n' +
          annotationPrompt(proposal),
      },
    ],
    metadata: { proposalId: proposal.id },
  });
  const parsed = parseAnnotationResponse(response.content);
  if (!parsed) {
    deps.logger.warn('supervisor-annotator: unparseable model output, skipping', {
      tenantId: proposal.tenantId,
      proposalId: proposal.id,
    });
    return false;
  }
  const annotation: SupervisorAnnotation = { ...parsed, annotatedAt: now.toISOString() };

  // Narrow-merge: re-fetch the FRESH payload immediately before writing.
  // This shrinks the read-modify-write window from multi-second LLM latency
  // down to single-digit milliseconds, but does NOT eliminate the race — two
  // concurrent annotation writes can still collide in that small window.
  // Future fix: push the merge to the repo layer via a server-side
  // jsonb_set / _meta-merge so the DB handles atomicity.
  // TODO: revisit findByStatus full-load with a created_at-filtered query
  // (e.g. WHERE created_at >= now() - interval '24h') when queues grow.
  //
  // Stale-status guard: if the proposal has left ready_for_review between
  // our sweep-read and now, skip the annotation write. A status change is
  // the strongest signal that the proposal is no longer a candidate (it may
  // have been approved or rejected while we were calling the LLM).
  const fresh = await deps.proposalRepo.findById(proposal.tenantId, proposal.id);
  if (!fresh) return false;
  if (fresh.status !== 'ready_for_review') {
    deps.logger.warn('supervisor-annotator: proposal status changed during annotation, skipping', {
      tenantId: proposal.tenantId,
      proposalId: proposal.id,
      newStatus: fresh.status,
    });
    return false;
  }

  const updated = await deps.proposalRepo.update(proposal.tenantId, proposal.id, {
    payload: payloadWithSupervisorAnnotation(fresh.payload, annotation),
  });
  return updated !== null;
}

/**
 * One sweep tick. Failure isolation at BOTH levels: a throwing tenant
 * is logged and skipped (others still sweep), and a failing proposal
 * within a tenant is logged and skipped (siblings still annotate).
 */
export async function runSupervisorAnnotationSweep(
  deps: SupervisorAnnotationSweepDeps,
): Promise<SupervisorAnnotationSweepResult> {
  const now = deps.now ? deps.now() : new Date();
  const recentWindowMs = deps.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
  const maxPerTenant = deps.maxPerTenantPerSweep ?? DEFAULT_MAX_PER_TENANT;
  const result: SupervisorAnnotationSweepResult = {
    tenantsSwept: 0,
    annotated: 0,
    skipped: 0,
    failures: 0,
  };

  const tenantIds = await deps.listTenantIds();
  for (const tenantId of tenantIds) {
    try {
      if (deps.isEnabledForTenant && !(await deps.isEnabledForTenant(tenantId))) {
        continue;
      }
      result.tenantsSwept += 1;
      const pending = await deps.proposalRepo.findByStatus(tenantId, 'ready_for_review');
      const candidates = pending
        .filter((p) => now.getTime() - p.createdAt.getTime() <= recentWindowMs)
        .filter((p) => !hasSupervisorAnnotation(p.payload))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, maxPerTenant);
      for (const proposal of candidates) {
        try {
          const annotated = await annotateProposal(deps, proposal, now);
          if (annotated) result.annotated += 1;
          else result.skipped += 1;
        } catch (err) {
          // Advisory: an LLM (or write) failure must never escalate.
          result.skipped += 1;
          deps.logger.warn('supervisor-annotator: annotation failed, skipping proposal', {
            tenantId,
            proposalId: proposal.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      result.failures += 1;
      deps.logger.error('supervisor-annotator: tenant sweep failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
