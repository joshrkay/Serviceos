# feat: Rivet iOS App — Master Blueprint (audit + completion plan)

**Created:** 2026-07-20
**Depth:** Deep
**Status:** plan

## Summary

The single source of truth for the Rivet mobile app (`packages/mobile`,
one Expo binary per D-021, iOS-first). It documents what is **built and
wired** (a code-grounded audit of all ~40 workflows in
`docs/mobile/workflows.md` §4), and plans **implementation units for every
gap** — spine-safety fixes, per-workflow affordances, the post-v1 offline
queue and conversational assistant, and the App Store release. v1 ships as
currently scoped (store metadata stays honest at every commit); offline
queue and the SSE assistant are explicitly post-v1 phases.

## Problem Frame

The app is ~80% built and API-wired, but the remaining 20% is not evenly
spread — three of the gaps sit in the product's safety/promise spine:

1. **Approval-lane safety is not mirrored client-side.** The review screen
   approves every proposal type with one tap
   (`packages/mobile/app/proposals/[id].tsx:128-142`); the catalog's rule
   (workflows.md §3) that money / comms / irreversible actions always get
   an explicit confirm exists only as server-side routing. A mis-tap can
   send an invoice or cancel an appointment with nothing but the 5s undo.
2. **The read-only E-lane is dead.** `lookup_*` intents on the recorded-memo
   path are deliberately skipped server-side
   (`packages/api/src/workers/voice-action-router.ts:1232` — "no voice
   back-channel"), and the mobile capture flow routes every outcome to
   `/approvals`. "What's my balance?" spoken into the app silently does
   nothing — half of "we handle the rest" is missing.
3. **Edit-before-approve (F4) doesn't exist** — no `PUT /api/proposals/:id`
   call anywhere in mobile — yet the store listing and App Review notes
   claim "Approve / Edit / Reject". An honesty gap App Review can trip on.

Beyond the spine: ~15 workflows lack their per-type affordance (details in
the coverage matrix), two settings screens are orphaned, and the offline
story is reconnect-heal only (as scoped for v1).

## Requirements

- R1. Every workflow in the catalog (A1–A10, B1–B7, C1–C8, D1–D3, E1–E9,
  F1–F6) has a working mobile affordance, or an explicit documented
  exclusion in this plan.
- R2. Money / comms / irreversible proposals require an explicit,
  lane-aware confirm on mobile (client mirror of the server rule);
  capture-class stays one-tap.
- R3. Read-only voice asks (E1–E6, D3) return a spoken/onscreen answer in
  the capture flow.
- R4. Edit-before-approve works end-to-end (`PUT /api/proposals/:id`),
  making the existing store copy true.
- R5. Store metadata is honest at every commit: no claim ships before the
  behavior; behavior changes that touch claims update
  `packages/mobile/store/` in the same unit.
- R6. Post-v1: offline queueing of voice recordings + capture-class
  approvals with safe replay (server idempotency prerequisite).
- R7. Post-v1: conversational voice assistant over the existing
  voice-session API (header-auth streaming; graceful degrade).
- R8. iOS release executed per `docs/mobile/ios-app-completion-prompt.md`
  (TestFlight → dual-persona verification → App Review).
- R9. Hygiene: orphaned screens wired or deleted; every unit carries its
  tests per CLAUDE.md (unit + handler-level; Docker-gated integration for
  DB-touching API changes; jsdom class-contract + Playwright viewport for
  mobile UI).

## Key Technical Decisions

- **Client lane gates consume `packages/shared/src/contracts/proposal-action-class.ts`** —
  it already mirrors the API's authoritative `actionClassForProposalType`
  in lockstep (parity-tested against the API source). No new shared work;
  never re-derive lanes in mobile. (Alternative — new client-side mapping —
  rejected: guaranteed drift; see
  `docs/solutions/architecture-patterns/derive-shared-status-rule-across-frontends.md`.)
- **E-lane answers ride the recorded-memo path, not sessions (v1).** The
  worker's lookup branch executes the lookup skill (`ai/skills/lookup-*`
  already return `{summary, data}`) and persists the answer on the
  recording result; the client renders an answer card from the poll it
  already does. (Alternative — client re-sends transcript to a text-in
  voice session — rejected for v1: duplicates turn infra, online-only,
  session lifecycle overhead; sessions are the post-v1 assistant's
  transport, U13.) The recording result *is* the back-channel the worker
  comment says is missing.
- **Manual lifecycle actions use direct, human-initiated endpoints where
  they exist** (e.g. `sendInvoice` in `packages/mobile/src/api/invoices.ts:32`,
  estimate create&send). Proposals remain the AI path; both audit
  server-side. Where no direct endpoint exists (issue invoice, late fee),
  prefer adding the server route over client-minted proposals — see Open
  Questions.
- **One binary, mode-aware surfaces (D-021).** No separate technician app;
  role/`current_mode` selects the surface. All new screens follow
  `src/navigation/personaNav.ts` gating.
