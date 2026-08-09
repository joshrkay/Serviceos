/**
 * Task 9 (2026-08-07 tradesperson plan) — AddMaterialTaskHandler
 * (drafting leg).
 *
 * Standalone file per the house ratchet (mirrors apply-credit-task.ts /
 * create-change-order-task.ts / create-service-agreement-task.ts) — new
 * drafting handlers land in their own file, not voice-extended-tasks.ts.
 *
 * `add_material` adds a row to the voice-captured shopping list (Task 8's
 * `material_items` substrate) — no money moves, and it's reversible.
 * Capture-class, same posture as `log_expense`.
 *
 * ── jobId resolution mirrors `LogExpenseTaskHandler` (voice-extended-
 * tasks.ts), NOT `create_change_order`'s hard gate ──────────────────────
 *
 * `add_material` joins `JOB_REF_INTENTS`
 * (ai/agents/customer-calling/entity-resolution.ts), so when a job is
 * named ("for the Patel job") the voice-action-router's entity resolver
 * has already resolved the spoken jobReference to a VERIFIED jobId and
 * stamped it onto `context.existingEntities.jobId` before this handler
 * runs — a ROUTER-INJECTED id, never an LLM-extracted field (same house
 * pattern as `apply_credit`'s invoiceId / `create_change_order`'s jobId).
 * UNLIKE `create_change_order` (whose jobId is REQUIRED — a change order
 * without its job is meaningless), `jobId` here is OPTIONAL on the
 * contract: a shopping-list item can be unlinked to any job ("grab three
 * boxes of PEX" with no job named is still a perfectly good capture), so
 * an unresolved/absent reference never gates the proposal.
 *
 * ── materialQuantity defaults to 1, mirroring the DB column default ──────
 *
 * `buildMaterialItem` (material-item.ts) defaults `quantity` to 1 when
 * omitted; this handler's default keeps the drafted payload's shape
 * identical to what execution would fill in anyway, so the review card
 * always shows a concrete number rather than a blank.
 *
 * ── materialNeededBy: best-effort parse, never gates ──────────────────────
 *
 * Reuses the SAME chrono+luxon reference-date construction
 * `create-service-agreement-task.ts`'s `parseSpokenStartsOn` uses (tenant-
 * timezone anchored, guard 1 only: reject a fully ambiguous relative
 * phrase with neither an explicit month nor day named). UNLIKE
 * `startsOn`, there is no guard-2 past-date rejection and no default
 * fallback when parsing fails — see `contracts/add-material.ts`'s module
 * doc comment for why a past `neededBy` is legitimate (an already-overdue
 * part is a real, useful shopping-list signal, not a malformed one). A
 * phrase that fails to parse is simply OMITTED from the payload — it's an
 * optional, purely informational field, so there's nothing to gate on and
 * nothing to guess at.
 *
 * ── No `_meta` confidence marker ───────────────────────────────────────────
 *
 * No catalog grounding or LLM call anywhere in this handler that would
 * produce a real confidence signal on a shopping-list line — `_meta` is
 * omitted rather than fabricated, same posture as
 * `create-service-agreement-task.ts`.
 *
 * ── Never auto-approves ────────────────────────────────────────────────────
 *
 * This handler deliberately omits `sourceTrustTier` (inputFor's default),
 * so `decideInitialStatus`'s only auto-approve branch
 * (`sourceTrustTier === 'autonomous' AND` capture-class) is never reached
 * at any confidence — same posture as `create_change_order` /
 * `create_service_agreement`. (A future revision MAY reconsider — a
 * shopping-list add is about as low-risk as a capture-class action gets —
 * but that is a deliberate scope decision for a later pass, not an
 * oversight here.)
 */
