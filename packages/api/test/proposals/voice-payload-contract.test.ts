/**
 * C1 — payload-contract drift test.
 *
 * See projects/rivet-voice-19/c1-design.md for the full design. Short
 * version: a voice-drafted proposal is only safe to auto-approve when its
 * payload will actually EXECUTE. `approveProposal` (proposals/actions.ts)
 * only blocks on `missingFields` — it has no idea whether the execution
 * handler's own validation will accept the payload. Before this test, a
 * drafting task handler could emit `missingFields: []` for a payload the
 * REAL execution handler rejects (a "Payload must include a valid X"
 * validation error), and nothing caught the mismatch: the proposal sails
 * through approval and then fails at execution — the exact class of bug
 * `add_note` has today (see the RED row below).
 *
 * Invariant (per mapped intent): the payload produced by the REAL drafting
 * task handler, given resolver-style `existingEntities`, must either
 *   (a) execute cleanly through the REAL execution handler (success, or a
 *       wiring-class `handler_not_wired:*` refusal when constructed
 *       dep-less), or
 *   (b) carry honest, non-empty `missingFields` (which `approveProposal` is
 *       separately proven to block on — see proposals/actions.test.ts).
 * Any row where `missingFields` is empty AND the execution handler rejects
 * the payload (a validation-class error, e.g. `/^Payload must/`) is a drift
 * failure.
 *
 * Mechanics:
 *   - Iterates `INTENT_TO_PROPOSAL_TYPE` (the single map, voice-intent-map.ts)
 *     and fails if any mapped intent has no row below, or any row names an
 *     unmapped intent — the permanent CI gate for new intents.
 *   - Drafting: the REAL `buildTaskHandlers` registry (handler-registry.ts)
 *     with a per-row mocked gateway (only for handlers that call the LLM)
 *     plus in-memory repos where a row needs one to draft with a resolved
 *     id. `review_response_proposal` / `create_standing_instruction` are
 *     built the way `voice-action-router.ts` (buildHandlers, ~line 478)
 *     does — they are excluded from the shared registry by design.
 *   - Execution ('resolves' rows only): the REAL execution-handler class,
 *     constructed with in-memory repos when needed for a full run, else
 *     dep-less so it acts as a pure payload validator (every voice-extended
 *     handler validates the payload BEFORE its own wiring check).
 *   - 'gated' rows never construct an execution handler — the row's whole
 *     claim is "this payload legitimately still needs a human to resolve
 *     something", which `missingFields` alone (or a `voice_clarification`
 *     degrade) already proves.
 */
