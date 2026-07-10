# feat: Wave 1 — Prove the money loop (follow-up task)

**Created:** 2026-07-10  
**Depth:** Standard  
**Status:** plan (ready to pick up)  
**Branch suggestion:** `feat/wave1-prove-money-loop`  
**Depends on:** `fix/frontend-render-stability-and-e2e` (list/detail flicker fix) — soft dependency; can start in parallel  
**Out of scope:** Wave 2 (TCPA wiring, appointment feasibility, field “I’m out”) and Wave 3 (auto-invoice-on-complete, multi-step dunning, QBO)

---

## Summary

Turn Rivet’s **already-built** money spine into **continuously proven** CI evidence.

Today the product can draft estimates, approve proposals, send invoices, and collect Stripe payments — but journey E2E specs are mostly `test.skip`, and the last QA matrix run was infra-blocked (0/74). Wave 1 does **not** add new product features. It proves five owner/customer loops with hermetic and/or seeded tests, then gets one green QA matrix run on Railway dev.

**Exit criteria (must all be true):**

1. CI proves `draft/approve estimate → execute` without manual clicking  
2. CI proves `invoice → Stripe webhook → paid` (Elements UI optional)  
3. Hermetic E2E covers public `/e/:id` approve and `/pay/:id` status  
4. One documented green QA matrix run: Business-Critical ≥27/30  
5. PR CI runs the new hermetic money specs whenever `VITE_CLERK_PUBLISHABLE_KEY` is set (placeholder `pk_test_` OK)

---

## Problem frame

| What exists | What’s missing |
|-------------|----------------|
| Strong unit/integration coverage for billing, proposals, Stripe webhooks | No always-on browser proof of the owner money loop |
| `e2e/journeys/*.spec.ts` written as documentation | Specs self-skip without Clerk secrets + seeded DB |
| Hermetic harness proven (`no-401-storm`, `render-stability`) | Not yet applied to estimate approve / invoice paid / public pages |
| QA matrix harness + gates | Last run failed on missing `CLERK_DEV_HMAC_TOKENS` / HMAC secret |
| Day-in-the-life promise: “approve in 30 seconds, cash collects itself” | Cannot show a green CI badge for that promise |

**Stakeholder risk:** shipping more features before this wave lets sales claim capabilities we cannot demonstrate under automation.

---

## Context & prior art

| Artifact | Use |
|----------|-----|
| `docs/quality/frontend-stability-and-workflow-assessment-2026-07-09.md` | Quality assessment that defined Wave 1 |
| `docs/feature-workflow-audit-2026-06-15.md` | JTBD #2/#5/#7 marked strong — prove, don’t rebuild |
| `docs/plans/2026-07-06-001-feat-offline-authed-e2e-coverage-plan.md` | Offline Clerk-stub fixture design — **reuse / finish** |
| `docs/plans/2026-06-25-003-feat-qa-full-matrix-unblock-plan.md` | QA matrix bootstrap — **execute**, don’t redesign |
| `docs/runbooks/qa-full-matrix-unblock.md` | Operator steps for matrix green |
| `e2e/helpers/clerk-stub.ts` | Offline signed-in boot |
| `e2e/render-stability.spec.ts` | Pattern for hermetic list refresh proof |
| `e2e/journeys/estimate-approval-execution.spec.ts` | Journey 2 skeleton |
| `e2e/journeys/invoice-to-payment.spec.ts` | Journey 3 skeleton |
| `packages/api/test/webhooks/` | Stripe signature test helpers |

---

## Scope — five work items

### W1-1 — Hermetic: Inbox / proposal approve → estimate executed

**Goal:** Prove the AI OS loop without Clerk cloud or live LLM.

**Approach:**
- Prefer offline Clerk stub + route-mocked API **or** local API with `DEV_AUTH_BYPASS` + InMemory/seeded fixtures
- Seed (or mock) a `ready_for_review` / pending proposal of type that creates/sends an estimate
- Drive Inbox (or Assistant) Approve in the real SPA
- Assert: approve POST fired, after undo window proposal reaches `executed` (mock worker tick **or** real execution worker on local API)
- Do **not** require `AI_PROVIDER_API_KEY` — use canned proposal payload

