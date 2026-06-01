import { z } from 'zod';
import { proposalStatusSchema } from './status.js';

/**
 * P0-033 (F-1) — API-shaped proposal payload for web inbox/list UIs.
 * Subset of full server `Proposal`; extend additively only (Tier 2).
 */
export const proposalResponseSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  // `proposalType` stays `string` deliberately: the shared `ProposalType` enum
  // is known-incomplete (e.g. the dispatch crew types `add_crew_member` /
  // `remove_crew_member` the web already sends are absent from it). Reconciling
  // that enum with the API's full ProposalType union is a tracked follow-up;
  // typing this field to the incomplete enum today would reject valid values.
  proposalType: z.string(),
  status: proposalStatusSchema,
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