import { describe, it, expect, vi } from 'vitest';
import { INTENT_TO_PROPOSAL_TYPE } from '../../src/proposals/voice-intent-map';
import { buildTaskHandlers, HandlerRegistryDeps } from '../../src/ai/orchestration/handler-registry';
import { TaskContext, TaskResult } from '../../src/ai/tasks/task-handlers';
import { RespondToReviewTaskHandler } from '../../src/ai/tasks/review-response-task';
import { CreateStandingInstructionTaskHandler } from '../../src/ai/tasks/standing-instruction-task';
import {
  Proposal,
  ProposalType,
  missingFieldsFor,
  InMemoryProposalRepository,
} from '../../src/proposals/proposal';
import { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { voiceClarificationPayloadSchema } from '../../src/proposals/contracts';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from '../../src/proposals/execution/handlers';
import { CreateInvoiceExecutionHandler } from '../../src/proposals/execution/invoice-execution-handler';
import {
  DraftEstimateExecutionHandler,
  CreateJobExecutionHandler,
  CreateAppointmentExecutionHandler,
  UpdateCustomerExecutionHandler,
} from '../../src/proposals/execution/handlers';
import { IssueInvoiceExecutionHandler } from '../../src/proposals/execution/issue-invoice-handler';
import { CreateInvoiceScheduleExecutionHandler } from '../../src/proposals/execution/invoice-schedule-handler';
import { BatchInvoiceExecutionHandler } from '../../src/proposals/execution/batch-invoice-handler';
import { UpdateJobExecutionHandler } from '../../src/proposals/execution/update-job-handler';
import { UpdateInvoiceExecutionHandler } from '../../src/proposals/execution/update-invoice-handler';
import { UpdateEstimateExecutionHandler } from '../../src/proposals/execution/update-estimate-handler';
import { RescheduleAppointmentExecutionHandler } from '../../src/proposals/execution/reschedule-handler';
import { CancelAppointmentExecutionHandler } from '../../src/proposals/execution/cancellation-handler';
import { ReassignAppointmentExecutionHandler } from '../../src/proposals/execution/reassignment-handler';
import {
  ConfirmAppointmentExecutionHandler,
  LogTimeEntryExecutionHandler,
} from '../../src/proposals/execution/full-app-voice-handlers';
import { AddNoteExecutionHandler } from '../../src/proposals/execution/voice-extended-handlers';
import { LogExpenseExecutionHandler } from '../../src/proposals/execution/log-expense-handler';
import { CreateStandingInstructionExecutionHandler } from '../../src/proposals/execution/standing-instruction-handler';
import { CreateCustomerVoiceExecutionHandler } from '../../src/proposals/execution/create-customer-handler';
import { EmergencyDispatchExecutionHandler } from '../../src/proposals/execution/emergency-dispatch-handler';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryJobRepository, type Job } from '../../src/jobs/job';
import { InMemoryInvoiceRepository, type Invoice } from '../../src/invoices/invoice';
import { InMemoryEstimateRepository, type Estimate } from '../../src/estimates/estimate';
import { buildLineItem, calculateDocumentTotals, type LineItem } from '../../src/shared/billing-engine';
import type { AppointmentRepository } from '../../src/appointments/appointment';
import type { JobRepository } from '../../src/jobs/job';
import type { InvoicingQueueDeps } from '../../src/invoices/invoicing-queue';

const TENANT_ID = 't-1';
const USER_ID = 'u-1';

// Resolver-style UUIDs — the seams voice-action-router.ts actually threads
// onto `existingEntities` (annotation.resolved.*, ~line 1490). Never
// invented keys, only real ones: technicianId, appointmentId, jobId,
// customerId, invoiceId, estimateId.
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID_FOR_EDIT = '22222222-2222-4222-8222-222222222223';
const INVOICE_ID = '33333333-3333-4333-8333-333333333333';
const ESTIMATE_ID = '44444444-4444-4444-8444-444444444444';
// B5.3 — reassign_appointment's resolver-verified seams.
const APPOINTMENT_ID = '55555555-5555-4555-8555-555555555555';
const TECHNICIAN_ID = '66666666-6666-4666-8666-666666666666';

// Anchor instant + tenant zone that `resolveDateTime` resolves "tomorrow at
// 2pm" against deterministically (mirrors test/ai/scheduling/resolve-datetime.test.ts).
const NOW = new Date('2026-06-01T12:00:00.000Z');
const TIMEZONE = 'America/New_York';

function ctx(overrides: Partial<TaskContext> = {}): TaskContext {
  return { tenantId: TENANT_ID, userId: USER_ID, message: 'test transcript', ...overrides };
}

/** Repo convention: test/ai/tasks/estimate-edit-task.test.ts lines 36-46. */
function mockGateway(jsonContent: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: jsonContent,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 100, output: 60, total: 160 },
      latencyMs: 44,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

/** Trips a test loudly if a row that shouldn't need the LLM calls it anyway. */
const NOOP_GATEWAY: LLMGateway = {
  complete: vi.fn(async () => {
    throw new Error('this row does not expect the gateway to be called');
  }),
} as unknown as LLMGateway;

const stubAuditRepo = new InMemoryAuditRepository();

async function draft(
  deps: HandlerRegistryDeps,
  proposalType: ProposalType,
  context: TaskContext,
): Promise<TaskResult> {
  const handlers = buildTaskHandlers(deps);
  const handler = handlers.get(proposalType);
  if (!handler) {
    throw new Error(`buildTaskHandlers registered no drafting handler for ${proposalType}`);
  }
  return handler.handle(context);
}