**Files (expected):**
- `e2e/helpers/offline-app.ts` (from offline-authed plan, if not already landed)
- `e2e/journeys/estimate-approval-execution.spec.ts` **or** new `e2e/money-loop/estimate-approve-execute.spec.ts`
- Optional: thin API test helper to mint a pending proposal for the stub tenant

**Done when:** Spec runs green in CI with only `VITE_CLERK_PUBLISHABLE_KEY=pk_test_…` (no `E2E_CLERK_SECRET_KEY`).

---

### W1-2 — Hermetic / seeded: Invoice → Stripe webhook → paid

**Goal:** Prove “did we get the money?”

**Approach:**
- Skip driving Stripe-hosted Checkout / Elements (brittle)
- Seed or mock an `open` invoice with known `invoiceId` + amount
- POST signed `checkout.session.completed` or `charge.succeeded` to `/webhooks/stripe` using existing test signing helper
- Assert invoice status `paid` (API and/or UI reload)
- Prefer hermetic (route mock + UI status) **plus** one API integration test that hits real webhook handler + durable idempotency

**Files (expected):**
- `e2e/journeys/invoice-to-payment.spec.ts` (unskip / rewrite)
- Reuse `packages/api` Stripe webhook signing helpers
- Optional UI assert on `/invoices/:id` or public `/pay/:id`

**Done when:** CI proves webhook → `paid` without Stripe test-mode network (signature + handler path). Live Stripe keys remain optional enhancement.

---

### W1-3 — Hermetic: Public estimate approval `/e/:id`

**Goal:** Customer-facing trust surface; no Clerk required.

**Approach:**
- Mock or seed `GET /public/estimates/:token` (or id route as implemented)
- Load `/e/:id` (or token URL)
- Assert customer name, line items, totals via `centsToDisplay` / `fmtUsd` (no mock-data fallback)
- Click approve/sign happy path; assert success UI + POST body shape
- Negative: network error shows error UI (regression for Blocker 8)

**Files (expected):**
- `e2e/public/estimate-approval.spec.ts` (new) or extend `estimate-approval-mobile.spec.ts` desktop twin
- Fixture pinned to shared estimate public contract Zod schema

**Done when:** Spec is always eligible in default Playwright project (no auth env required beyond app boot).

---

### W1-4 — Hermetic: Public pay page `/pay/:id` status

**Goal:** Cash-collection UI updates without spinner flicker / fake timeouts.

**Approach:**
- Mock invoice payment status endpoint used by `useInvoiceStatus`
- Load `/pay/:id`; assert initial status
- Advance / trigger poll; assert transition to `paid` **in place** (no full-page blank)
- Do not require real Stripe Elements for this wave (status poll proof only); Elements can be a Wave 1.1 stretch

**Files (expected):**
- `e2e/public/invoice-pay-status.spec.ts` (new)
- Align with `packages/web/src/hooks/useInvoiceStatus.ts`

**Done when:** Spec green in CI; documents that Elements card entry is out of scope for W1-4.

---

### W1-5 — One green QA matrix run (Business-Critical)

**Goal:** Operator-proof the full surface once; capture report as evidence.

**Approach:**
- Follow `docs/runbooks/qa-full-matrix-unblock.md` exactly
- Railway API: `CLERK_DEV_HMAC_TOKENS=true` + redeploy
- Local: fill `.env.qa`, `npm run qa:setup`, `npm run qa:matrix:run`, `npm run qa:matrix:gate`
- Target: Business-Critical ≥27/30; document waivers in `qa/gate-exceptions.json` if needed
- Voice-Critical 20/20 only if voice is in **this** launch scope; otherwise note as Wave 1 deferral with explicit waiver

**Deliverables:**
- `qa/reports/<date>/QA-REPORT.md` committed or linked in PR description
- Short note in this plan’s Progress section: pass counts + any exceptions

**Done when:** Gate script exits 0 for business-critical (or ≤3 documented exceptions).

---

## Non-goals (explicit)

