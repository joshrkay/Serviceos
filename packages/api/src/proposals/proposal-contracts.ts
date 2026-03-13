import { z } from 'zod';

export const proposalFilterSchema = z.object({
  status: z.enum(['draft', 'ready_for_review', 'approved', 'rejected', 'expired', 'executed', 'execution_failed']).optional(),
  proposalType: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ProposalFilter = z.infer<typeof proposalFilterSchema>;

export const proposalResponseSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  proposalType: z.string(),
  status: z.string(),
  summary: z.string(),
  explanation: z.string().optional(),
  confidenceScore: z.number().optional(),
  confidenceFactors: z.array(z.string()).optional(),
  payload: z.record(z.unknown()),
  sourceContext: z.record(z.unknown()).optional(),
  targetEntityType: z.string().optional(),
  targetEntityId: z.string().optional(),
  resultEntityId: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProposalResponse = z.infer<typeof proposalResponseSchema>;
