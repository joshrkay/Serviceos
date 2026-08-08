/**
 * Shared drafting-task helpers — THE single construction point for
 * `CreateProposalInput` across the AI/voice task handlers in this
 * directory.
 *
 * Moved out of `voice-extended-tasks.ts` (which used to own `inputFor`,
 * `entitiesFrom`, and `baseSourceContext` as private, unexported helpers).
 * Once enough standalone task-handler files needed the same
 * `CreateProposalInput` shape — including the `tenantThresholdOverride`
 * passthrough spread — they had no way to import a non-exported helper
 * from another file and started hand-rolling equivalent literals instead,
 * one per file. This module exists to collapse that back to one touch
 * point: import `entitiesFrom`/`baseSourceContext`/`inputFor` from here
 * rather than re-implementing any part of this shape.
 */
import { TaskContext } from './task-handlers';
import { CreateProposalInput, ProposalType } from '../../proposals/proposal';
import { ExtractedEntities } from '../orchestration/intent-classifier';

export function entitiesFrom(context: TaskContext): ExtractedEntities {
  return (context.existingEntities ?? {}) as ExtractedEntities;
}

export function baseSourceContext(context: TaskContext): Record<string, unknown> | undefined {
  if (!context.conversationId) return undefined;
  return { conversationId: context.conversationId };
}

export function inputFor(
  context: TaskContext,
  proposalType: ProposalType,
  payload: Record<string, unknown>,
  missingFields: string[],
  opts?: {
    trust?: 'autonomous' | undefined;
    /**
     * B2 — additional sourceContext entries to merge on top of
     * baseSourceContext (e.g. entityCandidates/entityKind/entityReference).
     * Optional and additive; existing call sites are unaffected.
     */
    sourceContext?: Record<string, unknown>;
    /**
     * B8.10 — surfaces a human-readable "why" on the review card
     * (Proposal.explanation) without touching the payload's Zod contract.
     * Used for the AC-3 non-nudgeable-match gate ("the Khan estimate was
     * already accepted") — optional and additive; existing call sites are
     * unaffected.
     */
    explanation?: string;
  }
): CreateProposalInput {
  const base = baseSourceContext(context);
  const extra = opts?.sourceContext;
  const sourceContext = extra ? { ...(base ?? {}), ...extra } : base;
  return {
    tenantId: context.tenantId,
    proposalType,
    payload,
    summary: context.message,
    explanation: opts?.explanation,
    sourceContext,
    createdBy: context.userId,
    missingFields: missingFields.length > 0 ? missingFields : undefined,
    sourceTrustTier: opts?.trust,
    // PR B — pass through the tenant threshold override the router
    // resolved at request entry. This module is now the single touch
    // point for that passthrough repo-wide: every drafting task handler
    // that needs it imports `inputFor` from here rather than hand-rolling
    // its own copy of this spread.
    ...(context.tenantThresholdOverride
      ? { tenantThresholdOverride: context.tenantThresholdOverride }
      : {}),
  };
}