- **Offline queue (U12) is capture-class-only and journaled in
  `documentDirectory`.** Approvals flush before voice; a replayed approve
  that 409s is dropped as "resolved elsewhere" (server `ConflictError` on
  any invalid transition is the safety proof); voice replay safety
  requires the U11 server idempotency fix — a hard prerequisite. Audio
  files move out of the OS-evictable cache dir at enqueue time. Store
  copy (`app-review-notes.md:51,94`) updates in the same unit (R5).
- **Assistant transport: `expo/fetch` streaming with the Clerk token in the
  `Authorization` header** — zero server change; the `?token=` query
  fallback was deliberately removed server-side (leaks to logs). SSE
  parsing lives in a transport-agnostic pure module; `react-native-sse` is
  the named plan-B; the synchronous `POST /:id/input` round-trip (which
  already returns `{state, ttsText, ttsAudio, proposalIds, ended}`) is the
  degrade path.
- **v1 store scope is unchanged until the matching unit lands** — offline
  claims appear only with U12; the "Edit" claim becomes true with U2 (or
  is removed from copy if U2 slips past submission).

## Scope Boundaries

**In scope:** everything in the coverage matrix below; the two post-v1
platform features (offline queue, assistant); the App Store release
execution; hygiene fixes surfaced by the audit.

**Non-goals:**
- Android/Play release execution (config exists; runbook covers it; not
  planned here).
- OTA updates (`expo-updates`) — out of scope for v1 per the release
  runbook.
- Web-app changes beyond none; API changes only where a mobile workflow
  requires them (U3, U11, possibly U5/U7 routes).
- Real-time streaming STT on device (server P8-012 territory).
- Operator-configurable undo window (server `UNDO_WINDOW_MS` fixed at 5s).

### Deferred to follow-up work
- Chain/grouping visualization for `batch_invoice` fan-out (A10) in the
  inbox — batch-approve works today; grouping is polish.
- Expo push **receipt polling** (`expo-push-service.ts:22-25` documented
  follow-up) — ticket-level pruning exists; async receipts are backend
  work, not mobile-blocking.
- Recent-activity feed pagination/virtualization if the feed grows.
- Technician-targeted push types (proposal pushes are approver-only by
  design; a field-facing push lane is a product decision, not a gap).

## Repository invariants touched

- **Human-approval gate (D-004):** U1 *strengthens* the client mirror
  (lane-aware confirms); nothing in this plan auto-executes anything.
- **Integer cents:** all line editors (U2, U6, U9) and the late-fee/
  reminder affordances (U5) render/edit cents via existing formatters
  (`src/lib/format.ts`); no float math client-side.
- **UTC / tenant timezone:** slot picker (U7) and availability rendering
  use tenant-tz rendering like `src/lib/technicianDay.ts` does today.
- **Audit events:** all mutations land on existing audited server routes;
  new routes added by U3/U11 (and possibly U5/U7) must audit like their
  siblings.
- **LLM gateway + catalog resolver + entity resolver:** untouched — U3
  executes existing lookup skills server-side; no client-side AI calls;
  clarification chips (F1) already consume the resolver output.
- **Zod contracts:** new payload shapes (recording answer in U3, queue
  journal in U12) get Zod schemas in `packages/shared` where they cross
  the wire.

## Coverage matrix (audited 2026-07-20, code-grounded)

Status: ✅ wired · ◐ partial · ✗ missing. Evidence = repo path the audit pinned.

