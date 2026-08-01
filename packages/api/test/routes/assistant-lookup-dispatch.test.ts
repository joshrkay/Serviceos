/**
 * POST /api/assistant/chat — `lookup_*` dispatch.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Sixteen `lookup_*` skills shipped and ran on the inbound-phone path, but
 * NONE were reachable from `/api/assistant/chat` — the endpoint where both
 * typed input and the mic button land. Production `ai_runs` had ZERO rows
 * with `task_type ILIKE '%lookup%' OR model='data-lookup'`, ever. Every
 * lookup question classified to a `lookup_*` intent, matched no handler,
 * and fell through to a DB-less generic LLM that answered from nothing.
 *
 * These tests pin the four properties that failure mode violated:
 *   1. a wired lookup reaches the SKILL and the skill's DB data reaches the
 *      response (not the generic LLM),
 *   2. a zero-row lookup returns the skill's accurate empty answer rather
 *      than a fluent invention,
 *   3. a skill FAILURE is visible, not swallowed into the generic fallback,
 *   4. the DB-authoritative `reports:view` gate still refuses.
 * Plus a regression pin that `UNPAID_QUERY_RE` still runs first.
 *
 * NO LIVE LLM CALLS. The gateway is the `scriptedGateway` fake used
 * throughout `assistant.route.test.ts`.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { createAssistantRouter } from '../../src/routes/assistant';
import type { AssistantLookupDeps } from '../../src/ai/orchestration/lookup-dispatch';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { Appointment } from '../../src/appointments/appointment';
import { InMemoryJobRepository, createJob } from '../../src/jobs/job';
import type { JobRepository } from '../../src/jobs/job';
import { InMemoryInvoiceRepository, createInvoice } from '../../src/invoices/invoice';
import { buildLineItem } from '../../src/shared/billing-engine';
import { InMemoryMoneyDashboardRepository } from '../../src/reports/money-dashboard';
import { InMemoryLeadRepository, type Lead } from '../../src/leads/lead';
import {
  createCatalogItem,
  InMemoryCatalogItemRepository,
} from '../../src/catalog/catalog-item';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TEST_TENANT = '11111111-1111-4111-8111-111111111111';
const TEST_USER = 'user-lookup-dispatch';
const TZ = 'America/New_York';
/** Noon EDT on 2026-07-15 — pins "today" for the day-overview window. */
const NOW = new Date('2026-07-15T16:00:00Z');

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

/**
 * `role` is the CLERK claim the route middleware reads. It is deliberately
 * separate from `resolveMemberRole` (the DB-authoritative role the lookup
 * authz gate reads) — that split is the whole point of the fail-closed gate.
 */
function buildApp(
  gateway: LLMGateway,
  opts: {
    lookups?: AssistantLookupDeps;
    invoiceRepo?: import('../../src/invoices/invoice').InvoiceRepository;
    role?: 'owner' | 'dispatcher' | 'technician';
  } = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-lookup',
      tenantId: TEST_TENANT,
      role: opts.role ?? 'owner',
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway,
      proposalRepo: new InMemoryProposalRepository(),
      ...(opts.invoiceRepo ? { invoiceRepo: opts.invoiceRepo } : {}),
      ...(opts.lookups ? { lookups: opts.lookups } : {}),
    }),
  );
  return app;
}

