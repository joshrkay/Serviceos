import { ProposalType } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { TaskHandler } from '../tasks/task-handlers';
import { CreateCustomerVoiceTaskHandler } from '../tasks/create-customer-task';
import { InvoiceTaskHandler } from '../tasks/invoice-task';
import { EstimateTaskHandler } from '../tasks/estimate-task';
import { CreateAppointmentAITaskHandler } from '../tasks/create-appointment-task';
import { SlotConflictChecker } from '../tasks/slot-conflict-checker';
import { AvailabilityFinder } from '../tasks/availability-finder';
import { AppointmentRepository } from '../../appointments/appointment';
import { JobRepository } from '../../jobs/job';
import { CatalogItemRepository } from '../../catalog/catalog-item';
import { InvoiceEditTaskHandler } from '../tasks/invoice-edit-task';
import { EstimateEditTaskHandler } from '../tasks/estimate-edit-task';
import { UpdateJobTaskHandler } from '../tasks/job-edit-task';
import { IssueInvoiceTaskHandler } from './task-router';
import type { EstimateRepository } from '../../estimates/estimate';
import type { InvoiceRepository } from '../../invoices/invoice';
import type { ProposalRepository } from '../../proposals/proposal';
import { InvoicingQueueDeps } from '../../invoices/invoicing-queue';
import { DunningEventRepository } from '../../invoices/dunning-config';
import type { CustomerRepository } from '../../customers/customer';
import { isCustomerDuplicateLoader } from '../../customers/dedup';
import {
  RescheduleAppointmentTaskHandler,
  CancelAppointmentTaskHandler,
  ReassignAppointmentTaskHandler,
  AddCrewMemberTaskHandler,
  RemoveCrewMemberTaskHandler,
  AddNoteTaskHandler,
  SendInvoiceTaskHandler,
  SendEstimateTaskHandler,
  SendEstimateNudgeTaskHandler,
  SendPaymentReminderTaskHandler,
  ApplyLateFeeTaskHandler,
  RecordPaymentTaskHandler,
  CreateJobVoiceTaskHandler,
  EmergencyDispatchTaskHandler,
  UpdateCustomerTaskHandler,
  LogExpenseTaskHandler,
  ConvertLeadTaskHandler,
  ConfirmAppointmentTaskHandler,
  MarkLeadLostTaskHandler,
  AddServiceLocationTaskHandler,
  LogTimeEntryTaskHandler,
  NotifyDelayTaskHandler,
  RequestFeedbackTaskHandler,
  BatchInvoiceTaskHandler,
  CreateInvoiceScheduleTaskHandler,
} from '../tasks/voice-extended-tasks';

/**
 * B5 (feat: voice-transcript-and-agent-paths) — the deps shared by the
 * "core" task-handler taxonomy that BOTH `workers/voice-action-router.ts`
 * (`buildHandlers`) and `routes/assistant.ts` need to draft the same
 * intent the same way. This module exists because the two surfaces had
 * already diverged: the assistant chat route silently dropped 12 of these
 * intents to a bare conversational LLM reply (no proposal at all) while
 * the voice worker drafted them — see B5 in
 * docs/plans/2026-07-17-001-feat-voice-transcript-and-agent-paths-plan.md.
 *
 * B4 — `issue_invoice` now lives HERE too (it used to be excluded as a
 * "known, tracked divergence": the worker had a repo-backed handler with
 * conversation-context resolution but no missingFields gate, the assistant
 * route had a dep-free gated one with no resolution). `ai/orchestration/
 * task-router.ts`'s `IssueInvoiceTaskHandler` is now the single
 * implementation for both — gated AND context-aware — registered here with
 * `proposalRepo`/`invoiceRepo`/`thresholdResolver` from `HandlerRegistryDeps`
 * so neither surface can re-diverge on it.
 *
 * Deliberately still EXCLUDES handlers that stay surface-specific by design
 * and are out of this taxonomy:
 *   - `review_response_proposal` / `create_standing_instruction` / the
 *     synthetic `_complaint` / `_negotiation` keys — voice-only intents
 *     outside B5's nine-path scope, needing deps (reviewRepo,
 *     customerNegotiationContextProvider, …) the assistant surface
 *     doesn't carry and wasn't asked to grow.
 *
 * Every field is optional except `gateway` — mirrors how every handler
 * constructed here already tolerates an absent dep by gating instead of
 * crashing (each handler's own `missing.push(...)` fallback).
 */