// ── Fixture builders ─────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    tenantId: TENANT_ID,
    customerId: CUSTOMER_ID,
    locationId: 'loc-1',
    jobNumber: 'JOB-0001',
    summary: 'Water heater replacement',
    status: 'scheduled',
    priority: 'normal',
    createdBy: USER_ID,
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const lineItems: LineItem[] = [buildLineItem('li-1', 'Diagnostic visit', 1, 12500, 0, true, 'labor')];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: INVOICE_ID,
    tenantId: TENANT_ID,
    jobId: JOB_ID_FOR_EDIT,
    invoiceNumber: 'INV-0001',
    status: 'draft',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    createdBy: USER_ID,
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}

function makeEstimate(overrides: Partial<Estimate> = {}): Estimate {
  const lineItems: LineItem[] = [buildLineItem('li-1', 'Site visit', 1, 15000, 0, true, 'labor')];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: ESTIMATE_ID,
    tenantId: TENANT_ID,
    jobId: JOB_ID_FOR_EDIT,
    estimateNumber: 'EST-0001',
    status: 'draft',
    lineItems,
    totals,
    createdBy: USER_ID,
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}

/** Single-active-appointment fake — only the fields resolveActiveAppointmentId reads. */
function singleActiveAppointmentRepo(): AppointmentRepository {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return {
    listWithMeta: async () => ({
      data: [{ id: 'appt-1', status: 'scheduled', jobId: JOB_ID, scheduledStart: future }],
    }),
  } as unknown as AppointmentRepository;
}

/** Minimal job repo for UpdateEstimateExecutionHandler's deposit-lock resolution. */
function noDepositJobRepo(): Pick<JobRepository, 'findById'> {
  return {
    findById: async (tenantId: string, id: string) =>
      tenantId === TENANT_ID && id === JOB_ID_FOR_EDIT
        ? ({ id: JOB_ID_FOR_EDIT, tenantId: TENANT_ID, depositPaidCents: 0 } as Job)
        : null,
  };
}

// ── Row shape ────────────────────────────────────────────────────────────

interface Row {
  intent: string;
  mode: 'resolves' | 'gated';
  /** One-line rationale, surfaced in the test name. */
  note: string;
  draft: () => Promise<TaskResult>;
  /** Only present for 'resolves' rows. */
  execute?: (proposal: Proposal) => Promise<ExecutionResult>;
}

function execContext(): ExecutionContext {
  return { tenantId: TENANT_ID, executedBy: USER_ID };
}

// ── Rows ─────────────────────────────────────────────────────────────────
//
// mode:'resolves' rows use resolver-style existingEntities to prove the
// draft completes ungated AND the real execution handler accepts the
// payload. mode:'gated' rows prove today's honest gating still holds — the
// payload legitimately needs a human before it can execute. Per
// c1-design.md: "everything not provably resolver-completable today starts
// 'gated'"; a row only moves to 'resolves' when both halves have been
// verified against the real handler source, not assumed from the design.

