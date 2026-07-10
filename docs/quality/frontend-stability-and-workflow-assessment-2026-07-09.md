# Rivet (ServiceOS) — Frontend Stability & Workflow Quality Assessment

_Date: 2026-07-09 · Scope: canonical product (`packages/{api,web,shared}`) · Focus: front-end flickering/re-render stability + tradesperson end-to-end workflow readiness_

## Executive verdict

**The product is real and mostly production-grade on the money/AI spine — but the front-end data layer has a systemic flicker bug that will feel broken to a tradesperson using the app daily.**

| Dimension | Grade | One-line |
|-----------|-------|----------|
| Backend money / proposal safety | **A−** | Integer cents, durable webhooks, FORCE RLS, leader-elected sweeps — go-live blockers 1–8 largely closed |
| AI / voice intake | **B+** | Strong when keys present; TCPA consent gate is **built but not wired** into call placement |
| Front-end render stability | **C−** | Dispatch/pending-proposals anti-flicker is excellent; `useListQuery` / `useDetailQuery` undo that work on Home, Jobs, Invoices, Estimates, Customers |
| Tradesperson workflow completeness | **B** | Mike/Jenna day-in-the-life core loops exist; field execution + emergencies + live E2E proof are soft |
| E2E / QA proof | **D+** | Unit tests strong; journey E2E mostly `test.skip`; last QA matrix run was infra-blocked (0/74) |

**Bottom line for a 1–2 truck shop:** the AI can answer the phone, draft estimates, and collect payments. The web UI that the owner and tech live in will periodically flash spinners, blank detail panes, and hide lists — especially on the Home dashboard every 60 seconds. That is the highest-leverage quality debt.

---

## 1. What we assessed

1. **Front-end rendering stability** — custom data hooks, optimistic UI, SSE/WS/polling overlap, loading/empty gates
2. **Critical tradesperson workflows** mapped to `docs/strategy/day-in-the-life.md` (Mike HVAC / Jenna plumbing)
3. **Known blockers** from `GO-LIVE-READINESS.md` (2026-05-24) vs current code
4. **QA / E2E evidence** — unit hooks, journey specs, QA matrix status
5. **Parity gaps** from `docs/strategy/parity-jobs-invoicing.md` and `docs/feature-workflow-audit-2026-06-15.md`

Evidence includes direct source reads, prior audits, and a green run of 33 flicker-related hook unit tests (`useListQuery`, `useDetailQuery`, `useDispatchBoard`, `usePendingProposals`).

---

## 2. Front-end flicker — root cause analysis

### 2.1 The systemic bug (Critical)

There is **no shared cache layer** (no React Query / SWR / Zustand). Data lives in per-hook `useState`. Two foundational hooks treat every refetch as a cold load:

#### `useListQuery` — sets `isLoading(true)` on every poll/refetch

```94:100:packages/web/src/hooks/useListQuery.ts
  const refetch = useCallback(async () => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    const myVersion = ++requestVersionRef.current;
    setIsLoading(true);
```

Data is **not** cleared (good), but consumers almost universally hide content when `isLoading`:

| Consumer | Poll / refresh | User-visible symptom |
|----------|----------------|----------------------|
| **HomePage** | 5× `refetchInterval: 60_000` | Today’s jobs, pending estimates, outstanding invoices swap to spinners every minute |
| **InvoicesPage** list | Manual `setInterval` 30s | Entire invoice list replaced by spinner |
| **JobsList / EstimatesPage / CustomersPage / Contracts** | Filter/search/refetch | List disappears behind spinner |
| **TechnicianDayView** | Loading gate | Day view blanks during refresh |

Home wiring (confirmed):

```318:335:packages/web/src/components/home/HomePage.tsx
  const LIVE_REFETCH_MS = 60_000;
  // ... appointments, jobs, estimates, invoices, leads all pass refetchInterval
```

