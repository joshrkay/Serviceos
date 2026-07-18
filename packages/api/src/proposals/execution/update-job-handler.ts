import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { JobRepository, UpdateJobInput, JobStatus, updateJob } from '../../jobs/job';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import {
  JobTimelineRepository,
  transitionJobStatus,
} from '../../jobs/job-lifecycle';
import {
  runJobCompletionEffects,
  JobCompletionEffectsDeps,
  CompletionEffectsLogger,
} from '../../jobs/completion-effects';
import { createLogger, Logger } from '../../logging/logger';
import { ValidationError, ForbiddenError, NotFoundError } from '../../shared/errors';

const VALID_STATUSES = new Set<JobStatus>([
  'new',
  'scheduled',
  'dispatched',
  'in_progress',
  'completed',
  'invoiced',
  'closed',
  'canceled',
]);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

/**
 * The proposal executor initiates the transition on behalf of an ALREADY-approved
 * proposal (the human tapped approve on the review card). It has no interactive
 * session role, so it acts as `'system'` — the same role the job-appointment sync
 * and other executor-initiated domain writes use. `'system'` is one of
 * BACKWARD_MOVE_ROLES, but the update_job payload carries no `reason`, so any
 * backward move still fails cleanly inside transitionJobStatus ("a reason is
 * required to move a job backward") — backward corrections stay on the governed
 * POST /:id/transition endpoint, never the voice update path.
 */
const TRANSITION_ACTOR_ROLE = 'system';

const defaultLogger: Logger = createLogger({
  service: 'update-job-handler',
  environment: process.env.NODE_ENV || 'development',
});

/**
 * Executes `update_job` proposals — a human-approved edit to an existing job's
 * status / priority / title / description (B7,
 * docs/plans/2026-07-17-001-feat-voice-transcript-and-agent-paths-plan.md).
 *
 * Status changes are routed through the GOVERNED lifecycle transition
 * (`transitionJobStatus`, jobs/job-lifecycle.ts) — the SAME mechanism
 * `POST /api/jobs/:id/transition` uses — so a voice-approved "mark it completed"
 * gets forward/backward-move validation, the `completedAt` stamp, a timeline
 * entry, the `job.status_changed` audit, and the completion side effects
 * (auto-invoice + milestone minting, via jobs/completion-effects.ts). Before
 * this fix the handler wrote status via a raw `updateJob`, so a completed
 * transition invoiced nothing, minted no milestones, never stamped
 * `completedAt` (starving the thank-you/review sweeps), and even accepted an
 * invalid canceled → completed jump.
 *
 * Non-status field edits (title/priority/description) still go through the
 * `updateJob` domain function. Ordering is all-or-nothing on the status change:
 * the transition runs FIRST and, if it fails validation, the whole execution
 * fails cleanly with that error and NO field delta is written.
 *
 * Money (deposit/pricing) and schedule (appointment) fields are out of scope by
 * construction: the Zod payload (proposals/contracts.ts `updateJobPayloadSchema`)
 * only ever carries status/priority/title/description.
 */