const ROWS: Row[] = [
  // ── LLM-drafting types, canned gateway JSON ──────────────────────────
  {
    intent: 'create_invoice',
    mode: 'resolves',
    note: 'resolved customerId + a priced line item drafts ungated; dep-less CreateInvoiceExecutionHandler synthetic-succeeds',
    draft: () =>
      draft(
        { gateway: mockGateway(JSON.stringify({
          lineItems: [{ description: 'Water heater install', quantity: 1, unitPrice: 85000, category: 'labor' }],
          confidence_score: 0.9,
        })) },
        'draft_invoice',
        ctx({ existingEntities: { customerId: CUSTOMER_ID } }),
      ),
    execute: (p) => new CreateInvoiceExecutionHandler().execute(p, execContext()),
  },
  {
    intent: 'draft_estimate',
    mode: 'resolves',
    note: 'resolved customerId + a priced line item drafts ungated; dep-less DraftEstimateExecutionHandler synthetic-succeeds',
    draft: () =>
      draft(
        { gateway: mockGateway(JSON.stringify({
          lineItems: [{ description: '50-gallon heater', quantity: 1, unitPrice: 85000, category: 'material' }],
          confidence_score: 0.9,
        })) },
        'draft_estimate',
        ctx({ existingEntities: { customerId: CUSTOMER_ID } }),
      ),
    execute: (p) => new DraftEstimateExecutionHandler().execute(p, execContext()),
  },
  {
    intent: 'create_appointment',
    mode: 'resolves',
    note: 'resolved timezone + a dateTimePhrase resolves the slot ungated; canned jobId skips the auto-open-a-job path entirely',
    draft: () =>
      draft(
        { gateway: mockGateway(JSON.stringify({
          dateTimePhrase: 'tomorrow at 2pm',
          jobId: JOB_ID,
          summary: 'Furnace tune-up',
          confidence_score: 0.9,
        })) },
        'create_appointment',
        ctx({ timezone: TIMEZONE, now: NOW, existingEntities: { customerId: CUSTOMER_ID } }),
      ),
    execute: (p) => new CreateAppointmentExecutionHandler().execute(p, execContext()),
  },
  {
    intent: 'update_invoice',
    mode: 'resolves',
    note: 'invoiceReference is a UUID the wired invoiceRepo confirms → verify-or-gate lifts the gate; UpdateInvoiceExecutionHandler applies the edit against a seeded draft invoice',
    draft: () => {
      const invoiceRepo = new InMemoryInvoiceRepository();
      return invoiceRepo.create(makeInvoice({ id: INVOICE_ID })).then(() =>
        draft(
          { gateway: mockGateway(JSON.stringify({
            invoiceReference: INVOICE_ID,
            editActions: [
              { type: 'add_line_item', lineItem: { description: 'Trip fee', quantity: 1, unitPrice: 5000, category: 'labor' } },
            ],
            confidence_score: 0.9,
          })), invoiceRepo },
          'update_invoice',
          ctx({}),
        ),
      );
    },
    execute: async (p) => {
      const invoiceRepo = new InMemoryInvoiceRepository();
      await invoiceRepo.create(makeInvoice({ id: INVOICE_ID }));
      return new UpdateInvoiceExecutionHandler(invoiceRepo).execute(p, execContext());
    },
  },
  {
    intent: 'update_estimate',
    mode: 'resolves',
    note: 'estimateReference is a UUID the wired estimateRepo confirms; UpdateEstimateExecutionHandler applies the edit against a seeded draft estimate (deposit-free job)',
    draft: () => {
      const estimateRepo = new InMemoryEstimateRepository();
      return estimateRepo.create(makeEstimate({ id: ESTIMATE_ID })).then(() =>
        draft(
          { gateway: mockGateway(JSON.stringify({
            estimateReference: ESTIMATE_ID,
            editActions: [
              { type: 'add_line_item', lineItem: { description: 'Disposal fee', quantity: 1, unitPrice: 7500, category: 'labor' } },
            ],
            confidence_score: 0.9,
          })), estimateRepo },
          'update_estimate',
          ctx({}),
        ),
      );
    },
    execute: async (p) => {
      const estimateRepo = new InMemoryEstimateRepository();
      await estimateRepo.create(makeEstimate({ id: ESTIMATE_ID }));
      return new UpdateEstimateExecutionHandler(estimateRepo, undefined, undefined, undefined, noDepositJobRepo()).execute(
        p,
        execContext(),
      );
    },
  },
  {
    intent: 'issue_invoice',
    mode: 'resolves',
    note: 'a UUID-shaped invoiceReference is rung-1 resolvable with no repo at all; dep-less IssueInvoiceExecutionHandler synthetic-succeeds',
    draft: () =>
      draft({ gateway: NOOP_GATEWAY }, 'issue_invoice', ctx({ existingEntities: { invoiceReference: INVOICE_ID } })),
    execute: (p) => new IssueInvoiceExecutionHandler().execute(p, execContext()),
  },
  {
    intent: 'batch_invoice',
    mode: 'resolves',
    note: 'wired invoicingDeps enumerate one completed-unbilled job → drafts ungated (missingFields is always []); dep-less BatchInvoiceExecutionHandler synthetic-succeeds',
    draft: () => {
      const invoicingDeps = {
        jobRepo: { findByTenant: async () => [{ id: JOB_ID, customerId: CUSTOMER_ID, moneyState: 'estimate_accepted' }] },
        invoiceRepo: { findByJobs: async () => [] },
        estimateRepo: {
          findByJobs: async () => [
            {
              jobId: JOB_ID,
              status: 'accepted',
              acceptedSelection: undefined,
              lineItems: [buildLineItem('1', 'Labor', 1, 10000, 1, true, 'labor')],
              totals: { discountCents: 0, taxRateBps: 0, totalCents: 10000 },
            },
          ],
        },
      } as unknown as InvoicingQueueDeps;
      return draft({ gateway: NOOP_GATEWAY, invoicingDeps }, 'batch_invoice', ctx({}));
    },
    execute: (p) => new BatchInvoiceExecutionHandler().execute(p, execContext()),
  },
  {
    intent: 'create_customer',
    mode: 'resolves',
    note: 'a spoken name alone drafts ungated (handler never sets missingFields); dep-less CreateCustomerVoiceExecutionHandler synthetic-succeeds',
    draft: () =>
      draft({ gateway: NOOP_GATEWAY }, 'create_customer', ctx({ existingEntities: { displayName: 'Jane Smith' } })),
    execute: (p) => new CreateCustomerVoiceExecutionHandler().execute(p, execContext()),
  },
  {
    intent: 'create_job',
    mode: 'resolves',
    note: 'resolved customerId + a title drafts ungated; dep-less CreateJobExecutionHandler synthetic-succeeds',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY },
        'create_job',
        ctx({ existingEntities: { customerId: CUSTOMER_ID, jobTitle: 'Kitchen remodel' } }),
      ),
    execute: (p) => new CreateJobExecutionHandler().execute(p, execContext()),
  },
  {
    intent: 'update_job',
    mode: 'resolves',
    note: 'a UUID jobId the wired jobRepo confirms lifts resolveJobIdGate; dep-less UpdateJobExecutionHandler refuses on wiring, not validation (handler_not_wired:jobRepo)',
    draft: () => {
      const jobRepo = new InMemoryJobRepository();
      return jobRepo.create(makeJob({ id: JOB_ID_FOR_EDIT })).then(() =>
        draft(
          { gateway: mockGateway(JSON.stringify({ jobId: JOB_ID_FOR_EDIT, status: 'in_progress', confidence_score: 0.9 })), jobRepo },
          'update_job',
          ctx({}),
        ),
      );
    },
    execute: (p) => new UpdateJobExecutionHandler().execute(p, execContext()),
  },
  {
    intent: 'reschedule_appointment',
    mode: 'resolves',
    note: 'a single active appointment resolves tenant-wide (no caller identity needed) and the phrase resolves against the tenant timezone; dep-less RescheduleAppointmentExecutionHandler synthetic-succeeds',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY, appointmentRepo: singleActiveAppointmentRepo() },
        'reschedule_appointment',
        ctx({ timezone: TIMEZONE, now: NOW, existingEntities: { newDateTimeDescription: 'tomorrow at 2pm' } }),
      ),
    execute: (p) => new RescheduleAppointmentExecutionHandler().execute(p, execContext()),
  },
  {
    intent: 'cancel_appointment',
    mode: 'resolves',
    note: 'a single active appointment resolves tenant-wide; dep-less CancelAppointmentExecutionHandler synthetic-succeeds',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY, appointmentRepo: singleActiveAppointmentRepo() },
        'cancel_appointment',
        ctx({}),
      ),
    execute: (p) => new CancelAppointmentExecutionHandler().execute(p, execContext()),
  },
  {
    intent: 'confirm_appointment',
    mode: 'resolves',
    note: 'a single active appointment resolves tenant-wide; dep-less ConfirmAppointmentExecutionHandler refuses on wiring, not validation (handler_not_wired:appointmentRepo)',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY, appointmentRepo: singleActiveAppointmentRepo() },
        'confirm_appointment',
        ctx({}),
      ),
    execute: (p) => new ConfirmAppointmentExecutionHandler(undefined, stubAuditRepo).execute(p, execContext()),
  },
  {
    intent: 'add_note',
    mode: 'resolves',
    note: 'RED — see B7.4 / run-log.md "C1 red→green transition". AddNoteTaskHandler sets payload.targetReference but never payload.targetId, so missingFields is empty while AddNoteExecutionHandler demands a targetId UUID.',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY },
        'add_note',
        ctx({
          existingEntities: {
            jobId: JOB_ID,
            jobReference: 'the Henderson job',
            noteTargetKind: 'job',
            noteBody: 'Called ahead, no answer.',
          },
        }),
      ),
    execute: (p) => new AddNoteExecutionHandler(undefined, stubAuditRepo).execute(p, execContext()),
  },
  {
    intent: 'log_time_entry',
    mode: 'resolves',
    note: 'resolved jobId lands on the payload (RV-051); dep-less LogTimeEntryExecutionHandler synthetic-succeeds',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY },
        'log_time_entry',
        ctx({ existingEntities: { jobReference: 'the Henderson job', jobId: JOB_ID } }),
      ),
    execute: (p) => new LogTimeEntryExecutionHandler().execute(p, execContext()),
  },
  {
    intent: 'emergency_dispatch',
    mode: 'resolves',
    note: 'fast-path handler never gates (proposal creation is the only step); dep-less EmergencyDispatchExecutionHandler synthetic-succeeds',
    draft: () => draft({ gateway: NOOP_GATEWAY }, 'emergency_dispatch', ctx({ message: 'gas smell at the Henderson house' })),
    execute: (p) => new EmergencyDispatchExecutionHandler().execute(p, execContext()),
  },
  {
    intent: 'update_customer',
    mode: 'resolves',
    note: 'identified caller (context.customerId) + one changed field drafts ungated; dep-less UpdateCustomerExecutionHandler refuses on wiring, not validation (handler_not_wired:customerRepo)',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY },
        'update_customer',
        ctx({ customerId: CUSTOMER_ID, existingEntities: { updatedPhone: '+15555550143' } }),
      ),
    execute: (p) => new UpdateCustomerExecutionHandler(undefined, stubAuditRepo).execute(p, execContext()),
  },
  {
    intent: 'log_expense',
    mode: 'resolves',
    note: 'a stated amount is the only gate this handler has; dep-less LogExpenseExecutionHandler synthetic-succeeds',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY },
        'log_expense',
        ctx({ existingEntities: { amount: 24000, expenseCategory: 'materials', vendor: 'Supply House' } }),
      ),
    execute: (p) => new LogExpenseExecutionHandler().execute(p, execContext()),
  },
  {
    intent: 'create_invoice_schedule',
    mode: 'resolves',
    note: 'resolved jobId + a parseable milestone sentence drafts ungated (deterministic parser, no LLM); dep-less CreateInvoiceScheduleExecutionHandler synthetic-succeeds',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY },
        'create_invoice_schedule',
        ctx({
          existingEntities: {
            jobId: JOB_ID,
            scheduleDescription: 'Set up 50% deposit, 50% on completion for the Hendersons',
          },
        }),
      ),
    execute: (p) => new CreateInvoiceScheduleExecutionHandler().execute(p, execContext()),
  },
  {
    intent: 'create_standing_instruction',
    mode: 'resolves',
    note: 'excluded from the shared registry by design (constructed the way voice-action-router.ts ~line 484 does); the handler always has SOME instruction text (falls back to the verbatim transcript on any gateway/parse failure) so missingFields is always []; dep-less CreateStandingInstructionExecutionHandler synthetic-succeeds',
    draft: () =>
      new CreateStandingInstructionTaskHandler(
        mockGateway(JSON.stringify({ instruction: 'Always add a $79 diagnostic fee to AC calls' })),
      ).handle(ctx({ message: 'from now on always add a $79 diagnostic fee to AC calls' })),
    execute: (p) => new CreateStandingInstructionExecutionHandler().execute(p, execContext()),
  },

  // ── mode:'gated' — today's honest gating, pinned so a future "fix" can't
  // silently weaken it without this test noticing ──────────────────────
  // ── B5.3 AC-6 — flipped from 'gated' to 'resolves': the defect this row
  // used to pin (appointmentId gated UNCONDITIONALLY, ignoring the id the
  // router's entity resolver already verified onto
  // existingEntities.appointmentId) is fixed in ReassignAppointmentTaskHandler.
  // With BOTH the appointment and the technician resolver-verified, the
  // draft is ungated and the payload executes.
  {
    intent: 'reassign_appointment',
    mode: 'resolves',
    note: 'resolver-verified appointmentId + technicianId (U1) draft ungated; dep-less ReassignAppointmentExecutionHandler synthetic-succeeds',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY },
        'reassign_appointment',
        ctx({
          existingEntities: {
            appointmentReference: 'the Garcia appointment',
            appointmentId: APPOINTMENT_ID,
            targetTechnicianName: 'Carlos',
            technicianId: TECHNICIAN_ID,
          },
        }),
      ),
    execute: (p) => new ReassignAppointmentExecutionHandler().execute(p, execContext()),
  },
  {
    intent: 'add_crew_member',
    mode: 'gated',
    note: 'appointmentId is unconditionally gated even with a resolved technicianId',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY },
        'add_crew_member',
        ctx({ existingEntities: { appointmentReference: 'the Garcia appointment', targetTechnicianName: 'Carlos' } }),
      ),
  },
  {
    intent: 'remove_crew_member',
    mode: 'gated',
    note: 'appointmentId is unconditionally gated even with a resolved technicianId',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY },
        'remove_crew_member',
        ctx({ existingEntities: { appointmentReference: "Tuesday's job", targetTechnicianName: 'Carlos' } }),
      ),
  },
  {
    intent: 'send_invoice',
    mode: 'gated',
    note: 'invoiceId is gated whenever the reference is not already a UUID',
    draft: () => draft({ gateway: NOOP_GATEWAY }, 'send_invoice', ctx({ existingEntities: { customerName: 'Henderson' } })),
  },
  {
    intent: 'send_estimate',
    mode: 'gated',
    note: 'estimateId is gated whenever the reference is not already a UUID',
    draft: () => draft({ gateway: NOOP_GATEWAY }, 'send_estimate', ctx({ existingEntities: { customerName: 'Khan' } })),
  },
  {
    intent: 'send_estimate_nudge',
    mode: 'gated',
    note: 'estimateId is unconditionally gated — never resolved by the entity resolver',
    draft: () =>
      draft({ gateway: NOOP_GATEWAY }, 'send_estimate_nudge', ctx({ existingEntities: { customerName: 'Khan' } })),
  },
  {
    intent: 'send_payment_reminder',
    mode: 'gated',
    note: 'invoiceId is unconditionally gated — never resolved by the entity resolver',
    draft: () =>
      draft({ gateway: NOOP_GATEWAY }, 'send_payment_reminder', ctx({ existingEntities: { customerName: 'Henderson' } })),
  },
  {
    intent: 'apply_late_fee',
    mode: 'gated',
    note: 'invoiceId is unconditionally gated — never resolved by the entity resolver',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY },
        'apply_late_fee',
        ctx({ existingEntities: { customerName: 'Henderson', amount: 2500 } }),
      ),
  },
  {
    intent: 'record_payment',
    mode: 'gated',
    note: "DEVIATION from the design's suggested 'resolves': RecordPaymentTaskHandler never reads existingEntities.invoiceId (the real resolver seam) at all — only ee.jobReference/ee.customerName, which are classifier free text, not resolver output. So even a resolver-verified invoiceId in existingEntities leaves invoiceId gated; it is not provably resolver-completable today.",
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY },
        'record_payment',
        ctx({ existingEntities: { invoiceId: INVOICE_ID, amount: 15000, paymentMethod: 'cash' } }),
      ),
  },
  {
    intent: 'convert_lead',
    mode: 'gated',
    note: 'leadId is unconditionally gated — never resolved by the entity resolver',
    draft: () =>
      draft({ gateway: NOOP_GATEWAY }, 'convert_lead', ctx({ existingEntities: { leadReference: 'the Johnson lead' } })),
  },
  {
    intent: 'mark_lead_lost',
    mode: 'gated',
    note: 'leadId is unconditionally gated — never resolved by the entity resolver',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY },
        'mark_lead_lost',
        ctx({ existingEntities: { leadReference: 'the Davis lead', lostReason: 'price' } }),
      ),
  },
  {
    intent: 'add_service_location',
    mode: 'gated',
    note: 'the structured address fields are unconditionally gated — the classifier only ever has freeform text',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY },
        'add_service_location',
        ctx({ customerId: CUSTOMER_ID, existingEntities: { serviceAddress: '412 Oak St' } }),
      ),
  },
  {
    intent: 'notify_delay',
    mode: 'gated',
    note: 'appointmentId is gated whenever no appointmentRepo is wired to resolve the caller\'s active appointment',
    draft: () =>
      draft(
        { gateway: NOOP_GATEWAY },
        'notify_delay',
        ctx({ existingEntities: { appointmentReference: 'the 10am', delayMinutes: 30 } }),
      ),
  },
  {
    intent: 'request_feedback',
    mode: 'gated',
    note: 'jobId is gated with no reference given (the handler carries jobReference/customerReference but never sets payload.jobId itself)',
    draft: () => draft({ gateway: NOOP_GATEWAY }, 'request_feedback', ctx({ existingEntities: {} })),
  },
  {
    intent: 'respond_to_review',
    mode: 'gated',
    note: 'no reviewRepo wired → degrades to a voice_clarification, constructed the way voice-action-router.ts (~line 478) builds this surface-specific handler',
    draft: () =>
      new RespondToReviewTaskHandler(new InMemoryProposalRepository()).handle(
        ctx({ existingEntities: { reviewReference: 'the 1-star review' } }),
      ),
  },
];