```360:360:packages/web/src/components/home/HomePage.tsx
  const todayLoading = appointmentsQuery.isLoading || jobsQuery.isLoading;
```

**This is the primary explanation for “flickering things” on the owner home screen.**

#### `useDetailQuery` — clears entity then full-page spinner

```45:51:packages/web/src/hooks/useDetailQuery.ts
    // Clear any previously-loaded entity so the consumer doesn't keep
    // rendering the prior id's data while the new fetch is in flight
    setData(null);
    const myVersion = ++requestVersionRef.current;
    setIsLoading(true);
```

Every ID change **and** every `refetch()` after an edit blanks Job / Invoice / Estimate detail. `LeadDetail` already does the right thing (`isLoading && !lead`); most other detail pages do not.

### 2.2 Secondary flicker sources (High / Medium)

| Issue | Severity | Where | Symptom |
|-------|----------|-------|---------|
| Attachment reload after capture | High | `AttachmentSection` | Optimistic photo appears → grid wiped by “Loading attachments…” |
| Lead pipeline refetch | Med–High | `LeadList` | Filter/rollback shows “Loading…”; initial `isLoading=false` can flash empty columns |
| Dispatch multi-source refresh | Medium | `DispatchBoard` | SSE + 15s poll + visibility + focus + `PROPOSALS_CHANGED` can stack (hook mitigates UI tear-down) |
| Inbox stale / no live sync | Medium | `InboxPage` | Badge updates elsewhere; list stays stale until remount |
| `AIProposalCard` local status | Medium | Shared card | Prop status changes don’t sync if instance reused |
| Shell Clerk `!isLoaded → null` | Low | `Shell.tsx` | Brief blank frame on boot |

### 2.3 What is done WELL (do not regress)

The team already solved this correctly in several places — **copy these patterns**:

| Pattern | Location | Why it works |
|---------|----------|--------------|
| Background refetch | `useDispatchBoard` (`hasDataRef` + `{ background: true }`) | Keeps board mounted; `isLoading` stays false; drag/scroll survive |
| Poll without loading flash | `usePendingProposals` | Only sets `isLoading` on initial load or forced refresh |
| Request versioning | List/Detail/Dispatch hooks | Prevents stale overwrites |
| Network coalescing | `usePendingProposals`, `useMe` | Multiple mounts don’t multiply spinners |
| Visibility-aware polling | List + pending proposals | Hidden tabs don’t burn requests |
| SSE/WS de-dupe | `useDispatchBoardStream` `presenceViaWs` | Presence doesn’t force full board refetch |
| Route transition bar | `Shell` | Prior page stays visible during lazy chunk load |
| Role home guard | `RoleHome` `isLoading && !me` | Techs don’t flash owner dashboard |
| In-place status poll | `useInvoiceStatus` | Payment page updates without spinner |

**The fix is not a rewrite.** Lift the `useDispatchBoard` / `usePendingProposals` background-loading contract into `useListQuery` and `useDetailQuery`, then stop gating list/detail UI on bare `isLoading`.

### 2.4 Recommended fix (priority order)

1. **`useListQuery`**: add `isInitialLoading` vs `isFetching` (or only `setIsLoading(true)` when `data.length === 0`). Keep showing last-good rows during polls.
2. **`useDetailQuery`**: clear `data` only when `id` changes; same-id refetch keeps stale entity + optional subtle refresh indicator.
3. **Consumers**: adopt `isLoading && !data` / `isLoading && data.length === 0` (LeadDetail / PendingProposalsCard pattern).
4. **`AttachmentSection`**: background reload when attachments already exist.
5. **DispatchBoard**: debounce/coalesce refetch; drop redundant `focus` if `visibilitychange` covers it.
6. **InboxPage**: listen to `PROPOSALS_CHANGED` with background merge (no `setIsLoading(true)`).
7. **Tests**: assert `isLoading` stays false during interval refetch when data exists — current `useListQuery` live-polling test only checks that requests fire.

---

## 3. Tradesperson workflow readiness (Mike / Jenna lens)

