import { z } from 'zod';
import { ProposalType } from '../enums.js';
import { proposalStatusSchema } from './status.js';

/**
 * P0-033 (F-1) — API-shaped proposal payload for web inbox/list UIs.
 * Subset of full server `Proposal`; extend additively only (Tier 2).
 */
export const proposalResponseSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  // Typed to the canonical ProposalType enum, kept in exact lockstep with the
  // API's VALID_PROPOSAL_TYPES union via proposal-type.test.ts.
  proposalType: z.nativeEnum(ProposalType),
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
  // Finding 2 — undo-window honesty. `approvedAt` is the server-stamped
  // approval instant; `undoExpiresAt` = approvedAt + UNDO_WINDOW_MS. Both are
  // ISO strings, both optional (present only on the approve response / an
  // approved proposal), so this stays backward compatible with every existing
  // inbox/list consumer that never reads them.
  approvedAt: z.string().optional(),
  undoExpiresAt: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProposalResponse = z.infer<typeof proposalResponseSchema>;
