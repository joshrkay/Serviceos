import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { assessConfidence } from '../guardrails/confidence';
import type { JobRepository } from '../../jobs/job';
import { candidatesForReference } from '../resolution/reference-candidates';
import type { EntityCandidate } from '../resolution/entity-resolver';

// Mirrors EstimateEditTaskHandler / InvoiceEditTaskHandler's check: a
// classifier/LLM-extracted reference is free text ("the Henderson job",
// "JOB-0012") in the overwhelming case, but may already BE the resolved id
// on a re-draft.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Canonical Job status/priority value sets (mirrors jobStatusSchema / jobPrioritySchema in @ai-service-os/shared). */
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
 * UpdateJobTaskHandler — produces `update_job` proposals from voice /
 * assistant transcripts like:
 *   "Mark the Henderson job in progress"
 *   "Change the priority on JOB-0012 to urgent"
 *   "Rename the Smith job to 'water heater replacement — 2nd unit'"
 *
 * B7 (feat: voice-transcript-and-agent-paths) — deliberately scoped to
 * SAFE field edits: status, priority, title (job summary), and
 * description (problemDescription). NOT money, NOT schedule — those have
 * their own proposal paths (draft/update_estimate, draft/update_invoice,
 * reschedule_appointment). capture-class, always human-approved
 * (sourceTrustTier: 'autonomous' + capture only auto-approves at high
 * confidence AND with a resolved jobId — see resolveJobIdGate below).
 *
 * The LLM returns a `jobReference` (a string the operator/review UI
 * resolves to a real job id) plus whichever fields the operator asked to
 * change. jobId resolution follows the SAME gate pattern as
 * EstimateEditTaskHandler.resolveEstimateIdGate (estimate-edit-task.ts):
 * a literal UUID reference is trusted and ungates the proposal; a
 * free-text reference is best-effort resolved via jobRepo search (stamped
 * onto payload.jobId for review-card context) but ALWAYS stays gated via
 * `missingFields: ['jobId']` — see that method's doc comment for the
 * `dropUnverifiedIds` hazard this avoids.
 */

const JOB_EDIT_SYSTEM_PROMPT = `You edit existing job records for a field service operating system — SAFE field changes only: status, priority, and the job's title/description. Money (estimates/invoices/pricing) and scheduling (appointments/visit times) have their own commands — never touch those here, and never invent line items, prices, or appointment times.

Given a voice transcript from an operator, extract (1) which job they want to change and (2) what changes they want applied.

Return valid JSON only (no prose, no markdown fences):
{
  "jobReference": "<string — job number, customer name, or whatever the operator said>",
  "status": "<one of: new, scheduled, dispatched, in_progress, completed, invoiced, closed, canceled — OMIT unless the operator explicitly asked to change the status>",
  "priority": "<one of: low, normal, high, urgent — OMIT unless the operator explicitly asked to change the priority>",
  "title": "<string — OMIT unless the operator asked to rename/retitle the job>",
  "description": "<string — OMIT unless the operator asked to change the job's description/notes>",
  "confidence_score": <number between 0 and 1>
}

Rules:
- Only include a field in the JSON when the operator explicitly asked to change it. Never restate a value the operator didn't mention.
- status/priority MUST be exactly one of the listed values, using underscores (e.g. "in_progress", never "in progress").
- Distinguish from other job-related commands:
  - "start/open a NEW job for..." is a DIFFERENT action (create_job) — never emit a jobReference-based edit for that.
  - "reschedule/move the appointment to..." is scheduling, not a job field — do not extract it here.
  - "note on the job: ..." (a freeform annotation, not changing a tracked field) is a different action (add_note) — do not force it into title/description unless the operator is clearly renaming the job or changing its description field.
- If you can't identify either the job or a concrete field change, set confidence below 0.7. It's fine to omit every change field if the transcript is truly ambiguous — don't fabricate.
- Never invent a job id, job number, or customer name. Use only what the transcript says.`;