Mapped to day-in-the-life moments. Status uses the same legend as the June 15 workflow audit.

### 3.1 Owner morning loop (Mike 5:45–6:30)

| Moment | Needed capability | Status | Stability risk |
|--------|-------------------|--------|----------------|
| Overnight call digest | Voice intake + SMS summary | ✅ Strong (key-gated) | Low |
| One-tap approve estimates | Inbox / SMS proposals | ✅ Working | Medium — optimistic revert flash on failure; Inbox not live-synced |
| Draft estimates from yesterday | AI estimate proposals | ✅ Strong backend; 🟡 confidence not always surfaced in UI | Medium — detail flicker on open |
| Phone answered while driving | Inbound voice agent | ✅ Strong | Low (backend) |

### 3.2 Mid-day ops (jobs, dispatch, field)

| Moment | Needed capability | Status | Stability risk |
|--------|-------------------|--------|----------------|
| See today’s schedule | Home + Schedule + Dispatch | ✅ Built | **Critical** — Home sections spinner every 60s |
| Drag-drop reassign | Dispatch board → proposal | ✅ Built + background refetch | Medium — stacked refetches |
| Tech “Today” view | `/technician/day` | 🟡 Partial | High — loading gate blanks view |
| Job photos / attachments | Job photos + CaptureSheet | ✅ Photos; reload flickers | **High** |
| Job notes → invoice | Auto draft from notes | 🟡 / gap | — |
| Field checklists / “I’m out” | Field PWA extras | 🔩 / missing | — |
| Emergency medical escalate | Fast-path escalate | 🟡 Partial (triage aspirational) | — |

### 3.3 Money loop (estimates → invoices → cash)

| Moment | Needed capability | Status | Stability risk |
|--------|-------------------|--------|----------------|
| Tiered e-sign estimate | Public `/e/:id` | ✅ Strong (mock leak fixed) | Low; minor cents display on tier lines |
| Convert estimate → job/invoice | Proposal execution | ✅ | Medium detail flicker |
| Stripe pay link | Public `/pay/:id` | ✅ + in-place status poll | Low (good pattern) |
| Partial payments / deposits / refunds | Billing engine | ✅ | Low |
| Overdue follow-ups | Leader-elected sweep | ✅ | Low |
| Recurring agreements → job+invoice | Worker | ✅ | Low |
| Money dashboard TZ | Tenant TZ bucketing | 🟡 UTC buckets | Accountant surprise at month/year boundary |
| Auto-invoice on job complete | Parity wave P20 | 📝 Specced, not built | — |

### 3.4 End-of-day (digest / admin reduction)

| Moment | Needed capability | Status | Stability risk |
|--------|-------------------|--------|----------------|
| EOD digest | `/digest/:date` + SMS | ✅ Live | Low–Med loading gates |
| SMS one-tap approve | P2-034 | ✅ | Low |
| Pending proposal badge | Shell + Home card | ✅ No poll flash | Low (good pattern) |
| Correction “what I learned” | Structured lessons | 🔩 Built-not-wired | — |

### 3.5 Workflow scorecard (product usefulness)

| JTBD | Verdict | Blocks “stable & useful”? |
|------|---------|---------------------------|
| 1 Intake & Booking | ✅ Strong | No — when AI keys set |
| 2 Estimating | ✅ / 🟡 UI confidence | Flicker on list/detail |
| 3 Scheduling / Dispatch | ✅ Strong | Multi-refresh noise |
| 4 Job Execution | 🟡 Partial | Photos flicker; checklists missing |
| 5 Invoicing & Payments | ✅ Strong | List poll flicker |
| 6 Customer Mgmt | ✅ Good | List flicker |
| 7 Admin Reduction (inbox/digest) | ✅ Working | Inbox stale; Home flicker undermines trust |
| 8 Accounting / QBO | 🟡 Off-by-default | Not beta-critical if CSV OK |
| 9 Reviews | ✅ Good | — |
| 10 Reporting | ✅ / 🟡 TZ | Label UTC or fix |
| 11 Emergencies | 🟡 Partial | Trust differentiator incomplete |
| 12 Field Tech | 🟡 Partial | Mobile exists; web day view flickers |

