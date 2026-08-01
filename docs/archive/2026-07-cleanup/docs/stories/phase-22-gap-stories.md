# Phase 22 — Voice Back Office Completion (ICP: 1–5 person shops)

> **6 stories** | Catalog-priced voice invoicing, issue_invoice, push-to-talk shell, offline voice, job profit, receipt capture

---

## Purpose

These are the gaps found in the 2026-06-10 competitive audit
(`docs/competitive-gap-analysis.md`) that are NOT already specced in earlier
phases. Together with P12 (owner-operator mode + unsupervised routing), P18
(voice/UI parity), P14 (inventory), P13 (equipment), P15-001 (QuickBooks),
and P8-015..027 (follow-up agent), they complete the pitch: **"You know the
trade. We run the business."** The owner speaks; the AI prices, invoices,
books, and reports — with proposals/undo/audit as the trust layer.

## Exit Criteria

A tech says "add a plumbing service call and three gaskets to the Miller
invoice" → proposal contains catalog-resolved line items priced in integer
cents from the tenant's price book. "Issue the invoice" works end-to-end.
A persistent mic is reachable from every screen on mobile; a voice note
recorded in a no-signal basement uploads when signal returns. "Did I make
money on the Miller job?" gets a spoken labor+parts+expenses margin answer.
A photo of a supply-house receipt becomes a job-linked expense proposal.

## Foundations already in place

- `packages/api/src/ai/tasks/invoice-edit-task.ts` — invoice edit task (P22-001 extends)
- `packages/api/src/ai/skills/lookup-catalog.ts` — catalog skill (P22-001 extends)
- `packages/api/src/catalog/catalog-item.ts` — priced catalog items (`unit_price_cents`)
- `packages/api/src/ai/orchestration/intent-classifier.ts` — `issue_invoice` intent already listed (P22-002 wires the handler)
- `packages/api/src/proposals/execution/voice-extended-handlers.ts` — handler patterns (send_invoice)
- `packages/web/src/components/assistant/AssistantPage.tsx` — recorder + TTS + proposal cards (P22-003 promotes into shell)
- `packages/api/src/routes/voice-sessions.ts` — in-app voice session FSM with SSE
- `packages/api/src/time-tracking/time-entry-service.ts`, `packages/api/src/expenses/expense.ts`, `packages/api/src/reports/money-dashboard.ts` — P22-005 inputs
- `packages/api/src/jobs/pg-job-photo.ts` + S3 file path — P22-006 reuses upload pattern
- `packages/api/src/ai/gateway/` — all LLM/vision calls route here

---

## Story Specifications

### P22-001 — Catalog-priced voice invoice line items

> **Size:** M | **Layer:** AI / Invoicing | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** none (P14-002 `job_parts` integrates later but is NOT required)

**Allowed files:** `packages/api/src/ai/tasks/invoice-edit-task.ts, packages/api/src/ai/tasks/invoice-task.ts (catalog context injection only), packages/api/src/ai/skills/lookup-catalog.ts (add pricing fields to result), packages/api/src/ai/tasks/catalog-resolution.ts (new — pure resolver), packages/api/test/ai/tasks/catalog-resolution.test.ts, packages/api/test/ai/tasks/invoice-edit-catalog.test.ts`

