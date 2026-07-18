# feat: Visual proposals — equipment photos on estimate line items (EE-4)

**Created:** 2026-07-17
**Depth:** Deep
**Status:** plan

## Summary

Let owners attach a photo to a catalog (price-book) item and show that photo
beside the matching line on the customer-facing estimate. Images flow onto
**AI-drafted** estimates automatically (the catalog resolver already stamps
catalog-derived fields onto grounded lines) as well as manually-authored ones.
The image is a **frozen snapshot** stamped on the estimate line at draft/create
time, stored as a stable `image_file_id` into the existing `files` table and
resolved to a short-lived signed URL only at the public edge. Ships with PostHog
instrumentation and end-to-end certification on both the UI and AI paths.

## Problem Frame

Visual proposals close better — a customer sees the actual equipment they're
buying. Today catalog items carry no image, so neither manual nor AI-drafted
estimates can show one. EE-1 already made the AI draft catalog-grounded
tiers/add-ons; adding images to the same grounding stamp makes every AI draft
visual for free. The customer approval page (`EstimateApprovalPage`) and the
price book (`PriceBookPage`) are the surfaces owners and customers touch.

## Requirements

- **R1.** An owner can attach/replace/remove a photo on a catalog item in the
  price book UI, reusing the existing presigned-upload storage (no new storage).
- **R2.** A manually-authored estimate line that picks a catalog item with a
  photo carries that photo.
- **R3.** An **AI-drafted** estimate line (voice/chat `draft_estimate` and
  MMS/photo) that grounds to a catalog item with a photo carries that photo —
  through to the persisted estimate and the customer view. UI and AI paths yield
  the **same** image for the same catalog item (parity).
- **R4.** The customer-facing estimate shows a thumbnail beside each line that
  has an image; lines/estimates without images render exactly as today.
- **R5.** The image is **frozen at quote time** — later editing/archiving the
  catalog item's photo does not change or blank an already-sent/accepted
  estimate.
- **R6.** No signed URL is ever persisted; the public view mints a fresh,
  tenant-scoped signed URL per read. A foreign/tampered file id can never mint a
  URL to another tenant's object.
- **R7.** PostHog measures adoption and impact: images present on created
  estimates, images present on **accepted** estimates, and price-book photo
  adoption.
- **R8.** Certified working end-to-end on BOTH the UI path and the AI/voice path
  (not only unit tests).
- **R9.** Mobile/public UI invariants hold: thumbnail can't break the ≤320px
  line grid; any tap target ≥44px; graceful no-image degrade.

## Key Technical Decisions