**For a tradesperson to trust the product daily, fix the Home/list/detail flicker first.** Backend capability without a calm UI will feel like “the app is broken” even when money is correct.

---

## 4. Go-live / production blockers — current status

Re-verified against code (2026-07-09). Supersedes stale rows in May `GO-LIVE-READINESS.md` where fixed.

| # | Blocker | Status | Notes |
|---|---------|--------|-------|
| 1 | Stripe/Clerk webhook durability | ✅ Fixed | `PgWebhookRepository` + prod fail-fast |
| 2 | Txn commit on error | ✅ Fixed | Rollback when `statusCode >= 400` |
| 3 | FORCE RLS | ✅ Fixed | Migration 130 + new tables |
| 4 | Assistant approve unauthenticated | ✅ Fixed | Uses `apiFetch` |
| 5 | Cron multi-instance | ✅ Fixed | `runAsLeader` + graceful shutdown |
| 6 | Payment audit | ✅ Fixed | `payment.recorded` side effects |
| 7 | Double-booking | 🟡 Partial | DB EXCLUDE/trigger + assign path; direct `POST /appointments` still skips feasibility |
| 8 | Estimate mock-data leak | ✅ Fixed | Error UI; mock guard test |
| 9 | Money display cents | 🟡 Partial | InvoicesPage fixed; EstimateApprovalPage tier lines still bare `.toLocaleString()` |
| 10 | Dual `apiFetch` / `useApiClient` | 🟡 Partial | Behavior aligned; duplication remains |
| 11 | TCPA/DNC outbound gate | 🔴 **Built, not wired** | `checkOutboundConsent` exists; **no production caller** imports it |
| 12 | Transcript encryption | ✅ Fixed (per June QA report) | Confirm env keys in prod |

**Also open for “stable & useful”:**

- E2E journeys (`signup→estimate`, `estimate approval`, `invoice→payment`, onboarding) are **`test.skip`** without Clerk secrets
- Last comprehensive QA matrix (2026-06-04): **0 pass / 74 fail** due to missing `E2E_CLERK_HMAC_SECRET` / `CLERK_DEV_HMAC_TOKENS` — infra gap, not product proof
- Branding drift (Fieldly / ServiceOS / Rivet) still noted in prior QA
- No React Query means every new live surface re-implements loading semantics — high regression risk

---

## 5. Test evidence & gaps

### What we ran this session

```
packages/web: useListQuery + useDetailQuery + useDispatchBoard + usePendingProposals
→ 4 files, 33 tests passed
```

These tests prove fetch/race/polling **mechanics**, not UI stability. Notably:

- `useListQuery` live-polling test asserts requests fire — **does not** assert `isLoading` stays false with data present
- `useDispatchBoard` **does** assert background refetch keeps `isLoading` false — the gold standard missing from list/detail

### Coverage shape

| Layer | Health | Gap |
|-------|--------|-----|
| Unit (API/web) | Strong (~5k+ API historically; 200+ web files) | Flicker regressions untested |
| Integration (testcontainers) | Strong for money/RLS/voice | Needs Docker |
| Playwright smoke | Present | Narrow |
| Journey E2E | Written, skipped | No CI proof of owner money loop |
| QA matrix | Harness mature | Last run infra-blocked |

---

## 6. Prioritized remediation plan

### P0 — Stop the flicker (1–3 days, highest user trust)

1. Background-loading contract in `useListQuery` + `useDetailQuery`
2. Update Home, Invoices, Jobs, Estimates, Customers, TechnicianDay to not unmount content on refresh
3. AttachmentSection background reload
4. Add regression tests: “poll with data → `isLoading` false / content still mounted”

