import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { initServer } from '@ts-rest/fastify';
import { apiContract } from '@rivet/contracts';
import { ZodError } from 'zod';
import type { Config } from '../config';
import { CommandError, type CommandBus } from '../core/commands';
import type { Db } from '../core/db';
import type { JobRunner } from '../core/jobs';
import { listCustomers, createCustomerCommand } from '../modules/crm/customers';
import { createJobCommand, listJobs, scheduleAppointmentCommand } from '../modules/money/jobs';
import {
  createEstimateCommand,
  decideEstimateCommand,
  listEstimates,
  sendEstimateCommand,
} from '../modules/money/estimates';
import {
  createInvoiceCommand,
  getInvoice,
  getMoneySummary,
  listInvoices,
  recordPaymentCommand,
  sendInvoiceCommand,
} from '../modules/money/invoices';
import {
  listProposals,
  makeApproveProposalCommand,
  rejectProposalCommand,
  undoProposalCommand,
} from '../modules/proposals/engine';
import { getMe, getTenantSettings, listEvents } from '../modules/platform/queries';
import { updateTenantSettingsCommand } from '../modules/platform/tenants';
import type { AuthContext } from './auth';
import type { AppDeps } from './deps';
import { registerWebhookRoutes } from './webhooks';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
    rawBody?: string;
  }
}

export type { AppDeps } from './deps';

