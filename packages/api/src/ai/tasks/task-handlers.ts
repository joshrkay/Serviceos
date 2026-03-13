import { Proposal, CreateProposalInput, createProposal, ProposalType } from '../../proposals/proposal';

export interface TaskContext {
  tenantId: string;
  message: string;
  conversationId?: string;
  existingEntities?: Record<string, unknown>;
  userId: string;
}

export interface TaskResult {
  proposal: Proposal;
  taskType: string;
}

export interface TaskHandler {
  taskType: ProposalType;
  handle(context: TaskContext): Promise<TaskResult>;
}

export class CreateCustomerTaskHandler implements TaskHandler {
  readonly taskType: ProposalType = 'create_customer';

  async handle(context: TaskContext): Promise<TaskResult> {
    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload: context.existingEntities ?? {
        name: '',
        email: '',
        phone: '',
      },
      summary: context.message,
      sourceContext: context.conversationId ? { conversationId: context.conversationId } : undefined,
      createdBy: context.userId,
    };

    const proposal = createProposal(input);
    return { proposal, taskType: this.taskType };
  }
}

export class CreateJobTaskHandler implements TaskHandler {
  readonly taskType: ProposalType = 'create_job';

  async handle(context: TaskContext): Promise<TaskResult> {
    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload: context.existingEntities ?? {
        title: '',
        description: '',
      },
      summary: context.message,
      sourceContext: context.conversationId ? { conversationId: context.conversationId } : undefined,
      createdBy: context.userId,
    };

    const proposal = createProposal(input);
    return { proposal, taskType: this.taskType };
  }
}

export class CreateAppointmentTaskHandler implements TaskHandler {
  readonly taskType: ProposalType = 'create_appointment';

  async handle(context: TaskContext): Promise<TaskResult> {
    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload: context.existingEntities ?? {
        date: '',
        time: '',
        customerId: '',
      },
      summary: context.message,
      sourceContext: context.conversationId ? { conversationId: context.conversationId } : undefined,
      createdBy: context.userId,
    };

    const proposal = createProposal(input);
    return { proposal, taskType: this.taskType };
  }
}

export class DraftEstimateTaskHandler implements TaskHandler {
  readonly taskType: ProposalType = 'draft_estimate';

  async handle(context: TaskContext): Promise<TaskResult> {
    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload: context.existingEntities ?? {
        lineItems: [],
        total: 0,
      },
      summary: context.message,
      sourceContext: context.conversationId ? { conversationId: context.conversationId } : undefined,
      createdBy: context.userId,
    };

    const proposal = createProposal(input);
    return { proposal, taskType: this.taskType };
  }
}