export interface HandlerRegistryDeps {
  gateway: LLMGateway;
  /** P22 catalog grounding for drafted/edited invoice & estimate line items. */
  catalogRepo?: CatalogItemRepository;
  /** create_appointment pre-draft slot-conflict check + alternative slots. */
  slotConflictChecker?: SlotConflictChecker;
  availabilityFinder?: AvailabilityFinder;
  /** Scheduling family (reschedule/cancel/confirm/notify_delay) + create_appointment. */
  appointmentRepo?: AppointmentRepository;
  /**
   * Scopes appointment resolution to the verified caller's own appointments
   * (appointment → job → customerId) and feeds send_payment_reminder's
   * dedup marker. B7 — also powers update_job's jobId reference
   * resolution/gate (UpdateJobTaskHandler.resolveJobIdGate).
   */
  jobRepo?: JobRepository;
  /**
   * update_invoice / send_invoice reference resolution + send_payment_reminder's
   * draft-time duplicate-reminder marker.
   */
  invoiceRepo?: InvoiceRepository;
  /** update_estimate acceptance-void marker. */
  estimateRepo?: Pick<EstimateRepository, 'findById' | 'findByTenant'>;
  /** send_payment_reminder's Layer-3 advisory duplicate-reminder marker. */
  dunningEventRepo?: DunningEventRepository;
  /**
   * batch_invoice's completed-unbilled enumeration (`findJobsRequiringInvoicing`)
   * needs the FULL (non-`Pick`) repo trio. Kept separate from the narrower
   * `estimateRepo`/`invoiceRepo` above — the same separation
   * `VoiceActionRouterDeps` already has (`invoicingDeps` vs `estimateRepo`).
   * Absent → batch_invoice degrades to its own built-in "not available"
   * clarification (never throws).
   */
  invoicingDeps?: InvoicingQueueDeps;
  /**
   * B4 — issue_invoice's conversation-context resolution ("the one we just
   * drafted"): the most recent same-conversation `draft_invoice` proposal
   * with a `resultEntityId`. Optional; absent → that rung of the resolution
   * ladder never fires and the proposal falls through to the missingFields
   * gate (see IssueInvoiceTaskHandler in ./task-router.ts).
   */
  proposalRepo?: ProposalRepository;
  /**
   * B4 — per-tenant auto-approve threshold override for issue_invoice,
   * mirroring the worker's `thresholdResolver`. Optional; absent falls
   * through to DEFAULT_AUTO_APPROVE_THRESHOLDS.
   */
  thresholdResolver?: (
    tenantId: string,
  ) => Promise<Partial<Record<'supervisor' | 'tech' | 'both', number>> | undefined>;
  /**
   * B8 (feat: voice-transcript-and-agent-paths) — create_customer draft-time
   * duplicate detection parity. Previously only the telephony FSM
   * (`twilio-adapter.ts`) constructed `CreateCustomerVoiceTaskHandler` with a
   * `duplicateLoader`; the voice worker and assistant chat used the thin
   * passthrough `CreateCustomerTaskHandler`, so a near-duplicate customer
   * created from a voice memo or the assistant chat surfaced no warning
   * until execution (`customers/customer.ts`'s non-blocking `createCustomer`
   * check). Wiring `customerRepo` here — the SAME repo every other surface
   * already has — lets this registry build the SAME dedup-aware handler the
   * FSM uses (`isCustomerDuplicateLoader` narrows it to a
   * `CustomerDuplicateLoader` exactly like `twilio-adapter.ts` does), so all
   * three surfaces share one construction site. Optional; absent → the
   * handler drafts with no dedup check (byte-identical to the pre-B8 thin
   * handler's always-clean draft).
   */
  customerRepo?: CustomerRepository;
}

/**
 * Build the shared task-handler registry for the "core" intent taxonomy —
 * every `ProposalType` both surfaces route to a real drafting handler (as
 * opposed to a surface-specific synthetic key, see the doc comment above).
 * Called once at composition time by both `createVoiceActionRouterWorker`
 * and `createAssistantRouter` so the two surfaces can't drift on how a
 * shared intent drafts again.
 */
