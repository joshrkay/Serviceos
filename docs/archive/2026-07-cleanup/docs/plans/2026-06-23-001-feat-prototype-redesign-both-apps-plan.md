# feat: ServiceOS Redesign — Mobile + Desktop to the New Prototype Brand & Flows

**Created:** 2026-06-23
**Depth:** Deep
**Status:** plan
**Design source:** `design_handoff_serviceos_mobile/` (README.md, SCREEN-MAPPING.md, TESTING.md, `designs/*.dc.html` — ~50 phone screens + iPad variants)
**Companions:** `docs/mobile/workflows.md`, `docs/mobile/owner-operator-app-spec.md`, `docs/plans/2026-06-19-001-feat-mobile-mvp-owner-operator-plan.md`

## Summary

Re-skin and re-flow **both** front-ends — `packages/mobile` (Expo/React Native) and
`packages/web` (React/Vite) — to the new ServiceOS design handoff, **wiring every
redesigned screen to APIs that already exist** and **migrating the entire automated-test
suite** to the new structure. This is overwhelmingly a **front-end + test** effort: the
research pass confirmed the backend (`packages/api`) already exposes full read+write
coverage for every design domain, so the deliverable is a *working* product — each flow
resolves to a real endpoint, and where a design implies an endpoint that doesn't exist
we map it onto the real mechanism (usually the proposal model) rather than inventing
backend.

Three product decisions are **locked** (confirmed with the owner, 2026-06-23):

1. **Path A — adopt the new brand** (blue `#1F5FD6`, Bricolage Grotesque + Hanken
   Grotesk, warm canvas, 18px cards) across both apps, via the shared token files.
2. **Bottom tab bar** for mobile (Home · Assistant · Customers · Jobs · Settings),
   implemented once as an Expo Router tab layout.
3. **Adapt the design system to desktop** — apply the new brand + components to web and
   extrapolate wider layouts from the mobile/iPad designs (no separate desktop comps
   exist).

## Problem Frame

The prototypes and the shipped apps are two different visual languages, and the mobile
app's screens are mostly thin list shells (`EntityList`) with no detail/wizard routes
and a hub-of-cards home. The new designs specify high-fidelity layout, copy, and every
interaction state (loading / empty / error / success / in-progress / undo). We want the
apps to *look and flow like the prototypes* while continuing to honor the product's hard
invariants (human-approval gate + 5s undo, integer-cent money, UTC→tenant-tz rendering,
≥44px tap targets, no 320px overflow, catalog-grounded prices). The risk is doing a
re-skin that drifts from the real API contracts or silently breaks the ~250 existing
tests; this plan makes the API mapping and the test migration first-class.

## Goals / Non-Goals

**Goals**
- Both apps match the prototype brand (Path A) and the prototype flows.
- Mobile gains the persistent tab bar, the voice overlay on every screen, and all the
  "New" routes (wizards, detail screens, tech views, leads, calls, notifications,
  settings sub-pages).
- Every screen is wired to an existing API (or an explicitly-flagged small gap).
- The full test suite is migrated: class-contract tests updated to new tokens/classes,
  new screens get their own contract + viewport tests, behavior tests preserved.

**Non-Goals (this plan)**
- No new business logic on the server. Net-new backend is limited to the small,
  explicitly-listed gap endpoints in §"API Reconciliation" — and only after verifying
  they don't already exist under another name.
- No change to the proposal/approval semantics (D-004 never auto-execute; 5s undo).
- Customer-facing public flows (estimate approval, pay, booking) stay in `packages/web`;
  mobile only links to them.
- Not retiring the web app — it's the desktop target and the host of public/portal flows.

## Requirements

- **R1.** A single shared brand: update `packages/mobile/src/theme/tokens.js` and
  `packages/web/src/index.css` to the Path A palette/radii, wire Bricolage + Hanken via
  `expo-font` (mobile) and `@font-face`/link (web). One change point; semantic token
  classes (`bg-primary`, `text-foreground`, …) resolve to the new brand everywhere.
- **R2.** Mobile navigation becomes an Expo Router tab group (5 tabs) + a shared voice
  overlay affordance reachable from every route; the canonical approve+5s-undo machine
  (`useProposalReview`) is preserved exactly.
- **R3.** Every prototype screen is built/upgraded to its mapped route at the design's
  fidelity and full state coverage, reusing `EntityList` / `useListQuery` /
  `useDetailQuery` and the existing domain hooks — never re-rolling data access.
