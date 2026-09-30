/**
 * #1498 — LLM QA 2026-09-29: chat lookups that dead-ended on "Which customer
 * do you mean?", a schedule answer that contradicted itself, and document
 * numbers (JOB-/INV-/EST-) that never resolved.
 *
 * Seam: POST /api/assistant/chat via supertest. The gateway is scripted to
 * return the classifier JSON the production classifier produced for each
 * failing utterance (intent from the recorded `taskType` in
 * ~/Serviceos-qa-evidence/2026-09-29-llm/chat/ — the evidence records the
 * intent, not the entities, so each case scripts the leanest entity set the
 * classifier could have returned: none, or the document number it names).
 * Everything after the classifier is the real route, dispatch and skills
 * over in-memory repos.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { createAssistantRouter } from '../../src/routes/assistant';
import type { AssistantLookupDeps } from '../../src/ai/orchestration/lookup-dispatch';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryJobRepository } from '../../src/jobs/job';
import type { Job } from '../../src/jobs/job';
import type { Appointment } from '../../src/appointments/appointment';
import { InMemoryUserRepository } from '../../src/users/user';
import { answerInAppLookup } from '../../src/ai/voice-turn/inapp-lookup-surface';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import type { Invoice, InvoiceStatus } from '../../src/invoices/invoice';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import type { Estimate, EstimateStatus } from '../../src/estimates/estimate';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { EntityResolver } from '../../src/ai/resolution/entity-resolver';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OPERATOR = 'user-1498-operator';
/** 1:00 PM EDT, Tuesday 2026-09-29 (tenant zone America/New_York). */
const NOW = new Date('2026-09-29T17:00:00Z');
const TZ = 'America/New_York';

