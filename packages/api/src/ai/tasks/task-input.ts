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
 * rather than re-implementing any part of this shape. Also home to
 * `contractErrorsFrom`/`contractGapFields` (Task 12 review, "I5") — the
 * `assertValidProposalPayload`-error-to-`missingFields` mapping every
 * standalone drafting task needs for its P2-002 contract-gate backstop.
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

/**
 * Quality-review fix (2026-08-09, Task 12 review, "I5") — pull the Zod
 * paths off a `ValidationError` thrown by `assertValidProposalPayload`
 * (it stores them as `details.errors`, each formatted
 * `"<path>: <message>"`). This was independently duplicated, BYTE-
 * IDENTICAL, in six standalone drafting task files (add-catalog-item-task,
 * add-material-task, create-service-agreement-task,
 * create-change-order-task, invoice-task, estimate-task) — each one's own
 * comment called it "the house pattern every standalone drafting task
 * file uses," which is exactly the point at which a house pattern becomes
 * a house problem. Extracted here, the single home every one of those
 * files already imports (or now imports for the first time — invoice-
 * task.ts/estimate-task.ts predate `task-input.ts` and didn't use
 * `inputFor`/`entitiesFrom`, but this pair of helpers is a self-contained
 * addition to their imports).
 */
export function contractErrorsFrom(err: unknown): string[] {
  const details = (err as { details?: { errors?: unknown } } | undefined)?.details;
  const errors = details?.errors;
  if (Array.isArray(errors)) {
    return errors.filter((e): e is string => typeof e === 'string');
  }
  return [err instanceof Error ? err.message : String(err)];
}

/**
 * Map contract errors onto operator-facing `missingFields` entries — the
 * leading path segment of each Zod issue. Object-level issues (a
 * `.refine` at the schema root, or a required top-level field with no
 * further path) carry an EMPTY path, so `fallback` names the gap the
 * operator actually has to fill in that case. Callers choose it
 * deliberately per contract — e.g. 'customerId' for invoice/estimate's
 * customerId-or-reference refine, 'name' for add_catalog_item's required
 * name, 'lineItems' for create_change_order's single line item.
 */
export function contractGapFields(errors: string[], fallback: string): string[] {
  const fields = new Set<string>();
  for (const error of errors) {
    const path = error.split(':')[0]?.trim() ?? '';
    const head = path.split(/[.[]/)[0];
    fields.add(head.length > 0 ? head : fallback);
  }
  return [...fields];
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
