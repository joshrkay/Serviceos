# feat: Offline authed E2E coverage — real-browser specs for Jobs, Estimates, Invoices, Assistant

**Created:** 2026-07-06
**Depth:** Standard
**Status:** plan

## Summary

Extend the offline Clerk-stub harness (`e2e/helpers/clerk-stub.ts`, proven by
`e2e/no-401-storm.spec.ts`) into a reusable Playwright fixture that boots the
real web bundle signed-in with zero network egress, then add one spec file per
core authed flow — Jobs, Estimates, Invoices, Assistant — with schema-validated
API mocks. Wire PR CI to run the suite on every PR via a placeholder Clerk key
fallback. Result: the authed frontend gets real-browser regression coverage
that runs in any sandbox or CI runner with no Clerk secrets and no database.

## Problem Frame

Today 19 of 42 default-project e2e specs skip without Clerk secrets or an
authenticated deployed URL, and the 4 smoke-ui specs need real Clerk egress —
so on every PR the authed frontend has **zero real-browser coverage** (the
repo has no Clerk CI secrets configured). jsdom tests mock the data hooks, so
whole bug classes are invisible to them: field-mapping drift between API shape
and component (`totals.totalCents` vs flat `total` — a real past bug), broken
route/detail wiring, mutations sending shapes the server's Zod would 400
(`docs/solutions/test-failures/mocked-client-shape-masks-server-schema-rejection.md`),
and error-state regressions like the 2026-07-06 401 storm. The clerk-stub
harness removed the auth blocker; this plan builds the coverage on top of it.

## Requirements

- R1. A shared Playwright fixture boots the app signed-in offline: Clerk stub +
  external-host abort + baseline shell mocks + error collectors, reusable by
  every offline spec with no per-spec boilerplate.
- R2. Mock fixtures are pinned to the real contracts: response bodies must
  `parse()` under `packages/shared/src/contracts/*` Zod schemas at fixture-build
  time; mutation request bodies are validated against the API's request schemas
  where they exist. Drift fails loudly, not silently (per the two
  mocked-shape prior learnings).
- R3. Each of Jobs, Estimates, Invoices, Assistant gets a real-browser spec
  covering: render-real-data, list→detail navigation wiring, one key mutation's
  request wiring, and one error-state path — with zero `pageerror` throughout.
- R4. Every mocked-API spec runs identically with a placeholder or a real
  publishable key (the stub short-circuits Clerk either way), and skips cleanly
  on a bare runner with neither.
- R5. PR CI (`.github/workflows/e2e.yml`) runs the offline suite on every PR
  via a placeholder `VITE_CLERK_PUBLISHABLE_KEY` fallback; secret-gated journey
  specs keep their existing gates untouched. (User-confirmed decision.)
- R6. Unmocked API endpoints hit during a spec are recorded and surfaced, so
  the catch-all mock can't silently swallow a missing mock.
- R7. The suite is deterministic under the app's background traffic: pollers
  (proposals 30s, onboarding 30s, invoice list 30s, voice sessions 10s),
  StrictMode double-effects, and the always-on escalations SSE must not flake
  any assertion.

## Key Technical Decisions

- **`test.extend()` fixture + per-domain mock modules** — a single
  `e2e/helpers/offline-app.ts` fixture bundles clerk stub, external-host abort,
  catch-all recorder, baseline shell mocks, and pageerror/console collectors;
  domain mocks live in `e2e/helpers/api-mocks/*` following the stateful
  `e2e/helpers/onboarding-v2-mock.ts` pattern. (Alternatives considered:
  per-spec inline `page.route` handlers — rejected, the shell baseline would be
  copy-pasted and drift per spec; MSW in the browser — rejected, puts test
  scaffolding into the app bundle and adds a service-worker lifecycle, while
  `page.route` keeps the harness 100% outside the app.)
- **Layered route registration exploiting last-registered-wins** — register in
  order: (1) external abort + catch-all `/api/*` recorder fulfilling `200 {}`,
  (2) baseline shell mocks, (3) domain mocks in the test body, (4) per-test
  overrides (e.g. a 500) last so they win. Fulfilling unmocked calls with `200
  {}` instead of 404 keeps unrelated widgets from painting error states; the
  R6 recorder keeps the gap visible.
