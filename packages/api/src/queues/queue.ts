import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logging/logger';

export interface QueueMessage<T = unknown> {
  id: string;
  type: string;
  payload: T;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
  createdAt: string;
}

export interface QueueConfig {
  queueUrl?: string;
  maxRetries: number;
  visibilityTimeout: number;
  deadLetterQueueUrl?: string;
}

export interface Queue {
  send<T>(type: string, payload: T, idempotencyKey?: string): Promise<string>;
  receive<T>(): Promise<QueueMessage<T> | null>;
  delete(messageId: string): Promise<void>;
  getConfig(): QueueConfig;
}

export function createQueueConfig(env: string): QueueConfig {
  return {
    queueUrl: process.env.SQS_QUEUE_URL,
    maxRetries: env === 'prod' ? 5 : 3,
    visibilityTimeout: 30,
    deadLetterQueueUrl: process.env.SQS_DLQ_URL,
  };
}

export class InMemoryQueue implements Queue {
  private messages: QueueMessage[] = [];
  private config: QueueConfig;

  constructor(config?: Partial<QueueConfig>) {
    this.config = {
      maxRetries: config?.maxRetries ?? 3,
      visibilityTimeout: config?.visibilityTimeout ?? 30,
      ...config,
    };
  }

  async send<T>(type: string, payload: T, idempotencyKey?: string): Promise<string> {
    const id = uuidv4();
    this.messages.push({
      id,
      type,
      payload,
      attempts: 0,
      maxAttempts: this.config.maxRetries,
      idempotencyKey: idempotencyKey || id,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  async receive<T>(): Promise<QueueMessage<T> | null> {
    const msg = this.messages.shift();
    if (!msg) return null;
    msg.attempts++;
    return msg as QueueMessage<T>;
  }

  async delete(_messageId: string): Promise<void> {
    // Message already removed on receive in-memory
  }

  getConfig(): QueueConfig {
    return this.config;
  }

  size(): number {
    return this.messages.length;
  }
}

export interface WorkerHandler<T = unknown> {
  type: string;
  handle(message: QueueMessage<T>, logger: Logger): Promise<void>;
}

export async function processMessage<T>(
  message: QueueMessage<T>,
  handler: WorkerHandler<T>,
  logger: Logger
): Promise<boolean> {
  const log = logger.child({
    messageId: message.id,
    messageType: message.type,
    attempt: message.attempts,
    idempotencyKey: message.idempotencyKey,
  });

  if (message.type !== handler.type) {
    log.warn('Message type mismatch', { expected: handler.type, actual: message.type });
    return false;
  }

  try {
    log.info('Processing message');
    await handler.handle(message, log);
    log.info('Message processed successfully');
    return true;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Message processing failed', {
      error: error.message,
      canRetry: message.attempts < message.maxAttempts,
    });

    if (message.attempts >= message.maxAttempts) {
      log.error('Message exceeded max attempts, sending to DLQ');
    }
    return false;
  }
}