| ID | Workflow | Status | Evidence / gap | Unit |
|---|---|---|---|---|
| A1 | draft_invoice | ✅ | `app/invoices/new.tsx` + proposal review | — |
| A2 | issue_invoice | ◐ | no Issue affordance on `app/invoices/[id].tsx`; generic approve only, no money gate | U1, U5 |
| A3 | send_invoice | ◐ | `sendInvoice` client fn exists, no button on detail | U1, U5 |
| A4 | record_payment | ✅ | Tap to Pay `CollectPaymentPanel` + voice proposal | — |
| A5 | draft_estimate tiers | ◐ | single-tier composer; no good/better/best UI | U6 |
| A6 | send_estimate | ✅ | `app/estimates/new.tsx:147` create&send | — |
| A7 | send_estimate_nudge | ✗ | no affordance; generic proposal render only | U6 |
| A8 | send_payment_reminder | ✗ | no affordance | U5 |
| A9 | apply_late_fee | ✗ | no affordance | U5 |
| A10 | batch_invoice + batch approve | ✅ | `app/approvals.tsx:23-45` "Approve all (N)" (grouping → deferred) | — |
| B1 | create_appointment | ◐ | voice-only; no manual booking form; schedule read-only | U7 |
| B2 | reschedule + slot picker | ◐ | generic rows; no slot/feasibility UI | U7 |
| B3 | cancel (irreversible) | ◐ | generic approve; no irreversible gate | U1, U7 |
| B4 | confirm_appointment | ✗ | generic proposal only | U7 |
| B5 | reassign/add/drop crew | ✗ | no dispatch-edit UI | U7 |
| B6 | en-route / running late | ✅ | `app/(tabs)/today.tsx:243-259` (20m hardcoded → U9) | — |
| B7 | emergency alert on Home | ✗ | server pushes; Home has no alert surface | U4 |
| C1 | create_customer | ✅ | `app/customers/new.tsx` + voice | — |
| C2 | update_customer | ✅ | `app/customers/[id]/edit.tsx` | — |
| C3 | add_service_location | ✗ | read-only via `JobPicker`; no add UI | U8 |
| C4 | convert_lead | ✗ | `app/leads/[id].tsx` read-only | U8 |
| C5 | mark_lead_lost | ✗ | no affordance | U8 |
| C6 | add_note | ◐ | voice-only; no manual composer | U8 |
| C7 | complaint (note+callback) | ✗ | no `[COMPLAINT]` rendering; generic cards | U8 |
| C8 | negotiation → callback | ✗ | generic proposal only | U8 |
| D1 | log_time_entry | ✅ | `app/jobs/[id]/time.tsx` clock-in/out | — |
| D2 | log_expense | ✗ | no affordance | U9 |
| D3 | lookup_job_profit | ✗ | no answer surface (E-lane) | U3 |
| E1–E6 | read-only voice asks | ◐ | read screens exist; **voice answer never rendered** (server skips lookups on memo path) | U3 |
| E5b | agreements screen | ✗ | no screen | U10 |
| E7 | end-of-day digest | ✅ | `app/digest/*` + batch approve | — |
| E8 | request_feedback / review_response | ✗ | no affordance | U10 |
| E9 | recurring agreements | ✗ | no screen; generic proposal render | U10 |
| F1 | disambiguation chips | ✅ | `ClarifyPicker` entity+catalog, `useProposalReview.ts:164-209` | — |
| F2 | approve by voice | ✗ | server task exists, unused by mobile | U13 |
| F3 | owner-away push routing | ✅ | `registerForPush.ts` → `POST /api/devices`; deep links; both server seams live | — |
| F4 | edit before approve | ✗ | no `PUT /:id` call; read-only rows; **store copy overclaims** | U2 |
| F5 | 5-second undo | ✅ | `useProposalReview.ts:211-243` + banner | — |
| F6 | reject with reason | ✅ | reason form → `POST /:id/reject` | — |

Cross-cutting audited facts: zero API mismatches (every mobile call
resolves to a real route); push registration is `POST /api/devices`
(both dispatch seams wired to `ExpoPushDeliveryProvider`; proposal pushes
target approvers only, by design); offline today = reconnect-heal reads
only; orphaned screens `app/(tabs)/settings/brand-voice.tsx` and
`app/(tabs)/settings/voice.tsx` are unlinked from the Settings hub
(`app/(tabs)/settings/index.tsx:13-18`).

## High-Level Technical Design

Phases ship in order; units inside a phase are parallelizable unless a
dependency says otherwise.

```
Phase A  Spine hardening (v1.0 gates)     U1 lane gates → U2 edit → U3 E-lane answers → U4 Home/Settings
Phase B  Domain slices (v1.x, shippable)  U5 money-in · U6 quoting · U7 schedule · U8 customers · U9 field · U10 oversight
Phase C  Post-v1 platform                 U11 voice idempotency → U12 offline queue ;  U13 assistant (independent)
Phase D  Release                          U14 App Store execution (needs U1+U2 or copy fix)
```

TestFlight (internal) can start any time; **external App Review waits for
Phase A** — U1 is safety, U2/U3 make existing store claims true.

## Implementation Units

### U1. Lane-aware approve confirm gates
- **Goal:** money / comms / irreversible proposals require an explicit,
  action-naming confirm (amount + recipient where applicable); capture
  stays one-tap. Client mirror of workflows.md §3.
- **Requirements:** R2
- **Dependencies:** none
- **Files:** `packages/mobile/src/proposals/approveGate.ts` (new, pure:
  lane → gate copy/behavior, consuming shared `proposal-action-class`),
  `packages/mobile/src/proposals/approveGate.test.ts` (new),
  `packages/mobile/app/proposals/[id].tsx`,
  `packages/mobile/src/screens/proposal-review.test.ts`