- **Zod-parse every response fixture; validate mutation request bodies** —
  fixture factories end in `jobListItemSchema.parse(...)` /
  `estimateResponseSchema.parse(...)` etc. (Node-side, at fixture build), and
  mutation mock handlers parse intercepted bodies with the API's request
  schemas (`recordPaymentSchema`, `updateEstimateSchema`, … from
  `packages/api/src/shared/contracts.ts`). Playwright's TS transform does not
  typecheck, so `satisfies` annotations alone prove nothing at runtime —
  runtime parse is the only self-enforcing pin. (Alternative: reuse jsdom test
  fixtures — rejected as the *mechanism*; they mock at the hook layer and
  embody the same self-agreement trap the prior learnings document, though
  their shapes are useful reference.)
- **Mock `/api/me` WITHOUT the `ai:run` permission** — the `/api/ws` WebSocket
  and the 10s `/api/voice/sessions/active` poller only start when
  `me.permissions` includes `ai:run`
  (`packages/web/src/hooks/useActiveSessions.ts`). Omitting it means no
  `routeWebSocket` stubbing is needed at all. The escalations SSE
  (`/api/escalations/events`, no permission gate) degrades gracefully into
  backoff on any failure — fulfill it 200-empty or let the catch-all answer it.
- **Assert on mutation trackers, never on GET counts** — StrictMode
  double-mounts effects and three pollers refire GETs; GET handlers must be
  idempotent and no test asserts "fetched exactly once". Mutations are
  user-action-triggered, so trackers record an ordered `{method, path, body}`
  list asserted exactly. (Alternative: `page.clock` to freeze pollers —
  rejected, freezing timers in a real app shell breaks debounces/animations
  unpredictably.)
- **CI placeholder-key fallback in the existing lane** — `${{
  secrets.E2E_CLERK_PUBLISHABLE_KEY || '<placeholder pk_test_…>' }}` in
  `e2e.yml`'s existing env block. The stub predefines `window.Clerk` before any
  app script runs, so clerk-react's loader never downloads clerk-js regardless
  of key — real and placeholder keys produce identical execution for stub
  specs (already demonstrated by the no-401 suite). (Alternatives: keep
  secret-gated — rejected, the suite's whole point is running without secrets
  and skip-by-default rots; separate always-on CI job — rejected, duplicates
  browser install + server boot for no isolation benefit. User confirmed.)
- **One spec file per flow under `e2e/offline/`** — matches the qa-matrix
  per-flow convention, keeps retry units and `--grep` ownership clean.
  (Alternative: one big file — rejected, couples unrelated flows into one
  flaky retry unit.)

## Scope Boundaries

**In scope:** the shared offline fixture; schema-validated mock modules for
jobs/estimates/invoices/assistant + baseline shell; four flow specs + one
harness boot spec; the `e2e.yml` placeholder fallback; e2e README section.

**Non-goals:**
- Business-logic assertions against mocked APIs (totals math, status-transition
  legality) — the API is fake; those assertions would test the mock. Contract
  and business-logic proof stays with the real-stack lanes (qa-matrix,
  integration tests), per
  `docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md`.
- Replacing or duplicating the opt-in coverage-sweep (route-load walk) or
  qa-matrix (real backend + DB assertions) lanes.
- WebSocket/SSE *streaming content* coverage (`page.routeWebSocket` voice
  frames, escalation events) — the gating decision makes it unnecessary here.
- Real-Clerk journey specs (signup, onboarding v2) — separate, secret-gated
  concern, untouched.

### Deferred to follow-up work
- Migrate `e2e/no-401-storm.spec.ts` onto the shared fixture (don't churn a
  fresh regression pin in the same change).
- Convert the hybrid gated specs (`e2e/comms-inbox-mobile.spec.ts`,
  `e2e/technician-phone-mobile.spec.ts`, `e2e/onboarding-phone-picker-mobile.spec.ts`)
  to the offline fixture where their assertions don't require real Clerk.
- Add shared response contracts for `/api/notes`, `/api/settings`,
  `/api/assistant/chat` so those mocks can be schema-pinned too.
- `docs/solutions/` entry documenting the offline clerk-stub pattern
  (via `ce-compound` after this ships).