/** Day-overview fixture: one urgent job + one appointment on 2026-07-15 NY. */
async function dayOverviewLookups(overrides: Partial<AssistantLookupDeps> = {}) {
  const jobRepo = new InMemoryJobRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const proposalRepo = new InMemoryProposalRepository();

  const job = await createJob(
    {
      tenantId: TEST_TENANT,
      customerId: 'cust-miller',
      locationId: 'loc-miller',
      summary: 'Furnace replacement at the Miller house',
      priority: 'urgent',
      createdBy: TEST_USER,
    } as never,
    jobRepo,
  );

  const appointment: Appointment = {
    id: 'appt-1',
    tenantId: TEST_TENANT,
    jobId: job.id,
    // 10:00 AM EDT on 2026-07-15.
    scheduledStart: new Date('2026-07-15T14:00:00Z'),
    scheduledEnd: new Date('2026-07-15T16:00:00Z'),
    timezone: TZ,
    status: 'scheduled',
    holdPendingApproval: false,
    createdBy: TEST_USER,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await appointmentRepo.create(appointment);

  const lookups: AssistantLookupDeps = {
    answers: {},
    shared: { jobRepo, appointmentRepo, proposalRepo },
    tenantTimezoneResolver: async () => TZ,
    now: () => NOW,
    ...overrides,
  };
  return { lookups, jobRepo, appointmentRepo, proposalRepo, job };
}

// The phrase below is a deterministic extended-intent match
// (`matchExtendedIntentPhrase`), which only fires when the route passes
// `extendedIntents: true`. Scripting the gateway to say `unknown` therefore
// doubles as the assertion that the flag really is set: if it weren't, the
// classifier would fall through to this scripted `unknown` and no lookup
// would run at all.
const DAY_QUESTION = 'What does my day look like?';
const GATEWAY_SAYS_UNKNOWN = JSON.stringify({
  intentType: 'unknown',
  confidence: 0.2,
  extractedEntities: {},
});

describe('POST /api/assistant/chat — lookup dispatch reaches the skill', () => {
  it('answers from the day-overview SKILL, with the tenant DB data in the reply', async () => {
    const gateway = scriptedGateway([GATEWAY_SAYS_UNKNOWN]);
    const { lookups } = await dayOverviewLookups();
    const app = buildApp(gateway, { lookups });

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: DAY_QUESTION }] });

    expect(res.status).toBe(200);
    // The lookup marker the production evidence query keys on.
    expect(res.body.model).toBe('data-lookup');
    expect(res.body.taskType).toBe('assistant.lookup.lookup_day_overview');

    const content: string = res.body.message.content;
    // Real rows out of the repos — an LLM with no DB access cannot produce these.
    expect(content).toContain('Furnace replacement at the Miller house');
    expect(content).toContain('1 appointment today');
    expect(content).toContain('10 AM');

    // And the generic LLM path never ran.
    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(res.body.degraded).toBeUndefined();
  });

  it('zero rows → the skill\'s accurate empty answer, not a fluent hallucination', async () => {
    const gateway = scriptedGateway([GATEWAY_SAYS_UNKNOWN]);
    const lookups: AssistantLookupDeps = {
      answers: {},
      shared: {
        jobRepo: new InMemoryJobRepository(),
        appointmentRepo: new InMemoryAppointmentRepository(),
        proposalRepo: new InMemoryProposalRepository(),
      },
      tenantTimezoneResolver: async () => TZ,
      now: () => NOW,
    };
    const app = buildApp(gateway, { lookups });

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: DAY_QUESTION }] });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('data-lookup');
    expect(res.body.taskType).toBe('assistant.lookup.lookup_day_overview');
    // The skill's own empty-state copy, verbatim.
    expect(res.body.message.content).toBe(
      'Your day is clear — no appointments today and nothing is waiting on you.',
    );
    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe('POST /api/assistant/chat — a failing lookup stays VISIBLE', () => {
  it('surfaces a degraded failure instead of silently falling back to the LLM', async () => {
    const gateway = scriptedGateway([
      // If the failure WERE swallowed, this is the fluent nonsense the
      // operator would get instead.
      'Sure! You have three appointments today and everything looks great.',
    ]);
    const { lookups, jobRepo } = await dayOverviewLookups();
    // The skill's repo read blows up mid-lookup.
    vi.spyOn(jobRepo as JobRepository, 'findByTenant').mockRejectedValue(
      new Error('pg: connection terminated'),
    );
    const app = buildApp(gateway, { lookups });

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: DAY_QUESTION }] });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('data-lookup');
    expect(res.body.degraded).toBe(true);
    expect(res.body.fallbackStage).toBe('lookup-failed');
    expect(res.body.message.content).toContain("I couldn't pull up your day overview");
    // The generic LLM answer must NOT be what the operator sees.
    expect(res.body.message.content).not.toContain('three appointments');
    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe('POST /api/assistant/chat — UNPAID_QUERY_RE still runs first', () => {
  it('routes "which invoices are unpaid?" to the deterministic invoice query, not the lookup dispatch', async () => {
    const invoiceRepo = new InMemoryInvoiceRepository();
    const invoice = await createInvoice(
      {
        tenantId: TEST_TENANT,
        jobId: 'job-1',
        customerId: 'cust-1',
        invoiceNumber: 'INV-0042',
        lineItems: [buildLineItem('li-1', 'Service call', 1, 12_500, 0, false)],
        taxRateBps: 0,
        createdBy: TEST_USER,
      } as never,
      invoiceRepo,
    );
    await invoiceRepo.update(TEST_TENANT, invoice.id, { status: 'open' } as never);

    const gateway = scriptedGateway([
      JSON.stringify({ intentType: 'lookup_invoices', confidence: 0.9, extractedEntities: {} }),
    ]);
    const { lookups } = await dayOverviewLookups();
    const app = buildApp(gateway, { lookups, invoiceRepo });

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Which invoices are unpaid?' }] });

    expect(res.status).toBe(200);
    // The pre-existing deterministic path — NOT assistant.lookup.*.
    expect(res.body.taskType).toBe('assistant.query.unpaid_invoices');
    expect(res.body.message.content).toContain('INV-0042');
    expect(res.body.message.content).toContain('$125.00');
    // It short-circuits before classification, so the gateway is untouched.
    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe('POST /api/assistant/chat — owner-grade lookups keep the reports:view gate', () => {
  const REVENUE_CLASSIFICATION = JSON.stringify({
    intentType: 'lookup_revenue',
    confidence: 0.94,
    extractedEntities: {},
  });

  function revenueLookups(
    resolveMemberRole: (tenantId: string, userId: string) => Promise<string | null>,
  ): AssistantLookupDeps {
    const moneyDashboardRepo = new InMemoryMoneyDashboardRepository();
    moneyDashboardRepo.setSummary({
      month: '2026-07',
      revenueCents: 4_250_00,
      outstandingCents: 90_000,
    } as never);
    return {
      answers: { moneyDashboardRepo, resolveMemberRole },
      shared: { proposalRepo: new InMemoryProposalRepository() },
      now: () => NOW,
    };
  }

  it('refuses when the DB-authoritative role lacks reports:view (Clerk claim says owner)', async () => {
    const gateway = scriptedGateway([REVENUE_CLASSIFICATION]);
    // The Clerk claim on the request says `owner` — the gate must not trust it.
    const app = buildApp(gateway, {
      role: 'owner',
      lookups: revenueLookups(async () => 'technician'),
    });

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'How much have we brought in this month?' }] });

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.lookup.lookup_revenue');
    expect(res.body.message.content).toBe(
      "That's an owner-level report. Ask an owner or dispatcher on your team to pull it up.",
    );
    // No revenue figure leaks into the refusal.
    expect(res.body.message.content).not.toContain('4250');
  });

  it('fails CLOSED when the role cannot be resolved at all', async () => {
    const gateway = scriptedGateway([REVENUE_CLASSIFICATION]);
    const app = buildApp(gateway, { lookups: revenueLookups(async () => null) });

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'How much have we brought in this month?' }] });

    expect(res.status).toBe(200);
    expect(res.body.message.content).toContain('owner-level report');
  });

  it('answers a dispatcher (has reports:view) from the money dashboard', async () => {
    const gateway = scriptedGateway([REVENUE_CLASSIFICATION]);
    const app = buildApp(gateway, { lookups: revenueLookups(async () => 'dispatcher') });

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'How much have we brought in this month?' }] });

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.lookup.lookup_revenue');
    // The money dashboard's cents, formatted by the skill.
    expect(res.body.message.content).toContain('$4250.00');
    expect(res.body.message.content).toContain('$900.00 still outstanding');
    expect(res.body.message.content).not.toContain('owner-level report');
  });
});

