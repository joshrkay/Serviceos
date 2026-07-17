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
  CreateProposalInput,
  createProposal,
} from '../../proposals/proposal';
import {
  applyConfidencePolicy,
  ConfidenceAction,
  ConfidencePolicy,
  DEFAULT_CONFIDENCE_POLICY,
} from '../guardrails/low-confidence';

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

/**
 * P22-002 — dep-free `issue_invoice` task handler for the default router.
 *
 * No LLM call needed: the payload is just `{ invoiceId }`, taken from the
 * classifier's extracted invoice reference (jobReference / invoiceReference,
 * UUID or "INV-0042"-style number — the execution handler resolves either).
 * When no reference was extracted the proposal carries an empty payload AND
 * `missingFields: ['invoiceId']` (mirrors SendInvoiceTaskHandler in
 * voice-extended-tasks.ts) so `decideInitialStatus`/`approveProposal` block
 * the proposal from ever reaching 'approved' — the review card prompts the
 * operator for the missing reference instead of the proposal auto-promoting
 * to ready_for_review and dying at execution on the absent invoiceId. The
 * richer conversation-context resolution ("the one we just drafted") lives
 * in the voice-action-router's repo-backed handler.
 */
export class IssueInvoiceTaskHandler implements TaskHandler {
  readonly taskType: ProposalType = 'issue_invoice';

  async handle(context: TaskContext): Promise<TaskResult> {
    const ref =
      context.existingEntities?.invoiceReference ??
      context.existingEntities?.jobReference;
    const invoiceId = typeof ref === 'string' && ref.trim() ? ref.trim() : undefined;

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload: invoiceId ? { invoiceId } : {},
      summary: invoiceId ? `Issue invoice ${invoiceId}` : context.message,
      sourceContext: context.conversationId
        ? { conversationId: context.conversationId }
        : undefined,
      createdBy: context.userId,
      missingFields: invoiceId ? undefined : ['invoiceId'],
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
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
