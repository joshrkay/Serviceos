import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { JobRepository, UpdateJobInput, updateJob } from '../../jobs/job';
import { AuditRepository } from '../../audit/audit';

const VALID_STATUSES = new Set([
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
 * Executes `update_job` proposals — a capture-class, human-approved edit
 * to an existing job's status / priority / title / description (B7,
 * docs/plans/2026-07-17-001-feat-voice-transcript-and-agent-paths-plan.md).
 *
 * Deliberately scoped to a raw field write via the `updateJob` domain
 * function (jobs/job.ts) — the SAME mechanism `PUT /api/jobs/:id` already
 * uses for these fields — NOT the governed lifecycle transition
 * (`transitionJobStatus`, jobs/job-lifecycle.ts, used by
 * `POST /api/jobs/:id/transition`), which enforces forward/backward-move
 * validation, writes a timeline entry, and fires completion side effects
 * (auto-invoice, milestone billing, the feedback sweep). A voice/assistant
 * "mark it in progress" / "bump the priority to urgent" / "rename the job"
 * is a simple correction the operator already reviewed and approved on the
 * proposal card — not a substitute for the governed transition flow.
 * Money (deposit/pricing) and schedule (appointment) fields are
 * out of scope by construction: the Zod payload (proposals/contracts.ts
 * `updateJobPayloadSchema`) only ever carries status/priority/title/
 * description.
 *
 * `updateJob` already emits the `job.updated` audit event this unit needs
 * (jobs/job.ts) — reused verbatim rather than duplicated here.
 */
export class UpdateJobExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'update_job';

  constructor(
    private readonly jobRepo?: JobRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  // Degrades to a hard failure (never a synthetic-id passthrough) without
  // the job repo — see execute(). Mutating an EXISTING entity with no repo
  // has no safe degraded mode, unlike a create handler minting a fresh id.
  isFullyWired(): boolean {
    return Boolean(this.jobRepo);
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

    const input: UpdateJobInput = {};
    if (typeof p.title === 'string' && p.title.trim().length > 0) {
      input.summary = p.title.trim();
    }
    if (typeof p.description === 'string') {
      input.problemDescription = p.description;
    }
    if (typeof p.priority === 'string' && VALID_PRIORITIES.has(p.priority)) {
      input.priority = p.priority as UpdateJobInput['priority'];
    }
    if (typeof p.status === 'string' && VALID_STATUSES.has(p.status)) {
      input.status = p.status as UpdateJobInput['status'];
    }

    if (Object.keys(input).length === 0) {
      return {
        success: false,
        error: 'Payload must include at least one field to update: status, priority, title, or description',
      };
    }

    if (!this.jobRepo) {
      // No synthetic success: a missing repo is a wiring fault on an
      // EXISTING-entity mutation, never a silent no-op that reports
      // success while persisting nothing.
      return { success: false, error: 'handler_not_wired:jobRepo' };
    }

    // No try/catch here: `updateJob` never throws a typed, cleanly-surfaceable
    // error (its only failure mode is a null return on "not found", handled
    // below) — an unexpected exception (e.g. a transient DB error) is left to
    // propagate so the executor retries, matching the convention documented
    // on UpdateEstimateExecutionHandler ("transient repo errors throw so the
    // executor can retry").
    const updated = await updateJob(
      proposal.tenantId,
      jobId,
      input,
      this.jobRepo,
      context.executedBy,
      this.auditRepo,
    );
    if (!updated) {
      return { success: false, error: `Job ${jobId} not found in this tenant` };
    }
    return { success: true, resultEntityId: updated.id };
  }
}