- Wiring `checkOutboundConsent` / TCPA (Wave 2)
- Feasibility on `POST /api/appointments` (Wave 2)
- Auto-invoice on job complete / multi-step dunning (Wave 3 / P20)
- Finishing full offline Jobs/Estimates/Invoices/Assistant CRUD suite from the 2026-07-06 plan beyond what W1-1 needs
- Branding unification (Fieldly / ServiceOS / Rivet)
- Enabling real Clerk journey signup in CI (nice-to-have; not blocking Wave 1 exit)

---

## Suggested implementation order

```text
Day 1–2  W1-3 public estimate + W1-4 public pay status
         (fastest wins; no auth; builds fixture muscle)

Day 2–3  W1-1 estimate approve → execute (hermetic)
         W1-2 invoice → webhook → paid

Day 3–4  Wire specs into e2e.yml with placeholder pk_test_
         Fix flakes from pollers / StrictMode (see offline-authed plan R7)

Day 4–5  W1-5 QA matrix green on Railway dev
         Commit report + update this plan Progress
```

Estimate: **3–5 engineering days** for one engineer familiar with the e2e harness.

---

## CI / env requirements

| Env | Required for | Notes |
|-----|--------------|-------|
| `VITE_CLERK_PUBLISHABLE_KEY=pk_test_…` | W1-1 hermetic authed | Placeholder OK; stub short-circuits Clerk |
| None beyond app boot | W1-3, W1-4 | Public routes |
| Stripe signing secret **test helper** (in-repo) | W1-2 | Not live Stripe |
| `.env.qa` + Railway `CLERK_DEV_HMAC_TOKENS` | W1-5 only | Operator / one-shot |

Update `.github/workflows/e2e.yml` so hermetic money specs run on every PR with a fallback placeholder key (same pattern as proposed in the offline-authed E2E plan R5).

---

## Test plan (acceptance)

| ID | Check | Command / evidence |
|----|-------|-------------------|
| T1 | Public estimate approve hermetic | `npx playwright test e2e/public/estimate-approval.spec.ts` |
| T2 | Public pay status hermetic | `npx playwright test e2e/public/invoice-pay-status.spec.ts` |
| T3 | Estimate approve → execute | Playwright money-loop spec green in CI |
| T4 | Invoice webhook → paid | Playwright and/or API integration green |
| T5 | No regress render-stability / 401-storm | Existing specs still green |
| T6 | QA matrix business gate | `npm run qa:matrix:gate` exit 0 |

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Execution worker / 5s undo makes E2E slow or flaky | Test hook to advance `approvedAt`, or mock worker tick; avoid multi-minute sleeps |
| Mock shapes drift from Zod contracts | Parse fixtures through `@ai-service-os/shared` schemas at build time (offline-authed plan R2) |
| Pollers / SSE cause flakes | Reuse visibility pause + catch-all unmocked-path recorder from offline-authed plan |
| QA matrix blocked on secrets again | W1-5 is explicitly operator-run; hermetic W1-1…4 must not depend on it |
| Scope creep into Wave 2/3 | Non-goals section; reject PRs that add product features under this task |

---

## Progress

| Item | Status |
|------|--------|
| W1-1 Estimate approve → execute | ☐ Not started |
| W1-2 Invoice → webhook → paid | ☐ Not started |
| W1-3 Public `/e/:id` | ☐ Not started |
| W1-4 Public `/pay/:id` status | ☐ Not started |
| W1-5 QA matrix business gate | ☐ Not started |
| CI placeholder key for hermetic suite | ☐ Not started |

---

## Handoff checklist (for the implementing agent)

1. Read this plan + `e2e/README.md` + `docs/plans/2026-07-06-001-feat-offline-authed-e2e-coverage-plan.md`  
2. Create branch `feat/wave1-prove-money-loop` from latest `main`  
3. Implement W1-3 → W1-4 → W1-1 → W1-2 → CI wiring → W1-5  
4. Do not modify Wave 2/3 product code unless a bug blocks a Wave 1 proof  
5. Update Progress table in this file before opening the PR  
6. PR title: `feat: Wave 1 — prove money loop (estimate/invoice/public/QA matrix)`  
7. PR body links this plan and attaches QA report path for W1-5  

---

## Success statement

> After Wave 1, any engineer can point at CI (and one QA matrix report) and say:  
> **“A tradesperson can approve an estimate and get paid — and we prove it on every PR.”**