- **R4.** Every screen's reads and writes resolve to an **existing** endpoint per the API
  Reconciliation table; design-implied endpoints that don't exist are mapped to the real
  mechanism (proposals / conversations / appointments) or flagged as a small gap with an
  owner decision.
- **R5.** Desktop (`packages/web`) is re-skinned via the UI kit (`components/ui/*`) +
  `index.css` tokens + `Shell.tsx`, and re-flowed to match the prototype patterns,
  extrapolated to wide layouts.
- **R6.** Test migration is part of each slice: (a) update the ~42 web class-coupled
  tests + the mobile screen contract tests to the new classes/copy; (b) add contract +
  Playwright viewport tests for every new mobile screen; (c) keep mobile coverage
  thresholds (statements 92 / branches 72 / functions 88 / lines 92) green; (d) keep the
  ~160 behavior-only web tests passing unchanged.
- **R7.** Invariants hold on every redesigned surface: integer-cent money via
  `formatMoney`/`formatMoneyShort`, UTC→tenant-tz rendering, ≥44px (`min-h-11`) targets,
  no horizontal overflow at 320px, catalog-grounded line-item prices (uncatalogued lines
  cap confidence below auto-approve).
- **R8.** No regression to the Railway api/web build or CI; mobile typecheck + vitest +
  Playwright viewport gates stay green.

## Key Technical Decisions

- **Path A is a token swap, not a per-screen restyle.** Both apps already drive color
  through semantic tokens (mobile `tokens.js` → CSS vars → NativeWind; web `index.css`
  `@theme`). We change the *values* and add fonts once; screens inherit. This is what
  makes a two-app rebrand tractable. (Locked.)
- **Tab bar = one Expo Router `(tabs)` layout.** Move the five primary routes under a tab
  group; keep secondary routes as pushed stacks per tab so back-stacks and scroll
  position are preserved. (Locked.)
- **Voice overlay is a shared shell affordance, not a route rebuild.** The capture/
  transcribe logic (`useVoiceCapture`) is unchanged; we add a top-center mic that opens a
  bottom sheet over the current route and feeds screen context to the assistant. (Per
  handoff "Assistant overlay-on-any-screen".)
- **Wire to the proposal model, not imagined REST.** Schedule mutations (reschedule /
  unschedule / no-show / cancel), and any "needs approval" write, go through
  `POST /api/proposals` + the approve/undo lifecycle — *not* the `/jobs/:id/reschedule`-
  style endpoints the design mocks imply. Messaging uses `/api/conversations/*`; calls
  use `/api/voice-sessions` + `/api/calls/*`. (See API Reconciliation.)
- **Desktop adapts the same component vocabulary.** Web keeps its shadcn/radix `ui/*`
  kit; we restyle those primitives to the brand and re-flow pages to mirror the prototype
  patterns at desktop width — we do **not** port RN screens to web. (Locked.)
- **Test migration is woven per-slice, not a final pass.** Each screen ships with its
  tests updated/added in the same commit (repo rule). Class-coupled web tests fail loudly
  with className diffs after the token swap and are fixed slice-by-slice.

## API Reconciliation (the "working product" backbone)

Research confirms **full existing coverage**; the table below maps design-implied
actions to the **real** endpoint so nothing is wired to a nonexistent route. Genuine
candidate gaps are flagged `⚠ VERIFY` and resolved in Phase 0 (confirm-or-add).