**Build prompt:** (1) Extend `lookup_catalog` skill result to include `id`, `unitPriceCents`, `unit`, `category` (it currently returns names only). (2) New pure module `catalog-resolution.ts`: `resolveSpokenLineItems(spokenItems: {description, quantity?}[], catalogItems) → {resolved: {catalogItemId, description, quantity, unitPriceCents}[], unresolved: {description, quantity?}[]}`. Match by normalized name + ILIKE-style fuzzy containment; a spoken item resolves only on a single unambiguous candidate, otherwise it stays `unresolved`. (3) In `InvoiceEditTaskHandler` (and invoice draft task where line items originate): fetch active catalog items for the tenant, inject a compact catalog table (name, unit, price) into the LLM prompt, and post-process LLM line items through `resolveSpokenLineItems`. Resolved items get exact `unitPriceCents` from the catalog (NEVER the LLM's guess — overwrite it). Unresolved items keep LLM text, `unitPriceCents: null`, and are flagged `needsPricing: true` in the proposal payload so the approval UI highlights them. (4) Cap injected catalog at 150 items (most-used first if usage data exists, else alphabetical); note the truncation in the prompt. (5) All money integer cents; totals via the shared billing engine — do not hand-roll math.

**Review prompt:** Verify catalog price always overrides LLM-guessed price for resolved items. Verify ambiguous matches ("valve" with 3 valve SKUs) stay unresolved rather than guessing. Verify quantity defaults to 1 when unstated. Verify proposal payload Zod contract still validates. Verify tenant isolation on catalog fetch.

**Required tests:** "service call + three gaskets" resolves both with catalog prices; ambiguous item lands in unresolved with needsPricing; LLM-hallucinated price overwritten by catalog price; >150-item catalog truncates without crash; empty catalog degrades to current free-text behavior; tenant isolation.

---

### P22-002 — `issue_invoice` execution handler + invoice intent unification

> **Size:** S | **Layer:** Proposals | **AI Build:** High | **Human Review:** Medium

**Dependencies:** none

**Allowed files:** `packages/api/src/proposals/execution/issue-invoice-handler.ts (new), packages/api/src/proposals/execution/handlers.ts (registry entry only), packages/api/src/proposals/contracts/issue-invoice.ts (new — Zod), packages/api/src/ai/orchestration/intent-classifier.ts (invoice intent examples only), packages/api/src/ai/orchestration/task-router.ts (issue_invoice route only), packages/api/test/proposals/issue-invoice-handler.test.ts, packages/api/test/ai/orchestration/invoice-intents.test.ts`

**Build prompt:** (1) The classifier already lists `issue_invoice` but no execution handler is registered — triggering it fails. Add `IssueInvoiceExecutionHandler`: payload `{invoiceId}`; transitions invoice draft → open, stamps `issued_date`, computes `due_date` from tenant payment terms, emits audit event. Reject (typed error, not throw-through) if invoice is not in `draft`. Mirror the structure of `SendInvoiceExecutionHandler` in `voice-extended-handlers.ts`. (2) Zod contract + registry wiring. (3) Intent unification pass limited to invoice intents: ensure "issue", "finalize", "send out the bill" phrasings classify correctly and that `issue_invoice` vs `send_invoice` disambiguation is documented in the prompt examples (issue = make official/payable; send = deliver to customer). (4) Idempotent: re-execution of an executed proposal is a no-op success.

**Review prompt:** Verify draft-only guard. Verify due-date uses tenant payment terms and timezone. Verify idempotency. Verify audit event emitted. Verify no changes outside invoice intents in the classifier.

**Required tests:** issue transitions draft→open with issued/due dates; non-draft rejected with typed error; idempotent re-execution; classifier routes 5+ issue phrasings and distinguishes issue vs send; tenant isolation.

---

### P22-003 — Global push-to-talk assistant in the app shell

> **Size:** M | **Layer:** Frontend | **AI Build:** Medium | **Human Review:** Medium

**Dependencies:** none (pairs with P12-002 shell mode toggle — coordinate, don't block)

**Allowed files:** `packages/web/src/components/voice/GlobalMicButton.tsx (new), packages/web/src/components/voice/VoiceOverlay.tsx (new), packages/web/src/components/voice/useGlobalVoice.ts (new), packages/web/src/components/layout/** (mount point only — minimal diff), packages/web/src/components/voice/__tests__/**`

**Build prompt:** (1) `GlobalMicButton`: persistent floating action button (bottom-right, thumb-reachable, 56px touch target) rendered in the shell layout on every authenticated route. Hidden on the public portal. (2) Tap → `VoiceOverlay`: full-screen on mobile, modal on desktop. Reuse — do not duplicate — the recording logic already in `AssistantPage.tsx` (MediaRecorder, codec detection, Safari fallback): extract its recorder hook into `useGlobalVoice.ts` and have BOTH AssistantPage and the overlay consume it. (3) Overlay flow: record → upload via existing `/api/voice/recordings` → poll transcript → display transcript → submit to `/api/assistant/chat` → render returned proposal cards (reuse `AIProposalCard`) with approve/reject inline. (4) Carry current page context (route, entityType/entityId if on a job/customer/invoice detail page) in the assistant request so "add a note" binds to the open record. (5) Keyboard shortcut (space-hold) on desktop; respects an `aria-live` transcript region.

**Review prompt:** Verify zero duplicated recorder code (single hook). Verify the FAB never overlaps existing bottom-sheet UI on technician mobile views. Verify page-context entity binding. Verify proposal approval from the overlay round-trips. Verify it is absent on portal/public routes.

**Required tests:** FAB renders on authenticated routes, not portal; overlay records and submits (mocked APIs); entity context included from JobDetail; proposal card approve calls the proposals API; recorder hook shared with AssistantPage (import assertion).

---

### P22-004 — PWA + offline voice capture queue

> **Size:** M | **Layer:** Frontend / Platform | **AI Build:** Medium | **Human Review:** Medium

**Dependencies:** P22-003 (shares `useGlobalVoice`)

**Allowed files:** `packages/web/public/manifest.webmanifest (new), packages/web/src/sw.ts (new — service worker), packages/web/vite.config.ts (PWA plugin wiring only), packages/web/index.html (manifest link + meta only), packages/web/src/offline/voice-queue.ts (new — IndexedDB queue), packages/web/src/offline/__tests__/**, packages/web/src/components/voice/useGlobalVoice.ts (queue integration only), packages/web/src/components/status/OfflineBadge.tsx (new), packages/web/package.json (vite-plugin-pwa dep only)`

**Build prompt:** (1) PWA manifest (name, icons, standalone display) + `vite-plugin-pwa` with a minimal service worker: precache the app shell, network-first for `/api/**` (NEVER cache API responses with tenant data — network-only with offline fallback message). (2) `voice-queue.ts`: IndexedDB-backed queue of recorded audio blobs + metadata (recordedAt, page context, tenant/user from session). When `navigator.onLine === false` or upload fails, `useGlobalVoice` enqueues instead of erroring; a sync loop (online event + 30s interval) drains the queue to `/api/voice/recordings` in order, with per-item retry capped at 5 then surfaced as a failed badge. (3) `OfflineBadge` in the shell: shows offline state and queued-note count ("2 voice notes will send when you're back online"). (4) Recording must work fully offline: capture, local persist, and playback for review.

**Review prompt:** Verify no tenant data is cached by the SW. Verify queue survives page reload (IndexedDB, not memory). Verify ordered drain and retry cap. Verify duplicate-upload protection (client-generated idempotency UUID per recording, sent as header). Verify iOS Safari PWA constraints documented.

**Required tests:** enqueue on offline; drain on online event; order preserved; retry caps at 5; reload persistence; idempotency key stable per recording.

---

### P22-005 — Per-job profit rollup + `lookup_job_profit` voice skill

> **Size:** M | **Layer:** Reports / Voice | **AI Build:** Medium | **Human Review:** Medium

**Dependencies:** none (parts costs join in automatically once P14-002 lands — code defensively against the table not existing yet via feature check)

**Allowed files:** `packages/api/src/reports/job-profit.ts (new), packages/api/src/routes/reports.ts (job-profit endpoint only), packages/api/src/ai/skills/lookup-job-profit.ts (new), packages/api/src/ai/orchestration/intent-classifier.ts (add lookup_job_profit intent only), packages/api/test/reports/job-profit.test.ts, packages/api/test/ai/skills/lookup-job-profit.test.ts, packages/web/src/pages/jobs/JobDetail.tsx (profit card only), packages/web/src/components/jobs/JobProfitCard.tsx (new), packages/web/src/components/jobs/__tests__/**`

**Build prompt:** (1) `job-profit.ts`: `getJobProfit(tenantId, jobId)` → `{revenueCents, laborCents, laborMinutes, materialsCents, expensesCents, marginCents, marginPct}`. Revenue = paid+open invoice totals linked to the job. Labor = `time_entries` duration (entry_type='job') × labor rate — read rate from tenant settings if present, else return labor as minutes-only with `laborCents: null` and `marginCents` computed without labor (flag `laborUnpriced: true`). Materials = `job_parts` if the table exists (runtime check), else 0. Expenses = job-scoped `expenses`. Integer cents throughout. (2) Route `GET /api/reports/job-profit/:jobId`. (3) Voice skill `lookup_job_profit`: resolves the job by reference ("the Miller job" via existing entity resolver), returns a TTS-friendly answer: "The Miller job brought in $850; you spent $320 on materials and 3 hours of labor — about $410 margin." Handles the unpriced-labor case honestly ("not counting your labor rate — set one in settings"). (4) `JobProfitCard` on JobDetail (owner/supervisor mode only).

**Review prompt:** Verify integer-cents math via shared billing engine where applicable. Verify graceful behavior with zero invoices / zero entries. Verify the runtime check for `job_parts` doesn't crash pre-P14. Verify role gating on the card. Verify tenant isolation.

**Required tests:** rollup math across revenue/labor/materials/expenses; unpriced-labor flag path; missing job_parts table path; zero-data job; TTS summary grammatical for negative margin; intent classifier routes 5+ phrasings.

---

### P22-006 — Receipt photo → expense proposal

> **Size:** M | **Layer:** AI / Expenses | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** none

**Allowed files:** `packages/api/src/ai/tasks/receipt-extraction-task.ts (new), packages/api/src/routes/expenses.ts (receipt upload endpoint only), packages/api/src/expenses/receipt-link.ts (new), packages/api/src/db/schema.ts (additive migration: receipt_file_id on expenses — discover next free migration number at dispatch time), packages/api/test/ai/tasks/receipt-extraction.test.ts, packages/api/test/expenses/receipt-link.test.ts, packages/web/src/components/jobs/ReceiptCapture.tsx (new), packages/web/src/components/jobs/__tests__/**, packages/web/src/api/expenses.ts (upload call only)`

**Build prompt:** (1) `POST /api/expenses/receipt`: accepts an image (reuse the S3 upload pattern from job photos in `files/` + `jobs/pg-job-photo.ts`), optional `jobId` from page context. (2) `receipt-extraction-task.ts`: vision call THROUGH THE LLM GATEWAY (`ai/gateway`) extracting `{vendor, totalCents, date, lineSummary, category guess}` from the image; emits an existing-type `log_expense` proposal (reuse its contract — do not invent a new proposal type) with the extracted fields, `receipt_file_id` linkage, and confidence. Low-confidence extraction (missing total or vendor) still creates the proposal with nulls flagged for the approval UI. (3) Additive migration: `expenses.receipt_file_id` nullable FK to files. (4) `ReceiptCapture`: camera-first capture button on JobDetail and the expenses surface; shows extraction preview before the proposal is submitted. (5) Amounts integer cents; date parsed in tenant timezone.

**Review prompt:** Verify all vision calls route through the gateway (no direct provider SDK). Verify `log_expense` contract reused, not forked. Verify nullable extraction handled (no NaN cents). Verify S3 object is tenant-scoped and the file row links correctly. Verify the proposal requires approval (capture tier at most — never autonomous for money).

**Required tests:** extraction maps to log_expense payload; $84.32 → 8432 cents; missing total → null + flagged; jobId from context attached; receipt_file_id persisted on execution; tenant isolation on upload.
