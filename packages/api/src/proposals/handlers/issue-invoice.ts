import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from '../execution/handlers';
import { Invoice, InvoiceRepository, issueInvoice } from '../../invoices/invoice';
import { RefreshJobMoneyStateDeps } from '../../jobs/job-money-state';

const DEFAULT_PAYMENT_TERM_DAYS = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves an invoice by UUID (internal ID) or by human-readable invoice
 * number (e.g. "INV-0042" or bare "0042"). Voice commands typically produce
 * the latter; the assistant platform produces the former.
 */
async function resolveInvoice(
  tenantId: string,
  ref: string,
  repo: InvoiceRepository
): Promise<Invoice | null> {
  if (UUID_RE.test(ref)) {
    return repo.findById(tenantId, ref);
  }
  const all = await repo.findByTenant(tenantId);
  return (
    all.find(
      (i) => i.invoiceNumber === ref || i.invoiceNumber === `INV-${ref}`
    ) ?? null
  );
}

export class IssueInvoiceExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'issue_invoice';

  constructor(
    private readonly invoiceRepo: InvoiceRepository,
    private readonly moneyStateDeps?: RefreshJobMoneyStateDeps,
  ) {}

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

    const invoice = await resolveInvoice(context.tenantId, invoiceId, this.invoiceRepo);
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

    await issueInvoice(context.tenantId, invoice.id, termDays, this.invoiceRepo, this.moneyStateDeps);

    return { success: true, resultEntityId: invoice.id };
  }
}
