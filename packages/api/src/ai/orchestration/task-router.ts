import { TaskHandler, TaskContext, TaskResult } from '../tasks/task-handlers';
import {
  CreateCustomerTaskHandler,
  CreateJobTaskHandler,
  CreateAppointmentTaskHandler,
  DraftEstimateTaskHandler,
} from '../tasks/task-handlers';
import { AppError } from '../../shared/errors';
import { Proposal } from '../../proposals/proposal';
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

export function createDefaultTaskRouter(): TaskRouter {
  const router = new TaskRouter();
  router.register(new CreateCustomerTaskHandler());
  router.register(new CreateJobTaskHandler());
  router.register(new CreateAppointmentTaskHandler());
  router.register(new DraftEstimateTaskHandler());
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
