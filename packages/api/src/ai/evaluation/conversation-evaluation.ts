import { v4 as uuidv4 } from 'uuid';

export interface ConversationEvaluation {
  id: string;
  tenantId: string;
  conversationId: string;
  estimateId: string;
  proposalRevisionId?: string;
  aiRunId?: string;
  accuracyScore?: number;
  feedback?: string;
  evaluatedBy?: string;
  createdAt: Date;
}

export interface CreateEvaluationInput {
  tenantId: string;
  conversationId: string;
  estimateId: string;
  proposalRevisionId?: string;
  aiRunId?: string;
}

export function validateEvaluationInput(input: Partial<CreateEvaluationInput>): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.conversationId) errors.push('conversationId is required');
  if (!input.estimateId) errors.push('estimateId is required');
  return errors;
}

export function createConversationEvaluation(input: CreateEvaluationInput): ConversationEvaluation {
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    estimateId: input.estimateId,
    proposalRevisionId: input.proposalRevisionId,
    aiRunId: input.aiRunId,
    createdAt: new Date(),
  };
}
