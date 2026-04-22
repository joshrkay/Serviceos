import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from '../execution/handlers';
import { InvoiceRepository, issueInvoice } from '../../invoices/invoice';

const DEFAULT_PAYMENT_TERM_DAYS = 30;

export class IssueInvoiceExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'issue_invoice';

  constructor(private readonly invoiceRepo: InvoiceRepository) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { invoiceId, paymentTermDays } = proposal.payload as {
      invoiceId?: unknown;
      paymentTermDays?: unknown;
    };

    if (!invoiceId || typeof invoiceId !== 'string') {
      return {
        success: false,
        error:
          'Could not determine which invoice to issue. Please specify the invoice number (e.g. "Send invoice INV-0042").',
      };
    }

    const invoice = await this.invoiceRepo.findById(context.tenantId, invoiceId);
    if (!invoice) {
      return { success: false, error: `Invoice ${invoiceId} not found.` };
    }

    if (invoice.status !== 'draft') {
      return {
        success: false,
        error: `Invoice ${invoice.invoiceNumber} cannot be issued — it is currently "${invoice.status}". Only draft invoices can be issued.`,
      };
    }

    const termDays =
      typeof paymentTermDays === 'number' ? paymentTermDays : DEFAULT_PAYMENT_TERM_DAYS;

    await issueInvoice(context.tenantId, invoiceId, termDays, this.invoiceRepo);

    return { success: true, resultEntityId: invoiceId };
  }
}