function classifierSays(intentType: string, extractedEntities: Record<string, unknown> = {}): LLMGateway {
  return {
    complete: vi.fn(
      async () =>
        ({
          content: JSON.stringify({ intentType, confidence: 0.9, extractedEntities }),
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

function buildApp(gateway: LLMGateway, lookups: AssistantLookupDeps) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: OPERATOR,
      sessionId: 'sess-1498',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({ gateway, proposalRepo: new InMemoryProposalRepository(), lookups }),
  );
  return app;
}

async function ask(app: express.Express, content: string) {
  return request(app).post('/api/assistant/chat').send({ messages: [{ role: 'user', content }] });
}

const zeroTotals = { subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0 } as never;

function invoice(
  number: string,
  status: InvoiceStatus,
  amountDueCents: number,
  opts: { dueDate?: Date; jobId?: string; totalCents?: number } = {},
): Invoice {
  return {
    id: `inv-${number}`,
    tenantId: TENANT,
    jobId: opts.jobId ?? 'job-any',
    invoiceNumber: number,
    status,
    lineItems: [],
    totals: { ...(zeroTotals as object), totalCents: opts.totalCents ?? amountDueCents } as never,
    amountPaidCents: 0,
    amountDueCents,
    ...(opts.dueDate ? { dueDate: opts.dueDate } : {}),
    createdBy: OPERATOR,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function estimate(number: string, status: EstimateStatus, totalCents = 10_000): Estimate {
  return {
    id: `est-${number}`,
    tenantId: TENANT,
    jobId: 'job-any',
    estimateNumber: number,
    status,
    lineItems: [],
    totals: { ...(zeroTotals as object), totalCents } as never,
    createdBy: OPERATOR,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as Estimate;
}

function job(number: string, summary: string, status: Job['status'], extra: Partial<Job> = {}): Job {
  return {
    id: `job-${number}`,
    tenantId: TENANT,
    customerId: 'cust-1',
    locationId: 'loc-1',
    jobNumber: number,
    summary,
    status,
    priority: 'normal',
    createdBy: OPERATOR,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  } as Job;
}

async function world(opts: { role?: string } = {}) {
  const invoiceRepo = new InMemoryInvoiceRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const jobRepo = new InMemoryJobRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const lookups: AssistantLookupDeps = {
    answers: {
      invoiceRepo,
      estimateRepo,
      resolveMemberRole: async () => opts.role ?? 'owner',
    },
    shared: { jobRepo, appointmentRepo, proposalRepo: new InMemoryProposalRepository() },
    tenantTimezoneResolver: async () => TZ,
    now: () => NOW,
  };
  return { lookups, invoiceRepo, estimateRepo, jobRepo, appointmentRepo };
}

const WHICH_CUSTOMER = 'Which customer do you mean?';

function appointment(
  id: string,
  jobId: string,
  startIso: string,
  endIso: string,
  status: Appointment['status'] = 'scheduled',
): Appointment {
  return {
    id,
    tenantId: TENANT,
    jobId,
    scheduledStart: new Date(startIso),
    scheduledEnd: new Date(endIso),
    timezone: TZ,
    status,
    holdPendingApproval: false,
    createdBy: OPERATOR,
    createdAt: NOW,
    updatedAt: NOW,
  } as Appointment;
}

/**
 * The QA day, in the tenant's zone (America/New_York), asked at 1 PM on
 * Tuesday 2026-09-29:
 *   today     9 AM  Gutter check      (ended, never marked done)
 *             10 AM Drain snaking     (completed)
 *             3 PM  Furnace repair    (still ahead, assigned to tech-1)
 *             5 PM  Canceled visit    (canceled — never counts)
 *   tomorrow  10 AM Water heater flush
 *             2 PM  AC tune-up        (assigned to tech-1)
 */
async function seedQaDay(w: Awaited<ReturnType<typeof world>>) {
  await w.jobRepo.create(job('JOB-0101', 'Gutter check', 'scheduled'));
  await w.jobRepo.create(job('JOB-0102', 'Drain snaking', 'completed'));
  await w.jobRepo.create(job('JOB-0103', 'Furnace repair', 'scheduled', { assignedTechnicianId: 'tech-1' }));
  await w.jobRepo.create(job('JOB-0104', 'Canceled visit', 'canceled'));
  await w.jobRepo.create(job('JOB-0105', 'Water heater flush', 'scheduled'));
  await w.jobRepo.create(job('JOB-0106', 'AC tune-up', 'scheduled', { assignedTechnicianId: 'tech-1' }));
  await w.appointmentRepo.create(appointment('a1', 'job-JOB-0101', '2026-09-29T13:00:00Z', '2026-09-29T14:00:00Z'));
  await w.appointmentRepo.create(
    appointment('a2', 'job-JOB-0102', '2026-09-29T14:00:00Z', '2026-09-29T15:00:00Z', 'completed'),
  );
  await w.appointmentRepo.create(appointment('a3', 'job-JOB-0103', '2026-09-29T19:00:00Z', '2026-09-29T20:00:00Z'));
  await w.appointmentRepo.create(
    appointment('a4', 'job-JOB-0104', '2026-09-29T21:00:00Z', '2026-09-29T22:00:00Z', 'canceled'),
  );
  await w.appointmentRepo.create(appointment('a5', 'job-JOB-0105', '2026-09-30T14:00:00Z', '2026-09-30T15:00:00Z'));
  await w.appointmentRepo.create(appointment('a6', 'job-JOB-0106', '2026-09-30T18:00:00Z', '2026-09-30T19:00:00Z'));
}

describe('#1498 slices 1+2 — schedule questions answer for the day that was asked', () => {
  it('C02: "What appointments do we have tomorrow?" lists tomorrow\'s visits, not "Which customer?"', async () => {
    const w = await world();
    await seedQaDay(w);
    const app = buildApp(
      classifierSays('lookup_appointments', { dateTimeDescription: 'tomorrow' }),
      w.lookups,
    );

    const res = await ask(app, 'What appointments do we have tomorrow?');

    expect(res.body.taskType).toBe('assistant.lookup.lookup_appointments');
    expect(res.body.message.content).toBe(
      'You have 2 appointments tomorrow: 10 AM — Water heater flush; 2 PM — AC tune-up.',
    );
    expect(res.body.outcome).toBe('answered');
  });

  it('C40: "Who\'s scheduled for tomorrow?" honours the day word even with no extracted date', async () => {
    const w = await world();
    await seedQaDay(w);
    const app = buildApp(classifierSays('lookup_appointments'), w.lookups);

    const res = await ask(app, "Who's scheduled for tomorrow?");

    expect(res.body.message.content).toBe(
      'You have 2 appointments tomorrow: 10 AM — Water heater flush; 2 PM — AC tune-up.',
    );
  });

  it('C01: an owner\'s "What\'s on my schedule today?" reads the business\'s day — all of it, and what is left', async () => {
    const w = await world();
    await seedQaDay(w);
    const app = buildApp(classifierSays('lookup_my_day'), w.lookups);

    const res = await ask(app, "What's on my schedule today?");

    expect(res.body.taskType).toBe('assistant.lookup.lookup_my_day');
    expect(res.body.message.content).toBe(
      'You have 3 appointments today, 1 still ahead: 3 PM — Furnace repair.',
    );
  });

  it('C36: "What does my day look like?" (day overview) speaks the SAME schedule sentence as C01', async () => {
    const w = await world();
    await seedQaDay(w);
    const app = buildApp(classifierSays('unknown'), w.lookups);

    const res = await ask(app, 'What does my day look like?');

    expect(res.body.taskType).toBe('assistant.lookup.lookup_day_overview');
    expect(res.body.message.content).toContain(
      'You have 3 appointments today, 1 still ahead: 3 PM — Furnace repair.',
    );
  });

  it('C34: "What does my day look like tomorrow?" answers for tomorrow, labelled tomorrow', async () => {
    const w = await world();
    await seedQaDay(w);
    const app = buildApp(classifierSays('lookup_day_overview'), w.lookups);

    const res = await ask(app, 'What does my day look like tomorrow?');

    expect(res.body.message.content).toBe(
      'You have 2 appointments tomorrow: 10 AM — Water heater flush; 2 PM — AC tune-up.',
    );
  });

  it('once the day is over, "nothing left today" says the day HAD visits — it never claims an empty day', async () => {
    const w = await world();
    await seedQaDay(w);
    const lookups = { ...w.lookups, now: () => new Date('2026-09-30T01:30:00Z') }; // 9:30 PM EDT
    const app = buildApp(classifierSays('lookup_my_day'), lookups);

    const res = await ask(app, "What's on my schedule today?");

    expect(res.body.message.content).toBe("Nothing left today — all 3 of today's appointments are behind you.");
  });

  it('a technician hears only their own assignments', async () => {
    const w = await world({ role: 'technician' });
    await seedQaDay(w);
    const userRepo = new InMemoryUserRepository();
    await userRepo.create({
      id: 'tech-1',
      tenantId: TENANT,
      clerkUserId: OPERATOR,
      email: 'tech@example.test',
      role: 'technician',
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);
    const lookups = { ...w.lookups, shared: { ...w.lookups.shared, userRepo } };
    const app = buildApp(classifierSays('lookup_my_day'), lookups);

    const res = await ask(app, "What's on my schedule tomorrow?");

    expect(res.body.message.content).toBe('You have 1 appointment tomorrow: 2 PM — AC tune-up.');
  });
});

describe('#1498 slice 1 — tenant-wide lookups answer without a customer', () => {
  it('C04: "How many open invoices…total outstanding?" counts every open invoice in the tenant', async () => {
    const w = await world();
    await w.invoiceRepo.create(invoice('INV-0001', 'open', 25_000));
    await w.invoiceRepo.create(invoice('INV-0002', 'partially_paid', 10_000));
    await w.invoiceRepo.create(invoice('INV-0003', 'paid', 0));
    await w.invoiceRepo.create(invoice('INV-0004', 'draft', 9_900));
    const app = buildApp(classifierSays('lookup_invoices'), w.lookups);

    const res = await ask(app, "How many open invoices do we have right now, and what's the total outstanding?");

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.lookup.lookup_invoices');
    expect(res.body.message.content).not.toContain(WHICH_CUSTOMER);
    expect(res.body.message.content).toBe('You have 2 open invoices with $350.00 outstanding in total.');
    expect(res.body.outcome).toBe('answered');
  });

  it('C27: the Spanish open-invoice question gets the same tenant-wide answer, not "Which customer?"', async () => {
    // The chat surface has no Spanish reply path today (no language detection
    // on POST /api/assistant/chat; only the phone skills localise), so the
    // answer is the English one — see the PR notes.
    const w = await world();
    await w.invoiceRepo.create(invoice('INV-0001', 'open', 25_000));
    const app = buildApp(classifierSays('lookup_invoices'), w.lookups);

    const res = await ask(app, '¿Cuántas facturas abiertas tenemos y cuánto nos deben en total?');

    expect(res.body.message.content).toBe('You have 1 open invoice with $250.00 outstanding in total.');
  });

  it('a technician (no invoices:view) is refused the tenant-wide invoice totals', async () => {
    const w = await world({ role: 'technician' });
    await w.invoiceRepo.create(invoice('INV-0001', 'open', 25_000));
    const app = buildApp(classifierSays('lookup_invoices'), w.lookups);

    const res = await ask(app, 'How many open invoices do we have?');

    expect(res.body.outcome).toBe('refused');
    expect(res.body.message.content).not.toContain('$250.00');
  });
});

describe('#1498 slice 1 — draft-estimate count', () => {
  it('C09: "How many draft estimates do I have?" counts the tenant\'s drafts', async () => {
    const w = await world();
    await w.estimateRepo.create(estimate('EST-0001', 'draft'));
    await w.estimateRepo.create(estimate('EST-0002', 'draft'));
    await w.estimateRepo.create(estimate('EST-0003', 'draft'));
    await w.estimateRepo.create(estimate('EST-0004', 'sent'));
    await w.estimateRepo.create(estimate('EST-0005', 'accepted'));
    const app = buildApp(classifierSays('lookup_estimates'), w.lookups);

    const res = await ask(app, 'How many draft estimates do I have?');

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.lookup.lookup_estimates');
    expect(res.body.message.content).toBe('You have 3 draft estimates.');
    expect(res.body.outcome).toBe('answered');
  });

  it('"How many estimates do we have?" (no status named) counts the open ones', async () => {
    const w = await world();
    await w.estimateRepo.create(estimate('EST-0001', 'draft'));
    await w.estimateRepo.create(estimate('EST-0002', 'sent'));
    await w.estimateRepo.create(estimate('EST-0003', 'sent'));
    await w.estimateRepo.create(estimate('EST-0004', 'accepted'));
    const app = buildApp(classifierSays('lookup_estimates'), w.lookups);

    const res = await ask(app, 'How many estimates do we have?');

    expect(res.body.message.content).toBe(
      'You have 3 open estimates: 1 not sent yet and 2 waiting on the customer.',
    );
  });
});

describe('#1498 slice 1 — document numbers resolve directly', () => {
  it('C06: "What\'s the status of job JOB-0081?" answers that job\'s status', async () => {
    const w = await world();
    await w.jobRepo.create(job('JOB-0081', 'Furnace repair', 'scheduled'));
    await w.jobRepo.create(job('JOB-0082', 'AC tune-up', 'completed'));
    const app = buildApp(classifierSays('lookup_jobs', { jobReference: 'JOB-0081' }), w.lookups);

    const res = await ask(app, "What's the status of job JOB-0081?");

    expect(res.body.taskType).toBe('assistant.lookup.lookup_jobs');
    expect(res.body.message.content).toBe('JOB-0081 (Furnace repair) is scheduled.');
    expect(res.body.outcome).toBe('answered');
  });

  it('C11: an unknown number gets an honest "couldn\'t find JOB-9999"', async () => {
    const w = await world();
    await w.jobRepo.create(job('JOB-0081', 'Furnace repair', 'scheduled'));
    const app = buildApp(classifierSays('lookup_jobs', { jobReference: 'JOB-9999' }), w.lookups);

    const res = await ask(app, "What's the status of job JOB-9999?");

    expect(res.body.message.content).toBe("I couldn't find JOB-9999.");
    expect(res.body.outcome).toBe('not_found');
  });

  it('C08: "What\'s the status of invoice INV-0067?" — a draft says it has not gone out, with its total', async () => {
    const w = await world();
    await w.invoiceRepo.create(invoice('INV-0067', 'draft', 25_000));
    await w.invoiceRepo.create(invoice('INV-0060', 'paid', 0, { totalCents: 18_000 }));
    // The classifier extracted no entity at all for this one: the number is
    // only in the operator's own words.
    const app = buildApp(classifierSays('lookup_invoices'), w.lookups);

    const draft = await ask(app, "What's the status of invoice INV-0067?");
    const paid = await ask(app, 'Status of INV-0060?');

    expect(draft.body.message.content).toBe(
      "INV-0067 is a draft for $250.00 — it hasn't been sent to the customer yet.",
    );
    expect(paid.body.message.content).toBe('INV-0060 is paid in full ($180.00).');
  });

  it('C39: "Show me job JOB-0081." reads the number from the operator\'s words', async () => {
    const w = await world();
    await w.jobRepo.create(job('JOB-0081', 'Furnace repair', 'in_progress'));
    const app = buildApp(classifierSays('lookup_jobs'), w.lookups);

    const res = await ask(app, 'Show me job JOB-0081.');

    expect(res.body.message.content).toBe('JOB-0081 (Furnace repair) is in progress.');
  });
});

describe('#1498 slice 4 — a per-customer answer names the customer', () => {
  it('C33: "What does Morgan Tatebrook owe us?" says Morgan Tatebrook, not "Your account"', async () => {
    const w = await world();
    const entityResolver = {
      resolve: vi.fn(async () => ({
        kind: 'resolved' as const,
        candidate: { id: '5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f', kind: 'customer' as const, label: 'Morgan Tatebrook', score: 0.97 },
      })),
    } as unknown as EntityResolver;
    const app = buildApp(
      classifierSays('lookup_balance', { customerName: 'Morgan Tatebrook' }),
      { ...w.lookups, entityResolver },
    );

    const res = await ask(app, 'What does Morgan Tatebrook owe us?');

    expect(res.body.message.content).toBe(
      "Morgan Tatebrook's account is paid in full — nothing currently owed.",
    );
  });
});

describe('#1498 slice 2 — chat and in-app voice give the SAME schedule answer', () => {
  it('V4: the voice "What does my day look like?" (lookup_my_day) speaks the chat sentence', async () => {
    const w = await world();
    await seedQaDay(w);
    const app = buildApp(classifierSays('lookup_my_day'), w.lookups);
    const session = new VoiceSessionStore().create(TENANT, 'inapp');

    const chat = await ask(app, "What's on my schedule today?");
    const spoken = await answerInAppLookup(w.lookups, {
      session,
      tenantId: TENANT,
      userId: OPERATOR,
      intent: 'lookup_my_day',
    });

    expect(spoken).toBe('You have 3 appointments today, 1 still ahead: 3 PM — Furnace repair.');
    expect(chat.body.message.content).toBe(spoken);
  });

  it('voice honours the spoken day word too: "Who\'s scheduled for tomorrow?" with no extracted date', async () => {
    const w = await world();
    await seedQaDay(w);
    const session = new VoiceSessionStore().create(TENANT, 'inapp');

    const spoken = await answerInAppLookup(w.lookups, {
      session,
      tenantId: TENANT,
      userId: OPERATOR,
      intent: 'lookup_appointments',
      transcript: "Who's scheduled for tomorrow?",
    });

    expect(spoken).toBe('You have 2 appointments tomorrow: 10 AM — Water heater flush; 2 PM — AC tune-up.');
  });
});
