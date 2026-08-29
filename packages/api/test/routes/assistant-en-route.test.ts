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

function buildApp(
  opts: {
    enRoute?: AssistantEnRouteDeps;
    role?: string;
    userId?: string;
    gateway?: LLMGateway;
  } = {},
) {
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
  const gateway = opts.gateway ?? scriptedGateway([classifierReply('en_route')]);
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway,
      proposalRepo,
      ...(opts.enRoute ? { enRoute: opts.enRoute } : {}),
    }),
  );
  return { app, proposalRepo, gateway };
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

  describe('#914 (C01) — deterministic phrase pre-check', () => {
    // The C01 live-sweep row (corpus.json, technician actor, utterance
    // "On my way to the job") got a generic assistant.general reply instead
    // of the en_route act: the classifier runs the full 'operator'-profile
    // (all 78 intents; D-028) taxonomy on chat with no actor-role narrowing
    // — unlike the phone/inapp-voice paths' 'field_tech' profile — so a
    // brief on-my-way utterance can miss classification. These tests build
    // an app whose SCRIPTED classifier deliberately returns something OTHER
    // than 'en_route' (reproducing the miss), and assert the deterministic
    // EN_ROUTE_PHRASE_RE pre-check still routes to the technician core.
    function buildAppWithMisclassifier(
      opts: { enRoute?: AssistantEnRouteDeps; wrongIntent?: string } = {},
    ) {
      const app = express();
      app.use(express.json());
      app.use((req: Request, _res: Response, next: NextFunction) => {
        (req as AuthenticatedRequest).auth = {
          userId: TECH_CLERK_ID,
          sessionId: 'sess-enroute-misclassify',
          tenantId: TEST_TENANT,
          role: 'technician',
        };
        next();
      });
      const proposalRepo = new InMemoryProposalRepository();
      app.use(
        '/api/assistant',
        createAssistantRouter({
          // The classifier returns a DIFFERENT intent — reproducing the
          // live-sweep miss — so only the deterministic phrase pre-check
          // (not `classification.intentType === 'en_route'`) can rescue it.
          gateway: scriptedGateway([classifierReply(opts.wrongIntent ?? 'unknown')]),
          proposalRepo,
          ...(opts.enRoute ? { enRoute: opts.enRoute } : {}),
        }),
      );
      return { app, proposalRepo };
    }

    it('"On my way to the job" (the exact C01 utterance) still fires the audited act when the classifier misses en_route', async () => {
      const bundle = enRouteBundle();
      const { app } = buildAppWithMisclassifier({ enRoute: bundle });

      const res = await chat(app, 'On my way to the job');

      expect(res.status).toBe(200);
      expect(res.body.taskType).toBe('assistant.en_route');
      expect(res.body.message.content).toContain('Sent the customer an on-my-way text');
      expect(bundle.coordinator.enqueueEnRouteNotice).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TEST_TENANT, appointmentId: 'appt-1' }),
      );
    });

    it('"OMW" (the SMS keyword, case-insensitive) also fires the act via the same phrase pre-check', async () => {
      const bundle = enRouteBundle();
      const { app } = buildAppWithMisclassifier({ enRoute: bundle });

      const res = await chat(app, 'omw');

      expect(res.status).toBe(200);
      expect(res.body.taskType).toBe('assistant.en_route');
      expect(bundle.coordinator.enqueueEnRouteNotice).toHaveBeenCalled();
    });

    it('an unrelated utterance with no en_route phrase and a misclassified intent still gets the generic reply (no over-matching)', async () => {
      const bundle = enRouteBundle();
      const { app } = buildAppWithMisclassifier({ enRoute: bundle, wrongIntent: 'unknown' });

      const res = await chat(app, 'What is my schedule looking like today?');

      expect(res.status).toBe(200);
      expect(res.body.taskType).not.toBe('assistant.en_route');
      expect(bundle.coordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
    });
  });
});

// ─── #910 / C02 — deterministic classification, not a scripted-correct one ──
//
// Every test above scripts the gateway with a classifier reply that ALREADY
// says `en_route` — it pins the DISPATCH/execution logic, but not whether
// classification itself is reliable. The 2026-08-29 live sweep (issue #910,
// corpus row C02, "On my way to the job" from an owner/non-technician
// account) found gpt-4o-mini intermittently classified this exact phrasing
// as something other than `en_route`, so the request fell through to the
// generic DB-less LLM (model gpt-4o-mini/assistant.general) instead of
// reaching the identity-aware en_route branch tested above — a
// non-deterministic failure, not a dispatch-order bug (routes/assistant.ts
// already checks the en_route branch before any generic fallback). These
// tests script the gateway to return something OTHER than en_route — the
// exact shape of the sweep's observed failure — and confirm the
// deterministic pre-scan (intent-classifier.ts's matchEnRoutePhrase) now
// routes correctly without ever calling the LLM.
describe('#910 — "On my way to the job" routes to en_route deterministically, even when the LLM would not', () => {
  it('a technician still fires the audited act when the gateway is scripted to say something else entirely', async () => {
    const bundle = enRouteBundle();
    const badGateway = scriptedGateway([
      classifierReply('unknown'),
      'Make sure to check the job details before arriving. Stay safe on the road!',
    ]);
    const { app, proposalRepo, gateway } = buildApp({ enRoute: bundle, gateway: badGateway });

    const res = await chat(app, 'On my way to the job');

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.en_route');
    expect(res.body.message.content).toContain('Sent the customer an on-my-way text');
    expect(bundle.coordinator.enqueueEnRouteNotice).toHaveBeenCalled();
    expect(await proposalRepo.findByTenant(TEST_TENANT)).toHaveLength(0);
    // The whole point: the deterministic match fires BEFORE the gateway is
    // ever consulted, so a flaky/wrong classifier response never has a
    // chance to derail this exact corpus phrasing.
    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('C02 — an owner/non-technician account gets the honest identity refusal deterministically (matches the corpus honest_refusal expectation, not the generic-LLM fallthrough the sweep observed)', async () => {
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
    const badGateway = scriptedGateway([
      'Make sure to check the job details, customer preferences, and any special instructions before arriving. Stay safe on the road!',
    ]);
    const { app, gateway } = buildApp({ enRoute: bundle, role: 'owner', gateway: badGateway });

    const res = await chat(app, 'On my way to the job');

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.en_route');
    expect(res.body.message.content).toContain('nothing was sent');
    expect(bundle.coordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
