/**
 * Task 12 (2026-08-07 tradesperson plan) — AddCatalogItemTaskHandler
 * (drafting leg).
 *
 * Standalone file per the house ratchet (mirrors apply-credit-task.ts /
 * create-change-order-task.ts / create-service-agreement-task.ts /
 * add-material-task.ts) — new drafting handlers land in their own file,
 * not voice-extended-tasks.ts.
 *
 * `add_catalog_item` lets an owner add a NEW price-book entry by voice
 * ("Add a catalog item: smart thermostat install, 385"). Capture-class —
 * the create-side mirror of `update_catalog_item`: a config change that
 * only shapes FUTURE drafts (which are themselves reviewed); no money
 * moves at creation, no customer is contacted, and it's reversible
 * (archive the item from the Catalog screen).
 *
 * ── Extraction seams: REUSES Task 2's fields, does not mint new ones for
 * name/description/price ──────────────────────────────────────────────────
 *
 * `catalogItemNewName` / `catalogItemNewDescription` / `unitPriceCents`
 * already exist on `ExtractedEntities` (Task 2, `update_catalog_item`).
 * Their meaning generalizes cleanly to a CREATE: "the NEW name"/"the NEW
 * description" is exactly what's true of a brand-new item's only name —
 * there is no prior value to rename FROM the way `update_catalog_item`'s
 * usage implies, but the shape and intent (a spoken string that becomes
 * the item's persisted name/description) are identical. Minting a second
 * `catalogItemName` field for the same concept would be pure duplication
 * on the shared, cross-intent entity bag. There is no field-presence-
 * hijack risk the way `log_expense`/`log_mileage` had (Task 11's
 * `TaskContext.intent` fix): `add_catalog_item` and `update_catalog_item`
 * dispatch to DIFFERENT drafting handlers and DIFFERENT execution
 * handlers — a stray value on the wrong intent's turn is simply never
 * read by that intent's handler, unlike two intents sharing ONE handler
 * class. `unitPriceCents` is reused as-is; it was never
 * `update_catalog_item`-exclusive in NAME the way `catalogItemNewName` /
 * `catalogItemNewDescription` are (explicitly qualified "New").
 *
 * `catalogItemUnit` (`CatalogUnit`: 'each'|'hour'|'sq ft'|'per lb'|
 * 'per gal') is a genuinely NEW field — no existing `ExtractedEntities`
 * field carries a catalog unit of measure. Validated against
 * `CATALOG_UNITS` at the classifier's parse boundary
 * (`ai/orchestration/intent-classifier.ts`), so an out-of-vocabulary value
 * never reaches this handler — the local re-check below is defense in
 * depth for callers of `entitiesFrom` that don't route through that parse
 * function (e.g. a hand-built `existingEntities` bag in a test or a
 * redraft path).
 *
 * ── 0-price legality: contract and gate AGREE ────────────────────────────
 *
 * `unitPriceCents: 0` is a LEGITIMATE, common price-book entry (a free
 * estimate, a no-charge warranty inspection) — see
 * `contracts/add-catalog-item.ts`'s module doc comment for the full
 * reasoning and the deliberate divergence from `create_service_agreement`'s
 * stricter (positive-only) voice gate. This handler drafts ungated on a
 * spoken `unitPriceCents === 0` — only a genuinely ABSENT/negative/
 * non-numeric/over-ceiling price gates — the SAME `>= 0` boundary the Zod
 * contract enforces, so the two can never disagree the way a prior task's
 * review found for a different type (contract accepted 0, the task
 * refused to draft on 0, and two passing tests locked the contradiction
 * in without either side ever exercising the disagreement).
 *
 * ── unit/category defaults live at EXECUTION time, not here ──────────────
 *
 * `CatalogItem.unit`/`.category` are BOTH required at the domain layer
 * (`catalog-item.ts`'s `CreateCatalogItemInput`) but this intent's
 * taxonomy has no category extraction seam at all (a v1 scope decision —
 * category is a business-taxonomy choice ["Labor"/"Parts"/"Materials"] a
 * tradesperson rarely states aloud alongside a price) and `unit` is only
 * SOMETIMES spoken. `AddCatalogItemExecutionHandler` supplies both
 * defaults at execution time (category: 'Labor', unit: 'each' — see that
 * handler's doc comment); this drafting task passes `unit` through only
 * when spoken and OMITS it otherwise, rather than guessing a default
 * here too, so the review card only ever shows what the operator
 * actually said.
 *
 * ── Never auto-approves ───────────────────────────────────────────────────
 *
 * Deliberately omits `sourceTrustTier` (`inputFor`'s default) — same
 * posture as `update_catalog_item` / `create_change_order` /
 * `create_service_agreement` / `add_material`.
 */
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { assertValidProposalPayload } from '../../proposals/contracts';
import { CATALOG_UNITS } from '../../proposals/contracts/add-catalog-item';
import type { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { entitiesFrom, inputFor } from './task-input';

// Mirrors contracts/add-catalog-item.ts's MAX_UNIT_PRICE_CENTS — see that
// module's doc comment for why this sanity ceiling isn't a domain-layer
// shared constant.
const MAX_UNIT_PRICE_CENTS = 100_000_00; // $100,000

/**
 * Pull the Zod paths off a `ValidationError` thrown by
 * `assertValidProposalPayload`. Mirrors `add-material-task.ts`'s
 * `contractErrorsFrom` (not exported from there, so duplicated here — same
 * house pattern every standalone drafting task file uses).
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
    fields.add(head.length > 0 ? head : 'name');
  }
  return [...fields];
}

export class AddCatalogItemTaskHandler implements TaskHandler {
  readonly taskType = 'add_catalog_item' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    const name = typeof ee.catalogItemNewName === 'string' ? ee.catalogItemNewName.trim() : '';
    if (name) {
      payload.name = name;
    } else {
      missing.push('name');
    }

    // Zero is a LEGAL price (see class doc comment) — only a genuinely
    // absent/negative/non-numeric/over-ceiling value gates.
    const price = ee.unitPriceCents;
    const validPrice =
      typeof price === 'number' &&
      Number.isFinite(price) &&
      price >= 0 &&
      price <= MAX_UNIT_PRICE_CENTS;
    if (validPrice) {
      payload.unitPriceCents = Math.round(price as number);
    } else {
      missing.push('unitPriceCents');
    }

    if (
      typeof ee.catalogItemNewDescription === 'string' &&
      ee.catalogItemNewDescription.trim().length > 0
    ) {
      payload.description = ee.catalogItemNewDescription.trim();
    }

    // Defense in depth — see class doc comment on why this re-checks the
    // classifier's own CATALOG_UNITS allowlist rather than trusting the
    // type alone.
    if (
      typeof ee.catalogItemUnit === 'string' &&
      (CATALOG_UNITS as readonly string[]).includes(ee.catalogItemUnit)
    ) {
      payload.unit = ee.catalogItemUnit;
    }

    // P2-002 — the MANDATORY payload contract gate (proposals/contracts.ts
    // documents assertValidProposalPayload as required before every
    // createProposal on an AI-authored path). A backstop, not the primary
    // gate: name/unitPriceCents are already flat-gated by hand above, so
    // this mainly catches shape issues the hand-written checks don't (an
    // over-length name, a malformed description).
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
