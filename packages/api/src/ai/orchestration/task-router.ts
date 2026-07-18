import { TaskHandler, TaskContext, TaskResult } from '../tasks/task-handlers';
import {
  CreateCustomerTaskHandler,
  CreateJobTaskHandler,
  CreateAppointmentTaskHandler,
} from '../tasks/task-handlers';
import { AppError } from '../../shared/errors';
import {
  Proposal,
  ProposalType,
  ProposalRepository,
  CreateProposalInput,
  createProposal,
} from '../../proposals/proposal';
import {
  applyConfidencePolicy,
  ConfidenceAction,
  ConfidencePolicy,
  DEFAULT_CONFIDENCE_POLICY,
} from '../guardrails/low-confidence';
import type { InvoiceRepository } from '../../invoices/invoice';
import {
  candidatesForReference,
  mapInvoicesToCandidates,
} from '../resolution/reference-candidates';

// P2-007 — single entry point that dispatches one classified conversational
// intent to exactly one task handler, producing one bounded Proposal.
// Unknown task types return UNSUPPORTED_TASK so malformed AI output can never
// silently execute. Multi-step flows (e.g. onboarding) compose this router at
// a higher layer; the router itself is deliberately one-shot.
export class TaskRouter {
  private handlers: Map<string, TaskHandler> = new Map();

  register(handler: TaskHandler): void {
    this.handlers.set(handler.taskType, handler);
  }

  getHandler(taskType: string): TaskHandler | undefined {
    return this.handlers.get(taskType);
  }

  async route(taskType: string, context: TaskContext): Promise<TaskResult> {
    const handler = this.handlers.get(taskType);
    if (!handler) {
      throw new AppError('UNSUPPORTED_TASK', `No handler registered for task type: ${taskType}`, 400);
    }
    return handler.handle(context);
  }

  listRegisteredTasks(): string[] {
    return Array.from(this.handlers.keys());
  }
}

// A classifier-extracted reference that already IS a usable invoice
// identifier for the execution handler's resolveInvoice() (a UUID, a bare
// number like "0042", or a "<prefix>-<digits>" invoice number — see
// issue-invoice-handler.ts). Invoice numbers are minted as
// `${settings.invoicePrefix}${padded}` with a tenant-editable prefix (settings.ts),
// so the shape must accept ANY alpha[alnum]-digits prefix ("INV-0042",
// "ACME-0042"), not just a hard-coded "INV-". Execution's resolveInvoice()
// matches invoiceNumber EXACTLY, so we do NOT try to fetch tenant settings
// here — we only need the reference to be shaped like a resolvable id.
// Anything else (e.g. "the Henderson invoice") is free text the execution
// handler cannot resolve on its own, so it must NOT be handed through
// ungated — it falls to rung 3 of the resolution ladder below instead.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVOICE_NUMBER_RE = /^(?:[A-Za-z][A-Za-z0-9]*-)?\d+$/;

// Exported for direct predicate unit tests (invoice-intents.test.ts). A
// resolvable ref is a UUID, a bare number ("0042"), or a
// "<alpha><alnum>*-<digits>" invoice number for ANY tenant prefix
// ("INV-0042", "ACME-0042"). Free-text names ("the Henderson invoice",
// "Henderson") are NOT resolvable and must fall to the gated rung.
export function looksLikeResolvedInvoiceRef(value: string): boolean {
  return UUID_RE.test(value) || INVOICE_NUMBER_RE.test(value);
}

export interface IssueInvoiceTaskDeps {
  /**
   * B4 — when present, an unresolved reference falls back to "the invoice
   * we just drafted in this conversation": the most recent same-conversation
   * `draft_invoice` proposal with a `resultEntityId`. Only `findByTenant` is
   * required; `findByConversation` (optional on ProposalRepository) is used
   * when available for a SQL-filtered lookup instead of a full tenant scan
   * (mirrors the `draft_estimate` clarification-loop lookup in
   * workers/voice-action-router.ts).
   */
  proposalRepo?: Pick<ProposalRepository, 'findByTenant' | 'findByConversation'>;
  /**
   * B4 — when present, powers two things: (1) B2-style `entityCandidates`
   * for a gated card with a free-text reference that didn't resolve via
   * conversation context, and (2) a "recent drafts" fallback when there is
   * no reference at all. Optional; absent → the gate carries no candidates
   * (Edit-field fallback only, same as before B4).
   */
  invoiceRepo?: Pick<InvoiceRepository, 'findByTenant'>;
  /**
   * Per-tenant auto-approve threshold override. Mirrors the worker's
   * `thresholdResolver` (see VoiceActionRouterDeps) so both surfaces apply
   * the same tenant-configured threshold to this proposal type.
   */
  thresholdResolver?: (
    tenantId: string,
  ) => Promise<Partial<Record<'supervisor' | 'tech' | 'both', number>> | undefined>;
}

