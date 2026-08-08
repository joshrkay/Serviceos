/**
 * Task 7 (2026-08-07 tradesperson plan) — CreateServiceAgreementTaskHandler
 * (drafting leg).
 *
 * Standalone file per the house ratchet (mirrors apply-credit-task.ts /
 * create-change-order-task.ts / send-customer-message-task.ts) — new
 * drafting handlers land in their own file, not voice-extended-tasks.ts.
 *
 * `create_service_agreement` signs a customer up for a recurring
 * maintenance plan/membership ("Sign the Garcias up for the annual
 * maintenance plan, 290 a year"). Capture-class: no money moves at
 * creation — the agreement's OWN sweep invoices later, and those invoices
 * ride the normal review path (see contracts/create-service-agreement.ts
 * and the execution handler for the full analysis).
 *
 * ── Customer resolution mirrors SendCustomerMessageTaskHandler exactly ────
 *
 * `create_service_agreement` joins `CUSTOMER_REF_INTENTS`
 * (ai/agents/customer-calling/entity-resolution.ts), so the voice-action-
 * router resolves the spoken customer name to a verified id BEFORE this
 * handler runs (or short-circuits to a `voice_clarification` on an
 * ambiguous match, or leaves it absent on no match / nothing spoken) and
 * threads it onto `context.customerId` — NOT
 * `context.existingEntities.customerId`. An unresolved reference gates
 * `missingFields: ['customerId']` rather than persisting a free-text
 * stand-in, same deliberately safer posture `send_customer_message` /
 * `update_customer` chose.
 *
 * ── Cadence -> RRULE: deterministic, no LLM call ──────────────────────────
 *
 * The classifier normalizes the spoken cadence word into one of four fixed
 * tokens (monthly/quarterly/twice_a_year/annual — "semiannual"/"yearly" are
 * synonyms the model maps onto the same tokens); this handler maps each
 * token to the RRULE string the recurrence engine
 * (agreements/recurrence.ts) understands. An absent or unrecognized
 * cadence gates `missingFields: ['recurrenceRule']` — never a guessed
 * default cadence.
 *
 * ── startsOn: tenant-timezone default, best-effort spoken override ────────
 *
 * Defaults to the first of next month computed from the TENANT's LOCAL
 * calendar date (`shared/timezone.ts localDateKey`) — never raw
 * server-local `Date` math, which would be off by a day for any tenant
 * whose local "today" differs from the server/UTC day (e.g. a UTC instant
 * just after midnight is still "yesterday" for a US-Pacific tenant). Falls
 * back to `DEFAULT_TENANT_TIMEZONE` when no tenant zone resolved — this
 * field only ever picks a SOFT default (never a hard scheduling
 * commitment gated on tenant-zone certainty the way appointment times
 * are), and the resulting date is always visible and editable on the
 * review card before approval (this type never sets `sourceTrustTier`, so
 * it can never auto-approve unreviewed — see below).
 *
 * A spoken start ("starting September", "October 1st") is parsed
 * best-effort via chrono-node, anchored to the tenant-local "now" —
 * mirrors `ai/scheduling/resolve-datetime.ts`'s own chrono+luxon reference-
 * date construction, minus the exact-time/daypart requirement (this field
 * is a bare calendar DATE, never a time-of-day). An unparseable phrase
 * falls back to the computed default rather than gating: unlike an entity
 * reference (customer/job/invoice id), a soft scheduling default that the
 * reviewer can correct before approving is not the kind of "silent guess"
 * the P0 voice-safety invariant (CLAUDE.md) targets.
 *
 * ── No `_meta` confidence marker ───────────────────────────────────────────
 *
 * Unlike `create_change_order` (which grounds a line price against the
 * tenant catalog), there is no catalog grounding or LLM call in this
 * handler that would produce a real confidence signal on a plan price —
 * `_meta` is deliberately omitted rather than fabricated
 * (`proposalConfidenceMetaSchema` requires `overallConfidence` whenever
 * `_meta` is present; omitting the whole envelope is the honest choice
 * when there is nothing to report).
 *
 * ── Never auto-approves ────────────────────────────────────────────────────
 *
 * This handler deliberately omits `sourceTrustTier` (inputFor's default),
 * so `decideInitialStatus`'s only auto-approve branch
 * (`sourceTrustTier === 'autonomous' AND` capture-class) is never reached
 * at any confidence — same posture as `create_change_order` /
 * `create_standing_instruction`.
 */
