# Phase 14 — Inventory + Parts

> **3 stories** | Truck stock, parts-per-job, voice lookup

---

## Purpose

Plumbing, electrical, HVAC, pest control, appliance repair — every truck-based vertical bills parts. Without inventory tracking, owners eat the margin. Phase 14 adds:
- **Inventory ledger**: warehouse + per-truck stock with audit-trail transactions
- **Parts-used-per-job**: tech adds parts on completion, stock auto-deducts, line items roll into invoice
- **Voice agent skill**: "do we have a half-inch copper elbow on Mike's truck?"

## Exit Criteria

Tech opens a job, adds 3 parts from truck stock, completes job. Truck stock auto-decremented. Parts appear as invoice line items at the marked-up price. Owner sees low-stock alert when truck-wide pipe-thread-tape drops below threshold. Voice caller asking "do you have a 50A breaker?" gets a routed answer from voice agent.

## Foundations already in place

- `packages/api/src/catalog/catalog-item.ts` — catalog items repo (extends in P14-001)
- `packages/api/src/jobs/job.ts` + line items shape (extends in P14-002)
- `packages/api/src/notifications/send-service.ts` — for low-stock alerts
- `packages/api/src/ai/skills/lookup-availability.ts` — voice skill template (P14-003)

---

## Story Specifications

### P14-001 — Inventory ledger (warehouse + per-truck stock)

> **Size:** L | **Layer:** Operations | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** none

**Allowed files:** `packages/api/src/inventory/**, packages/api/src/routes/inventory.ts, packages/api/src/db/schema.ts (migration 156 only), packages/api/src/app.ts (wiring only), packages/api/src/inventory/__tests__/**, packages/api/test/inventory/**, packages/web/src/pages/inventory/**, packages/web/src/components/inventory/**, packages/web/src/api/inventory.ts, packages/web/src/pages/settings/InventorySettings.tsx, packages/api/src/workers/low-stock-alert-worker.ts, packages/api/test/workers/low-stock-alert-worker.test.ts`

**Build prompt:** (1) Migration `156_create_inventory`: THREE tables.

`inventory_items`: `id, tenant_id, catalog_item_id (FK to catalog_items, nullable for ad-hoc), sku, name, unit (each|ft|gal|lb), low_stock_threshold INT NOT NULL DEFAULT 0, restock_target INT NOT NULL DEFAULT 0, is_active BOOL DEFAULT true, created_at, updated_at`. RLS. UNIQUE (tenant_id, sku) WHERE is_active = true.

`inventory_locations`: `id, tenant_id, name (e.g. "Main Warehouse" or "Mike's Truck"), location_type (enum: warehouse, truck, customer_site), assigned_user_id (nullable — for trucks)`. RLS.

`inventory_transactions`: `id, tenant_id, inventory_item_id (FK), location_id (FK), quantity_delta INT (positive = in, negative = out), transaction_type (enum: receive, transfer, consume_on_job, adjust, return), job_id (nullable FK), notes, created_by, created_at`. RLS. Indexes on (tenant_id, inventory_item_id), (tenant_id, location_id), (tenant_id, job_id).

Stock-on-hand is computed: `SUM(quantity_delta) WHERE inventory_item_id = $1 AND location_id = $2`. Materialize via view if perf demands.

(2) Service: `receiveStock`, `transferStock` (creates 2 transactions: -1 from source, +1 to dest), `consumeOnJob` (called by P14-002), `getStockOnHand(tenantId, itemId, locationId?)`, `lowStockItems(tenantId)` (cross-locations; returns items where total stock < threshold). (3) Routes: full CRUD on items/locations + `POST /api/inventory/transactions/transfer`, `GET /api/inventory/stock-on-hand`. (4) Worker: `low-stock-alert-worker` runs hourly; if any item under threshold and no alert sent in last 24hr, SMS the warehouse manager (configurable in InventorySettings). (5) Web: InventoryDashboard (low-stock callouts), InventoryItemList, InventoryLocationList (with stock-by-location grid), TransferStockDialog.