- A `tsc --noEmit` lane covering `e2e/` (Playwright doesn't typecheck).

## Repository invariants touched

- **Integer cents** — all money in mock fixtures is integer cents inside the
  nested `totals` object and `lineItems[].unitPriceCents/totalCents`; the
  shared-schema `parse()` enforces it mechanically.
- **Human-approval gate** — the Assistant spec asserts a proposal renders with
  explicit Approve/Reject controls and that `POST /api/proposals/:id/approve`
  fires only on operator click — pinning "never auto-execute" at the UI seam.
- **UTC times / tenant timezone** — fixture timestamps are ISO-8601 UTC;
  invoice fixtures set `dueDate` deliberately relative to run time because the
  Overdue label is derived client-side
  (`docs/solutions/architecture-patterns/derive-shared-status-rule-across-frontends.md`).
- **RLS/tenant_id, audit events, LLM gateway, Zod proposals, catalog/entity
  resolver** — no product code is modified (the only non-test change is one
  env line in `.github/workflows/e2e.yml`), so these are honored by
  construction; mock entities still carry `tenantId` because the shared
  schemas require it.

## High-Level Technical Design

```mermaid
flowchart TB
  subgraph fixture["offlineTest fixture (e2e/helpers/offline-app.ts)"]
    A[1. installClerkStub signedIn=true] --> B[2. abort external hosts]
    B --> C[3. catch-all /api/* → 200 {} + record unmockedApiCalls]
    C --> D[4. baseline shell mocks:<br/>/api/me (no ai:run) · /api/onboarding/status (complete)<br/>/api/settings · /api/proposals → empty]
    D --> E[5. pageerror + console collectors]
  end
  subgraph test["spec body (e2e/offline/*.spec.ts)"]
    F[6. installXxxMocks(page, state, tracker)<br/>zod-parsed fixtures, stateful handlers] --> G[7. optional per-test override<br/>e.g. 500 on one endpoint — registered last, wins]
    G --> H[assert: rendered data · nav wiring ·<br/>tracker {method,path,body} · error UI]
  end
  fixture --> test
  H --> I[teardown: pageErrors == [] ·<br/>unmockedApiCalls ⊆ allowlist]
```

Route matching is last-registered-wins, so specificity flows downward without
any handler needing to `route.fallback()`.

## Implementation Units

### U1. Offline app fixture + harness boot spec
- **Goal:** One import gives any spec a signed-in, hermetic, error-audited app.
- **Requirements:** R1, R4, R6, R7
- **Dependencies:** none (builds on existing `e2e/helpers/clerk-stub.ts`)
- **Files:**
  - `e2e/helpers/offline-app.ts` (new — `test.extend()` fixture)
  - `e2e/helpers/api-mocks/shell.ts` (new — baseline mocks + fixture types)
  - `e2e/offline/shell-boot.spec.ts` (new — harness self-test)
- **Approach:** Fixture provides `{ page, unmockedApiCalls, pageErrors,
  clerkCounters, apiTracker }`. Registration order per the design diagram.
  Baseline `/api/me` returns a `MeResponse` (shape:
  `packages/shared/src/types.ts`; consumed via `packages/web/src/hooks/useMe.ts`)
  for an owner persona WITHOUT `ai:run`; `/api/onboarding/status` returns the
  complete-status shape already used in `e2e/no-401-storm.spec.ts`;
  `/api/proposals` returns `{data: [], total: 0}`; `/api/settings` returns
  minimal terminology defaults. Skip gate identical to the no-401 suite
  (`E2E_BASE_URL || VITE_CLERK_PUBLISHABLE_KEY`). Teardown asserts
  `pageErrors == []` by default with a per-test opt-out.
- **Patterns to follow:** `e2e/helpers/clerk-stub.ts` (header-comment style,
  counters), `e2e/no-401-storm.spec.ts` (`isApiUrl` predicate,
  `blockExternalHosts`), `e2e/helpers/onboarding-v2-mock.ts` (stateful
  handlers, method guards → `route.continue()`).
- **Test scenarios** (`e2e/offline/shell-boot.spec.ts`):
  - Happy path: goto `/jobs` → Shell nav renders, URL stays `/jobs` (no
    `/login`, no `/onboarding` redirect), zero pageErrors.
  - Harness audit: `unmockedApiCalls` is empty (or matches a documented
    allowlist) after boot — proves the baseline mock set is complete.
  - Poller immunity: wait past one 10s tick; assert no WebSocket connection
    attempt errors and no pageErrors (pins the no-`ai:run` gating decision).
  - Edge: bare env (no key) → all offline specs skip, not fail.
- **Verification:** boot spec green 3× consecutively in this sandbox; suite
  skips cleanly with the env var unset.

### U2. Jobs mocks + exemplar spec
- **Goal:** First full flow proves all four assertion types and the
  override pattern; becomes the template the remaining flows copy.
- **Requirements:** R2, R3, R7
- **Dependencies:** U1
- **Files:**
  - `e2e/helpers/api-mocks/jobs.ts` (new)
  - `e2e/offline/jobs.spec.ts` (new)
- **Approach:** `installJobsMocks(page, state, tracker)` serves `GET /api/jobs`
  (list envelope `{data, total}` — `useListQuery` sends
  `?page&pageSize&search&status`), `GET /api/jobs/:id`
  (`jobDetailResponseSchema`), `POST /api/jobs/:id/transition` (tracker +
  state mutation), plus the detail page's satellites (`/api/time-entries?jobId=`,
  `/api/notes?entityType=job`) with minimal bodies. Fixture factory parses
  under `jobListItemSchema`/`jobDetailResponseSchema` from
  `packages/shared/src/contracts/job.ts` with an embedded
  `jobCustomerSummarySchema` customer.
