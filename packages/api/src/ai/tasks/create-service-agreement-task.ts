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
 * (agreements/recurrence.ts) understands. `CADENCE_TO_RRULE` is typed
 * against `ExtractedEntities['serviceAgreementCadence']` itself (quality-
 * review I3), not a widened `Record<string, string>` — a fifth cadence
 * token added to the classifier without a matching table entry is now a
 * COMPILE error instead of a silent `undefined` that gates with no signal.
 * An absent or unrecognized cadence gates `missingFields: ['recurrenceRule']`
 * — never a guessed default cadence.
 *
 * A NEW dollar amount, priced strictly positive: `ee.amount > 0` is
 * required — a `$0` plan is structurally legal on the contract (a comp
 * membership), but voice has no way to distinguish "the caller said zero"
 * from "the caller didn't state a price", so this handler never emits
 * `priceCents: 0` (see contracts/create-service-agreement.ts's doc comment
 * for the full rationale).
 *
 * ── startsOn: tenant-timezone default, best-effort spoken override ────────
 *
 * Defaults to the first of next month computed from the TENANT's LOCAL
 * calendar date (`shared/timezone.ts localDateKey`) — never raw
 * server-local `Date` math, which would be off by a day for any tenant
 * whose local "today" differs from the server/UTC day (e.g. a UTC instant
 * just after midnight is still "yesterday" for a US-Pacific tenant). Falls
 * back to `DEFAULT_TENANT_TIMEZONE` when no tenant zone resolved. This is
 * a DELIBERATE, narrower exception to the general "never silently default
 * an unresolved tenant timezone" rule (voice-action-router.ts's own doc
 * comment, next to the Phoenix mis-booking incident): the blast radius of
 * a wrong START DATE — possibly off by one day, on a review card the
 * operator reads before approving, for a sweep run weeks away — is
 * materially smaller than a mis-timed BOOKING. The assumption is made
 * VISIBLE rather than silent: whenever the fallback timezone is used, the
 * proposal's `explanation` names it explicitly (see `buildExplanation`
 * below) so the review card states what was assumed (WYSIWYG, same rule
 * `send_customer_message`'s draft-time clamp follows).
 *
 * A spoken start ("starting September", "October 1st") is parsed
 * best-effort via chrono-node, anchored to the tenant-local "now" —
 * mirrors `ai/scheduling/resolve-datetime.ts`'s own chrono+luxon reference-
 * date construction, minus the exact-time/daypart requirement (this field
 * is a bare calendar DATE, never a time-of-day). Two guards (quality-review
 * I2) keep chrono from accepting garbage:
 *   1. A fully AMBIGUOUS relative phrase (neither an explicit month nor an
 *      explicit day-of-month named — "a year", "last year") is rejected.
 *      Chrono still returns a best-guess date for these (reading them as a
 *      bare duration relative to "now"), and that guess is materially
 *      wrong for the classifier's own canonical example ("290 A YEAR"
 *      could drop "a year" into this field). Mirrors resolve-datetime.ts's
 *      own posture — it reports ambiguity back (`ambiguous_no_time`)
 *      rather than accepting a low-confidence parse; this is that same
 *      discipline for a bare date. "starting September" (month named) and
 *      "next week"/"next month" (chrono resolves a definite target month)
 *      all still pass this guard.
 *   2. A resolved date already in the tenant's PAST ("January 2019") is
 *      rejected. `runDueAgreements` (the recurring sweep, every 60 seconds
 *      — app.ts) would pick a back-dated `nextRunAt` up on its very next
 *      tick and advance ONE interval per pass, so a back-dated MONTHLY
 *      plan would drip a job+invoice pair roughly once a MINUTE until it
 *      caught up to today.
 * Either guard tripping — or chrono simply failing to parse anything —
 * falls back to the computed default rather than gating: unlike an entity
 * reference (customer/job/invoice id), a soft scheduling default that the
 * reviewer can correct before approving is not the kind of "silent guess"
 * the P0 voice-safety invariant (CLAUDE.md) targets. (An equivalent
 * `max(parsed, firstOfNextMonth)` clamp would produce the same end result
 * for guard 2; `return undefined` was chosen because `parseSpokenStartsOn`
 * already has an established "undefined = give up, caller defaults"
 * contract — reusing it needs no second computation path.)
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
 * ── explanation: make the RRULE human-readable ────────────────────────────
 *
 * `payload.recurrenceRule` is a string like `"FREQ=MONTHLY;INTERVAL=6"` —
 * no operator reviewing a proposal card verifies that by eye. `explanation`
 * (Proposal.explanation, rendered on the review card without touching the
 * payload's Zod contract) carries a plain-language summary instead, e.g.
 * "Twice a year, $290.00, starting Sep 1 2026" — built from whatever of
 * {cadence, price, start date} is concretely known, so a partially gated
 * draft still shows what it does have.
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
import { entitiesFrom, inputFor, resolveTenantTimezone, ResolvedTenantTimezone } from './task-input';
import { localDateKey } from '../../shared/timezone';
import { formatUsdCentsPlain } from '@ai-service-os/shared';

type ServiceAgreementCadence = NonNullable<ExtractedEntities['serviceAgreementCadence']>;

/**
 * The 4 cadence tokens the classifier may emit, mapped to the RRULE the
 * recurrence engine (agreements/recurrence.ts) understands. Typed against
 * `ServiceAgreementCadence` itself (quality-review I3) so a fifth token
 * added to `ExtractedEntities` without a matching entry here is a COMPILE
 * error, not a silent runtime `undefined`.
 */
const CADENCE_TO_RRULE: Record<ServiceAgreementCadence, string> = {
  monthly: 'FREQ=MONTHLY',
  quarterly: 'FREQ=MONTHLY;INTERVAL=3',
  // Quality-review minor — FREQ=QUARTERLY;INTERVAL=2 (recurrence.ts's
  // nextOccurrence: quarterly steps are `interval * 3` months) is EQUALLY
  // valid RRULE for "every 6 months"; MONTHLY;INTERVAL=6 was chosen so
  // every multi-month cadence in this table rides the same FREQ, not
  // because the engine lacks a QUARTERLY-based equivalent.
  twice_a_year: 'FREQ=MONTHLY;INTERVAL=6',
  annual: 'FREQ=YEARLY',
};

/** Plain-language cadence labels for the review-card `explanation` (see module doc comment). */
const CADENCE_LABELS: Record<ServiceAgreementCadence, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  twice_a_year: 'Twice a year',
  annual: 'Annual',
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
 * `undefined` — never throws — when the phrase doesn't yield a
 * sufficiently-certain, non-past date; the caller falls back to
 * `firstOfNextMonth`. See the module doc comment's "startsOn" section for
 * the two guards (quality-review I2).
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

  // Guard 1 (I2) — reject a fully ambiguous relative phrase.
  if (!start.isCertain('month') && !start.isCertain('day')) return undefined;

  const year = start.get('year');
  const month = start.get('month');
  const day = start.get('day');
  if (year == null || month == null || day == null) return undefined;
  const dt = DateTime.fromObject({ year, month, day }, { zone: timezone });
  if (!dt.isValid) return undefined;
  const resolved = dt.toFormat('yyyy-MM-dd');

  // Guard 2 (I2) — reject a date already in the tenant's past.
  if (resolved < localDateKey(now, timezone)) return undefined;

  return resolved;
}

