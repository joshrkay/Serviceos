/**
 * #847 — en_route ("on my way") from assistant chat.
 *
 * Before the fix the intent was in neither CHAT_INTENT_TO_REGISTRY_KEY nor
 * NON_ACTION_INTENTS, so a technician typing "on my way" hit the honest
 * unmapped-capability refusal ("I can't do that from here yet"). It now
 * dispatches from its own branch — before that refusal — into the SAME
 * technician core every other en-route surface drives, gated on a canonical
 * TECHNICIAN identity (the SMS keyword leg's anti-spoofing rule).
 *
 * NO LIVE LLM CALLS — the gateway is a scripted fake. The real-DB legs live
 * in test/integration/en-route-voice.test.ts.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { createAssistantRouter, type AssistantEnRouteDeps } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TEST_TENANT = 'tenant-chat-enroute';
const TECH_CLERK_ID = 'clerk-tech-chat';
const TECH_ID = 'tech-canonical-chat';
const NOW = new Date('2026-08-26T16:00:00.000Z'); // midday America/Chicago

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

function enRouteBundle(over: Partial<AssistantEnRouteDeps> = {}): AssistantEnRouteDeps & {
  coordinator: { enqueueEnRouteNotice: ReturnType<typeof vi.fn> };
} {
  const coordinator = { enqueueEnRouteNotice: vi.fn(async () => 'appt-1:en_route') };
  return {
    userRepo: {
      findByTenant: async () =>
        [
          {
            id: TECH_ID,
            tenantId: TEST_TENANT,
            clerkUserId: TECH_CLERK_ID,
            email: 'tech@x.com',
            role: 'technician',
            firstName: 'Carlos',
            lastName: 'Ruiz',
          },
        ] as never,
    },
    assignmentRepo: {
      findByTechnician: async (_t: string, techId: string) =>
        techId === TECH_ID ? ([{ id: 'a1', appointmentId: 'appt-1', technicianId: TECH_ID }] as never) : [],
    },
    appointmentRepo: {
      findById: async () =>
        ({
          id: 'appt-1',
          jobId: 'job-1',
          status: 'scheduled',
          scheduledStart: new Date('2026-08-26T18:00:00.000Z'),
        }) as never,
    },
    settingsRepo: { findByTenant: async () => ({ tenantId: TEST_TENANT, timezone: 'America/Chicago' } as never) },
    enRouteCoordinator: coordinator,
    now: () => NOW,
    coordinator,
    ...over,
  };
}

function buildApp(opts: { enRoute?: AssistantEnRouteDeps; role?: string; userId?: string } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: opts.userId ?? TECH_CLERK_ID,
      sessionId: 'sess-enroute',
      tenantId: TEST_TENANT,
      role: opts.role ?? 'technician',
    };
    next();
  });
  const proposalRepo = new InMemoryProposalRepository();
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway: scriptedGateway([classifierReply('en_route')]),
      proposalRepo,
      ...(opts.enRoute ? { enRoute: opts.enRoute } : {}),
    }),
  );
  return { app, proposalRepo };
}

async function chat(app: express.Express, content: string) {
  return request(app)
    .post('/api/assistant/chat')
    .send({ messages: [{ role: 'user', content }] });
}

describe('#847 — en_route from chat', () => {
  it('a technician fires the audited act and gets the on-my-way confirmation — no proposal, no LLM improvisation', async () => {
    const bundle = enRouteBundle();
    const { app, proposalRepo } = buildApp({ enRoute: bundle });

    const res = await chat(app, "I'm on my way");

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.en_route');
    expect(res.body.message.content).toContain('Sent the customer an on-my-way text');
    expect(bundle.coordinator.enqueueEnRouteNotice).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TEST_TENANT, appointmentId: 'appt-1', technicianName: 'Carlos Ruiz' }),
    );
    expect(await proposalRepo.findByTenant(TEST_TENANT)).toHaveLength(0);
  });

  it('a non-technician account is refused honestly and the act never fires', async () => {
    const bundle = enRouteBundle({
      userRepo: {
        findByTenant: async () =>
          [
            {
              id: 'owner-1',
              tenantId: TEST_TENANT,
              clerkUserId: TECH_CLERK_ID,
              email: 'o@x.com',
              role: 'owner',
            },
          ] as never,
      },
    });
    const { app } = buildApp({ enRoute: bundle, role: 'owner' });

    const res = await chat(app, "I'm on my way");

    expect(res.status).toBe(200);
    expect(res.body.message.content).toContain('nothing was sent');
    expect(bundle.coordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
  });

  it('no tenant timezone → an honest cannot-answer, never a UTC-guessed day', async () => {
    const bundle = enRouteBundle({
      settingsRepo: { findByTenant: async () => ({ tenantId: TEST_TENANT, timezone: null } as never) },
    });
    const { app } = buildApp({ enRoute: bundle });

    const res = await chat(app, "I'm on my way");

    expect(res.status).toBe(200);
    expect(res.body.message.content).toContain('no timezone set');
    expect(res.body.message.content).toContain('nothing was sent');
    expect(bundle.coordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
  });

  it('nothing eligible today → an explicit "nothing was sent" answer', async () => {
    const bundle = enRouteBundle({
      assignmentRepo: { findByTechnician: async () => [] },
    });
    const { app } = buildApp({ enRoute: bundle });

    const res = await chat(app, "I'm on my way");

    expect(res.status).toBe(200);
    expect(res.body.message.content).toContain('nothing was sent');
    expect(bundle.coordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
  });

  it('without the wired bundle the intent keeps the pre-#847 honest refusal (no regression for unwired deployments)', async () => {
    const { app } = buildApp();

    const res = await chat(app, "I'm on my way");

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.unhandled.en_route');
    expect(res.body.message.content).toContain("can't do that from here");
  });
});