// U7 — operator-surface lookup parity. `lookup_leads` / `lookup_catalog`
// used to be the two intents `dispatchAssistantLookup` returned null for,
// silently falling through to the DB-less generic LLM. They now answer on
// chat via the SAME shared skills telephony calls.
describe('POST /api/assistant/chat — U7 parity: lookup_leads / lookup_catalog', () => {
  const LEADS_CLASSIFICATION = JSON.stringify({
    intentType: 'lookup_leads',
    confidence: 0.93,
    extractedEntities: {},
  });
  const CATALOG_CLASSIFICATION = JSON.stringify({
    intentType: 'lookup_catalog',
    confidence: 0.93,
    extractedEntities: {},
  });

  function lead(id: string, stage: Lead['stage']): Lead {
    return {
      id,
      tenantId: TEST_TENANT,
      firstName: 'Lead',
      lastName: id,
      source: 'web_form',
      stage,
      createdBy: TEST_USER,
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  function leadsLookups(
    leadRepo: InMemoryLeadRepository,
    resolveMemberRole: (tenantId: string, userId: string) => Promise<string | null>,
  ): AssistantLookupDeps {
    return {
      answers: { leadRepo, resolveMemberRole },
      shared: { proposalRepo: new InMemoryProposalRepository() },
      now: () => NOW,
    };
  }

  async function seededCatalogRepo(): Promise<InMemoryCatalogItemRepository> {
    const repo = new InMemoryCatalogItemRepository();
    await repo.create(
      createCatalogItem({
        tenantId: TEST_TENANT,
        name: 'Drain cleaning',
        category: 'Labor',
        unit: 'hour',
        unitPriceCents: 22500,
      }),
    );
    await repo.create(
      createCatalogItem({
        tenantId: TEST_TENANT,
        name: 'Water heater flush',
        category: 'Labor',
        unit: 'each',
        unitPriceCents: 14900,
      }),
    );
    return repo;
  }

  function catalogLookups(
    catalogRepo: InMemoryCatalogItemRepository,
    resolveMemberRole: (tenantId: string, userId: string) => Promise<string | null>,
  ): AssistantLookupDeps {
    return {
      answers: { catalogRepo, resolveMemberRole },
      shared: { proposalRepo: new InMemoryProposalRepository() },
      now: () => NOW,
    };
  }

  it('answers the lead-pipeline question from the SKILL with tenant DB data', async () => {
    const gateway = scriptedGateway([LEADS_CLASSIFICATION]);
    const leadRepo = new InMemoryLeadRepository();
    await leadRepo.create(lead('lead-1', 'new'));
    await leadRepo.create(lead('lead-2', 'qualified'));
    await leadRepo.create(lead('lead-3', 'won')); // closed — not "open"
    // Technicians hold `customers:view` (the GET /api/leads gate): the same
    // role that can open the leads screen gets the answer here too.
    const app = buildApp(gateway, {
      lookups: leadsLookups(leadRepo, async () => 'technician'),
    });

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'How many open leads do we have?' }] });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('data-lookup');
    expect(res.body.taskType).toBe('assistant.lookup.lookup_leads');
    // Real rows out of the repo — won/lost leads excluded.
    expect(res.body.message.content).toBe('There are 2 open leads in the pipeline.');
    // Exactly ONE gateway call (the classifier) — the generic LLM never ran.
    expect(gateway.complete as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(res.body.degraded).toBeUndefined();
  });

  it('zero open leads → the skill\'s honest empty answer, not a fluent invention', async () => {
    const gateway = scriptedGateway([LEADS_CLASSIFICATION]);
    const app = buildApp(gateway, {
      lookups: leadsLookups(new InMemoryLeadRepository(), async () => 'owner'),
    });

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'How many open leads do we have?' }] });

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.lookup.lookup_leads');
    // The skill's own empty-state copy, verbatim.
    expect(res.body.message.content).toBe('There are no open leads in the pipeline right now.');
  });

  it('catalog: a dispatcher (settings:view) hears the price book', async () => {
    const gateway = scriptedGateway([CATALOG_CLASSIFICATION]);
    const app = buildApp(gateway, {
      lookups: catalogLookups(await seededCatalogRepo(), async () => 'dispatcher'),
    });

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'What services do we offer?' }] });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('data-lookup');
    expect(res.body.taskType).toBe('assistant.lookup.lookup_catalog');
    // Alphabetical, exactly the shared skill's copy.
    expect(res.body.message.content).toBe(
      'You have 2 catalog items: Drain cleaning, Water heater flush.',
    );
  });

  it('catalog: a technician is refused by the DB-authoritative role, not the Clerk claim', async () => {
    const gateway = scriptedGateway([CATALOG_CLASSIFICATION]);
    const catalogRepo = await seededCatalogRepo();
    const listByTenant = vi.spyOn(catalogRepo, 'listByTenant');
    // The Clerk claim says `owner` — the gate must not trust it.
    const app = buildApp(gateway, {
      role: 'owner',
      lookups: catalogLookups(catalogRepo, async () => 'technician'),
    });

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'What services do we offer?' }] });

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.lookup.lookup_catalog');
    expect(res.body.message.content).toBe(
      'The service catalog is an office-level view. Ask an owner or dispatcher on your team to pull it up.',
    );
    // Refusal short-circuits BEFORE the skill; nothing leaks.
    expect(listByTenant).not.toHaveBeenCalled();
    expect(res.body.message.content).not.toContain('Drain cleaning');
  });

  it('catalog: empty catalog answers honestly', async () => {
    const gateway = scriptedGateway([CATALOG_CLASSIFICATION]);
    const app = buildApp(gateway, {
      lookups: catalogLookups(new InMemoryCatalogItemRepository(), async () => 'owner'),
    });

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'What services do we offer?' }] });

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.lookup.lookup_catalog');
    expect(res.body.message.content).toBe('Your service catalog is empty right now.');
  });
});