export function buildTaskHandlers(deps: HandlerRegistryDeps): Map<ProposalType, TaskHandler> {
  const handlers = new Map<ProposalType, TaskHandler>();
  handlers.set('draft_invoice', new InvoiceTaskHandler(deps.gateway, deps.catalogRepo));
  handlers.set('draft_estimate', new EstimateTaskHandler(deps.gateway, deps.catalogRepo));
  handlers.set(
    'create_appointment',
    new CreateAppointmentAITaskHandler(
      deps.gateway,
      deps.slotConflictChecker,
      deps.availabilityFinder,
      deps.appointmentRepo,
      deps.jobRepo,
    ),
  );
  handlers.set(
    'update_invoice',
    new InvoiceEditTaskHandler(deps.gateway, {
      catalogRepo: deps.catalogRepo,
      invoiceRepo: deps.invoiceRepo,
    }),
  );
  handlers.set('update_estimate', new EstimateEditTaskHandler(deps.gateway, deps.estimateRepo, deps.catalogRepo));
  // B8 — dedup-aware handler for BOTH the voice worker and assistant chat,
  // matching the telephony FSM's construction in twilio-adapter.ts. Only the
  // `duplicateLoader` differs by availability of `deps.customerRepo`;
  // `requirePhone: false` because neither surface has a caller-ID phone —
  // see CreateCustomerTaskDeps.requirePhone in ai/tasks/create-customer-task.ts.
  handlers.set(
    'create_customer',
    new CreateCustomerVoiceTaskHandler({
      duplicateLoader:
        deps.customerRepo && isCustomerDuplicateLoader(deps.customerRepo)
          ? deps.customerRepo
          : undefined,
      requirePhone: false,
    }),
  );
  handlers.set('create_job', new CreateJobVoiceTaskHandler());
  // B7 — update_job: bounded, safe field edit (status/priority/title/
  // description) to an EXISTING job. jobRepo powers the jobId gate
  // (resolveJobIdGate); absent → every reference stays gated.
  handlers.set('update_job', new UpdateJobTaskHandler(deps.gateway, deps.jobRepo));
  handlers.set(
    'reschedule_appointment',
    new RescheduleAppointmentTaskHandler(deps.gateway, deps.appointmentRepo, deps.jobRepo),
  );
  handlers.set(
    'cancel_appointment',
    new CancelAppointmentTaskHandler(deps.appointmentRepo, deps.jobRepo),
  );
  handlers.set('reassign_appointment', new ReassignAppointmentTaskHandler());
  handlers.set('add_crew_member', new AddCrewMemberTaskHandler());
  handlers.set('remove_crew_member', new RemoveCrewMemberTaskHandler());
  handlers.set('add_note', new AddNoteTaskHandler());
  handlers.set('send_invoice', new SendInvoiceTaskHandler({ invoiceRepo: deps.invoiceRepo }));
  // Wire estimateRepo so gated free-text refs get AmbiguityPicker candidates
  // (same B2 pattern as send_invoice). The gate itself never lifts.
  handlers.set('send_estimate', new SendEstimateTaskHandler({ estimateRepo: deps.estimateRepo }));
  handlers.set('send_estimate_nudge', new SendEstimateNudgeTaskHandler());
  handlers.set(
    'send_payment_reminder',
    new SendPaymentReminderTaskHandler({
      dunningEventRepo: deps.dunningEventRepo,
      invoiceRepo: deps.invoiceRepo,
      jobRepo: deps.jobRepo,
    }),
  );
  handlers.set('apply_late_fee', new ApplyLateFeeTaskHandler());
  handlers.set('record_payment', new RecordPaymentTaskHandler());
  handlers.set('emergency_dispatch', new EmergencyDispatchTaskHandler());
  handlers.set('update_customer', new UpdateCustomerTaskHandler());
  handlers.set('log_expense', new LogExpenseTaskHandler());
  handlers.set('convert_lead', new ConvertLeadTaskHandler());
  handlers.set('confirm_appointment', new ConfirmAppointmentTaskHandler(deps.appointmentRepo, deps.jobRepo));
  handlers.set('mark_lead_lost', new MarkLeadLostTaskHandler());
  handlers.set('add_service_location', new AddServiceLocationTaskHandler());
  handlers.set('log_time_entry', new LogTimeEntryTaskHandler());
  handlers.set('notify_delay', new NotifyDelayTaskHandler(deps.appointmentRepo, deps.jobRepo));
  handlers.set('request_feedback', new RequestFeedbackTaskHandler());
  handlers.set('batch_invoice', new BatchInvoiceTaskHandler(deps.invoicingDeps));
  // U2 — milestone billing plan from a spoken sentence (deterministic
  // parser; no LLM drafting call).
  handlers.set('create_invoice_schedule', new CreateInvoiceScheduleTaskHandler());
  // B4 — unified issue_invoice: gated missingFields ladder (rung 3) PLUS
  // conversation-context resolution (rung 2, needs proposalRepo). See the
  // class doc comment in ./task-router.ts for the full resolution ladder.
  handlers.set(
    'issue_invoice',
    new IssueInvoiceTaskHandler({
      proposalRepo: deps.proposalRepo,
      invoiceRepo: deps.invoiceRepo,
      thresholdResolver: deps.thresholdResolver,
    }),
  );
  return handlers;
}