| Design action / screen | Design-implied (mock) | Real existing mechanism |
|---|---|---|
| Approvals list / Home pending | — | `GET /api/proposals/inbox` |
| Approve / reject / undo / edit / resolve-line / batch | — | `POST /api/proposals/:id/{approve,reject,undo,re-propose}`, `PUT /api/proposals/:id`, `POST /api/proposals/:id/resolve-line`, `POST /api/proposals/approve-batch` |
| Reschedule / unschedule / no-show job | `POST /jobs/:id/*` | `POST /api/proposals` (`reschedule_appointment`/`reassign_*`) → approve; or `PUT /api/appointments/:id` |
| Cancel appointment | `DELETE /jobs/:id` | `POST /api/jobs/:id/cancel` + `cancel_appointment` proposal (irreversible lane) |
| Messaging threads / send | `GET /threads`, `POST /threads/:id/messages` | `GET /api/conversations[/:customerId[/history]]`, `POST /api/conversations/:customerId/send-sms` |
| Calls list / detail | `GET /calls[/:id]` | `GET /api/voice-sessions`, `POST /api/calls/*`, `GET /api/voice/*` |
| Estimate wizard (create/send) | — | `POST /api/estimates`, `PATCH`, `POST /api/estimates/:id/send` |
| Invoice wizard (from job/estimate/blank, send, mark paid) | — | `POST /api/invoices` (+`/batch`), `POST /api/invoices/:id/{send,issue,mark-paid}`; convert via estimate→invoice |
| Customer add/edit | — | `POST /api/customers`, `PUT /api/customers/:id` (+contacts/tags/custom-fields) |
| New job | — | `POST /api/jobs` (+`/from-lead`), `PUT /api/jobs/:id` |
| Job photos | — | `POST/GET/DELETE /api/jobs/:jobId/photos` |
| Time tracking (clock in/out) | `POST /time-entries` | `GET/POST /api/time-entries` exist — **⚠ update/delete missing** |
| Expense capture | `POST /expenses` | **⚠ VERIFY** — likely job line-item/catalog write; confirm route or add small endpoint |
| Job debrief | `POST /jobs/:id/debrief` | **⚠ VERIFY** — map to notes (`POST /api/notes`) + status update, or add |
| Notifications history | `GET /notifications` | **⚠ VERIFY** — push *registration* exists (`/api/devices`); no history GET found. Confirm or add read-only list |
| Proposal execution status | — | Read `proposal.status` (no dedicated logs GET) — **⚠ optional** add if the UI needs detail |
| Team & roles | — | `GET /api/users`, `POST /api/users/invite`, `PATCH /api/users/:id` |
| Voice / lane / brand-voice settings | — | `GET/PATCH /api/settings`, `GET /api/settings/voice`, `POST /api/voice/auto-approve-toggle`, AI-approval-rules settings |
| Leads inbox / detail / convert | — | `GET /api/leads[/:id]`, `PATCH`, `POST /api/leads/:id/{convert,mark-lost}`, public `POST /public/intake/:tenantId/leads` |
| Public estimate-approval / pay / booking (web) | — | `/public/estimates/:token/*`, `/public/invoices/:token/*`, `/public/portal/:token/*` |

**Phase 0 exit criterion:** the four `⚠ VERIFY` rows are each resolved to "exists (route
X)" or "small additive endpoint, scoped as a sub-task with tenant_id+RLS+audit+integration
test per CLAUDE.md." No screen proceeds to build on an unresolved write.

## Workstreams & Phases

