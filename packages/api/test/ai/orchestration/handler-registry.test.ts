/**
 * B5 (feat: voice-transcript-and-agent-paths) — the shared handler-registry
 * builder that BOTH workers/voice-action-router.ts and routes/assistant.ts
 * call. This branch exists because those two surfaces had already
 * diverged (the assistant chat route silently dropped 12 intents to a bare
 * LLM reply while the voice worker drafted them); this test pins the
 * registry's contract — every "core" ProposalType is registered, each
 * handler tolerates every dep being absent (fail-open, gated — never
 * throws), and wiring a dep actually reaches the handler.
 */
import { describe, it, expect } from 'vitest';
import { buildTaskHandlers } from '../../../src/ai/orchestration/handler-registry';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import type { TaskContext } from '../../../src/ai/tasks/task-handlers';
import type { ProposalType } from '../../../src/proposals/proposal';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import { InMemoryJobRepository } from '../../../src/jobs/job';
import type { Job } from '../../../src/jobs/job';

function noopGateway(): LLMGateway {
  return {
    complete: async () =>
      ({
        content: '{}',
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 0, output: 0, total: 0 },
        latencyMs: 0,
      }) satisfies LLMResponse,
  } as unknown as LLMGateway;
}

function ctx(overrides: Partial<TaskContext> = {}): TaskContext {
  return { tenantId: 't-1', userId: 'u-1', message: 'test', ...overrides };
}

// The full "core" taxonomy the registry is expected to register — every
// ProposalType both the worker and the assistant route need a REAL drafting
// handler for. Deliberately excludes the surface-specific handlers
// (review_response_proposal, create_standing_instruction, the
// _complaint/_negotiation synthetic keys) documented as out-of-scope on
// HandlerRegistryDeps.
//
// B4 (feat: voice-transcript-and-agent-paths) — issue_invoice joined this
// list. It used to be excluded as a "known, tracked divergence" (the worker
// and the assistant route each had their own local handler); B4 unified them
// into ai/orchestration/task-router.ts's IssueInvoiceTaskHandler, registered
// here like every other core intent.
const EXPECTED_PROPOSAL_TYPES: ProposalType[] = [
  'draft_invoice',
  'draft_estimate',
  'create_appointment',
  'update_invoice',
  'update_estimate',
  'create_customer',
  'create_job',
  // B7 (feat: voice-transcript-and-agent-paths) — update_job.
  'update_job',
  'reschedule_appointment',
  'cancel_appointment',
  'reassign_appointment',
  'add_crew_member',
  'remove_crew_member',
  'add_note',
  'send_invoice',
  'send_estimate',
  'send_estimate_nudge',
  'send_payment_reminder',
  'apply_late_fee',
  'record_payment',
  'emergency_dispatch',
  'update_customer',
  'log_expense',
  'convert_lead',
  'confirm_appointment',
  'mark_lead_lost',
  'add_service_location',
  'log_time_entry',
  'notify_delay',
  'request_feedback',
  'batch_invoice',
  'create_invoice_schedule',
  'issue_invoice',
];