/**
 * B4 (feat: voice-transcript-and-agent-paths) — THE `issue_invoice` task
 * handler, used by both the assistant chat route and the voice worker (see
 * handler-registry.ts / assistant.ts / voice-action-router.ts). Before this
 * unit there were two divergent handlers: a dep-free one here (gated via
 * missingFields, no conversation-context resolution) and a repo-backed one
 * in voice-action-router.ts ("the one we just drafted" resolution, but
 * ungated — it emitted an empty payload with no missingFields, so an
 * unresolvable voice "issue the invoice" landed approvable and doomed at
 * execution). This handler unifies both behaviors with NEITHER gap:
 *
 * Resolution ladder:
 *   1. `existingEntities.invoiceReference`/`jobReference` already looks like
 *      a usable id (UUID or "INV-0042"/bare-number) → `payload.invoiceId`,
 *      ungated (the execution handler resolves either shape directly).
 *   2. Else, when NO reference was extracted and `conversationId` +
 *      `proposalRepo` are wired → the most recent same-conversation
 *      `draft_invoice` proposal with a `resultEntityId` →
 *      `payload.invoiceId`, ungated, AND `sourceContext.verifiedIds =
 *      { invoiceId }`. CRITICAL SECURITY: `verifiedIds` is stamped ONLY
 *      here, from a proposalRepo lookup — never copied from `existingEntities`
 *      (LLM/classifier output). `routes/assistant.ts`'s `dropUnverifiedIds`
 *      trusts this allowlist to survive its scrub; a hallucinated id must
 *      still be stripped there, so this handler must never let LLM-sourced
 *      text reach `verifiedIds`.
 *   3. Else → empty payload + `missingFields: ['invoiceId']` (blocks
 *      'approved' via decideInitialStatus/approveProposal exactly as
 *      before), plus B2-style `sourceContext.entityCandidates` from either
 *      a free-text reference search or (no reference at all) the tenant's
 *      most recent draft invoices — candidates are a UX affordance layered
 *      ON TOP of the gate, never a substitute for it.
 */
export class IssueInvoiceTaskHandler implements TaskHandler {
  readonly taskType: ProposalType = 'issue_invoice';

  constructor(private readonly deps: IssueInvoiceTaskDeps = {}) {}

