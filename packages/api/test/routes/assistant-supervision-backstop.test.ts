/**
 * I4 (post-C1 review, followup-autoapprove-default) — chokepoint backstop.
 *
 * `workers/voice-action-router.ts`'s `holdIfUnsupervised` exists precisely
 * so "even a future autonomous handler that forgets to thread presence
 * can't slip an auto-approved proposal past an unsupervised tenant." Chat
 * had no equivalent: its gate depended entirely on every dispatched
 * handler correctly forwarding `context.supervisorPresent` into
 * `CreateProposalInput`. All seven capture-class-autonomous handlers do
 * today, which makes the backstop's OWN output currently indistinguishable
 * from "no backstop at all" through the public HTTP surface — there is no
 * live handler that disagrees with the route's own supervision read.
 *
 * That's exactly why this is a WIRING test, not a behavior-difference
 * test: it spies on the real (unmocked-behavior) `holdIfUnsupervised`
 * export to confirm `routes/assistant.ts` actually calls it, with the
 * route's own resolved `supervisorPresent`, for every dispatched proposal
 * — the guarantee that protects the NEXT `CHAT_INTENT_TO_REGISTRY_KEY`
 * entry that forgets to forward the field internally.
 * `holdIfUnsupervised`'s own correctness (downgrades an approved proposal
 * when unsupervised; the D-015 lane exception; a forged stamp still
 * downgrades) is already covered by
 * test/workers/voice-action-router*.test.ts and is not re-proven here.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const holdIfUnsupervisedSpy = vi.hoisted(() => vi.fn());

vi.mock('../../src/workers/voice-action-router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/workers/voice-action-router')>();
  holdIfUnsupervisedSpy.mockImplementation(actual.holdIfUnsupervised);
  return { ...actual, holdIfUnsupervised: holdIfUnsupervisedSpy };
});

import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryJobRepository } from '../../src/jobs/job';
import type { Job } from '../../src/jobs/job';
import { InMemoryLocationRepository } from '../../src/locations/location';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { EntityResolver, EntityResolverResult } from '../../src/ai/resolution/entity-resolver';

const TEST_TENANT = 'tenant-backstop';
const TEST_USER = 'user-backstop';

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => ({
      content: responses[Math.min(i++, responses.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

function classifierReply(intentType: string, entities: Record<string, unknown> = {}): string {
  return JSON.stringify({ intentType, confidence: 0.95, reasoning: 'test', extractedEntities: entities });
}

function resolverFor(
  fn: (args: { kind: string }) => Promise<EntityResolverResult>,
): EntityResolver {
  return { resolve: fn } as unknown as EntityResolver;
}

function buildApp(gateway: LLMGateway, opts: {
  proposalRepo: InMemoryProposalRepository;
  entityResolver: EntityResolver;
  appointmentRepo: InMemoryAppointmentRepository;
  jobRepo: InMemoryJobRepository;
  locationRepo: InMemoryLocationRepository;
}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-backstop',
      tenantId: TEST_TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway,
      proposalRepo: opts.proposalRepo,
      entityResolver: opts.entityResolver,
      appointmentRepo: opts.appointmentRepo,
      jobRepo: opts.jobRepo,
      locationRepo: opts.locationRepo,
      tenantTimezoneResolver: async () => 'America/New_York',
    }),
  );
  return app;
}

async function chat(app: ReturnType<typeof buildApp>, content: string) {
  return request(app)
    .post('/api/assistant/chat')
    .send({ messages: [{ role: 'user', content }] });
}

describe('I4 — assistant.ts wires the shared holdIfUnsupervised chokepoint', () => {
  beforeEach(() => {
    holdIfUnsupervisedSpy.mockClear();
    _resetSupervisorPresenceCache();
  });

  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  it('calls holdIfUnsupervised with the route-resolved supervisorPresent for every dispatched proposal (single-intent path)', async () => {
    setSupervisorPresenceLoader(async () => true);
    const proposalRepo = new InMemoryProposalRepository();
    const jobRepo = new InMemoryJobRepository();
    const job: Job = {
      id: '77777777-7777-4777-8777-777777777777',
      tenantId: TEST_TENANT,
      customerId: 'cust-1',
      locationId: 'loc-1',
      jobNumber: 'JOB-BACKSTOP',
      summary: 'Backstop wiring job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: TEST_USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await jobRepo.create(job);
    const entityResolver = resolverFor(async ({ kind }) =>
      kind === 'job'
        ? { kind: 'resolved', candidate: { id: job.id, kind: 'job', label: 'Backstop job', score: 0.95 } }
        : { kind: 'skipped' },
    );
    const app = buildApp(
      scriptedGateway([classifierReply('update_job', { jobReference: 'the backstop job', status: 'completed' })]),
      {
        proposalRepo,
        entityResolver,
        appointmentRepo: new InMemoryAppointmentRepository(),
        jobRepo,
        locationRepo: new InMemoryLocationRepository(),
      },
    );

    const res = await chat(app, 'Mark the backstop job as completed');

    expect(res.status).toBe(200);
    expect(holdIfUnsupervisedSpy).toHaveBeenCalled();
    // Every call this dispatch produced was told the tenant IS supervised —
    // the route's own resolved value, not left undefined for the backstop
    // to guess at.
    for (const call of holdIfUnsupervisedSpy.mock.calls) {
      expect(call[1]).toBe(true);
    }
  });

  it('calls holdIfUnsupervised with supervisorPresent=false when the tenant is genuinely unsupervised', async () => {
    setSupervisorPresenceLoader(async () => false);
    const proposalRepo = new InMemoryProposalRepository();
    const jobRepo = new InMemoryJobRepository();
    const job: Job = {
      id: '88888888-8888-4888-8888-888888888888',
      tenantId: TEST_TENANT,
      customerId: 'cust-1',
      locationId: 'loc-1',
      jobNumber: 'JOB-BACKSTOP-2',
      summary: 'Backstop wiring job 2',
      status: 'scheduled',
      priority: 'normal',
      createdBy: TEST_USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await jobRepo.create(job);
    const entityResolver = resolverFor(async ({ kind }) =>
      kind === 'job'
        ? { kind: 'resolved', candidate: { id: job.id, kind: 'job', label: 'Backstop job 2', score: 0.95 } }
        : { kind: 'skipped' },
    );
    const app = buildApp(
      scriptedGateway([classifierReply('update_job', { jobReference: 'the backstop job', status: 'completed' })]),
      {
        proposalRepo,
        entityResolver,
        appointmentRepo: new InMemoryAppointmentRepository(),
        jobRepo,
        locationRepo: new InMemoryLocationRepository(),
      },
    );

    const res = await chat(app, 'Mark the backstop job as completed');

    expect(res.status).toBe(200);
    expect(holdIfUnsupervisedSpy).toHaveBeenCalled();
    for (const call of holdIfUnsupervisedSpy.mock.calls) {
      expect(call[1]).toBe(false);
    }
  });
});
