import { z } from 'zod';
import {
  MAX_INSTRUCTION_LENGTH,
  standingInstructionScopeSchema,
} from '../../instructions/standing-instructions';

/**
 * create_standing_instruction proposal payload (UB-A2).
 *
 * Captures a persistent tenant directive spoken by the owner ("from now on
 * always add a $79 diagnostic fee to AC calls"). On approval the execution
 * handler inserts a `standing_instructions` row (source 'proposal') via the
 * UB-A1 repository. The scope schema is REUSED from the domain module
 * (instructions/standing-instructions.ts) so the proposal layer and the data
 * layer can never drift on what a valid scope is — same single-source rule as
 * the milestone contract mirroring validateMilestones.
 */
export const createStandingInstructionPayloadSchema = z.object({
  instruction: z.string().trim().min(1).max(MAX_INSTRUCTION_LENGTH),
  scope: standingInstructionScopeSchema.optional(),
});

export type CreateStandingInstructionPayload = z.infer<
  typeof createStandingInstructionPayloadSchema
>;
