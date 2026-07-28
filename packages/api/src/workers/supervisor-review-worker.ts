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
 * each get ONE gateway call (taskType 'supervisor_annotate'; model resolved
 * by tier in config/ai-routing.ts) producing {riskSummary, flags}. The result is
 * written into the payload via the proposal repo's `update` path —
 * NEVER a status change, NEVER through approveProposal. Any LLM /
 * parse / write failure skips that proposal silently (advisory note;
 * the human reviewer sees the proposal either way and a later sweep
 * retries while the proposal stays in the recency window) — but each
 * failure is now counted in `payload._meta.supervisorAnnotationAttempts`
 * and a proposal that has failed MAX_ANNOTATION_ATTEMPTS times is dropped
 * from later candidate sets. That bound is load-bearing: silently swallowing
 * a DETERMINISTIC failure (the JSON-mode 400 this worker shipped with) meant
 * re-issuing the same doomed call every 60s for 24h per proposal.
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
  annotationAttemptCount,
  hasExhaustedAnnotationAttempts,
  hasSupervisorAnnotation,
  MAX_ANNOTATION_ATTEMPTS,
  payloadWithAnnotationAttempt,
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
  proposalRepo: Pick<ProposalRepository, 'findByStatus' | 'findByStatusSince' | 'findById' | 'update'>;
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

/**
 * System instruction for the annotation call.
 *
 * MUST name the output format explicitly. `annotateProposal` sets
 * `responseFormat: 'json'`, which the OpenAI-compatible adapters translate to
 * `response_format: { type: 'json_object' }` — and OpenAI rejects that request
 * outright ("'messages' must contain the word 'json' in some form") unless the
 * outbound messages mention "json". The original prompt was a prose line plus a
 * `JSON.stringify`'d fact object, neither of which is GUARANTEED to contain the
 * literal substring, so every annotation call 400'd before generating a token
 * and the advisory catch below re-tried it on every 60s sweep for the whole 24h
 * recency window. Stating the schema here fixes the precondition and gives the
 * model the shape `parseAnnotationResponse` actually accepts — dropping
 * `responseFormat` instead would have traded a hard failure for a much higher
 * parse-failure rate. `ensureJsonModeMessages` in the provider adapter is the
 * backstop that keeps this from regressing.
 */
export const SUPERVISOR_ANNOTATE_SYSTEM_PROMPT = `You review pending proposals and write a short advisory note for the human reviewer.

Return valid JSON only (no prose, no markdown fences):
{
  "riskSummary": "<one or two plain sentences on what the reviewer should check>",
  "flags": ["<short_snake_case_tag>", "..."]
}

Rules:
- riskSummary is required and must be non-empty; ${MAX_RISK_SUMMARY_CHARS} characters or fewer.
- flags holds up to ${MAX_FLAGS} short machine-readable tags (e.g. "high_amount", "new_customer", "vague_scope"). Use [] when nothing stands out.
- You are advisory only: never instruct the reviewer to approve or reject.`;

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

/**
 * Outcome of one annotation attempt.
 *   - 'annotated' — the advisory note was written.
 *   - 'skipped'   — benign terminal condition (proposal gone, or it left
 *                   ready_for_review while we were calling the LLM). NOT a
 *                   failure: retrying would be pointless, and it must never
 *                   count against the attempt budget.
 *   - 'failed'    — the model output was unusable. Counts against the budget.
 * A thrown error (provider outage, repo write failure) is caught by the sweep
 * and treated as 'failed' too.
 */
type AnnotationOutcome = 'annotated' | 'skipped' | 'failed';