**Review prompt:** Verify stock-on-hand never goes negative without explicit adjust. Verify transfer is atomic (both halves of the transaction in one DB txn). Verify alerts are deduped (no spam). Verify tenant isolation across all routes.

**Required tests:** receive → stock increases; transfer → both legs recorded; getStockOnHand returns sum; lowStockItems returns items below threshold; low-stock alert dedup over 24h.

---

### P14-002 — Parts-used-per-job

> **Size:** M | **Layer:** Field Ops | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P14-001

**Allowed files:** `packages/api/src/jobs/job-parts.ts, packages/api/src/jobs/pg-job-parts.ts, packages/api/src/jobs/job-parts-service.ts, packages/api/src/routes/job-parts.ts, packages/api/src/db/schema.ts (additive ALTER on jobs/job_parts only — no new migration; small migration block), packages/api/src/app.ts (wiring only), packages/api/test/jobs/job-parts.test.ts, packages/web/src/pages/jobs/JobParts.tsx, packages/web/src/components/jobs/JobPartsPicker.tsx, packages/web/src/pages/jobs/JobDetail.tsx (add parts section only), packages/web/src/components/jobs/__tests__/**, packages/web/src/api/job-parts.ts`

**Build prompt:** (1) Schema: `job_parts` table — `id, tenant_id, job_id (FK), inventory_item_id (FK), quantity, unit_price_cents BIGINT, source_location_id (FK to inventory_locations), notes, created_at`. RLS. Migration goes inside an additive ALTER block within a new migration number — but since this story is partial, it depends on P14-001's migration including a small `070b_create_job_parts` follow-up; OR the agent adds it as a new migration `071_create_job_parts`. Discover the right number by reading schema.ts at dispatch time. (2) Service: `addPartToJob(tenantId, jobId, inventoryItemId, quantity, sourceLocationId, unitPriceCents?)` — enforces stock availability, creates `inventory_transaction` (consume_on_job, negative delta), creates `job_parts` row, optionally adds an invoice line item if invoice exists. `removePartFromJob` reverses. (3) Routes: `POST /api/jobs/:id/parts`, `DELETE /api/jobs/:id/parts/:partId`, `GET /api/jobs/:id/parts`. (4) Web: JobPartsPicker (typeahead from inventory_items, shows truck stock; warns if low), JobParts list on JobDetail.

**Review prompt:** Verify atomic add (job_parts row + inventory_transaction in one txn). Verify stock availability checked before deduction. Verify invoice line item added when invoice present. Verify tenant isolation.

**Required tests:** add part deducts stock; remove restores stock; add fails if insufficient stock; invoice line added when invoice present; tenant isolation.

---

### P14-003 — Voice skill `lookup_part_availability`

> **Size:** S | **Layer:** Voice | **AI Build:** High | **Human Review:** Light

**Dependencies:** P14-001

**Allowed files:** `packages/api/src/ai/skills/lookup-part-availability.ts, packages/api/src/ai/skills/__tests__/lookup-part-availability.test.ts, packages/api/test/ai/skills/lookup-part-availability.test.ts, packages/api/src/ai/orchestration/intent-classifier.ts (add lookup_part_availability intent only), packages/api/src/telephony/twilio-adapter.ts (add lookup branch only)`

**Build prompt:** New voice skill `lookup-part-availability(tenantId, partQuery, locationId?)`. Fuzzy search `inventory_items` by name/sku (use existing pg_trgm or a simple ILIKE %query% if not available). If `locationId` (e.g., "on Mike's truck"), scope to that location's stock; else aggregate across all locations. Return TTS-friendly summary: "Yes, 3 half-inch copper elbows are on Mike's truck and 12 in the warehouse." Intent classifier adds `lookup_part_availability` with phrasings ("do we have...", "is there a...", "how many...are on the truck").

**Review prompt:** Verify fuzzy match returns ≤ 3 candidates if ambiguous. Verify location scoping works. Verify TTS string is grammatical for 0/1/N stock levels. Verify tenant isolation.

**Required tests:** exact-match returns single result; ambiguous returns clarification ("did you mean X or Y?"); zero stock summary is friendly; location scoping; intent classifier routes 5+ phrasings.