import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { assertValidProposalPayload } from '../../proposals/contracts';
import type { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import type { ExtractedEntities } from '../orchestration/intent-classifier';
import { entitiesFrom, inputFor } from './task-input';
import { isRuntimeTimezone, localDateKey } from '../../shared/timezone';
import { DEFAULT_TENANT_TIMEZONE } from '../scheduling/resolve-datetime';

/**
 * Pull the Zod paths off a `ValidationError` thrown by
 * `assertValidProposalPayload` (it stores them as `details.errors`, each
 * formatted `"<path>: <message>"`). Mirrors `estimate-task.ts`'s
 * `contractErrorsFrom` (not exported from there, so duplicated here — same
 * house pattern `apply-credit-task.ts`/`create-change-order-task.ts`/
 * `create-service-agreement-task.ts` use).
 */
function contractErrorsFrom(err: unknown): string[] {
  const details = (err as { details?: { errors?: unknown } } | undefined)?.details;
  const errors = details?.errors;
  if (Array.isArray(errors)) {
    return errors.filter((e): e is string => typeof e === 'string');
  }
  return [err instanceof Error ? err.message : String(err)];
}

/** Map contract errors onto operator-facing `missingFields` entries (leading path segment of each Zod issue). */
function contractGapFields(errors: string[]): string[] {
  const fields = new Set<string>();
  for (const error of errors) {
    const path = error.split(':')[0]?.trim() ?? '';
    const head = path.split(/[.[]/)[0];
    fields.add(head.length > 0 ? head : 'description');
  }
  return [...fields];
}

/**
 * Best-effort parse of a spoken "needed by" phrase into a calendar date,
 * anchored to the tenant-local "now" — mirrors
 * `create-service-agreement-task.ts`'s `parseSpokenStartsOn` MINUS its
 * guard 2 (past-date rejection): see this module's doc comment for why a
 * past `neededBy` is legitimate here. Returns `undefined` — never throws —
 * when the phrase doesn't yield a sufficiently-certain date; the caller
 * simply omits the field (never gates, never guesses a default).
 */
function parseSpokenNeededBy(phrase: string, timezone: string, now: Date): string | undefined {
  const refLocal = DateTime.fromJSDate(now).setZone(timezone);
  const referenceDate = new Date(
    refLocal.year,
    refLocal.month - 1,
    refLocal.day,
    refLocal.hour,
    refLocal.minute,
    refLocal.second,
    refLocal.millisecond,
  );
  const results = chrono.parse(phrase, referenceDate, { forwardDate: true });
  if (results.length === 0) return undefined;
  const start = results[0].start;

  // Reject a fully ambiguous relative phrase (neither an explicit month nor
  // an explicit day-of-month named) — same guard 1 as parseSpokenStartsOn.
  if (!start.isCertain('month') && !start.isCertain('day')) return undefined;

  const year = start.get('year');
  const month = start.get('month');
  const day = start.get('day');
  if (year == null || month == null || day == null) return undefined;
  const dt = DateTime.fromObject({ year, month, day }, { zone: timezone });
  if (!dt.isValid) return undefined;
  return dt.toFormat('yyyy-MM-dd');
}

function resolveTenantTimezone(context: TaskContext): string {
  const raw = typeof context.timezone === 'string' ? context.timezone.trim() : '';
  return raw && isRuntimeTimezone(raw) ? raw : DEFAULT_TENANT_TIMEZONE;
}

export class AddMaterialTaskHandler implements TaskHandler {
  readonly taskType = 'add_material' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context) as ExtractedEntities & { jobId?: string };
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    const description =
      typeof ee.materialDescription === 'string' && ee.materialDescription.trim().length > 0
        ? ee.materialDescription.trim()
        : undefined;
    if (description) {
      payload.description = description;
    } else {
      missing.push('description');
    }

    payload.quantity =
      typeof ee.materialQuantity === 'number' &&
      Number.isFinite(ee.materialQuantity) &&
      ee.materialQuantity > 0
        ? Math.round(ee.materialQuantity)
        : 1;

    // Router-injected verified job id (see class doc comment above) — never
    // the raw jobReference free text, and never gated when absent.
    if (typeof ee.jobId === 'string' && ee.jobId.length > 0) {
      payload.jobId = ee.jobId;
    }

    if (typeof ee.vendor === 'string' && ee.vendor.trim().length > 0) {
      payload.vendor = ee.vendor.trim();
    }

    const spokenNeededBy =
      typeof ee.materialNeededBy === 'string' ? ee.materialNeededBy.trim() : '';
    if (spokenNeededBy.length > 0) {
      const timezone = resolveTenantTimezone(context);
      const now = context.now ?? new Date();
      const neededBy = parseSpokenNeededBy(spokenNeededBy, timezone, now);
      if (neededBy) payload.neededBy = neededBy;
      // An unparseable/ambiguous phrase is simply dropped — see module doc
      // comment. Never gates: this is optional, informational context.
    }

    // P2-002 — the MANDATORY payload contract gate (proposals/contracts.ts
    // documents assertValidProposalPayload as required before every
    // createProposal on an AI-authored path). A backstop, not the primary
    // gate: description/quantity are already flat-gated by hand above, so
    // this mainly catches shape issues the hand-written checks don't (a
    // >1000-char description, a malformed jobId).
    let payloadContractErrors: string[] | undefined;
    try {
      assertValidProposalPayload(this.taskType, payload);
    } catch (err) {
      payloadContractErrors = contractErrorsFrom(err);
      for (const field of contractGapFields(payloadContractErrors)) {
        if (!missing.includes(field)) missing.push(field);
      }
    }

    const extraSourceContext = payloadContractErrors ? { payloadContractErrors } : undefined;

    const input: CreateProposalInput = inputFor(context, this.taskType, payload, missing, {
      sourceContext: extraSourceContext,
    });

    return { proposal: createProposal(input), taskType: this.taskType };
  }
}
