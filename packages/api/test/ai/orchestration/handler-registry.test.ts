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
// (issue_invoice, review_response_proposal, create_standing_instruction, the
// _complaint/_negotiation synthetic keys) documented as out-of-scope on
// HandlerRegistryDeps.
const EXPECTED_PROPOSAL_TYPES: ProposalType[] = [
  'draft_invoice',
  'draft_estimate',
  'create_appointment',
  'update_invoice',
  'update_estimate',
  'create_customer',
  'create_job',
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

  it('does NOT register the surface-specific handlers (issue_invoice, review_response_proposal, create_standing_instruction, the complaint/negotiation synthetic keys) — those stay owned by each call site', () => {
    const handlers = buildTaskHandlers({ gateway: noopGateway() });
    expect(handlers.get('issue_invoice')).toBeUndefined();
    expect(handlers.get('review_response_proposal')).toBeUndefined();
    expect(handlers.get('create_standing_instruction')).toBeUndefined();
    expect(handlers.get('_complaint' as ProposalType)).toBeUndefined();
    expect(handlers.get('_negotiation' as ProposalType)).toBeUndefined();
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
        ['draft_invoice', 'draft_estimate', 'update_invoice', 'update_estimate', 'create_appointment'].includes(
          type,
        )
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
});