- **Approach:** classify via shared contract; capture → current one-tap;
  money/comms/irreversible → confirm sheet ("Send $1,240 invoice to
  Rodriguez?") with distinct destructive styling for irreversible. Batch
  eligibility (`proposalEvents.ts:53`) already excludes non-capture — do
  not change it; assert it.
- **Patterns to follow:** confirm-sheet pattern of the reject-reason form
  (`app/proposals/[id].tsx:157-197`); shared-contract consumption per
  `derive-shared-status-rule-across-frontends.md`.
- **Test scenarios:**
  - Happy: capture proposal → one tap → approved + undo banner.
  - Money/comms/irreversible → tap Approve → confirm sheet with action
    summary; confirm → approve; cancel → no call.
  - Edge: unknown/new proposal type defaults to **review lane, not
    one-tap** (fail closed).
  - Contract: confirm buttons ≥44px (jsdom class-contract), no overflow at
    320px (extend `e2e/mobile-viewport.spec.ts`).
- **Verification:** exercising each lane in the app shows the gate;
  capture flow unchanged; batch approve unaffected.

### U2. Edit-before-approve (F4)
- **Goal:** owner edits a draft proposal in-app before approving
  (`PUT /api/proposals/:id`), making the store listing's "Edit" claim true.
- **Requirements:** R4, R5, R1(F4)
- **Dependencies:** U1 (shares the review-screen surface)
- **Files:** `packages/mobile/src/hooks/useProposalReview.ts` (+ its
  tests), `packages/mobile/app/proposals/[id].tsx`,
  `packages/mobile/src/components/LineItemSheet.tsx` (reuse for line-item
  types), `packages/mobile/src/screens/proposal-review.test.ts`
- **Approach:** edit affordance on editable payload fields; line-item
  types (draft_invoice/draft_estimate) reuse `LineItemSheet`; other types
  get minimal field editing (dates, amounts-in-cents, notes). Save →
  `PUT /:id` → re-fetch detail. Respect server-side re-draft semantics
  (an edit may reset status to draft — render whatever the server
  returns).
- **Patterns to follow:** `app/estimates/new.tsx` line-item editing; the
  server contract in `packages/api/src/routes/proposals.ts` (PUT at ~453).
- **Test scenarios:**
  - Happy: edit a line amount (cents) → save → updated detail rendered.
  - Edge: concurrent change (409/version) → re-fetch + user notice.
  - Error: validation rejection from server Zod → inline error, no state
    corruption; offline edit attempt → clear failure (edits are never
    queued — U12 scope note).
  - Integration: one handler-level test asserting the client payload shape
    matches the server PUT schema (mocked-client-shape learning:
    `docs/solutions/test-failures/mocked-client-shape-masks-server-schema-rejection.md`).
- **Verification:** dictate an estimate, change a line, approve the edited
  version; store copy now accurate.

### U3. E-lane answers: execute lookups on the recorded-memo path
- **Goal:** spoken read-only asks (E1–E6, D3) get an onscreen (and
  optionally spoken) answer in the capture flow.
- **Requirements:** R3, R1(E1–E6, D3)
- **Dependencies:** none (parallel with U1/U2)
- **Files (api):** `packages/api/src/workers/voice-action-router.ts`
  (lookup branch: execute skill instead of skip),
  `packages/api/src/db/schema.ts` + migration (persist
  `{answerSummary, answerData}` on the recording result — exact shape an
  implementation decision), `packages/api/test/integration/voice-lookup-answer.test.ts`
  (new, Docker-gated — DB-touching),
  `packages/shared/src/contracts/` (answer payload schema).
- **Files (mobile):** `packages/mobile/src/voice/uploadAndTranscribe.ts`
  (surface the answer outcome), `packages/mobile/app/(tabs)/voice.tsx` +
  `packages/mobile/src/components/AnswerCard.tsx` (new),
  `packages/mobile/src/screens/voice.test.ts`,
  `packages/mobile/src/voice/uploadAndTranscribe.test.ts`
- **Approach:** the worker's "no voice back-channel" premise is false for
  the app — the recording result the client polls *is* the back-channel.
  Lookup intent → run the `ai/skills/lookup-*` skill (they already return
  `{status, summary, data}`), persist answer, keep emitting the
  `lookup_events` analytics row. Client: poll outcome `answered` → render
  `AnswerCard` (summary + structured data, deep link to the relevant read
  screen); outcomes `proposal`/`clarification` unchanged.
- **Patterns to follow:** skill invocation as done on the session path
  (`InAppVoiceAdapter`); recording poll loop in `uploadAndTranscribe.ts`.
- **Test scenarios:**
  - Happy: "what's my balance" memo → recording completes with
    answerSummary → AnswerCard renders summary + amount (cents formatted).
  - Edge: lookup skill returns empty data → graceful "nothing found" copy;
    mixed utterance (action + question) → follows intent classifier's
    single routed intent (document behavior).
  - Error: skill failure → recording completes with answer-error state,
    client offers retry; **integration (Docker):** answer columns persist
    and RLS-scope correctly on real columns.
  - Handler-level (api): lookup branch executes skill with mocked gateway
    and stores summary; no proposal minted; analytics row still written.
- **Verification:** speak "who owes me money?" on device/web-export → an
  answer card appears without touching /approvals.

### U4. Home & Settings surface completion + hygiene
- **Goal:** B7 emergency alert surface on Home; recent-activity feed;
  orphaned settings screens linked or deleted.
- **Requirements:** R1(B7), R9
- **Dependencies:** none
- **Files:** `packages/mobile/app/(tabs)/index.tsx`,
  `packages/mobile/src/screens/home.test.ts`,
  `packages/mobile/src/push/notificationRouting.ts` (+test) if a new
  emergency screen target is added,
  `packages/mobile/app/(tabs)/settings/index.tsx`,
  `packages/mobile/src/screens/settings.test.ts`
- **Approach:** high-priority notification types (escalation/emergency —
  already in the shared taxonomy per
  `owner-notifications-adding-a-push-type.md`) render a dismissible
  high-urgency banner on Home while unacknowledged; recent-activity feed
  from executed proposals (`GET /api/proposals?status=executed`, newest
  N). Settings hub: link `brand-voice` and `voice` screens (they exist and
  render) — wiring beats deletion; if product says otherwise, delete both
  files + their tests in the same commit (CLAUDE.md dead-code rule —
  re-grep usage first).
- **Patterns to follow:** Home card composition in `app/(tabs)/index.tsx`;
  `SettingsSubPage` for links; `mobile-nav-chrome-additive-shell` learning
  for any chrome changes.
- **Test scenarios:**
  - Happy: emergency notification arrives foregrounded → banner renders,
    links to the call/appointment; dismiss persists.
  - Feed renders executed items with tenant-tz timestamps; empty state.
  - Settings hub lists brand-voice + voice; tap targets ≥44px.
  - Edge: emergency arrives while backgrounded → cold-start routing still
    lands correctly (extend `notificationRouting.test.ts`).
- **Verification:** all settings screens reachable; simulated emergency
  push shows the banner.

### U5. Money-in slice completion (A2, A3, A8, A9)
- **Goal:** invoice detail gains Issue / Send / Remind / Late-fee
  affordances; reminder + late-fee proposals render meaningfully.
- **Requirements:** R1(A2, A3, A8, A9)
- **Dependencies:** U1 (money confirms)
- **Files:** `packages/mobile/app/invoices/[id].tsx`,
  `packages/mobile/src/api/invoices.ts` (+tests),
  `packages/mobile/src/proposals/proposalReview.ts` (TYPE_LABELs +
  review rows for `send_payment_reminder`, `apply_late_fee`,
  `send_estimate_nudge`), `packages/mobile/src/screens/invoices.test.ts`,
  possibly `packages/api/src/routes/invoices.ts` (issue/late-fee routes —
  see Open Questions; if added: audit events + handler tests, integration
  test if schema-touching)
- **Approach:** status-aware action row on invoice detail (draft → Issue;
  open → Send / Remind / Late fee; each behind the U1 money/comms confirm
  pattern for consistency even on direct endpoints). Use existing
  `sendInvoice`; add client fns for the rest against whichever server
  surface Open Question 1 resolves to.
- **Patterns to follow:** `CollectPaymentPanel` mounting on invoice detail;
  `src/api/estimates.ts` client-fn shape.
- **Test scenarios:**
  - Happy: draft invoice → Issue → confirm → status open (cents intact,
    due date stamped tenant-tz); open → Send → confirm → sent state.
  - Edge: actions hidden for paid/void statuses; double-tap guarded.
  - Error: server 4xx surfaces `errorCopy` message; no optimistic state.
  - Proposal render: a `send_payment_reminder` proposal shows recipient +
    amount, not a generic label.
- **Verification:** full A1→A4 loop on device from one invoice detail.

### U6. Quoting slice completion (A5 tiers, A7 nudge)
- **Goal:** good/better/best tier UI in the estimate composer and in
  proposal review; estimate-nudge affordance on estimate detail.
- **Requirements:** R1(A5, A7)
- **Dependencies:** U1
- **Files:** `packages/mobile/app/estimates/new.tsx`,
  `packages/mobile/app/estimates/[id].tsx`,
  `packages/mobile/src/components/LineItemSheet.tsx`,
  `packages/mobile/src/proposals/proposalReview.ts`,
  `packages/mobile/src/screens/estimate-create.test.ts`,
  `packages/mobile/src/screens/estimate-detail.test.ts`
- **Approach:** tier model follows the AI good/better/best contract
  (`docs/plans/2026-07-17-001-feat-ai-good-better-best-estimates-plan.md`
  and its shared schemas) — render tier tabs/sections; composer can
  duplicate a base tier; review screen shows tier comparison. Nudge =
  comms-lane confirm on sent-but-unaccepted estimates.
- **Patterns to follow:** the web tier rendering shipped by that plan;
  existing `LineItemSheet` cents handling.
- **Test scenarios:**
  - Happy: AI tiered estimate proposal renders 3 tiers with per-tier
    totals (cents); composer builds a two-tier estimate manually.
  - Edge: single-tier estimates render exactly as today (no regression).
  - Nudge hidden for accepted/expired estimates.
  - Contract: tier tabs ≥44px; 320px no-overflow.
- **Verification:** dictate "quote the Henderson roof good-better-best" →
  review shows tiers → send.

### U7. Schedule slice completion (B1–B5)
- **Goal:** manual booking, slot-picker on reschedule review, cancel with
  irreversible gate, confirm-appointment, crew reassignment.
- **Requirements:** R1(B1–B5)
- **Dependencies:** U1 (irreversible gate)
- **Files:** `packages/mobile/app/schedule.tsx` (actions),
  `packages/mobile/app/appointments/new.tsx` (new),
  `packages/mobile/src/api/appointments.ts` (new client fns + tests),
  `packages/mobile/src/components/SlotPicker.tsx` (new),
  `packages/mobile/app/proposals/[id].tsx` (slot picker for
  `reschedule_appointment` type),
  `packages/mobile/src/screens/schedule.test.ts`, new
  `packages/mobile/src/screens/appointment-new.test.ts`
- **Approach:** booking form mirrors `customers/new.tsx` form pattern
  (customer picker → time slot → crew); slot picker feeds from the
  availability source (Open Question 2), renders tenant-tz. Reschedule
  proposals swap the generic rows for the picker pre-loaded with the AI's
  proposed slot. Cancel/confirm/reassign live on appointment context
  (schedule item → action sheet), each minting the matching direct call or
  proposal per the same rule as U5.
- **Patterns to follow:** `JobPicker` for entity pickers;
  `technicianDay.ts` for tz-safe day math.
- **Test scenarios:**
  - Happy: book manually → appears on schedule (tenant-tz); reschedule
    proposal → pick a different slot → approve with new time.
  - Edge: slot conflict from server → inline feasibility error; DST
    boundary day renders correctly.
  - Irreversible: cancel demands the U1 destructive confirm.
  - Error: reassign to unavailable tech → server rejection surfaced.
- **Verification:** "move Miller to Thursday 2pm" end-to-end with slot
  adjustment on device.

### U8. Customers & leads slice completion (C3–C8)
- **Goal:** convert lead, mark lost, add service location, manual note,
  complaint + negotiation rendering.
- **Requirements:** R1(C3–C8)
- **Dependencies:** U1
- **Files:** `packages/mobile/app/leads/[id].tsx`,
  `packages/mobile/src/api/leads.ts` (new client fns),
  `packages/mobile/app/customers/[id].tsx` (location add, note composer),
  `packages/mobile/src/api/customers.ts`,
  `packages/mobile/src/proposals/proposalReview.ts` (complaint `[COMPLAINT]`
  pinned marker, callback affordance, negotiation framing),
  `packages/mobile/src/screens/leads.test.ts`,
  `packages/mobile/src/screens/customer-detail.test.ts`,
  `packages/mobile/src/screens/proposal-review.test.ts`
- **Approach:** lead detail gains Convert (capture confirm) and Mark-lost
  (reason field, mirrors reject-reason form); customer detail gains
  add-location + note composer. Complaint proposals render the pinned
  marker + severity; callback proposals show a tap-to-call affordance
  (reuse `src/calls/useStartCall.ts`); negotiation-born callbacks state
  the AI never conceded (copy from `negotiation-task` semantics).
- **Test scenarios:**
  - Happy: convert lead → customer created, jobs relinked (assert via
    detail re-fetch); mark lost stores reason.
  - Complaint proposal renders `[COMPLAINT]` + severity; callback shows
    call button wired to the customer number.
  - Edge: convert an already-converted lead → server conflict surfaced.
  - Error: location add validation failure inline.
- **Verification:** "customer says we overcharged" memo → complaint note +
  callback both render distinctly and act.

### U9. Field & costs slice completion (D2 + B6 polish)
- **Goal:** expense/materials logging; running-late duration picker
  (replace hardcoded 20m).
- **Requirements:** R1(D2), R9
- **Dependencies:** none
- **Files:** `packages/mobile/app/jobs/[id]/expenses.tsx` (new),
  `packages/mobile/src/api/jobs.ts` (+tests),
  `packages/mobile/app/(tabs)/today.tsx`,
  `packages/mobile/src/screens/today.test.ts`, new
  `packages/mobile/src/screens/job-expenses.test.ts`
- **Approach:** expense form (vendor, category, amount-in-cents, photo
  receipt optional via existing job-photo pipeline) on the job detail
  family, mirroring `app/jobs/[id]/time.tsx`; running-late becomes a
  three-chip picker (10/20/30m) feeding the same endpoint.
- **Test scenarios:**
  - Happy: log $80 fittings → appears in job costs (cents).
  - Edge: zero/negative amount rejected client-side; offline attempt fails
    clearly (no queue until U12).
  - Running-late sends the chosen duration; chips ≥44px.
- **Verification:** "log 2 hours and $80 of fittings on the Lee job" via
  voice AND manually, both land.

### U10. Oversight slice completion (E5b/E8/E9)
- **Goal:** agreements read screen; request-feedback affordance;
  review_response + recurring proposal rendering.
- **Requirements:** R1(E8, E9)
- **Dependencies:** U1
- **Files:** `packages/mobile/app/agreements.tsx` +
  `packages/mobile/app/agreements/[id].tsx` (new),
  `packages/mobile/src/api/agreements.ts` (new, +tests),
  `packages/mobile/app/jobs/[id].tsx` (request-feedback action),
  `packages/mobile/src/proposals/proposalReview.ts` (recurring +
  review_response labels/rows),
  new `packages/mobile/src/screens/agreements.test.ts`
- **Approach:** agreements list/detail mirror the invoices read-screen
  pattern (`EntityList` + `LabelValueTable`); request-feedback is a
  comms-confirm on completed jobs; review_response proposals show the
  drafted reply text prominently (it posts publicly — comms lane).
- **Test scenarios:**
  - Happy: agreements list renders cadence + next-invoice date
    (tenant-tz); recurring proposal names the agreement.
  - Review_response renders the full drafted reply before confirm.
  - Edge: no agreements → empty state; feedback hidden for already-asked
    jobs (server truth).
- **Verification:** recurring proposal approved from the phone references
  the right agreement; feedback request sends.

### U11. API voice idempotency (offline prerequisite)
- **Goal:** `POST /api/voice/recordings` accepts and persists a client
  `idempotencyKey` (unique per tenant); a replay returns the existing
  recording instead of minting a duplicate.
- **Requirements:** R6 (prerequisite)
- **Dependencies:** none (land before U12)
- **Files:** `packages/api/src/routes/voice.ts`,
  `packages/api/src/db/schema.ts` + migration (`voice_recordings`
  idempotency column + partial unique index),
  `packages/api/src/voice/` repo layer,
  `packages/api/test/integration/voice-idempotency.test.ts` (new,
  Docker-gated — DB-touching, real columns per CLAUDE.md)
- **Approach:** the client already sends the key
  (`uploadAndTranscribe.ts`) — today the server schema silently drops it
  (`CreateVoiceRecordingBody`, voice.ts:31). Add it to the body schema,
  persist, unique-per-tenant; on conflict return the existing recording
  (200/202 with the original id) so the client poll loop just works.
- **Test scenarios:**
  - Integration (Docker): same key twice → one row, same recording id
    returned, exactly one transcription job enqueued; different tenants
    may share a key value (tenant-scoped uniqueness); RLS isolation.
  - Handler: missing key remains valid (backward compatible).
- **Verification:** double-fire the client upload → one proposal, not two.

### U12. Offline voice + approval queue (post-v1)
- **Goal:** voice recordings and capture-class approvals queue offline and
  flush safely on reconnect; store copy updated to match.
- **Requirements:** R6, R5
- **Dependencies:** U11 (hard), U1 (lane classification)
- **Files:** `packages/mobile/src/offline/queue.ts`,
  `packages/mobile/src/offline/flush.ts` (+ pure tests for both, new),
  `packages/mobile/src/voice/uploadAndTranscribe.ts`,
  `packages/mobile/src/hooks/useProposalReview.ts`,
  `packages/mobile/src/components/OfflineBanner.tsx` ("N actions
  waiting"), `packages/mobile/store/app-review-notes.md` (lines 51, 94),
  `packages/mobile/README.md`, one jest-expo test for the cache→document
  file move
- **Approach:** per the strategy findings — single JSON journal in
  `FileSystem.documentDirectory`, atomic write (temp→move); items
  `{id, kind, payload, status, attempts, enqueuedAt}`; enqueue moves audio
  out of the evictable cache dir; flush on the connectivity reconnect edge
  + foreground + manual retry, sequential, **approvals before voice**;
  `inflight` reverts to `pending` on relaunch (at-least-once; server
  idempotency/409 gives effectively-once). Approvals: capture-class only;
  409 → drop as "resolved elsewhere" + inbox re-fetch; 401 → park behind
  sign-in; 5xx → capped backoff; queued approvals show "Will approve when
  back online" (no fake countdown; real undo window anchors server
  `approvedAt` on flush) and are cancellable until flushed. **Never
  queued:** edits, resolve-line/entity, money/comms/irreversible,
  batch, reject, undo.
- **Patterns to follow:** RN-free injected-deps style of
  `uploadAndTranscribe.ts`; `__emitNetInfoForTests` hooks in
  `connectivity.ts`.
- **Test scenarios:**
  - Pure: enqueue/restore round-trip; FIFO; crash-recovery
    (inflight→pending); poison item parks after N attempts.
  - Flush machine: reconnect triggers; approvals-before-voice order;
    409-drop with notice; 401-park; partial-flush persistence.
  - jest-expo: recorded clip moved to documentDirectory; deletion only
    after confirmed flush.
  - Store copy: review-notes offline passages updated in the same commit
    (R5 assertion is the diff itself).
- **Verification:** airplane-mode capture + one-tap approve → both flush
  on reconnect exactly once; banner shows queue depth.

### U13. Conversational assistant (post-v1) + F2 approve-by-voice
- **Goal:** a stateful "talk to the agent" session screen over the
  existing voice-session API; spoken approval (F2) rides the same session.
- **Requirements:** R7, R1(F2)
- **Dependencies:** none on U11/U12 (independent); after Phase A
- **Files:** `packages/mobile/app/assistant.tsx` (new),
  `packages/mobile/src/assistant/sseParser.ts` (new, pure,
  transport-agnostic), `packages/mobile/src/assistant/useAssistantSession.ts`
  (new), tests for both (new), `packages/mobile/src/voice/useVoiceCapture.ts`
  (extract shared recorder logic),
  `packages/mobile/src/screens/assistant.test.ts` (new),
  `packages/api/test/` (one handler test asserting header-auth-only SSE)
- **Approach:** `expo/fetch` streaming reader with the Clerk token in the
  `Authorization` header (port of the web `useVoiceSession` reader; the
  server's `?token=` fallback is gone on purpose — never reintroduce it).
  SSE parsing is a pure module so the transport can swap to
  `react-native-sse` (plan-B) without touching the hook. Degrade path: the
  synchronous `POST /:id/input` already returns the full turn
  (`{state, ttsText, ttsAudio, proposalIds, ended}`), so a broken stream
  loses only async pushes. Per-turn STT via the sync
  `/api/voice/transcribe` endpoint; TTS base64 → cache file → expo-audio
  player, with explicit record/playback state sequencing. `proposal_created`
  events render chips deep-linking into the existing review screen —
  approval semantics (lanes, undo) stay in `useProposalReview`, unchanged.
  Assistant is online-only (no queue interplay). Run the `expo/fetch`
  streaming spike (iOS + Android, background/abort semantics) as the
  unit's first task; a spike failure switches transport to plan-B, not the
  design.
- **Test scenarios:**
  - Pure parser: chunk-split events, partial buffers, heartbeats,
    malformed JSON, multi-event chunks.
  - Hook with injected fake transport: start → greeting → input → events →
    ended; 401 refresh-retry; abort on unmount; stream-drop → degrade to
    sync round-trip; AppState background → foreground resume/reconnect.
  - F2: "approve the Rodriguez estimate" turn → proposal chip resolves →
    lane rules still enforced (money still confirms on screen).
  - Playwright web-export smoke: assistant screen renders.
- **Verification:** hold a multi-turn conversation ("what's my balance?" →
  "invoice the Hendersons for it") on a physical device; approve by voice
  with the confirm gate intact.

### U14. iOS App Store release execution
- **Goal:** Rivet 1.0.0 live on the App Store.
- **Requirements:** R8, R5
- **Dependencies:** U1 + U2 landed (or store copy edited to drop "Edit")
  before external App Review; TestFlight internal can start immediately.
- **Files:** none beyond `docs/mobile/ios-app-completion-prompt.md`
  execution (eas init writes `app.json` projectId;
  `ITSAppUsesNonExemptEncryption` added there per its Phase 2).
- **Approach:** execute the completion prompt phases 0–7 — accounts,
  code gates, EAS config, assets/metadata, ASC record, build+submit,
  dual-persona TestFlight verification, human-gated submission. EAS
  builds run off-sandbox (developer machine or CI with `EXPO_TOKEN`).
- **Test scenarios:** `Test expectation: none — release configuration and
  human-gated store process; the prompt's per-phase gates (typecheck,
  vitest, jest-expo, viewport e2e, validate:config, dual-persona device
  checklist) are the verification.`
- **Verification:** the completion prompt's Gate 7 — approved, live,
  installable, both personas' core loops work against production.

## Risks & Dependencies

- **Store-copy honesty race (active today):** listing + review notes claim
  "Edit" (F4) which doesn't exist. Mitigation: U2 lands before external
  review, or the copy drops the claim — U14 gates on one of the two.
- **U3 changes worker semantics:** the lookup skip is load-bearing for
  telephony surfaces; scope the answer-execution branch strictly to the
  recorded-memo (mobile) path so phone-call flows are untouched.
- **U5/U7 may need new server routes** (issue-invoice, late-fee, crew
  actions) — each addition carries audit events + handler tests +
  integration tests if schema-touching; budget for it.
- **`expo/fetch` streaming maturity (U13):** mitigated by the
  transport-agnostic parser, named plan-B, and the sync-input degrade.
- **Offline stale-approval harm (U12):** mitigated by capture-class-only
  scope, 409-drop, inbox re-fetch — never widen the queueable set without
  revisiting this analysis.
- **One-binary drift:** every new screen must respect `personaNav.ts`
  gating or technicians see supervisor surfaces (D-021 constraint).

## Open Questions (deferred to implementation)

1. **Issue-invoice / late-fee server surface (U5):** does a direct
   human-initiated route exist, or is the proposal path the only writer?
   Resolve by reading `packages/api/src/routes/invoices.ts` at U5 start;
   prefer adding a direct audited route over client-minted proposals.
2. **Slot-picker availability source (U7):** `lookup_availability` skill
   output vs a dispatch/availability endpoint — pick whichever returns
   structured slots; confirm at U7 start.
3. **Agreements list endpoint (U10):** confirm `/api/agreements` (or
   equivalent) exists and its list shape before building the screen.
4. **U3 persistence shape:** answer columns on `voice_recordings` vs a
   result side-table — decide with the migration; integration test pins
   whichever is chosen.
5. **Emergency ack semantics (U4):** is dismiss client-local or should an
   acknowledgement round-trip to the server? Default client-local; revisit
   if on-call escalation needs receipts.

## Sources & Research

Code-grounded audit + backend seam verification + deferred-feature
strategy (three independent research passes, 2026-07-20, findings
embedded above); `docs/mobile/workflows.md`;
`docs/mobile/owner-operator-app-spec.md` (note: its "two push seams /
device-tokens" description predates the generalized
`OwnerNotificationService` and the `/api/devices` route — this plan
reflects the newer code); `docs/decisions.md` D-004, D-016, D-021;
`docs/solutions/architecture-patterns/{owner-notifications-adding-a-push-type,mobile-nav-chrome-additive-shell-vs-tabs-group,derive-shared-status-rule-across-frontends}.md`;
`docs/solutions/test-failures/mocked-client-shape-masks-server-schema-rejection.md`;
`docs/mobile/ios-app-completion-prompt.md` (release execution);
`docs/mobile/RELEASE-RUNBOOK.md`.
