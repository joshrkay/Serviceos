import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult, normalizeDraftLineItems } from './handlers';
import {
  createInvoiceWithNextNumber,
  InvoiceRepository,
  CreateInvoiceInput,
} from '../../invoices/invoice';
import { SettingsRepository } from '../../settings/settings';
import { AuditRepository } from '../../audit/audit';
import { JobRepository, createJob } from '../../jobs/job';
import { LocationRepository } from '../../locations/location';
import { CustomerRepository } from '../../customers/customer';

/**
 * P5-005 — Deterministic execution for draft_invoice proposals.
 *
 * When the real invoiceRepo + settingsRepo are wired in (production), this
 * handler creates an invoice row with an auto-incremented invoice number,
 * ties it back to the job + optional estimate, and returns the created id.
 *
 * When the deps are absent (legacy in-memory tests that exercise the
 * validation shape without touching persistence), it falls back to the
 * synthetic-id behavior so existing tests still pass.
 */
export class CreateInvoiceExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'draft_invoice';

  constructor(
    private readonly invoiceRepo?: InvoiceRepository,
    private readonly settingsRepo?: SettingsRepository,
    // Without this the executed invoice persists but emits no
    // invoice.created audit event (the "every mutation emits audit"
    // invariant). The domain function already forwards it.
    private readonly auditRepo?: AuditRepository,
    // B6 — voice/assistant-drafted payloads carry a customerId but often no
    // jobId (jobId is optional in draftInvoicePayloadSchema), mirroring the
    // same gap DraftEstimateExecutionHandler closed for draft_estimate. When
    // both repos are wired the handler opens a job for the customer (same
    // primary/fallback-location resolution) instead of refusing the
    // canonical drafted payload. New optional params appended after
    // auditRepo so existing positional call sites remain valid.
    private readonly jobRepo?: JobRepository,
    private readonly locationRepo?: LocationRepository,
    // QA-2026-07-28 — tenant-scoped EXISTENCE check for the drafted
    // customerId. See the guard in execute(); optional so the existing
    // partially-wired unit fixtures keep their current behavior.
    private readonly customerRepo?: CustomerRepository,
  ) {}

  // Degrades to a synthetic-id passthrough (saves nothing) without both
  // the invoice repo and the settings repo — see execute().
  isFullyWired(): boolean {
    return Boolean(this.invoiceRepo) && Boolean(this.settingsRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    // QA-2026-07-26 (VOX-07) — accept customerId OR jobId, exactly like
    // DraftEstimateExecutionHandler (handlers.ts). This handler previously
    // demanded customerId UNCONDITIONALLY, even when the payload already
    // carried a resolved jobId — despite the invoice domain needing only the
    // job (customerId is used solely to auto-open a job when there isn't one,
    // ~20 lines below). A voice/assistant payload that resolved the JOB but
    // not the customer was rejected with "Payload must include a valid
    // customerId" while holding everything the create actually needs.
    const customerId =
      typeof payload.customerId === 'string' && payload.customerId.length > 0
        ? payload.customerId
        : undefined;
    // B6 — jobId is optional on the contract; a job is auto-opened below
    // (mirroring DraftEstimateExecutionHandler) when it's absent.
    let jobId =
      typeof payload.jobId === 'string' && payload.jobId.length > 0 ? payload.jobId : undefined;
    if (!customerId && !jobId) {
      return {
        success: false,
        error:
          'Invoice draft has neither a customerId nor a jobId — link a customer before approving',
      };
    }
    if (!Array.isArray(payload.lineItems) || payload.lineItems.length === 0) {
      return { success: false, error: 'Payload must include at least one lineItem' };
    }

    // Same hardening as the draft_estimate handler: never blind-cast LLM/
    // client-shaped line items into money math. A line missing an integer
    // totalCents would flow NaN into calculateDocumentTotals and Postgres
    // ("invalid input syntax for type integer: NaN").
    const { lineItems, malformed } = normalizeDraftLineItems(payload.lineItems);
    if (malformed.length > 0) {
      return {
        success: false,
        error: `Invoice draft has line items that can't be priced: ${malformed.join('; ')}`,
      };
    }

    // Idempotency — a second execution of the same proposal returns the id
    // that was produced on the first run. Works for both the persisting and
    // the synthetic-id paths.
    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    if (!this.invoiceRepo || !this.settingsRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    // QA-2026-07-28 — EXISTENCE checks, not format checks. A drafted id can be
    // perfectly well-formed and still reference nothing: INVOICE_SYSTEM_PROMPT
    // used to hand the model `"customerId": "<uuid>"` / `"jobId": "<uuid>"`
    // templates and close with "Ensure customerId and jobId are present", so it
    // invented ids — including the RFC 4122 EXAMPLE uuid
    // 123e4567-e89b-12d3-a456-426614174000, which sails through
    // `z.string().uuid()`. Unchecked, `customerId` auto-opens a JOB from a
    // customer that doesn't exist and `jobId` is written straight onto the
    // invoice as its job container (bypassing the auto-open path entirely) —
    // either violating a foreign key deep inside createJob/createInvoice or
    // attaching real money to nothing. So confirm each id names a real record
    // IN THIS TENANT before any write, and fail with a reason the operator can
    // act on. Skipped when a repo isn't wired, matching this handler's existing
    // degradation.
    if (customerId && this.customerRepo) {
      const customer = await this.customerRepo.findById(context.tenantId, customerId);
      if (!customer) {
        return {
          success: false,
          error:
            `Invoice draft references customer '${customerId}', which does not exist in this ` +
            `tenant — link a real customer before approving`,
        };
      }
    }
    if (jobId && this.jobRepo) {
      const job = await this.jobRepo.findById(context.tenantId, jobId);
      if (!job) {
        return {
          success: false,
          error:
            `Invoice draft references job '${jobId}', which does not exist in this tenant — ` +
            `link a real job before approving`,
        };
      }
    }

    try {
      // Invoices require a job container. A drafted payload without one
      // (customer resolved, job reference not) gets a job opened for the
      // customer — same primary/fallback-location resolution as
      // DraftEstimateExecutionHandler.
      if (!jobId) {
        if (!this.jobRepo || !this.locationRepo) {
          return {
            success: false,
            error:
              'Invoice draft has no jobId and job auto-creation is not configured — pick a job before approving',
          };
        }
        // Non-null assertion is safe: the guard at the top of execute()
        // already rejected the "neither customerId nor jobId" case, and this
        // branch only runs when jobId is absent. Same shape as
        // DraftEstimateExecutionHandler.
        const locations = await this.locationRepo.findByCustomer(context.tenantId, customerId!);
        const location =
          locations.find((loc) => loc.isPrimary && !loc.isArchived) ??
          locations.find((loc) => !loc.isArchived);
        if (!location) {
          return {
            success: false,
            error: 'Customer has no service location — add one before approving this invoice',
          };
        }
        const job = await createJob(
          {
            tenantId: context.tenantId,
            customerId: customerId!,
            locationId: location.id,
            summary:
              typeof payload.internalNotes === 'string' &&
              payload.internalNotes.trim().length > 0
                ? payload.internalNotes.trim()
                : proposal.summary || lineItems[0].description,
            createdBy: context.executedBy,
          },
          this.jobRepo,
          this.auditRepo,
        );
        jobId = job.id;
      }

      const input: Omit<CreateInvoiceInput, 'invoiceNumber'> = {
        tenantId: context.tenantId,
        jobId,
        estimateId: typeof payload.estimateId === 'string' ? payload.estimateId : undefined,
        lineItems,
        discountCents:
          typeof payload.discountCents === 'number' ? payload.discountCents : undefined,
        taxRateBps:
          typeof payload.taxRateBps === 'number' ? payload.taxRateBps : undefined,
        customerMessage:
          typeof payload.customerMessage === 'string' ? payload.customerMessage : undefined,
        createdBy: context.executedBy,
      };

      const invoice = await createInvoiceWithNextNumber(
        input,
        this.invoiceRepo,
        this.settingsRepo,
        this.auditRepo
      );
      return { success: true, resultEntityId: invoice.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