async function annotateProposal(
  deps: SupervisorAnnotationSweepDeps,
  proposal: Proposal,
  now: Date,
): Promise<AnnotationOutcome> {
  const response = await deps.gateway.complete({
    taskType: SUPERVISOR_ANNOTATE_TASK_TYPE,
    responseFormat: 'json',
    tenantId: proposal.tenantId,
    messages: [
      { role: 'system', content: SUPERVISOR_ANNOTATE_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          'Annotate this pending proposal for the human reviewer. ' +
          'Its facts follow as a JSON object:\n' +
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
    return 'failed';
  }
  const annotation: SupervisorAnnotation = { ...parsed, annotatedAt: now.toISOString() };

  // Narrow-merge: re-fetch the FRESH payload immediately before writing.
  // This shrinks the read-modify-write window from multi-second LLM latency
  // down to single-digit milliseconds, but does NOT eliminate the race — two
  // concurrent annotation writes can still collide in that small window.
  // Future fix: push the merge to the repo layer via a server-side
  // jsonb_set / _meta-merge so the DB handles atomicity.
  //
  // Stale-status guard: if the proposal has left ready_for_review between
  // our sweep-read and now, skip the annotation write. A status change is
  // the strongest signal that the proposal is no longer a candidate (it may
  // have been approved or rejected while we were calling the LLM).
  const fresh = await deps.proposalRepo.findById(proposal.tenantId, proposal.id);
  if (!fresh) return 'skipped';
  if (fresh.status !== 'ready_for_review') {
    deps.logger.warn('supervisor-annotator: proposal status changed during annotation, skipping', {
      tenantId: proposal.tenantId,
      proposalId: proposal.id,
      newStatus: fresh.status,
    });
    return 'skipped';
  }

  const updated = await deps.proposalRepo.update(proposal.tenantId, proposal.id, {
    payload: payloadWithSupervisorAnnotation(fresh.payload, annotation),
  });
  return updated !== null ? 'annotated' : 'skipped';
}

/**
 * Record one failed annotation attempt on the proposal so later sweeps can give
 * up on it. Without this, a proposal that fails every time is retried once per
 * 60s sweep for the whole 24h recency window (~1,440 wasted gateway calls per
 * proposal) with no backoff and no failure marker — which is exactly how the
 * JSON-mode 400 above drained the org's AI quota. The prompt fix removes the
 * known cause; this removes the unbounded amplification for every FUTURE cause.
 *
 * Stays inside the worker's contract: writes `payload._meta` ONLY, never the
 * status, never via `approveProposal`. Uses the same fresh-payload narrow merge
 * as the annotation write so a concurrent edit is preserved, and is itself
 * failure-isolated — if we cannot record the attempt we log and move on rather
 * than turning a soft skip into a hard failure.
 */
async function recordFailedAttempt(
  deps: SupervisorAnnotationSweepDeps,
  proposal: Proposal,
  now: Date,
): Promise<void> {
  try {
    const fresh = await deps.proposalRepo.findById(proposal.tenantId, proposal.id);
    if (!fresh || fresh.status !== 'ready_for_review') return;
    const next = payloadWithAnnotationAttempt(fresh.payload, now.toISOString());
    await deps.proposalRepo.update(proposal.tenantId, proposal.id, { payload: next });
    const attempts = annotationAttemptCount(next);
    if (attempts >= MAX_ANNOTATION_ATTEMPTS) {
      deps.logger.warn('supervisor-annotator: attempt budget exhausted, will stop retrying', {
        tenantId: proposal.tenantId,
        proposalId: proposal.id,
        attempts,
      });
    }
  } catch (err) {
    deps.logger.warn('supervisor-annotator: could not record failed attempt', {
      tenantId: proposal.tenantId,
      proposalId: proposal.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
      // Scale-to-1000 (P3): bound the working set in the DB to the recent window
      // (uses idx_proposals_status_created) instead of loading every
      // ready_for_review proposal and filtering by time in memory. Falls back to
      // the full scan when the windowed method is unavailable (legacy fakes).
      const since = new Date(now.getTime() - recentWindowMs);
      const pending = deps.proposalRepo.findByStatusSince
        ? await deps.proposalRepo.findByStatusSince(tenantId, 'ready_for_review', since)
        : await deps.proposalRepo.findByStatus(tenantId, 'ready_for_review');
      const candidates = pending
        .filter((p) => now.getTime() - p.createdAt.getTime() <= recentWindowMs)
        .filter((p) => !hasSupervisorAnnotation(p.payload))
        // Retry-storm brake: a proposal that has already failed annotation
        // MAX_ANNOTATION_ATTEMPTS times is dropped from the candidate set, so a
        // deterministic failure costs a handful of gateway calls instead of one
        // per 60s sweep for the whole 24h recency window.
        .filter((p) => !hasExhaustedAnnotationAttempts(p.payload))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, maxPerTenant);
      for (const proposal of candidates) {
        try {
          const outcome = await annotateProposal(deps, proposal, now);
          if (outcome === 'annotated') {
            result.annotated += 1;
          } else {
            result.skipped += 1;
            // Only genuine failures burn the budget; a benign 'skipped'
            // (status changed / proposal gone) must not.
            if (outcome === 'failed') await recordFailedAttempt(deps, proposal, now);
          }
        } catch (err) {
          // Advisory: an LLM (or write) failure must never escalate.
          result.skipped += 1;
          deps.logger.warn('supervisor-annotator: annotation failed, skipping proposal', {
            tenantId,
            proposalId: proposal.id,
            attempts: annotationAttemptCount(proposal.payload) + 1,
            maxAttempts: MAX_ANNOTATION_ATTEMPTS,
            error: err instanceof Error ? err.message : String(err),
          });
          await recordFailedAttempt(deps, proposal, now);
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
