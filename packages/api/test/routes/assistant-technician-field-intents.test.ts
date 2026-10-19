/**
 * POST /api/assistant/chat — the technician's day loop.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three independent blockers kept the core persona (a tradesperson in the
 * field) away from the assistant entirely:
 *
 *   1. `technician` held no `ai:run`, and `/api/assistant/chat` is guarded by
 *      `requirePermission('ai:run')` — the field user could not reach the AI
 *      at all, by voice or by typing.
 *   2. Epic 6 withheld `estimates:*` / `invoices:*` / `payments:*` on the
 *      stated non-goal that "technicians must not see office/billing
 *      surfaces". The owner overturned that on 2026-07-27: technicians DO
 *      quote and bill.
 *   3. Six field write intents had a task handler AND an execution handler but
 *      no entry in either chat dispatch map, so they fell through to a
 *      conversational LLM reply that drafted nothing.
 *
 * The grant that delivers (1)+(2) is deliberately just `ai:run`: the chat
 * route creates PROPOSALS, which needs `proposals:create` (already held) and
 * no billing permission whatsoever. These tests pin that draft-and-approve
 * shape, and pin that the permissions still withheld still refuse.
 *
 * NO LIVE LLM CALLS — the gateway is a scripted fake.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createAssistantRouter } from '../../src/routes/assistant';
import {
  requirePermission,
  resolveAuthorization,
  setAuthorizationLoader,
} from '../../src/middleware/auth';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { getPermissions, hasPermission } from '../../src/auth/rbac';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryCatalogItemRepository, createCatalogItem } from '../../src/catalog/catalog-item';
import { InMemoryJobRepository } from '../../src/jobs/job';
import type { EntityResolver } from '../../src/ai/resolution/entity-resolver';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TEST_TENANT = '22222222-2222-4222-8222-222222222222';
const TEST_USER = 'user-technician-field';

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(
      async () =>
        ({
          content: responses[Math.min(i++, responses.length - 1)],
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

/** Classifier responses are read as JSON by classifyIntent. */
function classifierReply(intentType: string, entities: Record<string, unknown> = {}): string {
  return JSON.stringify({
    intentType,
    confidence: 0.95,
    reasoning: 'test',
    extractedEntities: entities,
  });
}

function buildApp(
  gateway: LLMGateway,
  opts: { role?: 'owner' | 'dispatcher' | 'technician'; proposalRepo?: InMemoryProposalRepository } = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-tech',
      tenantId: TEST_TENANT,
      role: opts.role ?? 'technician',
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway,
      proposalRepo: opts.proposalRepo ?? new InMemoryProposalRepository(),
    }),
  );
  return app;
}

describe('technician × assistant — RBAC grant', () => {
  it('technician holds ai:run and can reach POST /api/assistant/chat with a real answer', async () => {
    expect(hasPermission('technician', 'ai:run')).toBe(true);

    const app = buildApp(
      scriptedGateway([
        JSON.stringify({ intentType: 'unknown', confidence: 0.2 }),
        JSON.stringify({ content: "Here's what's on today.", proposal: null }),
      ]),
    );
    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'what have I got on today?' }] });

    expect(res.status).toBe(200);
    // A real answer, not a 403 and not an empty body. This turn classifies as
    // 'unknown' and falls through to the generic LLM; the scripted reply is
    // honest, so the honesty guard passes it through (see
    // assistant-honest-refusal.test.ts) — the point here is that the
    // technician REACHES the AI at all.
    expect(res.body.message.content).toBe("Here's what's on today.");
  });

  it('the grant is ONLY ai:run — office/billing permissions stay withheld', () => {
    // The Epic 6 billing-isolation contract is deliberately preserved: the
    // owner's "technicians quote and bill" decision is delivered through the
    // draft-and-approve proposal path, not through direct office permissions.
    for (const perm of [
      'estimates:view',
      'estimates:create',
      'invoices:view',
      'invoices:create',
      'invoices:update',
      'payments:view',
      'payments:create',
      'appointments:create',
      'appointments:update',
      'reports:view',
      'proposals:approve',
    ] as const) {
      expect(hasPermission('technician', perm)).toBe(false);
      expect(getPermissions('technician')).not.toContain(perm);
    }
  });

  it('billing pushes still cannot reach a technician device', async () => {
    // NOTIFICATION_DESCRIPTORS gates payment_received on 'payments:create' and
    // invoice_overdue on 'invoices:update' — WRITE permissions, not :view.
    // Neither was granted, so the user-targeting resolver still excludes every
    // technician. This is the side effect most likely to annoy real users.
    const { NOTIFICATION_DESCRIPTORS } = await import(
      '../../src/notifications/owner-notification-service'
    );
    for (const type of ['payment_received', 'invoice_overdue'] as const) {
      const perm = NOTIFICATION_DESCRIPTORS[type].permission;
      expect(hasPermission('technician', perm)).toBe(false);
    }
  });
});