export class UpdateJobExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'update_job';

  private readonly logger: CompletionEffectsLogger & Pick<Logger, 'warn'>;

  constructor(
    private readonly jobRepo?: JobRepository,
    private readonly auditRepo?: AuditRepository,
    // Required to route a status change through the governed transition
    // (timeline entry). A status change without it fails cleanly; field-only
    // edits don't need it.
    private readonly timelineRepo?: JobTimelineRepository,
    // Completion side effects (auto-invoice + milestone minting). Optional so
    // pool-less unit tests can omit it; production wires it via app.ts /
    // createExecutionHandlerRegistry. When absent AND a completed transition
    // happens, we log a loud warn that the effects were skipped rather than
    // failing the completion (the transition itself is the money-safety fix;
    // the sweeps/next mutation reconcile money-state).
    private readonly completionDeps?: JobCompletionEffectsDeps,
    logger?: CompletionEffectsLogger & Pick<Logger, 'warn'>,
  ) {
    this.logger = logger ?? defaultLogger;
  }

  // Degrades to a hard failure (never a synthetic-id passthrough) without the
  // job repo OR the timeline repo — mutating an EXISTING entity with no repo
  // has no safe degraded mode, and a status change with no timeline repo can't
  // write the governed transition record. The boot-time guard
  // (wiring-assertions.ts) fails boot when a pool is configured but this is
  // false, so the no-op path can never run in production.
  isFullyWired(): boolean {
    return Boolean(this.jobRepo) && Boolean(this.timelineRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload || typeof payload !== 'object') {
      return { success: false, error: 'Payload is required' };
    }
    const p = payload as Record<string, unknown>;

    const jobId = p.jobId;
    if (!jobId || typeof jobId !== 'string') {
      return { success: false, error: 'Payload must include a valid jobId' };
    }

    // Non-status field deltas go through updateJob; status is routed through
    // the governed transition, so keep it separate.
    const fieldInput: UpdateJobInput = {};
    if (typeof p.title === 'string' && p.title.trim().length > 0) {
      fieldInput.summary = p.title.trim();
    }
    if (typeof p.description === 'string') {
      fieldInput.problemDescription = p.description;
    }
    if (typeof p.priority === 'string' && VALID_PRIORITIES.has(p.priority)) {
      fieldInput.priority = p.priority as UpdateJobInput['priority'];
    }
    const desiredStatus: JobStatus | undefined =
      typeof p.status === 'string' && VALID_STATUSES.has(p.status as JobStatus)
        ? (p.status as JobStatus)
        : undefined;

    const fieldKeys = Object.keys(fieldInput);
    if (fieldKeys.length === 0 && !desiredStatus) {
      return {
        success: false,
        error: 'Payload must include at least one field to update: status, priority, title, or description',
      };
    }

    if (!this.jobRepo) {
      // No synthetic success: a missing repo is a wiring fault on an
      // EXISTING-entity mutation, never a silent no-op that reports success
      // while persisting nothing.
      return { success: false, error: 'handler_not_wired:jobRepo' };
    }

    // Read current status to decide whether the status actually changes. A
    // no-op status (equal to current) is skipped rather than fed to
    // transitionJobStatus (which would reject X → X as an invalid transition).
    const current = await this.jobRepo.findById(context.tenantId, jobId);
    if (!current) {
      return { success: false, error: `Job ${jobId} not found in this tenant` };
    }
    const willTransition = desiredStatus !== undefined && desiredStatus !== current.status;

    // ── 1. Governed status transition FIRST (all-or-nothing). ──────────────
    // If it fails validation, the whole execution fails with that error and no
    // field delta is written below.
    let transitionedJob = current;
    if (willTransition) {
      if (!this.timelineRepo) {
        return { success: false, error: 'handler_not_wired:timelineRepo' };
      }
      try {
        const res = await transitionJobStatus(
          context.tenantId,
          jobId,
          desiredStatus!,
          context.executedBy,
          TRANSITION_ACTOR_ROLE,
          this.jobRepo,
          this.timelineRepo,
          this.auditRepo,
        );
        transitionedJob = res.job;
      } catch (err) {
        // A rejected transition (invalid move, backward without reason,
        // post-completion step-back, not-found) fails the execution cleanly —
        // no partial write. Any other error (transient DB fault) propagates so
        // the executor retries, matching UpdateEstimateExecutionHandler.
        if (
          err instanceof ValidationError ||
          err instanceof ForbiddenError ||
          err instanceof NotFoundError
        ) {
          return { success: false, error: err.message };
        }
        throw err;
      }
    }

    // ── 2. Non-status field edits via the domain function. ─────────────────
    // Audit is emitted once, consolidated, below — so no auditRepo here.
    if (fieldKeys.length > 0) {
      const updated = await updateJob(context.tenantId, jobId, fieldInput, this.jobRepo);
      if (!updated) {
        return { success: false, error: `Job ${jobId} not found in this tenant` };
      }
    }

    // ── 3. Keep the job.updated audit for the overall edit. ────────────────
    // transitionJobStatus already wrote the transition record (timeline +
    // job.status_changed); this one covers the whole approved update_job so the
    // trail shows the edit happened and which fields changed.
    if (this.auditRepo) {
      await this.auditRepo.create(
        createAuditEvent({
          tenantId: context.tenantId,
          actorId: context.executedBy,
          actorRole: 'unknown',
          eventType: 'job.updated',
          entityType: 'job',
          entityId: jobId,
          metadata: { changes: [...fieldKeys, ...(willTransition ? ['status'] : [])] },
        }),
      );
    }

    // ── 4. Completion side effects on entry to `completed`. ────────────────
    if (willTransition && desiredStatus === 'completed') {
      if (this.completionDeps) {
        await runJobCompletionEffects(this.completionDeps, transitionedJob, this.logger);
      } else {
        this.logger.warn(
          'update_job completed a job but completion effects (auto-invoice + milestone minting) were SKIPPED — completion deps not wired',
          { tenantId: context.tenantId, jobId },
        );
      }
    }

    return { success: true, resultEntityId: jobId };
  }
}
