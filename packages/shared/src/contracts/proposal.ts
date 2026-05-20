import { z } from 'zod';

/**
 * P0-033 (F-1) — API-shaped proposal payload for web inbox/list UIs.
 * Subset of full server `Proposal`; extend additively only (Tier 2).
 */
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