- **Patterns to follow:** endpoint inventory above (from
  `packages/web/src/components/jobs/JobsList.tsx`, `JobDetail.tsx`);
  `e2e/helpers/onboarding-v2-mock.ts` for tracker/state shape.
- **Test scenarios** (`e2e/offline/jobs.spec.ts`):
  - Happy path: `/jobs` renders seeded customer displayName + status chip from
    the schema-parsed fixture (pins field mapping end-to-end).
  - Navigation: click a row → `/jobs/:id` renders detail content (assert on
    content, not URL — lazy chunks settle after the URL); deep-link direct to
    `/jobs/:id` also renders (detail lives inside the list page component).
  - Action wiring: drive a status transition → tracker's last entry is
    `POST /api/jobs/:id/transition` with body `{status: <target>}`; UI reflects
    the new status from the mutated mock state.
  - Filter wiring: click a status tab → recorded list request includes the
    mapped `status` query param and page resets to 1.
  - Error path: override `GET /api/jobs` to 500 → error state renders, zero
    pageErrors, URL does NOT redirect to `/login` (only 401s may exit).
- **Verification:** spec green 3× in sandbox; `unmockedApiCalls` audit clean or
  allowlisted with a comment naming each endpoint.

### U3. CI placeholder-key fallback
- **Goal:** The offline suite (incl. the existing 401-storm pin) runs on every
  PR with zero secrets configured.
- **Requirements:** R4, R5
- **Dependencies:** U2 (land the lane with real content already green)
- **Files:**
  - `.github/workflows/e2e.yml` (modify one env line)
  - `e2e/README.md` (document the fallback + how to run locally)
- **Approach:** Change `VITE_CLERK_PUBLISHABLE_KEY: ${{ secrets.E2E_CLERK_PUBLISHABLE_KEY }}`
  to `${{ secrets.E2E_CLERK_PUBLISHABLE_KEY || '<placeholder>' }}` where the
  placeholder is `pk_test_` + base64 of a dummy domain ending `$` (clerk-react
  parses the key at provider mount, so it must be syntactically valid — reuse
  the exact literal already proven in this sandbox). `E2E_CLERK_SECRET_KEY`
  gates (journeys, test DB, onboarding-v2 flag) stay untouched. Note: the 4
  smoke-ui specs gate on the same env var and will run-and-fail on runners
  where Clerk's CDN is unreachable — GitHub-hosted runners have egress, so
  with a *placeholder* key the Clerk widget fetch targets a nonexistent
  instance; those specs' gating must be reviewed: tighten smoke-ui's skip to
  require a REAL key (`E2E_CLERK_PUBLISHABLE_KEY` secret-derived env, not the
  placeholder) so the fallback doesn't turn 4 green skips into 4 red failures.
