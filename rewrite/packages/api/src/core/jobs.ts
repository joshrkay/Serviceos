import { PgBoss, type Job } from 'pg-boss';

export interface JobSendOptions {
  singletonKey?: string;
  startAfter?: Date;
  retryLimit?: number;
  retryDelay?: number;
}

export type JobHandler = (data: Record<string, unknown>) => Promise<void>;

/**
 * Thin wrapper over pg-boss: the single durable job system. Queues are
 * created idempotently; handlers receive one job at a time and MUST be
 * idempotent (outbox redispatch and pg-boss retries can both re-deliver).
 */
export class JobRunner {
  private readonly boss: PgBoss;
  private readonly queues = new Set<string>();

  constructor(adminUrl: string) {
    this.boss = new PgBoss({ connectionString: adminUrl });
    this.boss.on('error', (err: unknown) => {
      console.error('[jobs] pg-boss error', { message: (err as Error).message });
    });
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async registerQueue(name: string): Promise<void> {
    if (this.queues.has(name)) return;
    await this.boss.createQueue(name, { retryLimit: 3, retryDelay: 2, retryBackoff: true });
    this.queues.add(name);
  }

  async send(topic: string, data: Record<string, unknown>, options: JobSendOptions = {}): Promise<void> {
    await this.registerQueue(topic);
    await this.boss.send(topic, data, {
      singletonKey: options.singletonKey,
      startAfter: options.startAfter,
      retryLimit: options.retryLimit ?? 3,
      retryDelay: options.retryDelay ?? 2,
    });
  }

  async work(topic: string, handler: JobHandler): Promise<void> {
    await this.registerQueue(topic);
    // Snappy polling: these jobs are user-facing (SMS replies, proposal
    // execution right after a 5s undo window).
    await this.boss.work(topic, { pollingIntervalSeconds: 1 }, async (jobs: Job<object>[]) => {
      for (const job of jobs) {
        await handler(job.data as Record<string, unknown>);
      }
    });
  }

  async schedule(topic: string, cron: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.registerQueue(topic);
    await this.boss.schedule(topic, cron, data);
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}