### P1 — Close remaining safety / money polish (2–4 days)

1. Wire `checkOutboundConsent` into every outbound dial path (or disable outbound AI until wired)
2. Feasibility gate on `POST /api/appointments` (or document DB-only protection)
3. `fmtUsd` / `centsToDisplay` on EstimateApprovalPage tier lines
4. Unskip + green one money journey E2E in CI (`invoice-to-payment` or `signup-to-first-estimate`)

### P2 — Workflow completeness for beta shops (1–2 weeks)

1. Run full QA matrix green (Clerk HMAC + seed + gate)
2. Inbox live refresh on `PROPOSALS_CHANGED`
3. Debounce DispatchBoard refetch sources
4. Tenant-TZ money dashboard (or explicit UTC label)
5. Field gaps that block Jenna/Mike: notes→invoice, “I’m out”, emergency triage honesty

### P3 — Architectural hardening

1. Consider TanStack Query (or a thin shared `useQuery` with stale-while-revalidate) so every page inherits anti-flicker
2. Consolidate on one auth-fetch API
3. Enforce coverage gate (`continue-on-error` removal) once green

---

## 7. What is genuinely solid (keep shipping on this foundation)

- Proposal gate: Zod contracts, never auto-execute money/comms, 5s undo, claim-for-execution, audit
- Billing engine: integer cents, shared estimate/invoice path, Stripe Connect + durable webhook dedup
- Catalog-grounded AI pricing with confidence caps
- Dispatch board anti-flicker + presence WS de-dupe (best FE pattern in the repo)
- Pending proposals badge polling without spinner flash
- Public estimate/pay flows (token hashing, no mock fallback)
- Voice corpus / intent depth investment (separate from UI stability)
- Institutional docs (`day-in-the-life`, parity roadmap, solutions library)

---

## 8. Assessment summary for stakeholders

**If the question is “can this run a tradesperson’s business?”**  
→ **Yes for the AI back-office spine** (phone → book → estimate → approve → invoice → pay), when credentials are set and outbound calling is either gated or disabled.

**If the question is “is the front-end stable enough that they will trust it?”**  
→ **Not yet.** The Home dashboard and most list/detail pages will flicker on a timer or on every navigation/refetch because loading state is modeled as “cold load” instead of “stale-while-revalidate.” Dispatch and the proposal badge prove the team knows how to fix this — it simply was not applied to the shared list/detail hooks.

**Recommended sequencing:** fix P0 flicker in the shared hooks first (one change, many pages), then wire TCPA, then get one real E2E money journey green in CI. After that, the product is in a credible place for a small beta of owner-operators.

---

## Appendix A — Key files

| Area | Path |
|------|------|
| List flicker source | `packages/web/src/hooks/useListQuery.ts` |
| Detail flicker source | `packages/web/src/hooks/useDetailQuery.ts` |
| Gold-standard anti-flicker | `packages/web/src/hooks/useDispatchBoard.ts` |
| Poll without flash | `packages/web/src/hooks/usePendingProposals.ts` |
| Home 60s polls | `packages/web/src/components/home/HomePage.tsx` |
| Invoice 30s poll | `packages/web/src/components/invoices/InvoicesPage.tsx` |
| Unwired TCPA gate | `packages/api/src/voice/outbound-consent.ts` |
| Persona spine | `docs/strategy/day-in-the-life.md` |
| Workflow audit | `docs/feature-workflow-audit-2026-06-15.md` |
| Prior go-live | `GO-LIVE-READINESS.md`, `qa/reports/2026-06-04-comprehensive-qa-report.md` |

## Appendix B — Method

- Parallel codebase exploration of architecture, blockers, and FE flicker patterns
- Direct reads of data hooks and Home/Invoices consumers
- Status re-verification of May go-live blockers against current `packages/api` / `packages/web`
- Cross-check with June workflow audit + QA report
- Vitest run of 33 related hook tests (all passed; flicker assertions largely absent)