describe('ai/orchestration/handler-registry — buildTaskHandlers', () => {
  it('registers a handler for every core ProposalType, with no deps wired', () => {
    const handlers = buildTaskHandlers({ gateway: noopGateway() });
    for (const type of EXPECTED_PROPOSAL_TYPES) {
      expect(handlers.get(type), `missing handler for ${type}`).toBeDefined();
      expect(handlers.get(type)!.taskType).toBe(type);
    }
    expect(handlers.size).toBe(EXPECTED_PROPOSAL_TYPES.length);
  });

  it('does NOT register the surface-specific handlers (review_response_proposal, create_standing_instruction, the complaint/negotiation synthetic keys) — those stay owned by each call site', () => {
    const handlers = buildTaskHandlers({ gateway: noopGateway() });
    expect(handlers.get('review_response_proposal')).toBeUndefined();
    expect(handlers.get('create_standing_instruction')).toBeUndefined();
    expect(handlers.get('_complaint' as ProposalType)).toBeUndefined();
    expect(handlers.get('_negotiation' as ProposalType)).toBeUndefined();
  });

  // B4 — issue_invoice with no proposalRepo/invoiceRepo wired still gates
  // cleanly (rung 3: missingFields, no candidates) rather than throwing —
  // proven separately from the loop below because its `.handle()` needs no
  // gateway call at all (deterministic, unlike the LLM-drafting handlers).
  it('issue_invoice gates cleanly (no throw) with no deps wired', async () => {
    const handlers = buildTaskHandlers({ gateway: noopGateway() });
    const { proposal } = await handlers.get('issue_invoice')!.handle(ctx());
    expect(proposal.payload).toEqual({});
    expect(proposal.sourceContext).toMatchObject({ missingFields: ['invoiceId'] });
  });

  // B4 — proposalRepo threaded into buildTaskHandlers reaches
  // IssueInvoiceTaskHandler's conversation-context resolution rung, proving
  // the shared registry — not a surface-local construction — is what both
  // callers now get.
  it('threads proposalRepo into issue_invoice so a same-conversation draft_invoice resolves "the one we just drafted"', async () => {
    const { InMemoryProposalRepository, createProposal } = await import('../../../src/proposals/proposal');
    const proposalRepo = new InMemoryProposalRepository();
    const draft = createProposal({
      tenantId: 't-1',
      proposalType: 'draft_invoice',
      payload: {},
      summary: 'Draft invoice',
      sourceContext: { conversationId: 'conv-1' },
      createdBy: 'u-1',
    });
    draft.resultEntityId = 'invoice-xyz';
    await proposalRepo.create(draft);

    const handlers = buildTaskHandlers({ gateway: noopGateway(), proposalRepo });
    const { proposal } = await handlers
      .get('issue_invoice')!
      .handle(ctx({ conversationId: 'conv-1', message: 'issue the one we just drafted' }));

    expect(proposal.payload).toEqual({ invoiceId: 'invoice-xyz' });
    expect(proposal.sourceContext?.verifiedIds).toEqual({ invoiceId: 'invoice-xyz' });
  });

  it('every handler tolerates a fully-absent dep bundle — gates instead of throwing', async () => {
    const handlers = buildTaskHandlers({ gateway: noopGateway() });
    for (const type of EXPECTED_PROPOSAL_TYPES) {
      // draft_invoice/draft_estimate/update_invoice/update_estimate/
      // create_appointment call the LLM gateway to draft — exercised
      // elsewhere (their own task-handler suites); this loop's contract is
      // "construction + handle() never throws for the deterministic
      // passthrough handlers", so skip the LLM-drafting ones here.
      if (
        [
          'draft_invoice',
          'draft_estimate',
          'update_invoice',
          'update_estimate',
          'update_job',
          'create_appointment',
        ].includes(type)
      ) {
        continue;
      }
      await expect(handlers.get(type)!.handle(ctx())).resolves.toBeDefined();
    }
  });

  it('threads appointmentRepo + jobRepo into reschedule_appointment so a resolvable single active appointment yields a concrete appointmentId', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const job: Job = {
      id: 'job-1',
      tenantId: 't-1',
      customerId: 'cust-1',
      locationId: 'loc-1',
      jobNumber: 'JOB-0001',
      summary: 'Miller job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: 'u-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await jobRepo.create(job);
    await appointmentRepo.create({
      id: 'appt-1',
      tenantId: 't-1',
      jobId: job.id,
      scheduledStart: new Date(Date.now() + 86_400_000),
      scheduledEnd: new Date(Date.now() + 90_000_000),
      timezone: 'America/New_York',
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: 'u-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const handlers = buildTaskHandlers({ gateway: noopGateway(), appointmentRepo, jobRepo });
    const { proposal } = await handlers.get('reschedule_appointment')!.handle(
      ctx({
        tenantId: 't-1',
        existingEntities: {
          appointmentReference: 'the Miller job',
          newDateTimeDescription: 'Thursday at 2pm',
        },
      }),
    );
    expect(proposal.proposalType).toBe('reschedule_appointment');
    expect((proposal.payload as Record<string, unknown>).appointmentId).toBe('appt-1');
  });

  it('batch_invoice degrades to a voice_clarification (never throws) when invoicingDeps is absent, and drafts when wired', async () => {
    const withoutDeps = buildTaskHandlers({ gateway: noopGateway() });
    const { proposal: clarified } = await withoutDeps.get('batch_invoice')!.handle(ctx());
    expect(clarified.proposalType).toBe('voice_clarification');
    expect((clarified.payload as Record<string, unknown>).classifierReasoning).toBe(
      'Batch invoicing is not available right now.',
    );

    const withDeps = buildTaskHandlers({
      gateway: noopGateway(),
      invoicingDeps: {
        jobRepo: { findByTenant: async () => [] } as never,
        invoiceRepo: { findByJobs: async () => [] } as never,
        estimateRepo: { findByJobs: async () => [] } as never,
      },
    });
    const { proposal: empty } = await withDeps.get('batch_invoice')!.handle(ctx());
    // No completed-unbilled jobs in this fixture — still a clarification
    // (an empty batch is never draftable), but with the DIFFERENT message
    // BatchInvoiceTaskHandler emits once invoicingDeps is wired — proving
    // invoicingDeps reached findJobsRequiringInvoicing rather than the
    // handler short-circuiting on "absent".
    expect(empty.proposalType).toBe('voice_clarification');
    expect((empty.payload as Record<string, unknown>).classifierReasoning).toBe(
      'You have no completed jobs waiting to be invoiced right now.',
    );
  });

  // B7 (feat: voice-transcript-and-agent-paths) — the registry wires
  // deps.jobRepo into UpdateJobTaskHandler so a resolvable free-text job
  // reference is stamped onto payload.jobId (still gated — see
  // job-edit-task.test.ts for the full gating contract).
  it('threads jobRepo into update_job so a resolvable free-text reference stamps payload.jobId', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job: Job = {
      id: 'job-1',
      tenantId: 't-1',
      customerId: 'cust-1',
      locationId: 'loc-1',
      jobNumber: 'JOB-0001',
      summary: 'Water heater replacement',
      status: 'scheduled',
      priority: 'normal',
      createdBy: 'u-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await jobRepo.create(job);

    const gateway: LLMGateway = {
      complete: async () =>
        ({
          content: JSON.stringify({ jobReference: 'JOB-0001', status: 'in_progress', confidence_score: 0.9 }),
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 0, output: 0, total: 0 },
          latencyMs: 0,
        }) satisfies LLMResponse,
    } as unknown as LLMGateway;

    const handlers = buildTaskHandlers({ gateway, jobRepo });
    const { proposal } = await handlers.get('update_job')!.handle(ctx());
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.jobId).toBe('job-1');
    // Still gated — a search-resolved id never lifts the missingFields gate
    // (see resolveJobIdGate's doc comment in job-edit-task.ts).
    expect(proposal.sourceContext).toMatchObject({ missingFields: ['jobId'] });
  });

  // B8 (feat: voice-transcript-and-agent-paths) — create_customer draft-time
  // duplicate detection parity. Before B8, only the telephony FSM
  // (twilio-adapter.ts) constructed CreateCustomerVoiceTaskHandler with a
  // duplicateLoader; this registry built the thin passthrough instead, so
  // the voice worker and assistant chat surfaced no advisory. These tests
  // pin that buildTaskHandlers now constructs the SAME dedup-aware handler
  // for both surfaces, wired from `customerRepo`.
  describe('B8 — create_customer dedup-aware wiring', () => {
    function customerRepoWithMatch(): {
      findDuplicates: (
        tenantId: string,
        criteria: { phone?: string; email?: string; name?: string },
      ) => Promise<Array<Record<string, unknown>>>;
    } {
      return {
        findDuplicates: async (tenantId: string) => [
          {
            id: 'existing-cust-1',
            tenantId,
            firstName: 'Alex',
            lastName: 'Smith',
            displayName: 'Alex Smith',
            primaryPhone: '+15551230100',
            preferredChannel: 'phone',
            smsConsent: false,
            isArchived: false,
            createdBy: 'u',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      };
    }

    it('constructs create_customer as CreateCustomerVoiceTaskHandler (not the thin passthrough)', () => {
      const handlers = buildTaskHandlers({ gateway: noopGateway() });
      const handler = handlers.get('create_customer');
      expect(handler?.constructor.name).toBe('CreateCustomerVoiceTaskHandler');
    });

    it('threads customerRepo into create_customer as the duplicateLoader — a near-duplicate stamps the advisory marker', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const customerRepo = customerRepoWithMatch() as any;
      const handlers = buildTaskHandlers({ gateway: noopGateway(), customerRepo });
      const { proposal } = await handlers.get('create_customer')!.handle(
        ctx({
          existingEntities: { displayName: 'Alex Smith', callerIdPhone: '+15551230100' },
        }),
      );
      expect(proposal.proposalType).toBe('create_customer');
      const meta = (proposal.payload as Record<string, unknown>)._meta as
        | { markers?: Array<{ path: string; reason: string }> }
        | undefined;
      expect(meta?.markers?.length ?? 0).toBeGreaterThanOrEqual(1);
    });

    it('omits the advisory marker with no customerRepo wired (clean draft, unchanged from pre-B8)', async () => {
      const handlers = buildTaskHandlers({ gateway: noopGateway() });
      const { proposal } = await handlers.get('create_customer')!.handle(
        ctx({
          existingEntities: { displayName: 'Alex Smith', callerIdPhone: '+15551230100' },
        }),
      );
      expect(proposal.proposalType).toBe('create_customer');
      expect((proposal.payload as Record<string, unknown>)._meta).toBeUndefined();
    });

    it('drafts a phone-less create_customer proposal (requirePhone: false — no caller-ID concept on the worker/assistant surfaces)', async () => {
      const handlers = buildTaskHandlers({ gateway: noopGateway() });
      const { proposal } = await handlers.get('create_customer')!.handle(
        ctx({ existingEntities: { displayName: 'Sarah', email: 'sarah@example.com' } }),
      );
      expect(proposal.proposalType).toBe('create_customer');
      expect((proposal.payload as Record<string, unknown>).name).toBe('Sarah');
    });
  });
});
