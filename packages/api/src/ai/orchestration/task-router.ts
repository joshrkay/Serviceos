import { TaskHandler, TaskContext, TaskResult } from '../tasks/task-handlers';
import {
  CreateCustomerTaskHandler,
  CreateJobTaskHandler,
  CreateAppointmentTaskHandler,
  DraftEstimateTaskHandler,
} from '../tasks/task-handlers';
import { AppError } from '../../shared/errors';

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
