import { z } from 'zod';
import { proposalStatusSchema } from '@ai-service-os/shared';

export const proposalFilterSchema = z.object({
  // Reuse the canonical proposal status set (kept in lockstep with the DB CHECK
  // via shared/contracts/status.test.ts). Previously hand-listed here and had
  // already drifted — it was missing 'undone'.
  status: proposalStatusSchema.optional(),
  proposalType: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ProposalFilter = z.infer<typeof proposalFilterSchema>;

export const rejectProposalBodySchema = z.object({
  reason: z.string().min(1, 'reason is required'),
  details: z.string().optional(),
});

export type RejectProposalBody = z.infer<typeof rejectProposalBodySchema>;

export const editProposalBodySchema = z.object({
  edits: z.record(z.unknown()),
});

export type EditProposalBody = z.infer<typeof editProposalBodySchema>;

// The proposal response shape lives in @ai-service-os/shared so api and web
// share one definition. This file previously carried a byte-for-byte duplicate
// (with the same loose `status: z.string()`); it's now re-exported from the
// canonical source, which types `status` via proposalStatusSchema.
export { proposalResponseSchema, type ProposalResponse } from '@ai-service-os/shared';
