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
 *
 * Known exceptions: complaint-task.ts (deliberately unconverted — custom
 * summaries, an always-present `source: 'voice'` sourceContext,
 * idempotencyKey/explanation), task-router.ts (IssueInvoiceTaskHandler,
 * whose threshold comes from an async thresholdResolver fallback rather
 * than off context, so it genuinely can't use inputFor as-is) — see each
 * for why.
 */
import { TaskContext } from './task-handlers';
import { CreateProposalInput, ProposalType } from '../../proposals/proposal';
import { ExtractedEntities } from '../orchestration/intent-classifier';
import { isRuntimeTimezone } from '../../shared/timezone';
import { DEFAULT_TENANT_TIMEZONE } from '../scheduling/resolve-datetime';

export function entitiesFrom(context: TaskContext): ExtractedEntities {
  return (context.existingEntities ?? {}) as ExtractedEntities;
}

export interface ResolvedTenantTimezone {
  timezone: string;
  /** True when no valid tenant timezone was available and DEFAULT_TENANT_TIMEZONE was substituted. */
  usedFallback: boolean;
}

/**
 * Quality-review fix (2026-08-09, Task 11 review, "I4") — the single
 * `context.timezone` validate-or-fallback pattern that had drifted into
 * FOUR independent copies (add-material-task.ts, create-service-agreement-
 * task.ts, voice-extended-tasks.ts's RescheduleAppointmentTaskHandler, and
 * LogExpenseTaskHandler's log_mileage branch) — each one "mirrors" the
 * others in a comment rather than sharing code. Returns the RICH shape
 * (mirroring create-service-agreement-task.ts's own `ResolvedTimezone`,
 * the strictest existing consumer) rather than a bare string: that file's
 * `buildExplanation` needs `usedFallback` to tell the operator "(assumed
 * America/New_York — tenant timezone unset)" on the review card, and a
 * tenant genuinely configured for America/New_York must never be
 * indistinguishable from one that fell back to it by coincidence — a bare
 * `timezone === DEFAULT_TENANT_TIMEZONE` check cannot tell those apart.
 * Callers that only need the zone string destructure `.timezone`.
 */
export function resolveTenantTimezone(context: TaskContext): ResolvedTenantTimezone {
  const raw = typeof context.timezone === 'string' ? context.timezone.trim() : '';
  if (raw && isRuntimeTimezone(raw)) return { timezone: raw, usedFallback: false };
  return { timezone: DEFAULT_TENANT_TIMEZONE, usedFallback: true };
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