Sequenced so the **shared foundation** lands first (cheap, global), then mobile (the
designs' primary target), then desktop adaptation, with **tests in every slice**.

### Phase 0 — Foundation & reconciliation (shared)
- **0.1 Brand tokens.** Update `packages/mobile/src/theme/tokens.js` + regenerate
  `tokens.d.ts`; update `packages/web/src/index.css` `@theme`/CSS vars to the Path A
  palette (foreground `#16202E`, primary `#1F5FD6`, background `#F6F4EF`, card `#fff`,
  border `#ECE8E0`, destructive `#C23B3B`, success `#1F8A5B`, …), radii (cards 18 / xl),
  both light + dark values. Update `tokens.test.ts` (mobile) + any token assertions.
- **0.2 Fonts.** Wire Bricolage Grotesque (headings) + Hanken Grotesk (body) via
  `expo-font` in mobile `_layout`, and via web font-face/link; add `font-bricolage`/
  `font-hanken` utilities.
- **0.3 API reconciliation.** Resolve the four `⚠ VERIFY` rows; file sub-tasks for any
  genuinely-missing small endpoints (expenses, debrief, notifications list, time-entry
  update/delete) — each with the mandated tenant_id/RLS/audit/integration-test.
- **0.4 UI-kit brand pass (web).** Restyle `packages/web/src/components/ui/*` (button,
  card, input, badge, modal, sheet, tabs, stepper…) to the brand; update
  `primitives.test.tsx`/`modal`/`tabs`/`sheet` contract tests as needed.
- *Acceptance:* both apps build + typecheck; design tokens render brand; font smoke
  test; reconciliation doc updated; no behavior tests broken.

### Phase 1 — Mobile navigation shell + voice overlay
- **1.1** Introduce Expo Router `(tabs)` group: Home (`index`), Assistant (`voice`),
  Customers, Jobs, Settings; move secondary routes under per-tab stacks. Tab bar styled
  to brand, ≥44px targets, safe-area aware.
- **1.2** Shared voice-overlay affordance (top-center mic) mounted in the shell; opens a
  bottom sheet using `useVoiceCapture`; passes current-route context. Keep the standalone
  `voice` screen.
- **1.3** Tests: new `tabs` layout contract test (tab targets, active state, no 320px
  overflow), overlay contract test, Playwright viewport spec for the shell.
- *Acceptance:* every route reachable via tabs; mic overlay opens on any screen; viewport
  e2e green at 320/390.

### Phase 2 — Mobile: existing screens to fidelity (Exists/Extend)
Bring the 8 implemented screens up to the design and full state coverage; update each
screen's `src/screens/*.test.ts` contract test to new classes/copy.
- Home/Dashboard (`app/index.tsx`): snapshot tiles, pending-proposals hero, Voice-ROI
  card, activity feed → `useMe`/`useMoneyDashboard`/`usePendingProposals`.
- Approvals (`app/approvals.tsx`): proposal cards w/ confidence + countdown + "Approve
  all" sheet (uses `approve-batch`).
- Proposal review (`app/proposals/[id].tsx`): match the canonical machine **exactly**
  (preserve `useProposalReview`).
- Customers list + detail; Estimates list; Invoices list; Messages + thread; Settings
  hub; Voice/Assistant (overlay extension).
- *Acceptance:* each screen matches design states; contract tests updated; coverage stays
  ≥ thresholds.

### Phase 3 — Mobile: new flows (New)
Grouped as shippable vertical slices (spine + per-type affordance + tests), ordered by
product value (money loop first, per `docs/mobile/workflows.md`):
- **S1 Money-in:** Invoice detail (`invoices/[id]`), New-Invoice 3-step wizard
  (`invoices/new`, from job/estimate/blank), catalog add/remove sheet, mark-paid. Wire
  to `/api/invoices/*` + catalog resolver.
- **S2 Quoting:** Estimate detail/approved state, Estimate Builder 3-step
  (`estimates/new`), tiers + send.
- **S3 Schedule & jobs:** Schedule List/Day/Week/Map (`schedule` extend), New Job
  (`jobs/new`), Job Detail (`jobs/[id]`), TechJobView (tech mode + iPad), Job Photos,
  Tech Out Reschedule, Time Tracking, Expense Capture, Job Debrief, Driving Mode. Schedule
  mutations via proposals.
- **S4 Customers & leads:** Add/Edit Customer (`customers/new`+edit), Leads inbox/detail
  (`leads`, `leads/[id]`) + convert.
- **S5 Comms:** Call Log/Detail (`calls`, `calls/[id]`), Inbound-Call states, Message
  Templates.
- **S6 Settings & oversight:** Team & Roles, Voice/Brand-Voice, Lane settings, Billing,
  Lead Sources, Notifications (`notifications`), Onboarding, Weekly Digest / End-of-Day
  Review, Reviews.
- *Each slice:* new route(s) + reuse hooks + new contract test(s) + Playwright viewport
  coverage; integration test if it touches a new endpoint.

### Phase 4 — Desktop (web) re-skin + re-flow
- **4.1** Global chrome: restyle `Shell.tsx` (sidebar/topbar, mode toggle, proposal
  badge) to brand; update `Shell-mode`/`Shell.proposals` tests.
- **4.2** Page-by-page brand + flow alignment to the prototype patterns at desktop width,
  reusing the now-branded `ui/*` kit. Prioritize the 5 public customer pages
  (Estimate-Approval, Booking, Intake, Invoice-Pay, Feedback) — they have explicit
  layout-contract tests and are the highest design scrutiny.
- **4.3** Update the ~42 class-coupled web tests as their screens change; keep ~160
  behavior tests green.
- *Acceptance:* web matches brand + flows at desktop; `npm run test` green; e2e smoke +
  layout specs green.

### Phase 5 — Test migration hardening & sweep
- Reconcile coverage thresholds; add any missing new-screen contract/viewport tests.
- Run mobile `typecheck + vitest + e2e:viewport`; web `test + e2e` (+ qa-matrix on
  demand); api build (`tsc --project tsconfig.build.json`).
- *Acceptance:* all gates green on the branch; coverage ≥ mobile thresholds.

## Test Strategy (R6 detail)

| Layer | Mobile | Web |
|---|---|---|
| Unit/pure | `tokens.test.ts`, `format`, `greeting` (update brand values) | `currency`, `lineItems`, `formatInTenantTz` (unchanged) |
| Class-contract | `src/screens/*.test.ts` — update `min-h-11`/copy/new classes; add one per new screen | ~42 className tests (EstimateApproval/Booking/Feedback/Shell layout…) updated to new classes |
| Hook/behavior | `useProposalReview`, `useListQuery`, etc. — **unchanged** | ~160 behavior tests — **unchanged** |
| Viewport e2e | Playwright `e2e/*` at 320/390 — extend to new screens (no-overflow, ≥44px) | e2e smoke + `*-mobile.spec.ts` layout specs |
| Coverage gate | keep 92/72/88/92 | keep existing threshold |

Migration rule: a screen and its tests change in the **same commit**; class-coupled
tests are expected to fail with explicit className diffs after Phase 0 and are fixed in
the slice that touches that screen.

## Sequencing & Milestones

1. **M0** Phase 0 — brand tokens + fonts + reconciliation + web UI-kit pass.
2. **M1** Phase 1 — mobile tab shell + voice overlay.
3. **M2** Phase 2 — mobile existing screens to fidelity.
4. **M3** Phase 3 S1–S2 — money-in + quoting (the promise that pays for the app).
5. **M4** Phase 3 S3–S6 — schedule/jobs, customers/leads, comms, settings/oversight.
6. **M5** Phase 4 — desktop re-skin + re-flow.
7. **M6** Phase 5 — test hardening + full-suite green.

Mobile and desktop share Phase 0; after that they can run as parallel tracks if staffed,
but the plan assumes mobile-first (it is the designs' native target) then desktop.

## Risks & Mitigations

- **Token swap breaks many web tests at once.** *Mitigation:* expected; class-coupled
  tests fixed slice-by-slice (loud className diffs), behavior tests untouched.
- **Design implies endpoints that don't exist.** *Mitigation:* the API Reconciliation
  table + Phase 0 `⚠ VERIFY` gate; wire to proposals/conversations, add only the small
  flagged endpoints with full repo ceremony.
- **Tab-bar refactor regresses deep-link/push routing.** *Mitigation:* preserve
  `useNotificationRouter` targets; add nav contract + viewport tests in Phase 1.
- **Catalog grounding bypassed in new wizards.** *Mitigation:* line-item sheets resolve
  through the catalog resolver; uncatalogued lines cap confidence — pinned by tests.
- **iPad/desktop extrapolation ambiguity.** *Mitigation:* iPad designs as the wide
  reference; desktop decisions logged as they arise.
- **Scope is large.** *Mitigation:* vertical slices are independently shippable; money-in
  first; backend already supports all of it so slice order is a product call.

## Open Questions / Decision Log

- **Locked:** Path A brand · bottom tab bar · adapt design system to desktop.
- **To resolve in Phase 0 (`⚠ VERIFY`):** expenses endpoint, job-debrief endpoint,
  notifications-history GET, time-entry update/delete — confirm-or-add.
- **Deferred:** dedicated desktop comps (extrapolating for now); conversational SSE on
  mobile; native camera deep features.

## Acceptance Criteria (program)

- Both apps render the Path A brand from the shared token files; Bricolage/Hanken load.
- Mobile uses the 5-tab bar + voice overlay; every prototype screen exists at fidelity
  with full state coverage; the approve+5s-undo machine is unchanged.
- Every screen's reads/writes hit an existing endpoint (or a Phase-0-approved small one).
- Desktop matches the brand + flows at desktop width.
- Full suite green: mobile (typecheck + vitest ≥ thresholds + Playwright viewport), web
  (vitest + e2e), api build — with all new screens covered by contract + viewport tests.

## Appendix — Screen → Route → Status → Primary API → Tests

See `design_handoff_serviceos_mobile/SCREEN-MAPPING.md` for the per-screen route map and
the agent inventory for full state/data detail. Status legend: Exists / Extend / New.
Phase 2 = Exists/Extend to fidelity; Phase 3 = New (by slice S1–S6); Phase 4 = web.