describe('technician × assistant — field write intents dispatch to proposals', () => {
  const cases: Array<{ intent: string; proposalType: string; utterance: string }> = [
    { intent: 'add_note', proposalType: 'add_note', utterance: 'add a note that the valve was corroded' },
    { intent: 'log_time_entry', proposalType: 'log_time_entry', utterance: 'log two hours on the Miller job' },
    { intent: 'log_expense', proposalType: 'log_expense', utterance: 'log a forty dollar part' },
    { intent: 'send_estimate', proposalType: 'send_estimate', utterance: 'send the estimate to Mrs Miller' },
    { intent: 'update_customer', proposalType: 'update_customer', utterance: "update Mrs Miller's phone number" },
  ];

  for (const { intent, proposalType, utterance } of cases) {
    it(`${intent} produces a ${proposalType} proposal for a technician`, async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const app = buildApp(scriptedGateway([classifierReply(intent)]), { proposalRepo });

      const res = await request(app)
        .post('/api/assistant/chat')
        .send({ messages: [{ role: 'user', content: utterance }] });

      expect(res.status).toBe(200);
      // The proposal card comes back on the turn...
      expect(res.body.message.proposal).toBeDefined();
      // ...and it was PERSISTED (the pre-fix failure mode returned an
      // unpersisted card whose id 404'd on approve).
      const stored = await proposalRepo.findByTenant(TEST_TENANT);
      expect(stored).toHaveLength(1);
      expect(stored[0].proposalType).toBe(proposalType);
      // Draft-and-approve: never executes on the technician's say-so.
      expect(stored[0].status).not.toBe('approved');
    });
  }

  it('create_appointment drafts for a technician instead of auto-executing', async () => {
    // create_appointment is one of SEVEN autonomous, capture-class drafting
    // types (proposals/caller-approval-gate.ts AUTO_APPROVE_DIRECT_PERMISSION),
    // so decideInitialStatus can return 'approved' — and the execution layer
    // performs NO permission check of its own. Without the gate, `ai:run`
    // would have become a back door around `appointments:create`, which
    // technicians deliberately lack.
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('create_appointment', {
          customerName: 'Miller',
          startTime: '2026-08-01T14:00:00Z',
        }),
        classifierReply('create_appointment', {
          customerName: 'Miller',
          startTime: '2026-08-01T14:00:00Z',
        }),
      ]),
      { proposalRepo },
    );

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'book Miller for Tuesday at 2pm' }] });

    expect(res.status).toBe(200);
    const stored = await proposalRepo.findByTenant(TEST_TENANT);
    expect(stored).toHaveLength(1);
    // The technician gets their draft — it just waits for the approval tap.
    expect(stored[0].status).not.toBe('approved');
    expect(stored[0].approvedAt).toBeUndefined();
  });
});

describe('technician × assistant — the gate still fails closed', () => {
  afterEach(() => {
    setAuthorizationLoader(null);
  });

  it('a withheld permission is refused when the DB role is technician and the Clerk claim says owner', async () => {
    // Established pattern: the JWT claim is the LIE, the DB row is the TRUTH.
    // resolveAuthorization overwrites req.auth.role with the membership role,
    // so a stale/forged `owner` token buys nothing.
    setAuthorizationLoader(async () => ({
      userId: '33333333-3333-4333-8333-333333333333',
      role: 'technician',
      status: 'active',
      deleted: false,
    }));

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: TEST_USER,
        sessionId: 'sess-tech',
        tenantId: TEST_TENANT,
        role: 'owner', // <- the Clerk claim lies
      };
      next();
    });
    app.use(resolveAuthorization);
    app.get('/estimates', requirePermission('estimates:create'), (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/chat', requirePermission('ai:run'), (_req, res) => {
      res.json({ ok: true });
    });

    // Withheld → refused, despite the owner claim.
    const denied = await request(app).get('/estimates');
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('FORBIDDEN');

    // Granted → allowed, on the DB role alone.
    const allowed = await request(app).get('/chat');
    expect(allowed.status).toBe(200);
  });
});

