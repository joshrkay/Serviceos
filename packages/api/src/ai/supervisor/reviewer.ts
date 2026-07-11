/**
 * N-004 (P2-037) — the Supervisor Agent reviewer (four-check orchestrator).
 *
 * Awaited inline at the pre-dispatch chokepoint. Runs the three deterministic
 * checks (pricing-anomaly, account-routing, brand-voice banned-phrase) first,
 * then ONE lightweight-tier LLM call (missed-urgency + register-drift), all
 * under a hard 60s budget. Every outcome except a hold dispatches normally:
 *   - pass / flag          → attach N-002 markers, dispatch
 *   - critical (harm)      → enforce: hold + escalation alert; shadow: log only
 *   - timeout / error      → fail-open, dispatch, verdict logged
 *
 * Each LLM-bearing review logs one ai_runs row (taskType 'supervisor_review').
 * PII discipline: the prompt carries derived features + the operator-facing
 * summary, never the raw transcript.
 */
import type { LLMRequest, LLMResponse } from '../gateway/gateway';
import type { AiRunRepository } from '../ai-run';
import { createAiRun, startAiRun } from '../ai-run';
import type { Proposal, ProposalRepository } from '../../proposals/proposal';
import { actionClassForProposalType } from '../../proposals/proposal';
import { payloadHeadlineCents } from '../../proposals/payload-money';
import { payloadWithSupervisorMarker } from '../../proposals/supervisor/marker';
import { notifyOwner } from '../../notifications/owner-notifications-instance';
import {
  checkAccountRouting,
  checkBrandVoice,
  checkMissedUrgency,
  checkPricingAnomaly,
  extractRoutingSignals,
  parseSupervisorLlmResponse,
  urgencySeverityPreFilter,
  type AccountType,
} from './checks';
import {
  DEFAULT_SUPERVISOR_REVIEW_MODE,
  isCustomerHarmCheck,
  type CheckResult,
  type ReviewVerdict,
  type SupervisorReviewMode,
} from './types';
import type { SupervisorReviewGate } from './review-gate';
import type { SupervisorReviewRepository } from './reviews-repo';

/** Hard budget for the whole review path. Fail-open on exceed (verdict='timeout'). */
export const SUPERVISOR_REVIEW_BUDGET_MS = 60_000;
export const SUPERVISOR_REVIEW_TASK_TYPE = 'supervisor_review';

interface ReviewerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Structural slice of the gateway — mock-friendly. */
export interface ReviewerGateway {
  complete(request: LLMRequest): Promise<LLMResponse>;
}

/** Rolling-average baseline for the pricing-anomaly check (computed inline; no snapshot table). */
export interface PricingBaseline {
  avgCents: number | null;
  sampleSize: number;
}

export interface SupervisorReviewerDeps {
  gateway: ReviewerGateway;
  aiRunRepo: AiRunRepository;
  reviewsRepo: SupervisorReviewRepository;
  proposalRepo: Pick<ProposalRepository, 'update' | 'updateStatus'>;
  /** Rollout flag per tenant. Absent resolver / error ⇒ default shadow. */
  resolveMode?: (tenantId: string) => Promise<SupervisorReviewMode>;
  /** Rolling average of realized totals for the proposal's category / tenant. */
  resolveBaseline?: (proposal: Proposal) => Promise<PricingBaseline>;
  /** customers.account_type for the proposal's customer. */
  resolveAccountType?: (proposal: Proposal) => Promise<AccountType | null>;
  /** Tenant locked banned-phrase list. */
  resolveBannedPhrases?: (tenantId: string) => Promise<string[]>;
  /** Resolved lightweight-tier model id (logged on ai_runs + supervisor_reviews). */
  supervisorModel: string;
  logger: ReviewerLogger;
  now?: () => Date;
  budgetMs?: number;
}

function timeout(ms: number): Promise<'__timeout__'> {
  return new Promise((resolve) => setTimeout(() => resolve('__timeout__'), ms));
}

/** Build the PII-safe LLM prompt: derived features + operator summary, no raw transcript. */
function buildLlmInput(proposal: Proposal): Record<string, unknown> {
  const meta = (proposal.payload._meta ?? {}) as Record<string, unknown>;
  const src = (proposal.sourceContext ?? {}) as Record<string, unknown>;
  return {
    proposalType: proposal.proposalType,
    actionClass: actionClassForProposalType(proposal.proposalType),
    summary: proposal.summary,
    severity: typeof meta.severity === 'string' ? meta.severity : null,
    scheduledStart:
      typeof proposal.payload.scheduledStart === 'string' ? proposal.payload.scheduledStart : null,
    // Emergency-detector features carried on sourceContext (vocabulary/age/
    // weather/medical mentions), when present. Never the raw transcript.
    callerSignals: src.callerSignals ?? null,
  };
}

interface ReviewComputation {
  checks: CheckResult[];
  aiRunId: string | null;
}