- **Store `image_file_id` (UUID → `files`), denormalized onto the line — not a
  URL, not a live catalog lookup.** — The estimate is a frozen, version-locked
  quote; `description`/`unitPrice`/`pricingSource` are already stamped onto the
  line at draft time. An image is part of what the customer agrees to, so it
  freezes on the same axis. A file id is stable (a signed URL would rot in the
  DB); "replace a catalog photo" = upload a new file + repoint
  `catalog_items.image_file_id`, leaving past estimate lines pointing at the
  original file. (Alternatives: **live resolve from `catalogItemId` at view
  time** — rejected: `estimate_line_items` has NO `catalog_item_id` column
  (it's dropped before persistence), it drifts after send, and it can't show an
  image on a manual/uncatalogued line; **persist a signed URL** — rejected: URLs
  expire and would rot on a long-lived public page.)
- **Two columns of the same kind:** `catalog_items.image_file_id` (source of
  truth) and `estimate_line_items.image_file_id` (frozen snapshot). Both
  nullable; both resolve to signed URLs only at the edge.
- **AI parity rides the existing stamp.** `applyCatalogPricing` already copies
  catalog fields onto grounded lines; add `imageFileId` there and the AI path
  inherits images with no handler changes. The load-bearing risk is *field
  survival*: the proposal Zod `lineItemSchema` must allow it and
  `normalizeDraftLineItems` (the executor whitelist) must forward it, or the
  image silently vanishes on the AI path only.
- **PostHog: props on existing events, not new event names** — keeps the
  deny-by-default mapper's exhaustiveness guard intact; all props are
  counts/booleans via `pickMeta` (never URLs or file ids — PII/secret hygiene).

## Scope Boundaries

**In scope:** catalog image field + upload UI; frozen image_file_id on estimate
lines (AI + manual); tenant-scoped signed-URL resolution on the public view;
customer thumbnail render (+ authenticated detail + client PDF parity); PostHog
props; dual-path verification.

**Non-goals:**
- New storage/upload infrastructure (reuse P0-010 `files`).
- Per-line ad-hoc customer photos unrelated to the catalog (job photos already
  cover site photos) — except the small optional hook in U5.
- Image editing/cropping/AI generation.
- Multiple images per item (one hero image per catalog item in v1).
- (Originally deferred) EE-1's tier/selection PostHog backfill — now that EE-1
  is merged to `main` and this branch is rebased onto it, this is **folded into
  U8** rather than excluded.

### Deferred to follow-up work
- **Operator-resolved ambiguous lines** (`proposals/resolve-line.ts`) getting an
  image: needs `imageFileId` added to the recorded candidate set in
  `applyCatalogPricing`'s `catalogResolution` and stamped on pick. The primary
  AI win (exact/high grounding) needs no candidate plumbing; ambiguous-pick
  parity is a small follow-on (noted in U4).

## Repository invariants touched

- **Integer cents** — untouched; `image_file_id` is a UUID, no money math.
- **tenant_id + RLS** — new columns live on tenant-scoped tables; the public
  view resolves `image_file_id` **scoped to `estimate.tenantId`** (R6).
- **Audit events** — image adds ride existing mutation audit metadata
  (catalog create/update, estimate create, approve); no new mutation paths.
- **Catalog grounding** — image stamped in the same `'catalog'` branch as
  price; only grounded lines get a catalog image (uncatalogued lines get none),
  consistent with the money-grounding invariant.
- **Zod proposals / human approval** — `imageFileId` added to the proposal
  `lineItemSchema`; approval gate unchanged.
- **Migrations** — two idempotent `ADD COLUMN IF NOT EXISTS … UUID` migrations
  in `packages/api/src/db/schema.ts` (next number `254`), mirroring `179`.

## High-Level Technical Design

```
Price book (owner)                     AI draft (voice / MMS)
  PriceBookPage --upload--> files        estimate-task / mms-estimate-task
  catalog_items.image_file_id                     |
        |                                 groundLineItemPricing
        |  (manual pick: CatalogPicker)          |
        +------------------+            applyCatalogPricing  <-- stamp imageFileId
                           |                      |
                           v            proposal lineItemSchema (allow imageFileId)
                    estimate line                 |
             image_file_id (frozen)      normalizeDraftLineItems (FORWARD imageFileId)
                           |                      |
                           v                      v
                    pg-estimate.insertLineItems (image_file_id column)
                           |
                           v
        public-estimate-service.toView
          resolve image_file_id --(tenant-scoped)--> signed URL
                           |
                           v
             EstimateApprovalPage thumbnail (mobile-safe)
```

## Implementation Units

### U1. Catalog item `image_file_id` (source of truth)
- **Goal:** Add a nullable `image_file_id` to catalog items end to end (domain,
  DB, contract, API response).
- **Requirements:** R1 (enables), R3/R5 (source).
- **Dependencies:** none.
- **Files:** `packages/api/src/db/schema.ts` (migration `254_catalog_items_image_file_id`), `packages/api/src/catalog/catalog-item.ts`, `packages/api/src/catalog/pg-catalog-item.ts`, `packages/api/src/shared/contracts.ts` (`createCatalogItemSchema`/`updateCatalogItemSchema`), `packages/api/src/routes/catalog-items.ts` (`toApiModel`), `packages/api/test/catalog/*.test.ts`, `packages/api/test/integration/catalog.test.ts`.
- **Approach:** `ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS image_file_id UUID;` (mirror migration `179`). Add `imageFileId?: string` to `CatalogItem`, create/update inputs, `createCatalogItem`, and the InMemory repo. `pg-catalog-item` `mapRow` reads `row.image_file_id`, `create` adds the column+param, `update` adds an `if (updates.imageFileId !== undefined)` set-clause. `toApiModel` exposes `imageFileId`. Optional `imageFileId: z.string().uuid().optional()` on both schemas.
- **Patterns to follow:** the `pricing_source` add (migration 179) and the existing per-field `update` set-clause style in `pg-catalog-item.ts`.
- **Test scenarios:**
  - Happy: create/update a catalog item with `imageFileId`; round-trips through the repo and `toApiModel`.
  - Edge: null/absent `imageFileId` is valid and default.
  - Integration (Docker): the real `catalog_items.image_file_id` column round-trips (mocked pool wouldn't prove the column exists — see `docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md`).
- **Verification:** a catalog item persists and reads back its `imageFileId` against real Postgres.

### U2. Catalog image upload UI (price book)
- **Goal:** Owner attaches/replaces/removes a catalog item photo, reusing the presigned-upload flow.
- **Requirements:** R1.
- **Dependencies:** U1.
- **Files:** `packages/web/src/components/settings/PriceBookPage.tsx`, `packages/web/src/api/*` (reuse the presign helper pattern from `packages/web/src/api/job-photos.ts`), `packages/web/src/components/settings/PriceBookPage.test.tsx`.
- **Approach:** In the create/edit slide-over, add an image control that presigns (`POST /api/files/upload-url` with `entityType: 'catalog_item'`), PUTs the file to the returned URL with a **raw `fetch`** (not `apiFetch`, so the Bearer header doesn't break the S3 signature — mirror `uploadJobPhoto`), then stores the returned `fileId` on the item at save. Render a thumbnail in the list. Camera-aware `<input type="file" accept="image/*">` mirroring `JobPhotoUploader`.
- **Patterns to follow:** `packages/web/src/api/job-photos.ts` `uploadJobPhoto`, `packages/web/src/components/jobs/JobPhotoUploader.tsx` (pluggable `uploader` prop for tests).
- **Test scenarios:**
  - Happy: pick a file → presign called → PUT called → item saved with `imageFileId`; thumbnail shows.
  - Remove: clearing the image nulls `imageFileId`.
  - Error: a failed PUT surfaces an error and doesn't save a dangling id.
  - Mobile: control ≥44px tap target; no 320px overflow (jsdom class-contract).
- **Verification:** in the price book, attaching a photo persists an `imageFileId` and shows a thumbnail.

### U3. Estimate line `image_file_id` (frozen snapshot column)
- **Goal:** Persist and read a nullable `image_file_id` on estimate line items.
- **Requirements:** R2, R3, R5 (persistence).
- **Dependencies:** none (independent of U1).
- **Files:** `packages/api/src/db/schema.ts` (migration `255_estimate_line_items_image_file_id`), `packages/api/src/shared/billing-engine.ts` (`LineItem`), `packages/shared/src/contracts/money.ts` (`lineItemSchema`, kept in lockstep by `money.test.ts`), `packages/api/src/shared/document-row-mappers.ts` (`mapLineItemRow`), `packages/api/src/estimates/pg-estimate.ts` (`insertLineItems`), `packages/api/test/shared/money.test.ts`, `packages/api/test/integration/estimates.test.ts`.
- **Approach:** `ALTER TABLE estimate_line_items ADD COLUMN IF NOT EXISTS image_file_id UUID;`. Add `imageFileId?: string` to `LineItem` and `lineItemSchema` (mirror the optional `pricingSource`). `mapLineItemRow` adds `imageFileId: row.image_file_id ?? undefined` (invoice_line_items has no such column → `undefined` there, untouched). `insertLineItems` adds the column + `item.imageFileId ?? null`.
- **Patterns to follow:** how `pricing_source` was threaded (migration 179 + `mapLineItemRow` line for `pricing_source`).
- **Test scenarios:**
  - Happy: a line with `imageFileId` persists and reads back (integration, real Postgres — pins the column).
  - Edge: absent `imageFileId` → `undefined` on read; invoice lines unaffected.
  - Contract: `money.test.ts` lockstep passes with the new optional field.
- **Verification:** an estimate line round-trips its `imageFileId` through the pg repo.

### U4. AI-path stamping + field survival (parity core)
- **Goal:** AI-grounded lines carry the catalog image through the proposal into the persisted estimate.
- **Requirements:** R3.
- **Dependencies:** U1, U3.
- **Files:** `packages/api/src/ai/resolution/catalog-resolver.ts` (`applyCatalogPricing`), `packages/api/src/proposals/contracts.ts` (`lineItemSchema`), `packages/api/src/proposals/execution/handlers.ts` (`normalizeDraftLineItems`), `packages/api/test/ai/resolution/catalog-resolver.test.ts`, `packages/api/test/proposals/execution/handlers-persistence.test.ts`, `packages/api/test/ai/estimate-task.test.ts`.
- **Approach:** In `applyCatalogPricing`'s exact/high (`'catalog'`) branch, add `imageFileId: item.imageFileId` to the stamped line (next to `catalogItemId`/`pricingSource`). Add `imageFileId: z.string().uuid().optional()` to the proposal `lineItemSchema` so it survives `assertValidProposalPayload` (called by the MMS handler). Add `...(typeof li.imageFileId === 'string' ? { imageFileId: li.imageFileId } : {})` to the `normalizeDraftLineItems` whitelist so it isn't dropped between approved payload and persisted line. **Both survival changes are mandatory or the image vanishes on the AI path only.** (Follow-on, deferred: add `imageFileId` to the `catalogResolution` candidate records + stamp in `resolve-line.ts` for operator-resolved ambiguous lines.)
- **Patterns to follow:** the existing catalog-field stamp in `applyCatalogPricing`; the whitelist forwarding of `pricingSource`/`groupKey` in `normalizeDraftLineItems` (and its own comments about `totalCents` being dropped).
- **Test scenarios:**
  - Happy: a drafted line grounding to an image-bearing catalog item is stamped with `imageFileId` (estimate-shaped `unitPrice` fixture).
  - Survival: `normalizeDraftLineItems` forwards `imageFileId`; a persisted estimate line (integration) has `image_file_id` non-null.
  - Negative: an uncatalogued/ambiguous line has no `imageFileId`; a catalog item without an image stamps none.
  - Schema: a proposal payload with `imageFileId` passes `assertValidProposalPayload('draft_estimate', …)`.
- **Verification:** an AI draft that grounds to an image-bearing item persists a line with `image_file_id`.

### U5. Manual-path stamping
- **Goal:** A manually-picked catalog line carries the catalog image.
- **Requirements:** R2.
- **Dependencies:** U1, U3.
- **Files:** `packages/web/src/components/forms/catalogToLineItem.ts`, `packages/web/src/components/forms/CatalogPicker.tsx`, `packages/web/src/components/forms/LineItemEditor.tsx`, matching tests; API list response (`routes/catalog-items.ts` already exposes `imageFileId` from U1).
- **Approach:** Add `imageFileId` to `CatalogPickItem` and thread through `catalogItemToDraft` → `LineItemDraft` → the estimate create/update payload so the picked line carries it. Optional small hook: allow a direct per-line image attach for lines with no catalog link (reusing U2's upload helper).
- **Patterns to follow:** the existing catalog-field threading in `catalogToLineItem.ts`.
- **Test scenarios:**
  - Happy: picking an image-bearing catalog item yields a line draft carrying `imageFileId`.
  - Edge: picking an item without an image carries none.
- **Verification:** a manually-authored estimate line built from an image-bearing catalog item carries `imageFileId`.

### U6. Public view image resolution (tenant-scoped signed URL)
- **Goal:** Resolve each line's `image_file_id` to a fresh, tenant-scoped signed URL on the public estimate view.
- **Requirements:** R4, R6.
- **Dependencies:** U3.
- **Files:** `packages/api/src/estimates/public-estimate-service.ts` (deps + `toView` + `PublicEstimateView`), `packages/api/test/estimates/public-estimate-service.test.ts`, `packages/api/test/integration/estimate-phases.test.ts`.
- **Approach:** Inject `StorageProvider` + `FileRepository` into `PublicEstimateServiceDeps`. In `toView`, batch-resolve each line's `image_file_id` — **validated against `estimate.tenantId`** (a file id belonging to another tenant, or unresolved, yields no image) — to a signed GET URL (prefer the `thumbnailS3Key` variant when present). Add `imageUrl?: string` to `PublicEstimateView.lineItems`. Never persist the URL; mint per read. TTL comfortably longer than a page session (the page's ~15s re-sync poll refreshes it).
- **Patterns to follow:** `packages/api/src/jobs/job-photo-service.ts` hydrating `downloadUrl` via `storage.generateDownloadUrl`.
- **Test scenarios:**
  - Happy: a line with a valid `image_file_id` resolves an `imageUrl`.
  - Security: an `image_file_id` from another tenant resolves to no image (cross-tenant guard) — this is the load-bearing test.
  - Edge: absent id, and an id whose file is missing, both → `imageUrl` absent (no throw).
  - Integration (Docker): resolution against real repos.
- **Verification:** the public view carries a resolvable `imageUrl` for image-bearing lines and never leaks a foreign tenant's file.

### U7. Customer thumbnail render (+ detail + PDF parity)
- **Goal:** Show the thumbnail beside each line on the customer estimate, mobile-safe, with parity in the authenticated detail view and client PDF.
- **Requirements:** R4, R9.
- **Dependencies:** U6.
- **Files:** `packages/web/src/components/customer/EstimateApprovalPage.tsx`, `packages/web/src/lib/estimatePdf.ts`, the authenticated estimate detail component, `EstimateApprovalPage.*.test.tsx`, `e2e/estimate-approval-mobile.spec.ts`.
- **Approach:** Carry `imageUrl` through the page's line re-map (it currently narrows to `{description,qty,rate}` and would drop it) and render a fixed-size thumbnail in the line row within the `grid-cols-[minmax(0,1fr)…]` layout; constrain width so a wide photo can't break the ≤320px grid; if a lightbox opens, its trigger is ≥44px; degrade to no-image without layout shift. Mirror into the authenticated detail view and `estimatePdf.ts` so all three renderings match.
- **Patterns to follow:** the existing line render + the mobile note already in `EstimateApprovalPage` (≤390px handling); the tier/add-on row rendering for placement.
- **Test scenarios:**
  - Happy: a line with `imageUrl` renders a thumbnail; without one renders as today.
  - Mobile: jsdom class-contract (≥44px trigger, no overflow classes) + a Playwright viewport spec at 320px asserting the thumbnail shows and the row doesn't overflow.
  - Parity: PDF/detail render the same image presence.
- **Verification:** the customer page shows the photo at 320px with no horizontal overflow.

### U8. PostHog instrumentation (images + EE-1 tier/selection backfill)
- **Goal:** Measure image adoption/impact AND (folded in per the post-merge
  decision) EE-1's tier/selection adoption/impact — via props on existing
  events.
- **Requirements:** R7 (+ EE-1 measurability, now that EE-1 is on `main`).
- **Dependencies:** U1, U3.
- **Files:** `packages/api/src/estimates/estimate.ts` (estimate.created audit metadata), `packages/api/src/estimates/public-estimate-service.ts` (approve metadata — where `acceptedSelection` is known), `packages/api/src/catalog/catalog-item.ts` (catalog audit metadata), `packages/api/src/analytics/audit-event-mapping.ts`, `packages/api/test/analytics/audit-event-mapping.test.ts`.
- **Approach:** Extend audit metadata + `pickMeta` mappings (props only, no new event names; no URLs/file ids/PII):
  - **Images:** `estimate_created` gets `line_items_with_image` (int) + `line_items_total` (int); `estimate_approved` gets `had_line_item_images` (bool); `catalog_item.created`/`.updated` get `has_image` (bool).
  - **EE-1 tiers (backfill):** `estimate_created` gets `has_tiers` (bool) + `tier_group_count` (int) + `addon_count` (int); `estimate_approved` gets `had_tiers` (bool) + `upsold_above_default` (bool, derived from whether the customer's `acceptedSelection` chose a non-default tier). This is the signal that finally answers "do good-better-best tiers lift close rate / average ticket."
- **Patterns to follow:** existing `pickMeta` mappings for `catalog_item.created` and `public_estimate.approved` in `audit-event-mapping.ts`; the tier/selection data already computed in `createEstimate` (group fields) and `public-estimate-service.approve` (`acceptedSelection`).
- **Test scenarios:**
  - Happy (images): the mapper emits `has_image`/`line_items_with_image`/`had_line_item_images` from audit metadata.
  - Happy (tiers): a tiered estimate emits `has_tiers`/`tier_group_count`; approving a non-default tier emits `upsold_above_default: true`; a flat estimate emits `has_tiers: false`.
  - Edge: no-image / flat estimate → counts 0, bools false; props never contain a URL, file id, or line-item text.
- **Verification:** the audit→PostHog mapper carries the image AND tier/selection props with correct values (a tiered estimate is now measurable end to end).

### U9. Dual-path verification (certification)
- **Goal:** Certify the SAME image surfaces whether the estimate was authored in the UI or by the AI — the acceptance bar.
- **Requirements:** R3, R8.
- **Dependencies:** U1–U8.
- **Files:** driven via `packages/api:verify` and `packages/web:verify` skills (no product code); capture outcomes in the PR description.
- **Approach:**
  - **UI path** (`packages/web:verify` + `packages/api:verify`): seed a catalog item, attach a photo via `PriceBookPage`, author an estimate picking that item via `CatalogPicker`, send it, open the public approval page in Chromium at 320px and assert the thumbnail renders with no overflow.
  - **AI path** (`packages/api:verify`): run `EstimateTaskHandler.handle` (and `MmsEstimateTaskHandler.handle`) with input that grounds to the image-bearing catalog item; assert the proposal line carries `imageFileId`; approve → assert the persisted `estimate_line_items.image_file_id` is non-null; `GET` the public estimate and assert the same `imageUrl` resolves.
  - **Parity assertion:** hand-built and AI-drafted estimates of the same catalog item yield the same image.
  - **Negative:** a no-image item and a legacy line both render cleanly (no broken `<img>`, no layout shift).
- **Verification:** both paths certified; parity + negative cases observed and recorded in the PR.

## Risks & Dependencies

- **Silent field-drop on the AI path** (U4) — the sharpest parity bug: image
  works in the UI but vanishes via AI unless BOTH the proposal `lineItemSchema`
  and `normalizeDraftLineItems` are updated. Pinned by a persistence-level test.
- **Cross-tenant file exposure** (U6) — the public route is unauthenticated;
  `image_file_id` must resolve scoped to `estimate.tenantId`. Load-bearing
  security test.
- **Signed-URL expiry** (U6) — never persist a URL; mint per read. Resolved by
  the `image_file_id` design.
- **Mobile layout** (U7) — a wide image must not break the ≤320px grid.
- **Image absence is the common case** — every schema/mapper/view/render treats
  the image as optional; no path assumes presence.
- **Mocked-pool blind spots** — both column adds need real-Postgres integration
  tests (`docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md`).

## Open Questions (deferred to implementation)

- **Thumbnail vs full image** on the public view — prefer `thumbnailS3Key` when
  the files pipeline produced one, else the full object; exact fallback decided
  against the `FileRecord` fields at implementation.
- **Signed-URL TTL** — a concrete value ≥ a page session; tuned against the
  existing re-sync poll interval.
- **Operator-resolved ambiguous lines** getting images — include the candidate
  plumbing now or ship exact/high first (deferred by default).

## Sources & Research

- `Explore` + `Plan` sub-agents, 2026-07-17 (surface map + strategy).
- Correction surfaced by research: `estimate_line_items` has **no**
  `catalog_item_id` column, so a live view-time lookup is not viable — the
  frozen `image_file_id` is the only coherent design.
- `docs/solutions/conventions/line-item-price-field-estimate-vs-invoice.md`
  (estimate `unitPrice` vs invoice `unitPriceCents`; use an estimate-shaped
  fixture — `imageFileId` itself is uniform).
- `docs/solutions/architecture-patterns/self-degrading-migration-for-managed-postgres.md`
  (idempotent `ADD COLUMN IF NOT EXISTS`).
- `docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md`
  (real-Postgres tests for new columns).
- Reuse reference: `packages/api/src/routes/job-photos.ts` +
  `packages/web/src/api/job-photos.ts` (presigned upload pattern).
- Cross-reference: EE-1 tier/selection PostHog backfill belongs on PR #697.
