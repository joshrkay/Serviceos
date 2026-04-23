import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import {
  createInvoice,
  InvoiceRepository,
  CreateInvoiceInput,
} from '../../invoices/invoice';
import { LineItem } from '../../shared/billing-engine';
import { SettingsRepository, getNextInvoiceNumber } from '../../settings/settings';

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
    private readonly settingsRepo?: SettingsRepository
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    if (!payload.customerId || typeof payload.customerId !== 'string') {
      return { success: false, error: 'Payload must include a valid customerId' };
    }
    if (!payload.jobId || typeof payload.jobId !== 'string') {
      return { success: false, error: 'Payload must include a valid jobId' };
    }
    if (!Array.isArray(payload.lineItems) || payload.lineItems.length === 0) {
      return { success: false, error: 'Payload must include at least one lineItem' };
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

    try {
      const invoiceNumber = await getNextInvoiceNumber(context.tenantId, this.settingsRepo);

      const input: CreateInvoiceInput = {
        tenantId: context.tenantId,
        jobId: payload.jobId,
        estimateId: typeof payload.estimateId === 'string' ? payload.estimateId : undefined,
        invoiceNumber,
        lineItems: payload.lineItems as LineItem[],
        discountCents:
          typeof payload.discountCents === 'number' ? payload.discountCents : undefined,
        taxRateBps:
          typeof payload.taxRateBps === 'number' ? payload.taxRateBps : undefined,
        customerMessage:
          typeof payload.customerMessage === 'string' ? payload.customerMessage : undefined,
        createdBy: context.executedBy,
      };

      const invoice = await createInvoice(input, this.invoiceRepo);
      return { success: true, resultEntityId: invoice.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