- **Patterns to follow:** existing env-block comments in `e2e.yml` (block
  ownership markers).
- **Test scenarios:** `Test expectation: none — CI config`; verified by
  behavior (below) rather than a test file. Locally simulate both modes:
  placeholder key → offline specs run + smoke-ui skips; real-key env shape →
  identical offline behavior (stub short-circuits).
- **Verification:** a PR from this branch shows the e2e workflow executing the
  offline specs (not skipping), smoke-ui skipping (not failing), journeys
  skipping as today.

### U4. Estimates mocks + spec
- **Goal:** Cover the heaviest-fan-out flow, including the optimistic-lock and
  send wiring.
- **Requirements:** R2, R3
- **Dependencies:** U2 (template)
- **Files:**
  - `e2e/helpers/api-mocks/estimates.ts` (new)
  - `e2e/offline/estimates.spec.ts` (new)
- **Approach:** Mocks for `GET /api/estimates` (list), `GET /api/estimates/:id`
  (`estimateResponseSchema`), `POST /api/estimates/:id/send` (validate body
  against the send-channel request shape; respond `{viewUrl, viewToken}`),
  `PUT /api/estimates/:id` (validate against `updateEstimateSchema` from
  `packages/api/src/shared/contracts.ts`; capture the `If-Match` version
  header), satellites (`/api/estimates/:id/history`, `/api/notes?entityType=estimate`,
  `/api/jobs/:jobId` enrichment, `/api/settings` doc-preview business name).
  Deep-linking `/estimates/:id` fires BOTH list and detail queries
  (`defaultSelectedId` architecture) — mocks must serve both.
- **Patterns to follow:** U2 template; status-tab map `API_STATUS_FOR_TAB` in
  `packages/web/src/components/estimates/EstimatesPage.tsx` (Sent →
  `ready_for_review`, Approved → `accepted`, Declined → `rejected`).
- **Test scenarios** (`e2e/offline/estimates.spec.ts`):
  - Happy path: list renders estimate number + nested-totals amount from the
    parsed fixture (integer cents → formatted currency).
  - Navigation: deep-link `/estimates/:id` renders detail (both queries served).
  - Action wiring: Send flow → tracker records `POST /api/estimates/:id/send`
    with a body that parses under the server's send schema; success UI shows.
  - Optimistic lock: line-item edit → `PUT` carries `If-Match` with the
    fixture's `version` (pins the concurrency header wiring).
  - Error path: 500 on detail → detail error state, list still healthy, zero
    pageErrors.
- **Verification:** spec green 3× in sandbox; request-body validation
  demonstrably fails the test if a required field is dropped from the send
  body (mutation-test it once manually during implementation).

### U5. Invoices mocks + spec
- **Goal:** Cover invoices incl. the derived-Overdue rule and payment
  recording.
- **Requirements:** R2, R3, R7
- **Dependencies:** U2 (template)
- **Files:**
  - `e2e/helpers/api-mocks/invoices.ts` (new)
  - `e2e/offline/invoices.spec.ts` (new)
- **Approach:** Mocks for `GET /api/invoices` (list; **the list refetches every
  30s** — handler must be idempotent and pause-aware assertions avoided),
  `GET /api/invoices/:id` (`invoiceResponseSchema`), `POST /api/payments`
  (validate body against `recordPaymentSchema` — `{invoiceId, amountCents,
  method}`, integer cents), `GET /api/leads/:id` (origin attribution),
  `/api/notes?entityType=invoice`. One fixture with `dueDate` in the past and
  `status: 'open'` to exercise the client-derived Overdue label.
- **Patterns to follow:** U2 template;
  `packages/web/src/components/invoices/InvoicesPage.test.tsx` fixture shapes
  (nested `totalsOf(cents)` — its comment documents the flat-totals bug);
  `docs/solutions/architecture-patterns/derive-shared-status-rule-across-frontends.md`.
- **Test scenarios** (`e2e/offline/invoices.spec.ts`):
  - Happy path: list renders amounts and the past-due fixture shows the
    Overdue-derived label (pins `deriveInvoiceUiStatus` against a real render).
  - Navigation: list → detail renders line items + amount due.
  - Action wiring: record payment → tracker's last entry is
    `POST /api/payments` whose body parses under `recordPaymentSchema`; UI
    moves to paid state from mutated mock state.
  - Error path: 500 on `POST /api/payments` → error surface, invoice stays
    unpaid, zero pageErrors.