function tryParseJson(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeStatus(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_');
  return VALID_STATUSES.has(normalized) ? normalized : undefined;
}

function normalizePriority(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return VALID_PRIORITIES.has(normalized) ? normalized : undefined;
}

function buildPayload(parsed: Record<string, unknown> | null): Record<string, unknown> {
  if (!parsed) return {};
  const payload: Record<string, unknown> = {};

  if (typeof parsed.jobReference === 'string') {
    payload.jobReference = parsed.jobReference;
  }
  // Rare but allowed by the contract: a concrete jobId (e.g. when the
  // classifier hints carried a verified id, or a re-draft carries a prior
  // resolution). Passed through so review can skip reference resolution.
  if (typeof parsed.jobId === 'string') {
    payload.jobId = parsed.jobId;
  }

  const status = normalizeStatus(parsed.status);
  if (status) payload.status = status;

  const priority = normalizePriority(parsed.priority);
  if (priority) payload.priority = priority;

  if (typeof parsed.title === 'string' && parsed.title.trim().length > 0) {
    payload.title = parsed.title;
  }
  if (typeof parsed.description === 'string') {
    payload.description = parsed.description;
  }

  return payload;
}

export class UpdateJobTaskHandler implements TaskHandler {
  readonly taskType = 'update_job' as const;
  private readonly gateway: LLMGateway;
  /**
   * jobId target resolution — same role EstimateEditTaskHandler's
   * estimateRepo plays for resolveEstimateIdGate. Optional so callers/tests
   * without a job repo keep working (every reference then stays gated).
   */
  private readonly jobRepo?: Pick<JobRepository, 'findById' | 'findByTenant'>;

  constructor(gateway: LLMGateway, jobRepo?: Pick<JobRepository, 'findById' | 'findByTenant'>) {
    this.gateway = gateway;
    this.jobRepo = jobRepo;
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const llmResponse = await this.gateway.complete({
      taskType: 'update_job',
      // Top-level tenantId so the gateway keys this tenant's concurrency
      // quota / cache bucket correctly (never the shared SYSTEM_TENANT_ID).
      tenantId: context.tenantId,
      messages: [
        { role: 'system', content: JOB_EDIT_SYSTEM_PROMPT },
        { role: 'user', content: this.buildUserMessage(context) },
      ],
      responseFormat: 'json',
    });

    const parsed = tryParseJson(llmResponse.content);
    const payload = buildPayload(parsed);

    const confidence = assessConfidence(parsed ?? {});

    const { target, candidates } = await this.resolveTargetJob(context.tenantId, payload);

    // Resolve the free-text jobReference onto payload.jobId (direct UUID,
    // or an unambiguous jobRepo match) before this proposal can be
    // approved — see resolveJobIdGate below. Anything that doesn't resolve
    // to a trusted UUID gates the proposal via missingFields so
    // approveProposal blocks it instead of letting an unresolved edit
    // reach UpdateJobExecutionHandler, which has no resolution step of its
    // own and would fail after approval.
    const jobIdMissingFields = this.resolveJobIdGate(payload, target);

    // B2 pattern — layer the resolved candidate list ON TOP of the gate
    // (never a substitute for it): only recorded while the gate is still
    // present, so the AmbiguityPicker only ever appears on a card the
    // operator still needs to act on.
    const sourceContext: Record<string, unknown> = {
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      ...(jobIdMissingFields.length > 0 && candidates.length > 0
        ? {
            entityCandidates: candidates,
            entityKind: 'job',
            entityReference: payload.jobReference,
          }
        : {}),
    };

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload,
      summary: context.message,
      confidenceScore: confidence.score,
      confidenceFactors: confidence.factors,
      sourceContext: Object.keys(sourceContext).length > 0 ? sourceContext : undefined,
      createdBy: context.userId,
      // update_job touches an existing entity but is a bounded, safe field
      // edit (no money, no schedule) — capture-class, same trust-tier
      // treatment as update_estimate/update_invoice. The jobId gate + the
      // execution handler's own "at least one field" guard are the real
      // safety net; auto-approval additionally requires a resolved jobId
      // (missingFields forces 'draft' — see decideInitialStatus).
      sourceTrustTier: 'autonomous',
      ...(jobIdMissingFields.length > 0 ? { missingFields: jobIdMissingFields } : {}),
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
      // Phase 12 — forward supervisor presence so this autonomous, capture-class
      // edit only auto-approves when a supervisor is on the wall (same gate as
      // the estimate/invoice edit paths).
      ...(context.supervisorPresent !== undefined
        ? { supervisorPresent: context.supervisorPresent }
        : {}),
      ...(context.supervisorMode ? { supervisorMode: context.supervisorMode } : {}),
    };

    return { proposal: createProposal(input), taskType: this.taskType };
  }

  /**
   * Best-effort target resolution. Never throws — a repo hiccup or an
   * ambiguous reference simply skips to the gated path (the hard
   * guarantee lives at execute time). Mirrors
   * EstimateEditTaskHandler.resolveTargetEstimate: the same search that
   * identifies (or fails to identify) an unambiguous single match also
   * doubles as the AmbiguityPicker's candidate list (top 5, via the
   * shared `candidatesForReference` helper) — `target` only ever needs
   * the id (to stamp payload.jobId), so it's read off the candidate the
   * search already fetched rather than a second `findById` round trip.
   */
  private async resolveTargetJob(
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<{ target: { id: string } | null; candidates: EntityCandidate[] }> {
    if (!this.jobRepo) return { target: null, candidates: [] };
    try {
      if (typeof payload.jobId === 'string' && payload.jobId.length > 0) {
        const target = await this.jobRepo.findById(tenantId, payload.jobId);
        return { target, candidates: [] };
      }
      const reference = payload.jobReference;
      if (typeof reference === 'string' && reference.trim().length > 0) {
        // ILIKE search on summary / job_number; only an UNAMBIGUOUS single
        // match identifies the target.
        const candidates = await candidatesForReference({
          tenantId,
          reference,
          kind: 'job',
          jobRepo: this.jobRepo,
        });
        return { target: candidates.length === 1 ? { id: candidates[0].id } : null, candidates };
      }
    } catch {
      // Resolution must never block proposal creation.
    }
    return { target: null, candidates: [] };
  }

  /**
   * Gating rule — mirrors EstimateEditTaskHandler.resolveEstimateIdGate
   * verbatim (see its doc comment in estimate-edit-task.ts for the full
   * `dropUnverifiedIds` rationale): missingFields is cleared ONLY when the
   * reference/id is ALREADY a literal UUID — never merely because
   * resolveTargetJob's search resolved a free-text reference
   * unambiguously. A DB-resolved id from a free-text search is never
   * literally present in the operator's raw text, so the assistant
   * surface's `dropUnverifiedIds` guard would silently strip it right
   * before persistence — an "ungated" missingFields would then leave the
   * proposal approvable with jobId gone, reintroducing the exact
   * doomed-approval bug that fix closed. voice-action-router.ts has no
   * such guard, but the two surfaces must gate identically or the same
   * transcript would behave differently depending on which one drafted
   * it.
   *
   * Never throws: mutates `payload` in place and returns the
   * missingFields array to stamp on the proposal; a null `target` (no
   * repo, ambiguous match, zero match, or a repo hiccup already swallowed
   * by resolveTargetJob) simply leaves the proposal gated.
   * `jobReference` is left untouched either way so the review card can
   * always show what the operator said.
   */
  private resolveJobIdGate(payload: Record<string, unknown>, target: { id: string } | null): string[] {
    if (isUuid(payload.jobId)) {
      // Already a resolved id (e.g. a re-draft carrying a prior pick, or a
      // classifier hint that was itself a verified UUID) — safe to
      // ungate: this literal string is present in the classifier
      // entities/text dropUnverifiedIds checks.
      return [];
    }

    const reference = payload.jobReference;
    if (isUuid(reference)) {
      payload.jobId = reference;
      return [];
    }

    // A free-text reference resolved unambiguously by resolveTargetJob's
    // search is still useful review-card context — stamp it, unless
    // payload.jobId already carries something — but per the rule above it
    // never lifts the gate.
    if (target && typeof payload.jobId !== 'string') {
      payload.jobId = target.id;
    }

    // Free-text reference (resolved or not) — always gated. See the
    // method doc comment for why "resolved via search" doesn't bypass
    // this on its own.
    return ['jobId'];
  }

  private buildUserMessage(context: TaskContext): string {
    const parts: string[] = [];
    parts.push(`Transcript: ${context.message}`);
    if (context.existingEntities && Object.keys(context.existingEntities).length > 0) {
      parts.push(`Classifier hints: ${JSON.stringify(context.existingEntities)}`);
    }
    return parts.join('\n');
  }
}

export { JOB_EDIT_SYSTEM_PROMPT, tryParseJson, buildPayload };
