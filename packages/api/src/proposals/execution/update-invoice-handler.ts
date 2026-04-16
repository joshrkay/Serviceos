import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { InvoiceRepository } from '../../invoices/invoice';
import {
  applyInvoiceEdits,
  InvoiceEditAction,
} from '../../invoices/invoice-editor';
import { ValidationError } from '../../shared/errors';

/**
 * Executes `update_invoice` proposals by applying the edit actions in
 * the payload to the target invoice. The pure edit logic lives in
 * invoice-editor.ts — this handler is the persistence boundary: fetch,
 * delegate, write-back, return a result.
 *
 * Failure modes return ExecutionResult.success=false (payload-level
 * errors, missing invoice, wrong tenant, non-draft status, validation
 * errors from the editor). Transient repo errors throw so the executor
 * can retry — matches the convention in the other handlers.
 */
export class UpdateInvoiceExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'update_invoice';

  constructor(private readonly invoiceRepo: InvoiceRepository) {}

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    if (!payload || typeof payload !== 'object') {
      return { success: false, error: 'Payload is required' };
    }

    const invoiceId = (payload as Record<string, unknown>).invoiceId;
    if (!invoiceId || typeof invoiceId !== 'string') {
      return { success: false, error: 'Payload must include a valid invoiceId' };
    }

    const editActions = (payload as Record<string, unknown>).editActions;
    if (!Array.isArray(editActions) || editActions.length === 0) {
      return { success: false, error: 'Payload must include at least one editAction' };
    }

    const invoice = await this.invoiceRepo.findById(proposal.tenantId, invoiceId);
    if (!invoice) {
      // Ambiguous on purpose — don't leak whether the invoice exists
      // in another tenant. RLS + tenant-scoped findById already enforce
      // isolation; this is the caller-facing equivalent.
      return { success: false, error: `Invoice ${invoiceId} not found in this tenant` };
    }

    try {
      const { updatedInvoice } = applyInvoiceEdits(
        invoice,
        editActions as InvoiceEditAction[]
      );
      await this.invoiceRepo.update(proposal.tenantId, invoiceId, {
        lineItems: updatedInvoice.lineItems,
        totals: updatedInvoice.totals,
        amountDueCents: updatedInvoice.amountDueCents,
        updatedAt: updatedInvoice.updatedAt,
      });
      return { success: true, resultEntityId: invoice.id };
    } catch (err) {
      if (err instanceof ValidationError) {
        return { success: false, error: err.message };
      }
      throw err;
    }
  }
}