// ── The test ─────────────────────────────────────────────────────────────

describe('C1 — voice payload-contract drift (per mapped intent)', () => {
  it('every mapped intent has exactly one row, and every row names a mapped intent', () => {
    const mappedIntents = Object.keys(INTENT_TO_PROPOSAL_TYPE).sort();
    const rowIntents = ROWS.map((r) => r.intent).sort();

    for (const intent of mappedIntents) {
      expect(rowIntents, `intent '${intent}' is in INTENT_TO_PROPOSAL_TYPE but has no row here`).toContain(intent);
    }
    for (const intent of rowIntents) {
      expect(
        mappedIntents,
        `row '${intent}' does not name an intent in INTENT_TO_PROPOSAL_TYPE — never invent an intent here`,
      ).toContain(intent);
    }
    // Duplicate-row guard — a second row for the same intent would silently
    // shadow the first in a naive lookup and defeat the completeness check.
    expect(new Set(rowIntents).size).toBe(rowIntents.length);
  });

  for (const row of ROWS) {
    const proposalType = INTENT_TO_PROPOSAL_TYPE[row.intent as keyof typeof INTENT_TO_PROPOSAL_TYPE];

    it(`${row.intent} (${proposalType}, ${row.mode}) — ${row.note}`, async () => {
      const { proposal } = await row.draft();
      const missing = missingFieldsFor(proposal);

      if (row.mode === 'gated') {
        // Honest gating today: either the drafted proposal still carries
        // non-empty missingFields (approveProposal blocks on this
        // separately), or the task handler declined to draft at all and
        // degraded to a schema-valid voice_clarification.
        if (proposal.proposalType === 'voice_clarification') {
          expect(() => voiceClarificationPayloadSchema.parse(proposal.payload)).not.toThrow();
        } else {
          expect(missing.length, `expected ${row.intent} to stay gated but missingFields was empty`).toBeGreaterThan(0);
        }
        return;
      }

      // mode === 'resolves'
      expect(missing, `expected ${row.intent} to draft ungated but missingFields was ${JSON.stringify(missing)}`).toEqual([]);
      expect(proposal.proposalType).toBe(proposalType);

      const execute = row.execute;
      if (!execute) throw new Error(`row '${row.intent}' is mode:'resolves' but declares no execute()`);
      const result = await execute(proposal);

      const isWiringRefusal = !result.success && typeof result.error === 'string' && result.error.startsWith('handler_not_wired:');
      expect(
        result.success || isWiringRefusal,
        `C1 DRIFT for '${row.intent}': missingFields was empty but the real execution handler rejected the payload — ${result.error}`,
      ).toBe(true);
    });
  }
});