- **Verification:** spec green 3× in sandbox including a run that straddles a
  30s list-refetch tick (no flake from the poller).

### U6. Assistant mocks + spec
- **Goal:** Cover the assistant chat → proposal → human-approval wiring.
- **Requirements:** R2, R3; invariant: human-approval gate
- **Dependencies:** U2 (template)
- **Files:**
  - `e2e/helpers/api-mocks/assistant.ts` (new)
  - `e2e/offline/assistant.spec.ts` (new)
- **Approach:** Mocks for `POST /api/assistant/chat` (respond
  `{message: {content, proposal}, conversationId}` with a proposal that parses
  under `proposalResponseSchema` from `packages/shared/src/contracts/proposal.ts`),
  `POST /api/proposals/:id/approve`, `POST /api/proposals/:id/reject`,
  `PUT /api/proposals/:id` (edits). Fresh mount with no `conversationId` in
  URL/localStorage fires no conversation fetch — keep localStorage clean per
  test. Voice upload/session endpoints are out of scope (no user activation in
  these tests); the catch-all covers strays.
- **Patterns to follow:** U2 template;
  `packages/web/src/components/assistant/AssistantPage.test.tsx` for message/
  proposal shapes rendered by `AIProposalCard`.
- **Test scenarios** (`e2e/offline/assistant.spec.ts`):
  - Happy path: type + send → tracker records `POST /api/assistant/chat` with
    the typed message in `messages`; assistant bubble renders mock content.
  - Approval gate: proposal card renders with explicit Approve control;
    NO approve call fires before click; after click, tracker records
    `POST /api/proposals/:id/approve` (pins never-auto-execute at the UI seam).
  - Reject path: reject click → `POST /api/proposals/:id/reject` recorded.
  - Error path: 500 on chat → error/retry affordance renders, zero pageErrors,
    prior conversation bubbles remain.
- **Verification:** spec green 3× in sandbox; approval-gate scenario fails if
  an auto-approve regression fires the approve call without a click (verify by
  temporarily auto-firing in the mock during implementation — mutation test).

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Mock drift from the real API (top risk; two prior learnings) | Runtime Zod `parse()` on both directions (R2); assertion weight on request wiring; qa-matrix/coverage-sweep remain the real-stack backstop; explicitly out of scope to assert business logic against mocks |
| CI fallback turns smoke-ui skips into failures on egress-enabled runners | U3 explicitly tightens smoke-ui gating to require a real (secret-derived) key — placeholder must not satisfy it |
| Pollers/StrictMode flake | Idempotent GET handlers, tracker-based mutation assertions, no GET-count assertions (R7) |
| `/api/ws` connection noise | `/api/me` mock omits `ai:run`; if a future flow needs the voice wall, add `routeWebSocket` then (deferred) |
| Playwright TS not typechecked | Runtime schema parsing is the enforcement; a `tsc` lane for `e2e/` is deferred follow-up |
| Detail-inside-list-page architecture changes (routes split later) | Specs assert on rendered content, never on component internals; deep-link scenarios keep working through a route refactor |

## Open Questions (deferred to implementation)

- Exact `MeResponse.permissions` strings for an owner-without-`ai:run` persona —
  read from the server's rbac map at implementation time rather than inventing.
- Which mutation endpoints beyond payments/estimate-update have importable
  request schemas in `packages/api/src/shared/contracts.ts` (jobs transition,
  estimate send, assistant chat) — map each during U2/U4/U6; where none exists,
  tracker-only assertions and a note in the deferred-contracts follow-up.
- The exact list envelope key names `useListQuery` expects (`{data, total}` per
  research) — confirm against `packages/web/src/hooks/useListQuery.ts` before
  writing the first factory.
- Whether `/api/estimates/:id/history` and notes must return non-empty bodies
  for the detail page to render cleanly, or lazy sections tolerate `200 {}`.
- Whether importing `packages/api/src/shared/contracts.ts` into e2e helpers
  pulls in server-only transitive imports; if so, re-export the needed request
  schemas through `packages/shared` instead (small follow-up inside U4/U5).
