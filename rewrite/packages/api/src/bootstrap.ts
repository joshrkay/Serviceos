import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadConfig, type Config } from './config';
import { CommandBus } from './core/commands';
import { createDb, type Db } from './core/db';
import { JobRunner } from './core/jobs';
import { createOutboxDispatcher, drainOutbox } from './core/outbox';
import { buildApp } from './http/app';
import { AuthService } from './http/auth';
import { LLMGateway } from './modules/ai/gateway';
import { registerIntentExtractionWorker } from './modules/ai/intent';
import { defaultRouting, OpenAIProvider, StubProvider } from './modules/ai/providers';
import { registerCommsWorkers } from './modules/comms/workers';
import { ConsoleSmsProvider, TwilioSmsProvider, type SmsProvider } from './modules/comms/sms-provider';
import { markOverdueInvoicesCommand, recordPaymentCommand } from './modules/money/invoices';
import { registerProposalExecutor } from './modules/proposals/executor';

export interface Runtime {
  config: Config;
  db: Db;
  bus: CommandBus;
  jobs: JobRunner;
  gateway: LLMGateway;
  sms: SmsProvider;
  app: FastifyInstance;
  shutdown(): Promise<void>;
}

/**
 * Composition root. Modules register their workers here; the HTTP app and
 * the job system share one command bus and one database.
 */
export async function createRuntime(overrides: Partial<Config> = {}): Promise<Runtime> {
  const config = loadConfig(overrides);
  const db = createDb(config.databaseUrl, config.databaseAdminUrl);
  const jobs = new JobRunner(config.databaseAdminUrl);
  const bus = new CommandBus(db, createOutboxDispatcher(db, jobs));
  const auth = new AuthService(db, config);

  const sms: SmsProvider =
    config.twilioAccountSid && config.twilioAuthToken
      ? new TwilioSmsProvider(config.twilioAccountSid, config.twilioAuthToken)
      : new ConsoleSmsProvider();

  const gateway = new LLMGateway(
    db,
    {
      openai: config.openaiApiKey
        ? new OpenAIProvider(config.openaiApiKey, config.openaiBaseUrl)
        : new StubProvider(),
      stub: new StubProvider(),
    },
    defaultRouting(Boolean(config.openaiApiKey)),
  );

  await jobs.start();

  // Workers (all idempotent; safe across multiple instances).
  await registerProposalExecutor(jobs, bus);
  await registerCommsWorkers({ db, bus, jobs, sms });
  await registerIntentExtractionWorker({ db, bus, jobs, gateway });
  await registerMoneyWorkers(jobs, bus, db);

  // Outbox backstop drain (after-commit dispatch covers the happy path).
  await jobs.work('platform.outbox-drain', async () => {
    await drainOutbox(db, jobs);
  });
  await jobs.schedule('platform.outbox-drain', '* * * * *');
  await jobs.schedule('comms.daily-digest', '0 13 * * *');
  await jobs.schedule('money.overdue-sweep', '0 6 * * *');

  const app = await buildApp({ config, db, bus, jobs, auth });

  return {
    config,
    db,
    bus,
    jobs,
    gateway,
    sms,
    app,
    async shutdown() {
      await app.close();
      await jobs.stop();
      await db.close();
    },
  };
}

const stripePaymentJobSchema = z.object({
  tenantId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  amountCents: z.number().int().min(1),
  externalRef: z.string().min(1),
});

async function registerMoneyWorkers(jobs: JobRunner, bus: CommandBus, db: Db): Promise<void> {
  await jobs.work('money.record-stripe-payment', async (raw) => {
    const data = stripePaymentJobSchema.parse(raw);
    await bus.execute(
      recordPaymentCommand,
      { tenantId: data.tenantId, actor: { type: 'system', id: 'stripe-webhook' } },
      {
        invoiceId: data.invoiceId,
        amountCents: data.amountCents,
        method: 'card' as const,
        externalRef: data.externalRef,
      },
    );
  });

  await jobs.work('money.overdue-sweep', async () => {
    const tenants = await db.admin.query<{ id: string }>(`SELECT id FROM tenants`);
    for (const tenant of tenants.rows) {
      await bus.execute(
        markOverdueInvoicesCommand,
        { tenantId: tenant.id, actor: { type: 'system', id: 'overdue-sweep' } },
        {},
      );
    }
  });
}
