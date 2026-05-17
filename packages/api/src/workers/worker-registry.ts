import { WorkerHandler, QueueMessage, processMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { googleReviewsSweepRegistration } from './google-reviews';

export class WorkerRegistry {
  private handlers: Map<string, WorkerHandler> = new Map();

  register<T>(handler: WorkerHandler<T>): void {
    if (this.handlers.has(handler.type)) {
      throw new Error(`Handler already registered for type: ${handler.type}`);
    }
    this.handlers.set(handler.type, handler as WorkerHandler);
  }

  getHandler(type: string): WorkerHandler | undefined {
    return this.handlers.get(type);
  }

  getRegisteredTypes(): string[] {
    return Array.from(this.handlers.keys());
  }

  async dispatch(message: QueueMessage, logger: Logger): Promise<boolean> {
    const handler = this.handlers.get(message.type);
    if (!handler) {
      logger.error('No handler registered for message type', { type: message.type });
      return false;
    }
    return processMessage(message, handler, logger);
  }
}

/**
 * P7-026 — Periodic-sweep registrations.
 *
 * The existing `WorkerRegistry` above is for queue-message-driven handlers.
 * Cross-tenant interval sweeps (overdue-invoice, recurring-agreements,
 * google-reviews) are wired into setInterval drivers from `app.ts`. This
 * array is the additive registration surface for those sweeps so the
 * wiring layer can iterate one source of truth instead of growing more
 * hard-coded imports inside `app.ts`. New entries here are additive only;
 * removing or renaming an entry is a breaking change.
 */
export const PERIODIC_SWEEP_REGISTRATIONS = [
  googleReviewsSweepRegistration,
] as const;
