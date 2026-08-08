/**
 * Tradesperson wave 1, Task 6 — CreateChangeOrderTaskHandler (drafting leg).
 *
 * Standalone file per the quality-review ratchet (mirrors complaint-task.ts /
 * brand-voice-task.ts / apply-credit-task.ts) — voice-extended-tasks.ts is at
 * capacity, and new drafting handlers land in their own file from here on.
 *
 * `create_change_order` mints a NEW estimate pinned to an EXISTING job — a
 * mid-job scope change the customer asked for ("The Garcias want a second
 * zone — change order for 1800"), not a fresh bid. Capture-class (no money
 * moves at creation; sending the resulting estimate is a later, separate
 * comms-class step), same posture as `draft_estimate`.
 *
 * `jobId` resolution mirrors `UpdateJobTaskHandler` (job-edit-task.ts)
 * exactly: `create_change_order` joins `JOB_REF_INTENTS`
 * (ai/agents/customer-calling/entity-resolution.ts), so by the time this
 * handler runs the voice-action-router's entity resolver has already
 * resolved the spoken jobReference to a VERIFIED jobId and stamped it onto
 * `context.existingEntities.jobId` — a ROUTER-INJECTED id, never an
 * LLM-extracted field, so (like `apply_credit`'s invoiceId /
 * `UpdateJobTaskHandler`'s jobId) it is deliberately NOT added to
 * `ExtractedEntities` or the classifier's JSON template/parse allowlist.
 * `jobId` is REQUIRED on the contract — that's what makes this a change
 * order and not `draft_estimate` (whose jobId is optional). An unresolved
 * reference gates the proposal (`missingFields: ['jobId']`): a change order
 * without its job is meaningless.
 *
 * The added-work description (`changeOrderDescription`) becomes the change
 * order's title (`changeOrderTitle`, contracts/create-change-order.ts) and
 * the single line item's description; a stated amount (`amount`, integer
 * cents) becomes that line's `unitPriceCents`. The line is then run through
 * `groundLineItemPricing` (ai/resolution/catalog-resolver.ts) — the SAME
 * tenant-catalog grounding pass `EstimateTaskHandler`/`InvoiceTaskHandler`
 * use — so a catalog match overrides (or fills in) the price. No LLM call:
 * unlike `draft_estimate`, the added work is a single named line, not a
 * multi-line quote the model needs to structure.
 *
 * Quality-review fix — a line that comes out of grounding with NO
 * resolvable `unitPriceCents` (no spoken amount AND no catalog match — the
 * classifier's own canonical example, "Customer added three more outlets —
 * write it up", has no stated amount) used to draft UNGATED
 * (`groundLineItemPricing` only ever populates `missingFields` for an
 * AMBIGUOUS catalog match, never for a simply-unpriced line) and then fail
 * post-approval at `CreateChangeOrderExecutionHandler`
 * (`normalizeDraftLineItems` refuses to persist a priceless line). Gated
 * explicitly here instead, same idiom `applyCatalogPricing` uses for an
 * ambiguous match: `missingFields: ['lineItems[0].unitPriceCents']`.
 *
 * Quality-review fix — `payload._meta` (the RV-007 Confidence Marker
 * envelope, contracts.ts) is validated at the SHARED payload-contract choke
 * point for every proposal type, and `overallConfidence` is a REQUIRED
 * field on it whenever `_meta` is present — omitting it (the original bug)
 * produced a payload that failed `assertValidProposalPayload` the moment an
 * operator tried to edit or approve it from the review card. `_meta` is now
 * ALWAYS built with `overallConfidence` set (mirrors every other catalog-
 * grounded drafting handler — estimate-task.ts, invoice-task.ts,
 * mms-estimate-task.ts — which all do the same
 * `catalogOutcome.anyUncatalogued ? 'low' : ...` shape), and the mandatory
 * `assertValidProposalPayload` gate (contracts.ts's own doc comment: every
 * production AI-drafting task handler MUST call it before `createProposal`)
 * is applied as a backstop so a future contract change can never again ship
 * an invalid payload silently.
 *
 * An uncatalogued price is never numerically capped (no `confidenceScore`
 * exists here — there is no LLM call to produce one): the safety mechanism
 * is that this handler deliberately omits `sourceTrustTier`, so
 * `decideInitialStatus`'s only auto-approve branch (which requires
 * `sourceTrustTier === 'autonomous'`) is never reached at ANY confidence —
 * mirrors `LogExpenseTaskHandler`/`ConfirmAppointmentTaskHandler`'s posture
 * for a deterministic, non-LLM capture handler. `overallConfidence: 'low'`
 * on an uncatalogued line is therefore purely a REVIEW-CARD signal (never a
 * numeric auto-approve gate) — RBAC-wise this type is dispatcher-approvable,
 * same as `draft_estimate` (it is NOT in `CONFIG_WRITING_PROPOSAL_TYPES`,
 * proposals/actions.ts).
 */
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { assertValidProposalPayload } from '../../proposals/contracts';
import type { ProposalConfidenceMeta } from '../../proposals/contracts';
import { changeOrderTitle } from '../../proposals/contracts/create-change-order';
import type { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import type { ExtractedEntities } from '../orchestration/intent-classifier';
import { CatalogItemRepository } from '../../catalog/catalog-item';
import {
  CatalogPricingOutcome,
  groundLineItemPricing,
  lineItemConfidenceSignals,
} from '../resolution/catalog-resolver';
import { entitiesFrom, inputFor } from './task-input';

/**
 * Pull the Zod paths off a `ValidationError` thrown by
 * `assertValidProposalPayload` (it stores them as `details.errors`, each
 * formatted `"<path>: <message>"`). Mirrors `estimate-task.ts`'s
 * `contractErrorsFrom` (not exported from there, so duplicated here).
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
    fields.add(head.length > 0 ? head : 'lineItems');
  }
  return [...fields];
}

export class CreateChangeOrderTaskHandler implements TaskHandler {
  readonly taskType = 'create_change_order' as const;

  /**
   * P22 catalog grounding. When present, the drafted line item is resolved
   * against the tenant's active catalog and a match's price overrides the
   * spoken amount. Optional so callers/tests without a catalog repo keep
   * working (the line then rides the spoken amount as-is, uncatalogued).
   */
  private readonly catalogRepo?: CatalogItemRepository;

  constructor(catalogRepo?: CatalogItemRepository) {
    this.catalogRepo = catalogRepo;
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context) as ExtractedEntities & { jobId?: string };
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    if (typeof ee.jobId === 'string' && ee.jobId.length > 0) {
      payload.jobId = ee.jobId;
    } else {
      missing.push('jobId');
    }

    const description =
      typeof ee.changeOrderDescription === 'string' && ee.changeOrderDescription.trim().length > 0
        ? ee.changeOrderDescription.trim()
        : undefined;

    payload.title = changeOrderTitle(description);

    const lineItem: Record<string, unknown> = {
      description: description ?? 'Additional work',
      quantity: 1,
    };
    if (typeof ee.amount === 'number' && ee.amount > 0) {
      lineItem.unitPriceCents = Math.round(ee.amount);
    }

    // Always resolve to an outcome — even with no catalog wired, an empty
    // catalog, or a read error, the line is treated as uncatalogued so a
    // human reviews an AI/spoken price rather than it silently auto-approving.
    const catalogOutcome: CatalogPricingOutcome = await groundLineItemPricing(
      [lineItem],
      'unitPriceCents',
      this.catalogRepo ? () => this.catalogRepo!.listByTenant(context.tenantId) : null,
    );
    payload.lineItems = catalogOutcome.lineItems;

    // Quality-review fix — a line with NO resolvable price (no spoken
    // amount, no catalog match) must gate: groundLineItemPricing's own
    // missingFields only ever covers an AMBIGUOUS catalog match, never a
    // simply-unpriced line, so without this check the proposal drafted
    // ungated and failed post-approval at execution instead.
    const groundedLine = (payload.lineItems as Array<Record<string, unknown>>)[0] as
      | Record<string, unknown>
      | undefined;
    if (typeof groundedLine?.unitPriceCents !== 'number') {
      missing.push('lineItems[0].unitPriceCents');
    }

    const confidenceFactors: string[] = [];
    if (catalogOutcome.anyCatalogPriced) confidenceFactors.push('catalog_priced');
    if (catalogOutcome.anyUncatalogued) confidenceFactors.push('uncatalogued_line_item');

    // RV-007 — Confidence Marker `_meta`, same shape every other catalog-
    // grounded drafting handler builds (estimate-task.ts / invoice-task.ts /
    // mms-estimate-task.ts): `overallConfidence` is ALWAYS present (it is a
    // REQUIRED field on `_meta` whenever `_meta` is set — see the module doc
    // comment above for the bug this fixes), and `fieldConfidence`/`markers`
    // translate the catalog resolver's pricingSource outcomes for the review
    // card (uncatalogued/ambiguous lines → 'low' + a marker) — no new
    // confidence computation.
    const signals = lineItemConfidenceSignals(
      payload.lineItems as Array<Record<string, unknown>>,
      'unitPriceCents',
    );
    const meta: ProposalConfidenceMeta = {
      overallConfidence: catalogOutcome.anyUncatalogued ? 'low' : 'high',
      ...(Object.keys(signals.fieldConfidence).length > 0
        ? { fieldConfidence: signals.fieldConfidence }
        : {}),
      ...(signals.markers.length > 0 ? { markers: signals.markers } : {}),
    };
    payload._meta = meta;

    // Extra sourceContext entries layered on top of inputFor's
    // baseSourceContext (conversationId) — mirrors the `extraSourceContext`
    // idiom voice-extended-tasks.ts's SendInvoiceTaskHandler uses: left
    // `undefined` (never an empty object) when there's nothing to add, so
    // inputFor's own conversationId-only-or-undefined collapse is preserved.
    let extraSourceContext: Record<string, unknown> | undefined;
    if (catalogOutcome.catalogResolution) {
      extraSourceContext = { catalogResolution: catalogOutcome.catalogResolution };
    }

    const allMissing = [...catalogOutcome.missingFields, ...missing];

    // P2-002 — the MANDATORY payload contract gate (proposals/contracts.ts
    // documents assertValidProposalPayload as required before every
    // createProposal on an AI-authored path). Enforced as a hard block
    // rather than an exception: a payload that fails here is stamped into
    // missingFields (forces 'draft' via decideInitialStatus) instead of
    // shipping a proposal that throws ValidationError at the first
    // edit/approve touch — the exact failure mode the missing
    // `overallConfidence` bug produced before this gate existed.
    let payloadContractErrors: string[] | undefined;
    try {
      assertValidProposalPayload(this.taskType, payload);
    } catch (err) {
      payloadContractErrors = contractErrorsFrom(err);
      for (const field of contractGapFields(payloadContractErrors)) {
        if (!allMissing.includes(field)) allMissing.push(field);
      }
    }
    if (payloadContractErrors) {
      extraSourceContext = { ...(extraSourceContext ?? {}), payloadContractErrors };
    }

    const input: CreateProposalInput = {
      ...inputFor(context, this.taskType, payload, allMissing, {
        sourceContext: extraSourceContext,
      }),
      confidenceFactors: confidenceFactors.length > 0 ? confidenceFactors : undefined,
    };

    return { proposal: createProposal(input), taskType: this.taskType };
  }
}
