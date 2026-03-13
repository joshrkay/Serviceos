import { WorkerHandler, QueueMessage, processMessage } from '../queues/queue';
import { Logger } from '../logging/logger';

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
