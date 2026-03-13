import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { CreateInvoiceExecutionHandler } from './invoice-execution-handler';

export interface ExecutionContext {
  tenantId: string;
  executedBy: string;
}

export interface ExecutionResult {
  success: boolean;
  resultEntityId?: string;
  error?: string;
}

export interface ExecutionHandler {
  proposalType: ProposalType;
  execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult>;
}

export class CreateCustomerExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_customer';

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.name || typeof payload.name !== 'string') {
      return { success: false, error: 'Payload must include a valid name' };
    }
    return { success: true, resultEntityId: uuidv4() };
  }
}

export class UpdateCustomerExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'update_customer';

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.customerId || typeof payload.customerId !== 'string') {
      return { success: false, error: 'Payload must include a valid customerId' };
    }
    return { success: true };
  }
}

export class CreateJobExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_job';

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.customerId || typeof payload.customerId !== 'string') {
      return { success: false, error: 'Payload must include a valid customerId' };
    }
    if (!payload.title || typeof payload.title !== 'string') {
      return { success: false, error: 'Payload must include a valid title' };
    }
    return { success: true, resultEntityId: uuidv4() };
  }
}

export class CreateAppointmentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_appointment';

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.jobId || typeof payload.jobId !== 'string') {
      return { success: false, error: 'Payload must include a valid jobId' };
    }
    if (!payload.scheduledStart || typeof payload.scheduledStart !== 'string') {
      return { success: false, error: 'Payload must include a valid scheduledStart' };
    }
    if (!payload.scheduledEnd || typeof payload.scheduledEnd !== 'string') {
      return { success: false, error: 'Payload must include a valid scheduledEnd' };
    }
    return { success: true, resultEntityId: uuidv4() };
  }
}

export class DraftEstimateExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'draft_estimate';

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.customerId || typeof payload.customerId !== 'string') {
      return { success: false, error: 'Payload must include a valid customerId' };
    }
    if (!Array.isArray(payload.lineItems) || payload.lineItems.length === 0) {
      return { success: false, error: 'Payload must include at least one lineItem' };
    }
    return { success: true, resultEntityId: uuidv4() };
  }
}

export class UpdateEstimateExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'update_estimate';

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.estimateId || typeof payload.estimateId !== 'string') {
      return { success: false, error: 'Payload must include a valid estimateId' };
    }
    return { success: true };
  }
}

export function createExecutionHandlerRegistry(): Map<ProposalType, ExecutionHandler> {
  const handlers: ExecutionHandler[] = [
    new CreateCustomerExecutionHandler(),
    new UpdateCustomerExecutionHandler(),
    new CreateJobExecutionHandler(),
    new CreateAppointmentExecutionHandler(),
    new DraftEstimateExecutionHandler(),
    new UpdateEstimateExecutionHandler(),
    new CreateInvoiceExecutionHandler(),
  ];

  const registry = new Map<ProposalType, ExecutionHandler>();
  for (const handler of handlers) {
    registry.set(handler.proposalType, handler);
  }
  return registry;
}
