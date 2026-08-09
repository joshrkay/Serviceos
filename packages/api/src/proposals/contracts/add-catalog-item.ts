import { z } from 'zod';
import type { CatalogUnit } from '../../catalog/catalog-item';

/**
 * add_catalog_item proposal payload (Task 12, 2026-08-07 tradesperson plan).
 *
 * Owner adds a NEW price-book entry by voice ("Add a catalog item: smart
 * thermostat install, 385"). Capture-class — the create-side mirror of
 * update_catalog_item: a config change that only shapes FUTURE drafts
 * (which are themselves reviewed); no money moves at creation, no customer
 * is contacted, and it's reversible (the item can be archived from the
 * Catalog screen).
 *
 * `name` is required, non-empty AFTER TRIMMING (`.trim().min(1)` — Task 9's
 * review found a whitespace-only string passing a draft-time gate that
 * lacked `.trim()` and only throwing later at execution; this is the same
 * class of bug that ordering avoids).
 *
 * ── 0-price legality: contract and drafting gate AGREE ───────────────────
 *
 * `unitPriceCents` is required, a non-negative integer — ZERO IS LEGAL. A
 * free/comp price-book line ("free estimate", "no-charge warranty
 * inspection") is a real, common catalog entry for a tradesperson. This is
 * a DELIBERATE divergence from `create-service-agreement.ts`'s stricter,
 * POSITIVE-only voice gate for a RECURRING plan price: a stated $0
 * RECURRING charge is inherently suspicious (why sign up for a $0/period
 * plan?), so that task chose to treat a spoken zero as indistinguishable
 * from "no price stated". A one-time price-book SKU carries no such
 * suspicion — "free estimate" is a real marketing line many trades
 * advertise. `AddCatalogItemTaskHandler` (ai/tasks/add-catalog-item-task.ts)
 * mirrors this EXACT `>= 0` boundary at draft time — a spoken 0 drafts
 * ungated, only a genuinely ABSENT/negative/non-numeric/over-ceiling price
 * gates — so contract and drafting gate can never disagree the way Task
 * 9's review found for a different type (the contract accepted 0 while the
 * task refused to draft on 0, and two passing tests locked the
 * contradiction in without either side ever exercising the disagreement).
 *
 * A sanity ceiling (`MAX_UNIT_PRICE_CENTS`, $100,000 — mirrors
 * create-service-agreement.ts's identical `PRICE_CENTS_SANITY_CEILING`) is
 * a backstop against a misheard "290 thousand" style figure, NOT a real
 * product limit. It is NOT imported from a shared constant: catalog-item.ts
 * / shared/contracts.ts's `createCatalogItemSchema` place no upper bound on
 * `unitPriceCents` at the domain/HTTP layer, so this bound has no
 * counterpart to drift from — the "one shared constant" lesson (Task 8's
 * `MAX_QUANTITY`) only applies where the same cap is enforced on both
 * sides, which is not the case here.
 *
 * `description` is optional, trimmed, and — like `name` — rejects
 * whitespace-only input (`.trim().min(1)` again) for the same reason.
 *
 * `unit` is optional. Its 5-token vocabulary (`CATALOG_UNITS`) mirrors
 * `catalog-item.ts`'s `CatalogUnit` type (checked at compile time via the
 * `satisfies` assertion below) but is NOT imported from a shared runtime
 * array — `catalog-item.ts` exports no such array (only the bare TS type),
 * and duplicating a small, stable enum literal here mirrors the
 * codebase's existing convention for this exact class of cross-layer
 * vocabulary (e.g. `EXPENSE_CATEGORIES` is independently declared in both
 * `expenses/expense.ts` and `ai/orchestration/intent-classifier.ts`).
 * `AddCatalogItemExecutionHandler` defaults `unit` to `'each'` at
 * execution time when unspoken — see that handler's doc comment.
 */

// Mirrors catalog-item.ts's CatalogUnit vocabulary; `satisfies` fails the
// build if that type's literal set ever changes without this array
// following — see the module doc comment for why this isn't a runtime
// import instead.
export const CATALOG_UNITS = ['each', 'hour', 'sq ft', 'per lb', 'per gal'] as const satisfies readonly CatalogUnit[];

// Backstop against a misheard huge figure, not a real product limit —
// mirrors create-service-agreement.ts's PRICE_CENTS_SANITY_CEILING ($100k).
export const MAX_UNIT_PRICE_CENTS = 100_000_00; // $100,000

export const addCatalogItemPayloadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  unitPriceCents: z.number().int().nonnegative().max(MAX_UNIT_PRICE_CENTS),
  description: z.string().trim().min(1).max(1000).optional(),
  unit: z.enum(CATALOG_UNITS).optional(),
});

export type AddCatalogItemPayload = z.infer<typeof addCatalogItemPayloadSchema>;
