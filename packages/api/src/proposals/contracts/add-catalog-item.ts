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
 * product limit. `catalog-item.ts` / `shared/contracts.ts`'s
 * `createCatalogItemSchema` place no upper bound on `unitPriceCents` at
 * the domain/HTTP layer at all — this contract's own ceiling is the only
 * bound anywhere in the stack, which is fine here because this intent has
 * exactly ONE producer (voice), so a contract-level ceiling can never
 * disagree with a drafting-time gate.
 *
 * `update_catalog_item` (`contracts/update-catalog-item.ts`) writes
 * `proposedUnitPriceCents` onto the SAME `catalog_items.unit_price_cents`
 * column from the SAME spoken `unitPriceCents` field, and briefly imported
 * this same `MAX_UNIT_PRICE_CENTS` onto ITS contract too (quality-review
 * fix, "I4") to close exactly that CREATE/EDIT divergence for a misheard
 * figure. That placement was wrong and was reverted (follow-up fix,
 * 2026-08-09): unlike `add_catalog_item`, `update_catalog_item` has TWO
 * producers — voice AND the correction-repetition loop — and the non-voice
 * one legitimately carries a never-spoken, human-verified price the
 * misheard-figure backstop was never meant to police. `MAX_UNIT_PRICE_CENTS`
 * is still exported from here and imported into
 * `ai/tasks/voice-extended-tasks.ts`'s `UpdateCatalogItemTaskHandler`
 * drafting gate — the ONE place in that sibling that ever writes a
 * genuinely spoken value — rather than onto its shared contract.
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
// Also imported by ai/tasks/voice-extended-tasks.ts's
// UpdateCatalogItemTaskHandler drafting gate (NOT that sibling's contract
// — see this file's module doc comment for why the contract-level
// placement was reverted, follow-up fix 2026-08-09): both intents' voice
// drafting paths write the SAME catalog_items.unit_price_cents column from
// the SAME spoken unitPriceCents field, so the misheard-figure ceiling
// must still agree at the point each one trusts a spoken value.
export const MAX_UNIT_PRICE_CENTS = 100_000_00; // $100,000

export const addCatalogItemPayloadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  unitPriceCents: z.number().int().nonnegative().max(MAX_UNIT_PRICE_CENTS),
  description: z.string().trim().min(1).max(1000).optional(),
  unit: z.enum(CATALOG_UNITS).optional(),
});

export type AddCatalogItemPayload = z.infer<typeof addCatalogItemPayloadSchema>;
