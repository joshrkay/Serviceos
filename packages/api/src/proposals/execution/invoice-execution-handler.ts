import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';

export class CreateInvoiceExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'draft_invoice';

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
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
    // Check idempotency - if already executed, return existing
    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }
    return { success: true, resultEntityId: uuidv4() };
  }
}