/** `MMM d, yyyy` label for the review-card explanation (the bare calendar date, never tz-shifted). */
function formatStartsOnLabel(startsOn: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${startsOn}T00:00:00Z`));
}

/**
 * Plain-language summary of the drafted plan for the review card (see
 * module doc comment "explanation" section). Built from whatever of
 * {cadence, price, start date} is concretely known so a partially gated
 * draft still shows what it does have. Names the tenant-timezone fallback
 * explicitly when one was used, so the assumption is never silent
 * (WYSIWYG — quality-review addendum ruling).
 */
function buildExplanation(
  cadence: ServiceAgreementCadence | undefined,
  priceCents: number | undefined,
  startsOn: string,
  tz: ResolvedTenantTimezone,
): string {
  const parts: string[] = [];
  if (cadence) parts.push(CADENCE_LABELS[cadence]);
  if (typeof priceCents === 'number') parts.push(formatUsdCentsPlain(priceCents));
  parts.push(`starting ${formatStartsOnLabel(startsOn)}`);
  let explanation = parts.join(', ');
  if (tz.usedFallback) {
    explanation += ` (assumed ${tz.timezone} — tenant timezone unset)`;
  }
  return explanation;
}

export class CreateServiceAgreementTaskHandler implements TaskHandler {
  readonly taskType = 'create_service_agreement' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
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

    const cadence = ee.serviceAgreementCadence;
    const rrule = cadence ? CADENCE_TO_RRULE[cadence] : undefined;
    if (rrule) {
      payload.recurrenceRule = rrule;
    } else {
      missing.push('recurrenceRule');
    }

    let priceCents: number | undefined;
    if (typeof ee.amount === 'number' && ee.amount > 0) {
      priceCents = Math.round(ee.amount);
      payload.priceCents = priceCents;
    } else {
      missing.push('priceCents');
    }

    const tz = resolveTenantTimezone(context);
    const now = context.now ?? new Date();
    const spokenStartsOn =
      typeof ee.serviceAgreementStartsOn === 'string' ? ee.serviceAgreementStartsOn.trim() : '';
    const startsOn =
      (spokenStartsOn.length > 0 ? parseSpokenStartsOn(spokenStartsOn, tz.timezone, now) : undefined) ??
      firstOfNextMonth(now, tz.timezone);
    payload.startsOn = startsOn;

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
        inputFor(context, this.taskType, payload, missing, {
          sourceContext: extraSourceContext,
          explanation: buildExplanation(cadence, priceCents, startsOn, tz),
        }),
      ),
      taskType: this.taskType,
    };
  }
}