// OVAS-02 — the chat route used to downgrade only create_appointment /
// create_booking. Every other autonomous drafting type (draft_estimate,
// draft_invoice, update_estimate, update_invoice) was persisted 'approved' for
// a technician and executed on their say-so.
describe('OVAS-02 — a supervised, confident chat draft never self-executes for a role that lacks the direct permission', () => {
  const CUSTOMER_ID = '44444444-4444-4444-8444-444444444444';
  const JOB_ID = '55555555-5555-4555-8555-555555555555';

  beforeEach(() => {
    setSupervisorPresenceLoader(async () => true);
  });
  afterEach(() => {
    _resetSupervisorPresenceCache();
  });

  function gatewayByTask(replies: Record<string, string>): LLMGateway {
    return {
      complete: vi.fn(
        async (req: { taskType?: string }) =>
          ({
            content: replies[req.taskType ?? ''] ?? '{}',
            model: 'mock',
            provider: 'mock',
            tokenUsage: { input: 1, output: 1, total: 2 },
            latencyMs: 1,
          }) satisfies LLMResponse,
      ),
    } as unknown as LLMGateway;
  }

  const resolver = {
    resolve: vi.fn(async (input: { kind: string }) =>
      input.kind === 'customer'
        ? { kind: 'resolved', candidate: { id: CUSTOMER_ID, kind: 'customer', label: 'Miller', score: 0.99 } }
        : input.kind === 'job'
          ? { kind: 'resolved', candidate: { id: JOB_ID, kind: 'job', label: 'Miller job', score: 0.99 } }
          : { kind: 'not_found' },
    ),
  } as unknown as EntityResolver;

  async function chatAs(
    role: 'owner' | 'dispatcher' | 'technician',
    replies: Record<string, string>,
    utterance: string,
  ) {
    const proposalRepo = new InMemoryProposalRepository();
    const catalogRepo = new InMemoryCatalogItemRepository();
    await catalogRepo.create(
      createCatalogItem({
        tenantId: TEST_TENANT,
        name: 'Capacitor Replacement',
        category: 'labor',
        unit: 'each',
        unitPriceCents: 18900,
      }),
    );
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create({
      id: JOB_ID,
      tenantId: TEST_TENANT,
      customerId: CUSTOMER_ID,
      locationId: 'loc-1',
      jobNumber: 'JOB-1',
      summary: 'AC not cooling',
      status: 'scheduled',
      priority: 'normal',
      createdBy: TEST_USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: TEST_USER,
        sessionId: 'sess-ovas02',
        tenantId: TEST_TENANT,
        role,
      };
      next();
    });
    app.use(
      '/api/assistant',
      createAssistantRouter({
        gateway: gatewayByTask(replies),
        proposalRepo,
        catalogRepo,
        jobRepo,
        entityResolver: resolver,
      }),
    );
    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: utterance }] });
    expect(res.status).toBe(200);
    const stored = await proposalRepo.findByTenant(TEST_TENANT);
    expect(stored).toHaveLength(1);
    return stored[0];
  }

  const estimateReplies = {
    classify_intent: classifierReply('draft_estimate', {
      customerName: 'Miller',
      lineItemDescriptions: ['Capacitor Replacement'],
    }),
    draft_estimate: JSON.stringify({
      lineItems: [{ description: 'Capacitor Replacement', quantity: 1, unitPrice: 18900 }],
      confidence_score: 0.99,
    }),
  };
  const ESTIMATE_UTTERANCE = 'Quote Miller a capacitor replacement';

  it('draft_estimate: the owner keeps the auto-approval (no behavior change)', async () => {
    const stored = await chatAs('owner', estimateReplies, ESTIMATE_UTTERANCE);
    expect(stored.proposalType).toBe('draft_estimate');
    expect(stored.status).toBe('approved');
  });

  it('draft_estimate: a dispatcher (holds estimates:create) keeps the auto-approval', async () => {
    const stored = await chatAs('dispatcher', estimateReplies, ESTIMATE_UTTERANCE);
    expect(stored.status).toBe('approved');
  });

  it('draft_estimate: a technician gets the draft, held for a permission holder', async () => {
    const stored = await chatAs('technician', estimateReplies, ESTIMATE_UTTERANCE);
    expect(stored.proposalType).toBe('draft_estimate');
    expect(stored.status).not.toBe('approved');
    expect(stored.approvedAt).toBeUndefined();
  });

  it('update_job: a technician holds jobs:update, so their own job edit still auto-approves', async () => {
    const stored = await chatAs(
      'technician',
      {
        classify_intent: classifierReply('update_job', { jobReference: 'the Miller job', status: 'completed' }),
        update_job: JSON.stringify({
          jobReference: 'the Miller job',
          status: 'completed',
          confidence_score: 0.99,
        }),
      },
      'Mark the Miller job completed',
    );
    expect(stored.proposalType).toBe('update_job');
    expect(stored.status).toBe('approved');
  });
});