function errorBody(err: unknown): { message: string } {
  return { message: err instanceof Error ? err.message : 'unexpected error' };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, bus, auth } = deps;
  const app = Fastify({
    logger: {
      level: config.env === 'test' ? 'warn' : 'info',
      // No PII in logs: never serialize request/response bodies.
      serializers: {
        req(request) {
          return { method: request.method, url: request.url };
        },
      },
    },
  });

  await app.register(cors, { origin: true });
  await app.register(formbody);

  // Capture raw bodies for webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, payload, done) => {
    request.rawBody = payload as string;
    try {
      done(null, payload === '' ? {} : JSON.parse(payload as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const resolved = await auth.resolve(request.headers);
    if (!resolved) {
      await reply.status(401).send({ message: 'unauthorized' });
      return reply;
    }
    request.auth = resolved;
  });

  const userActor = (request: { auth: AuthContext }) =>
    ({
      tenantId: request.auth.tenantId,
      actor: { type: 'user' as const, id: request.auth.userId },
    }) as const;

  const approveProposalCommand = makeApproveProposalCommand(config.undoWindowSeconds);

  const s = initServer();
  const router = s.router(apiContract, {
    me: async ({ request }) => ({ status: 200, body: await getMe(db, request.auth) }),

    settings: {
      get: async ({ request }) => ({
        status: 200,
        body: await getTenantSettings(db, request.auth.tenantId),
      }),
      update: async ({ request, body }) => {
        try {
          const updated = await bus.execute(updateTenantSettingsCommand, userActor(request), body);
          return { status: 200, body: updated };
        } catch (err) {
          if (err instanceof CommandError || err instanceof ZodError) {
            return { status: 400, body: errorBody(err) };
          }
          throw err;
        }
      },
    },

    customers: {
      list: async ({ request, query }) => ({
        status: 200,
        body: { customers: await listCustomers(db, request.auth.tenantId, query.search) },
      }),
      create: async ({ request, body }) => {
        try {
          const customer = await bus.execute(createCustomerCommand, userActor(request), body);
          return { status: 201, body: customer };
        } catch (err) {
          if (err instanceof CommandError) {
            return { status: err.code === 'conflict' ? 409 : 400, body: errorBody(err) };
          }
          throw err;
        }
      },
    },

    jobs: {
      list: async ({ request }) => ({
        status: 200,
        body: { jobs: await listJobs(db, request.auth.tenantId) },
      }),
      create: async ({ request, body }) => {
        try {
          const job = await bus.execute(createJobCommand, userActor(request), body);
          return { status: 201, body: job };
        } catch (err) {
          if (err instanceof CommandError) return { status: 400, body: errorBody(err) };
          throw err;
        }
      },
      schedule: async ({ request, params, body }) => {
        try {
          const appointment = await bus.execute(scheduleAppointmentCommand, userActor(request), {
            jobId: params.id,
            ...body,
          });
          return { status: 201, body: appointment };
        } catch (err) {
          if (err instanceof CommandError) {
            return { status: err.code === 'not_found' ? 404 : 400, body: errorBody(err) };
          }
          throw err;
        }
      },
    },

    estimates: {
      list: async ({ request }) => ({
        status: 200,
        body: { estimates: await listEstimates(db, request.auth.tenantId) },
      }),
      create: async ({ request, body }) => {
        try {
          const estimate = await bus.execute(createEstimateCommand, userActor(request), body);
          return { status: 201, body: estimate };
        } catch (err) {
          if (err instanceof CommandError) return { status: 400, body: errorBody(err) };
          throw err;
        }
      },
      send: async ({ request, params }) => {
        try {
          const estimate = await bus.execute(sendEstimateCommand, userActor(request), {
            estimateId: params.id,
          });
          return { status: 200, body: estimate };
        } catch (err) {
          if (err instanceof CommandError) {
            return { status: err.code === 'not_found' ? 404 : 400, body: errorBody(err) };
          }
          throw err;
        }
      },
      decide: async ({ request, params, body }) => {
        try {
          const estimate = await bus.execute(decideEstimateCommand, userActor(request), {
            estimateId: params.id,
            decision: body.decision,
          });
          return { status: 200, body: estimate };
        } catch (err) {
          if (err instanceof CommandError) {
            return { status: err.code === 'not_found' ? 404 : 400, body: errorBody(err) };
          }
          throw err;
        }
      },
    },

    invoices: {
      list: async ({ request }) => ({
        status: 200,
        body: { invoices: await listInvoices(db, request.auth.tenantId) },
      }),
      get: async ({ request, params }) => {
        const invoice = await getInvoice(db, request.auth.tenantId, params.id);
        if (!invoice) return { status: 404, body: { message: 'invoice not found' } };
        return { status: 200, body: invoice };
      },
      create: async ({ request, body }) => {
        try {
          const invoice = await bus.execute(createInvoiceCommand, userActor(request), body);
          return { status: 201, body: invoice };
        } catch (err) {
          if (err instanceof CommandError) return { status: 400, body: errorBody(err) };
          throw err;
        }
      },
      send: async ({ request, params }) => {
        try {
          const invoice = await bus.execute(sendInvoiceCommand, userActor(request), {
            invoiceId: params.id,
          });
          return { status: 200, body: invoice };
        } catch (err) {
          if (err instanceof CommandError) {
            return { status: err.code === 'not_found' ? 404 : 400, body: errorBody(err) };
          }
          throw err;
        }
      },
      recordPayment: async ({ request, params, body }) => {
        try {
          const invoice = await bus.execute(recordPaymentCommand, userActor(request), {
            invoiceId: params.id,
            ...body,
          });
          return { status: 200, body: invoice };
        } catch (err) {
          if (err instanceof CommandError) {
            return { status: err.code === 'not_found' ? 404 : 400, body: errorBody(err) };
          }
          throw err;
        }
      },
    },

    proposals: {
      list: async ({ request, query }) => ({
        status: 200,
        body: { proposals: await listProposals(db, request.auth.tenantId, query.status) },
      }),
      approve: async ({ request, params }) => {
        try {
          const proposal = await bus.execute(approveProposalCommand, userActor(request), {
            proposalId: params.id,
          });
          return { status: 200, body: proposal };
        } catch (err) {
          if (err instanceof CommandError) return { status: 409, body: errorBody(err) };
          throw err;
        }
      },
      reject: async ({ request, params, body }) => {
        try {
          const proposal = await bus.execute(rejectProposalCommand, userActor(request), {
            proposalId: params.id,
            reason: body.reason,
          });
          return { status: 200, body: proposal };
        } catch (err) {
          if (err instanceof CommandError) return { status: 409, body: errorBody(err) };
          throw err;
        }
      },
      undo: async ({ request, params }) => {
        try {
          const proposal = await bus.execute(undoProposalCommand, userActor(request), {
            proposalId: params.id,
          });
          return { status: 200, body: proposal };
        } catch (err) {
          if (err instanceof CommandError) return { status: 409, body: errorBody(err) };
          throw err;
        }
      },
    },

    events: {
      list: async ({ request, query }) => ({
        status: 200,
        body: {
          events: await listEvents(db, request.auth.tenantId, {
            entityType: query.entityType,
            limit: query.limit,
          }),
        },
      }),
    },

    reports: {
      moneySummary: async ({ request }) => ({
        status: 200,
        body: await getMoneySummary(db, request.auth.tenantId),
      }),
    },
  });

  await app.register(s.plugin(router));
  await registerWebhookRoutes(app, deps);

  if (config.webDistPath) {
    const fastifyStatic = await import('@fastify/static');
    await app.register(fastifyStatic.default, { root: config.webDistPath, wildcard: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/webhooks/')) {
        return reply.status(404).send({ message: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