  private async resolveFromConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<string | undefined> {
    const proposalRepo = this.deps.proposalRepo;
    if (!proposalRepo) return undefined;
    try {
      const candidates = await (proposalRepo.findByConversation
        ? proposalRepo.findByConversation(tenantId, conversationId)
        : proposalRepo.findByTenant(tenantId));
      const recentDraft = candidates
        .filter(
          (p) =>
            p.proposalType === 'draft_invoice' &&
            p.sourceContext?.conversationId === conversationId &&
            p.resultEntityId,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      return recentDraft?.resultEntityId ?? undefined;
    } catch {
      return undefined;
    }
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const ref =
      context.existingEntities?.invoiceReference ??
      context.existingEntities?.jobReference;
    const trimmedRef = typeof ref === 'string' && ref.trim() ? ref.trim() : undefined;

    let invoiceId: string | undefined;
    const missing: string[] = [];
    const extraSourceContext: Record<string, unknown> = {};

    if (trimmedRef && looksLikeResolvedInvoiceRef(trimmedRef)) {
      // Rung 1 — already a usable reference; resolveInvoice() at execution
      // time handles the UUID/number-vs-lookup split.
      invoiceId = trimmedRef;
    } else if (!trimmedRef && context.conversationId) {
      // Rung 2 — "the one we just drafted" conversation-context resolution.
      // GUARDED on `!trimmedRef`: this rung ignores any reference and just
      // grabs the most-recent same-conversation draft_invoice, so it may run
      // ONLY when NO reference was extracted. A PRESENT-but-unresolvable
      // reference ("issue the Henderson invoice") must NOT silently resolve
      // to whatever was last drafted in this conversation — that could issue
      // the wrong customer's invoice on a single approval. It falls through
      // to the gated rung 3 instead (missingFields + candidates on the ref).
      // A repo-resolved id is verifiable by construction (it came from a DB
      // lookup, not LLM text), so it's stamped into `verifiedIds` alongside
      // the payload — never the reverse.
      const resolved = await this.resolveFromConversation(context.tenantId, context.conversationId);
      if (resolved) {
        invoiceId = resolved;
        extraSourceContext.verifiedIds = { invoiceId: resolved };
      }
    }

    if (!invoiceId) {
      // Rung 3 — gated. Layer candidates on top; the gate itself is
      // unconditional whenever no id was resolved above.
      missing.push('invoiceId');

      let candidates = await candidatesForReference({
        tenantId: context.tenantId,
        reference: trimmedRef,
        kind: 'invoice',
        invoiceRepo: this.deps.invoiceRepo,
      });
      if (candidates.length === 0 && !trimmedRef && this.deps.invoiceRepo) {
        // No reference at all ("issue the invoice") — offer the tenant's
        // most recent DRAFT invoices (only drafts are issuable; anything
        // else would just fail InvoiceNotDraftError at execution) as a
        // one-tap starting point instead of a dead-end card.
        try {
          const recentDrafts = await this.deps.invoiceRepo.findByTenant(context.tenantId, {
            status: 'draft',
            limit: 5,
            sort: 'desc',
          });
          candidates = mapInvoicesToCandidates(recentDrafts);
        } catch {
          // Failure-soft — candidates are a nicety, never load-bearing.
        }
      }
      if (candidates.length > 0) {
        extraSourceContext.entityCandidates = candidates;
        extraSourceContext.entityKind = 'invoice';
        if (trimmedRef) extraSourceContext.entityReference = trimmedRef;
      }
    }

    const tenantThresholdOverride =
      context.tenantThresholdOverride ??
      (this.deps.thresholdResolver
        ? await this.deps.thresholdResolver(context.tenantId).catch(() => undefined)
        : undefined);

    const baseSourceContext = context.conversationId ? { conversationId: context.conversationId } : {};
    const sourceContext = { ...baseSourceContext, ...extraSourceContext };

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload: invoiceId ? { invoiceId } : {},
      summary: invoiceId ? `Issue invoice ${invoiceId}` : context.message,
      sourceContext: Object.keys(sourceContext).length > 0 ? sourceContext : undefined,
      createdBy: context.userId,
      missingFields: missing.length > 0 ? missing : undefined,
      ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
    };

    const proposal = createProposal(input);
    return { proposal, taskType: this.taskType };
  }
}

export function createDefaultTaskRouter(): TaskRouter {
  const router = new TaskRouter();
  router.register(new CreateCustomerTaskHandler());
  router.register(new CreateJobTaskHandler());
  router.register(new CreateAppointmentTaskHandler());
  // draft_estimate intentionally NOT registered here: the only stub handler
  // for it (DraftEstimateTaskHandler, removed) was a no-LLM, no-catalog
  // passthrough that echoed context.existingEntities straight into the
  // proposal payload — an ungrounded-price hazard under the money-path
  // catalog-grounding rule. This router has no production callers (verified
  // by repo-wide grep); the real draft_estimate path is
  // ai/tasks/estimate-task.ts's EstimateTaskHandler, wired in
  // routes/assistant.ts and workers/voice-action-router.ts with LLM +
  // catalog grounding.
  router.register(new IssueInvoiceTaskHandler());
  return router;
}

export interface GuardedRouteResult {
  taskResult: TaskResult;
  proposal: Proposal;
  confidenceAction: ConfidenceAction;
}

// P2-013 — Low-confidence handling policy integration point.
//
// Route the task, then evaluate the resulting proposal's confidence against
// the policy. The returned `confidenceAction` tells the caller whether to
// mark the proposal ready for review (high/medium), emit a clarification
// proposal alongside it (low), or abort (very low). The proposal status is
// downgraded to draft when the confidence falls below the ready-for-review
// threshold so nothing auto-executes on a shaky signal.
export async function routeWithGuardrails(
  router: TaskRouter,
  taskType: string,
  context: TaskContext,
  policy: ConfidencePolicy = DEFAULT_CONFIDENCE_POLICY
): Promise<GuardedRouteResult> {
  const taskResult = await router.route(taskType, context);
  const { proposal, action } = applyConfidencePolicy(taskResult.proposal, policy);
  return { taskResult, proposal, confidenceAction: action };
}