import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import { createProposal } from '../../proposals/proposal';
import { assertValidProposalPayload } from '../../proposals/contracts';
import type { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import type { ExtractedEntities } from '../orchestration/intent-classifier';
import { entitiesFrom, inputFor } from './task-input';
import { isRuntimeTimezone, localDateKey } from '../../shared/timezone';
import { DEFAULT_TENANT_TIMEZONE } from '../scheduling/resolve-datetime';

/** The 4 cadence tokens the classifier may emit, mapped to the RRULE the recurrence engine (agreements/recurrence.ts) understands. */
const CADENCE_TO_RRULE: Record<string, string> = {
  monthly: 'FREQ=MONTHLY',
  quarterly: 'FREQ=MONTHLY;INTERVAL=3',
  twice_a_year: 'FREQ=MONTHLY;INTERVAL=6',
  annual: 'FREQ=YEARLY',
};

/**
 * Pull the Zod paths off a `ValidationError` thrown by
 * `assertValidProposalPayload` (it stores them as `details.errors`, each
 * formatted `"<path>: <message>"`). Mirrors `estimate-task.ts`'s
 * `contractErrorsFrom` (not exported from there, so duplicated here — same
 * house pattern `apply-credit-task.ts`/`create-change-order-task.ts` use).
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
    fields.add(head.length > 0 ? head : 'payload');
  }
  return [...fields];
}

function resolveTenantTimezone(context: TaskContext): string {
  return typeof context.timezone === 'string' && isRuntimeTimezone(context.timezone.trim())
    ? context.timezone.trim()
    : DEFAULT_TENANT_TIMEZONE;
}

/**
 * First of next month, as a `YYYY-MM-DD` string, computed from the
 * tenant's LOCAL calendar date — never raw server-local `Date` math (see
 * module doc comment "startsOn" section above).
 */
function firstOfNextMonth(now: Date, timezone: string): string {
  const todayLocal = localDateKey(now, timezone); // 'YYYY-MM-DD', tenant-local
  const [y, m] = todayLocal.split('-').map(Number);
  // `m` is 1-indexed (Jan=1); `Date.UTC`'s month param is 0-indexed, so
  // passing `m` straight through lands one calendar month ahead of
  // `todayLocal` — exactly "first of next month". Date.UTC normalizes a
  // December (m=12) rollover into January of the following year.
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

/**
 * Best-effort parse of a spoken starts-on phrase into a calendar date,
 * anchored to the tenant-local "now" (same chrono+luxon reference-date
 * construction `ai/scheduling/resolve-datetime.ts` uses). Returns
 * `undefined` — never throws — when the phrase doesn't yield a date; the
 * caller falls back to `firstOfNextMonth`.
 */
function parseSpokenStartsOn(phrase: string, timezone: string, now: Date): string | undefined {
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
  const year = start.get('year');
  const month = start.get('month');
  const day = start.get('day');
  if (year == null || month == null || day == null) return undefined;
  const dt = DateTime.fromObject({ year, month, day }, { zone: timezone });
  return dt.isValid ? dt.toFormat('yyyy-MM-dd') : undefined;
}

export class CreateServiceAgreementTaskHandler implements TaskHandler {
  readonly taskType = 'create_service_agreement' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context) as ExtractedEntities & {
      serviceAgreementCadence?: string;
    };
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    // Router-injected verified customer id (see class doc comment above).
    if (context.customerId) {
      payload.customerId = context.customerId;
    } else {
      missing.push('customerId');
    }

    const name =
      typeof ee.serviceAgreementName === 'string' && ee.serviceAgreementName.trim().length > 0
        ? ee.serviceAgreementName.trim()
        : undefined;
    if (name) {
      payload.name = name;
    } else {
      missing.push('name');
    }

    const rrule =
      typeof ee.serviceAgreementCadence === 'string'
        ? CADENCE_TO_RRULE[ee.serviceAgreementCadence]
        : undefined;
    if (rrule) {
      payload.recurrenceRule = rrule;
    } else {
      missing.push('recurrenceRule');
    }

    if (typeof ee.amount === 'number' && ee.amount > 0) {
      payload.priceCents = Math.round(ee.amount);
    } else {
      missing.push('priceCents');
    }

    const timezone = resolveTenantTimezone(context);
    const now = context.now ?? new Date();
    const spokenStartsOn =
      typeof ee.serviceAgreementStartsOn === 'string' ? ee.serviceAgreementStartsOn.trim() : '';
    payload.startsOn =
      (spokenStartsOn.length > 0 ? parseSpokenStartsOn(spokenStartsOn, timezone, now) : undefined) ??
      firstOfNextMonth(now, timezone);

    // P2-002 — the MANDATORY payload contract gate (proposals/contracts.ts
    // documents assertValidProposalPayload as required before every
    // createProposal on an AI-authored path). A backstop, not the primary
    // gate: every field above is already flat-gated by hand, so this
    // mainly catches shape issues the hand-written checks don't (e.g. a
    // >200-char plan name).
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

    return {
      proposal: createProposal(
        inputFor(context, this.taskType, payload, missing, { sourceContext: extraSourceContext }),
      ),
      taskType: this.taskType,
    };
  }
}