async function runLlmCheck(
  deps: SupervisorReviewerDeps,
  proposal: Proposal,
): Promise<{ signals: ReturnType<typeof parseSupervisorLlmResponse>; aiRunId: string | null }> {
  const input = buildLlmInput(proposal);
  let run = createAiRun({
    tenantId: proposal.tenantId,
    taskType: SUPERVISOR_REVIEW_TASK_TYPE,
    model: deps.supervisorModel,
    inputSnapshot: input,
    createdBy: 'system',
  });
  run = startAiRun(run);
  // Persist the run row FIRST so supervisor_reviews.ai_run_id references a real
  // row (never a fabricated id — see check-fk-path-coverage.sh).
  try {
    await deps.aiRunRepo.create(run);
  } catch (err) {
    deps.logger.warn('supervisor-review: ai_run create failed, continuing without run row', {
      tenantId: proposal.tenantId,
      proposalId: proposal.id,
      error: err instanceof Error ? err.message : String(err),
    });
    // Deterministic-only fallback: no LLM signals, no ai_run_id.
    return { signals: null, aiRunId: null };
  }

  try {
    const response = await deps.gateway.complete({
      taskType: SUPERVISOR_REVIEW_TASK_TYPE,
      responseFormat: 'json',
      tenantId: proposal.tenantId,
      messages: [
        {
          role: 'user',
          content:
            'Review this pending proposal for missed urgency and brand-voice register ' +
            'drift. Reply JSON {"missedUrgency":bool,"medicalMentionUnescalated":bool,' +
            '"registerDrift":bool,"rationale":string}:\n' +
            JSON.stringify(input),
        },
      ],
      metadata: { proposalId: proposal.id },
    });
    const signals = parseSupervisorLlmResponse(response.content);
    await deps.aiRunRepo.updateStatus(proposal.tenantId, run.id, 'completed', {
      outputSnapshot: (signals ?? { unparseable: true }) as Record<string, unknown>,
    });
    return { signals, aiRunId: run.id };
  } catch (err) {
    await deps.aiRunRepo
      .updateStatus(proposal.tenantId, run.id, 'failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      .catch(() => undefined);
    // The LLM half failed; the deterministic checks still stand.
    return { signals: null, aiRunId: run.id };
  }
}

async function computeReview(
  deps: SupervisorReviewerDeps,
  proposal: Proposal,
  now: Date,
): Promise<ReviewComputation> {
  const payload = proposal.payload;

  // Deterministic checks run concurrently (no model needed).
  const [baseline, accountType, bannedPhrases] = await Promise.all([
    deps.resolveBaseline?.(proposal) ?? Promise.resolve<PricingBaseline>({ avgCents: null, sampleSize: 0 }),
    deps.resolveAccountType?.(proposal) ?? Promise.resolve<AccountType | null>(null),
    deps.resolveBannedPhrases?.(proposal.tenantId) ?? Promise.resolve<string[]>([]),
  ]);

  const pricing = checkPricingAnomaly({
    totalCents: payloadHeadlineCents(payload),
    baselineAvgCents: baseline.avgCents,
    sampleSize: baseline.sampleSize,
  });

  const routingSignals = extractRoutingSignals(payload);
  const routing = checkAccountRouting({
    accountType,
    hasB2bMoneyTerms: routingSignals.hasB2bMoneyTerms,
    impliedSegment: routingSignals.impliedSegment,
  });

  const meta = (payload._meta ?? {}) as Record<string, unknown>;
  const preFilter = urgencySeverityPreFilter({
    severity: typeof meta.severity === 'string' ? meta.severity : undefined,
    scheduledStart:
      typeof payload.scheduledStart === 'string' ? payload.scheduledStart : undefined,
    now,
  });

  // A deterministic account-routing CRITICAL can short-circuit the LLM entirely.
  if (routing.verdict === 'critical') {
    const urgency = checkMissedUrgency(null, preFilter);
    const brand = checkBrandVoice({ text: proposal.summary, bannedPhrases });
    return { checks: [urgency, pricing, brand, routing], aiRunId: null };
  }

  const { signals, aiRunId } = await runLlmCheck(deps, proposal);
  const urgency = checkMissedUrgency(signals, preFilter);
  const brand = checkBrandVoice({
    text: proposal.summary,
    bannedPhrases,
    registerDrift: signals?.registerDrift,
  });
  return { checks: [urgency, pricing, brand, routing], aiRunId };
}

/** Aggregate check verdicts into the review-row verdict + hold decision. */
function aggregate(
  checks: CheckResult[],
  mode: SupervisorReviewMode,
): { verdict: ReviewVerdict; critical: boolean; hold: boolean; reasons: string[] } {
  const nonPass = checks.filter((c) => c.verdict !== 'pass');
  const reasons = nonPass
    .map((c) => c.reason)
    .filter((r): r is string => typeof r === 'string' && r.length > 0);
  // Critical is scoped to customer-harm checks (urgency / routing) per the
  // owner-decided enforce carve-out; pricing + brand-voice are flag-only.
  const harmCritical = checks.some(
    (c) => c.verdict === 'critical' && isCustomerHarmCheck(c.id),
  );
  const hold = mode === 'enforce' && harmCritical;
  const verdict: ReviewVerdict = hold ? 'hold' : nonPass.length > 0 ? 'flag' : 'pass';
  return { verdict, critical: harmCritical, hold, reasons };
}

/**
 * Build the process-wide gate. Installed from app.ts; unconfigured paths are
 * unaffected (see review-gate.ts).
 */
export function createSupervisorReviewGate(deps: SupervisorReviewerDeps): SupervisorReviewGate {
  const budgetMs = deps.budgetMs ?? SUPERVISOR_REVIEW_BUDGET_MS;

  return {
    async review({ proposal }) {
      const mode = await (deps.resolveMode?.(proposal.tenantId) ?? Promise.resolve(DEFAULT_SUPERVISOR_REVIEW_MODE)).catch(
        () => DEFAULT_SUPERVISOR_REVIEW_MODE,
      );
      if (mode === 'off') return { hold: false };
      // AMEND P2-007 skip rule: internal-tier proposals bypass the gate.
      if ((proposal.sourceContext as Record<string, unknown> | undefined)?.tier === 'internal') {
        return { hold: false };
      }

      const now = deps.now ? deps.now() : new Date();
      const startMs = now.getTime();
      const shadow = mode !== 'enforce';

      let computation: ReviewComputation | '__timeout__';
      try {
        computation = await Promise.race([computeReview(deps, proposal, now), timeout(budgetMs)]);
      } catch (err) {
        // Fail-open on any error: log an 'error' review and dispatch.
        deps.logger.warn('supervisor-review: check error, failing open', {
          tenantId: proposal.tenantId,
          proposalId: proposal.id,
          error: err instanceof Error ? err.message : String(err),
        });
        await deps.reviewsRepo
          .create({
            tenantId: proposal.tenantId,
            proposalId: proposal.id,
            model: deps.supervisorModel,
            verdict: 'error',
            critical: false,
            checks: {},
            flags: [],
            latencyMs: (deps.now ? deps.now() : new Date()).getTime() - startMs,
            shadow,
          })
          .catch(() => undefined);
        return { hold: false };
      }

      if (computation === '__timeout__') {
        // Fail-open on budget exceed: never block the money loop.
        deps.logger.warn('supervisor-review: budget exceeded, failing open', {
          tenantId: proposal.tenantId,
          proposalId: proposal.id,
          budgetMs,
        });
        await deps.reviewsRepo
          .create({
            tenantId: proposal.tenantId,
            proposalId: proposal.id,
            model: deps.supervisorModel,
            verdict: 'timeout',
            critical: false,
            checks: {},
            flags: [],
            latencyMs: budgetMs,
            shadow,
          })
          .catch(() => undefined);
        return { hold: false };
      }

      const { checks, aiRunId } = computation;
      const { verdict, critical, hold, reasons } = aggregate(checks, mode);
      const latencyMs = (deps.now ? deps.now() : new Date()).getTime() - startMs;
      const checksById = Object.fromEntries(checks.map((c) => [c.id, c]));

      // Persist the review row (best-effort — never blocks dispatch).
      await deps.reviewsRepo
        .create({
          tenantId: proposal.tenantId,
          proposalId: proposal.id,
          aiRunId,
          model: deps.supervisorModel,
          verdict,
          critical,
          checks: checksById,
          flags: reasons,
          latencyMs,
          shadow,
        })
        .catch((err) => {
          deps.logger.warn('supervisor-review: review row write failed', {
            proposalId: proposal.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      // Track the proposal AS MUTATED by this gate so the caller can render the
      // fresh payload/status instead of its stale in-memory copy.
      let reviewed: Proposal = proposal;

      // Attach N-002 markers for every non-pass check (both shadow + enforce).
      if (reasons.length > 0) {
        const markedPayload = payloadWithSupervisorMarker(proposal.payload, reasons);
        reviewed = { ...reviewed, payload: markedPayload };
        await deps.proposalRepo
          .update(proposal.tenantId, proposal.id, {
            payload: markedPayload,
          })
          .catch((err) => {
            deps.logger.warn('supervisor-review: marker write failed', {
              proposalId: proposal.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }

      if (hold) {
        // Enforce + customer-harm critical: force draft (no one-tap link minted,
        // no approval SMS) and fire the high-priority escalation alert.
        reviewed = { ...reviewed, status: 'draft' };
        await deps.proposalRepo
          .updateStatus(proposal.tenantId, proposal.id, 'draft')
          .catch((err) => {
            deps.logger.warn('supervisor-review: hold status write failed', {
              proposalId: proposal.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        await notifyOwner(proposal.tenantId, 'escalation', {
          reason: `Supervisor held a proposal: ${reasons.join('; ') || 'critical review finding'}`,
          proposalId: proposal.id,
        }).catch(() => undefined);
        deps.logger.info('supervisor-review: proposal held (enforce, customer-harm critical)', {
          tenantId: proposal.tenantId,
          proposalId: proposal.id,
          reasons,
        });
      }

      return { hold, proposal: reviewed };
    },
  };
}
