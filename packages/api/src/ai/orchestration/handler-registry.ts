import { ProposalType } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { TaskHandler, CreateCustomerTaskHandler } from '../tasks/task-handlers';
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
import type { EstimateRepository } from '../../estimates/estimate';
import type { InvoiceRepository } from '../../invoices/invoice';
import { InvoicingQueueDeps } from '../../invoices/invoicing-queue';
import { DunningEventRepository } from '../../invoices/dunning-config';
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
 * Deliberately EXCLUDES handlers that stay surface-specific by design and
 * are out of this taxonomy:
 *   - `issue_invoice` — the worker's local `IssueInvoiceTaskHandler` and
 *     the assistant's `ai/orchestration/task-router.ts` one are a KNOWN,
 *     tracked divergence (unification is B4's job, not this module's).
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
  handlers.set('create_customer', new CreateCustomerTaskHandler());
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
  handlers.set('send_estimate', new SendEstimateTaskHandler());
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
  return handlers;
}
