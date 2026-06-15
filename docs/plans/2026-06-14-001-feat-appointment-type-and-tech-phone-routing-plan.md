# feat: Appointment-type taxonomy + per-tradesperson escalation phone routing

**Created:** 2026-06-14
**Depth:** Deep
**Status:** plan

## Summary
Two independent, sequenced builds for the AI voice agent, each landing as its
own set of atomic commits. **Build 1** adds a typed appointment-type taxonomy
(`estimate | repair | install | maintenance | diagnostic`) emitted by the
appointment task's own LLM prompt, Zod-validated, surfaced on the
`create_appointment` proposal payload and persisted on the appointment row.
**Build 2** finishes per-tradesperson escalation routing: a technician selects
their own mobile number and inbound-call escalation dials *that* number instead
of the shared business line. Both ship with a layered test suite (unit +
Docker-gated integration + golden e2e).

## Problem Frame
The "verify what exists" baseline already shipped (see
`docs/verification-runs/voice-inbound-appointment-2026-06-14.md` and
`packages/api/test/voice/inbound-caller-booking-golden-path.test.ts`). Two gaps
remain, both surfaced during that verification:

1. **No discrete appointment type.** "Type" today is just the classifier intent
   plus a free-text job summary. Dispatchers can't filter/sort by quote vs
   repair vs install, and the booking proposal a human approves doesn't say
   what *kind* of visit it is.
2. **A technician's own number is never dialed on escalation.** Every on-call
   user rings the same `tenant_settings.business_phone`. The per-user column
   (`users.mobile_number`) and repo methods already exist and the dial cascade
   already routes per-user numbers through `DispatcherPhoneResolver` — but the
   *production* resolver (`createBusinessPhoneDispatcherResolver`) ignores its
   `userId` arg, and there's no technician-facing UI to set the number.

## Requirements
- R1. A `create_appointment` booking carries a typed, enum-validated
  appointment type emitted by the LLM (never an unconstrained string).
- R2. The type is persisted on the appointment row and visible on the proposal
  payload for the operator/task path.
- R3. Changing the appointment-task prompt must NOT change the intent-classifier
  voice-quality cassettes; the create-appointment task cassettes are
  regenerated and the launch-gate still passes.
- R4. A technician can set/clear their own mobile number (owner can set any
  user's), normalized to E.164, with an audit event on the mutation.
- R5. Inbound-call escalation dials the on-call user's `mobile_number` when set,
  falling back to `business_phone` when unset — never losing escalation for a
  tenant that hasn't adopted per-user numbers.
- R6. Every DB-touching change is pinned by a Docker-gated integration test
  against real columns + RLS; voice/AI behavior by handler tests with a mocked
  gateway; the new UI by a jsdom class-contract test + a 320px Playwright spec.

## Key Technical Decisions
- **Emit `appointmentType` from the appointment TASK prompt
  (`create-appointment-task.ts`), not the shared intent classifier.** The
  classifier is shared across ~40 intents and is voice-quality-cassette-gated;
  the appointment task has its own focused prompt with zero cross-intent blast
  radius. (Alternative: classifier emits a coarse type — rejected: changes every
  classifier cassette hash for all intents.)
- **One canonical enum, not per-vertical.** `estimate | repair | install |
  maintenance | diagnostic` — every canonical vertical pack (HVAC, plumbing,
  electrical) shares exactly these categories. "Emergency" stays a trust-tier /
  `emergency_dispatch` concern, not an appointment type. (Alternative:
  per-vertical type sets — rejected as premature; the shared set already covers
  the packs.)
- **Reuse the existing `users.mobile_number` column + `setMobileNumber` repo
  method.** It already exists (migration `109_users_mobile_number`, P1-022) with
  RLS via the users table policy and a `(tenant_id, mobile_number)` partial
  unique index. (Alternative: a new `users.phone` column or `user_phones` table
  — rejected: duplicates an existing, repo-supported column.)
- **The dispatcher-phone-resolver returns the on-call user's `mobileNumber` or
  `null`; the `business_phone` fallback lives at the escalation call site, after
  the rotation is exhausted — NOT inside the resolver.** `escalateToHuman`'s walk
  treats a resolver `null` as "advance to the next on-call user" and any non-null
  as "dial this one"; a `business_phone` fallback *inside* the resolver makes
  every entry resolve non-null, pinning every call to rotation entry 0 and
  silently defeating per-user selection. The dial cascade already consumes
  per-user numbers (`telephony-routes.test.ts` P8-013). (Alternative: fallback
  inside the resolver — rejected for the reason above.)
- **SMS/OTP verification of the number is deferred.** Out of scope; the column's
  optional `phone_verified_at` is not introduced here.

## Scope Boundaries
**In scope:** the appointment-type enum end to end (contract → task emission →
proposal payload → appointment row), and per-tradesperson escalation routing
(resolver swap, self-service endpoint, technician UI), each with layered tests.

**Non-goals:**
- A real type taxonomy on the *classifier* / inbound-caller DRAFT proposal (the
  inbound proposal is built at classify time, not via the task handler — see
  Risks). Operator/task path + persisted row carry the type.
- SMS/OTP number verification.
- Multiple numbers per user; number provisioning/porting.
- Changing the human-approval gate or auto-approval rules.

### Deferred to follow-up work
- Surfacing `appointmentType` on the inbound-caller DRAFT proposal (would need
  inline type extraction on the FSM confirm path).
- A dispatch-board UI filter/sort by appointment type.
- Owner-managed roster UI to assign numbers for other users in bulk.

## Repository invariants touched
- **RLS / tenant_id:** `appointment_type` rides on `appointments` (already
  tenant-scoped + RLS); `mobile_number` rides on `users` (already tenant-scoped
  + RLS, `tenant_isolation_users`). The new endpoint runs inside tenant context.
- **Audit events:** the set-phone endpoint emits `user.mobile_number.updated`
  (PII-safe metadata — changed keys only, never the number); appointment
  creation already audits.
- **LLM gateway:** type extraction goes through the existing appointment-task
  `gateway.complete({ taskType: 'create_appointment', responseFormat: 'json' })`
  call — no new AI entry point.
- **Zod proposals, never trust raw LLM:** `appointmentType` is added to
  `createAppointmentPayloadSchema` as an optional enum; the task validates the
  LLM value against the enum and drops anything out-of-set (mirrors the
  classifier's `pickEnum` discipline).
- **Human-approval gate:** unchanged — appointments still land for review; type
  is descriptive metadata and never affects auto-approval.
- Integer cents / catalog resolver / entity resolver: not touched (no money, no
  line-item pricing, no new free-text entity refs).

## Implementation Units

### U1. Shared appointment-type enum + proposal contract
- **Goal:** Define the typed enum once and admit it into the proposal payload
  contract.
- **Requirements:** R1.
- **Dependencies:** none.
- **Files:**
  - `packages/shared/src/contracts/status.ts` — add `appointmentTypeSchema =
    z.enum([...])` + `export type AppointmentTypeValue`, mirroring
    `appointmentStatusSchema`; register in the `STATUS_SCHEMAS` map if that
    pattern is used for it.
  - `packages/shared/src/index.ts` (or the contracts barrel) — re-export.
  - `packages/api/src/proposals/contracts.ts` — add `appointmentType:
    appointmentTypeSchema.optional()` to `createAppointmentPayloadSchema` (after
    `summary`); follow the existing `priority: z.enum([...]).optional()` pattern
    in `createJobPayloadSchema`.
  - Tests: `packages/shared/test/contracts/status.test.ts` (or the existing
    status contract test) + a case in the proposals contract test.
- **Approach:** Pure contract change. Keep the enum optional so existing
  payloads/rows (null type) stay valid. **Gotcha:**
  `createAppointmentPayloadSchema` is a `ZodEffects` (`.refine()`-wrapped), so it
  can't be `.extend()`ed — add `appointmentType` to the base `z.object({...})`
  BEFORE the `.refine()` calls. Leave `createBookingPayloadSchema` unchanged (thin
  `{ appointmentId }` pointer); the type rides the appointment row, not the
  booking proposal. The enum is the single source of truth imported by the task
  handler (U3), the execution handler (U2), and the web UI.
- **Patterns to follow:** `appointmentStatusSchema` in `status.ts`; optional
  enum in `createJobPayloadSchema`.
- **Test scenarios:**
  - Happy path: `appointmentTypeSchema.parse('repair')` succeeds; each of the 5
    values parses.
  - Edge: `.optional()` allows `undefined`; an unknown value (`'emergency'`)
    fails `safeParse`.
  - `createAppointmentPayloadSchema` accepts a payload with and without
    `appointmentType`.
- **Verification:** Shared + contract tests green; the enum type is importable
  from both `packages/api` and `packages/web`.

### U2. Persist `appointment_type` (migration + interface + execution handler)
- **Goal:** Store the type on the appointment row and thread it from an approved
  proposal into the persisted appointment.
- **Requirements:** R2, R6.
- **Dependencies:** U1.
- **Files:**
  - `packages/api/src/db/schema.ts` — **append** a new migration key at the END
    of the `MIGRATIONS` object (`getMigrationSQL` concatenates `Object.values` in
    INSERTION order and re-runs every migration idempotently on each boot; do NOT
    edit an existing migration body — the `migration-immutability.test.ts` guard
    fails). Next free key ~`178` (verify; duplicate numeric prefixes are tolerated
    since the full string is the key). Body: `ALTER TABLE appointments ADD COLUMN
    IF NOT EXISTS appointment_type TEXT` + a `CHECK (appointment_type IN (...) OR
    appointment_type IS NULL)` matching the enum; optional `CREATE INDEX IF NOT
    EXISTS idx_appointments_type ON appointments (tenant_id, appointment_type)`.
    Do NOT patch migration 018.
  - `packages/api/src/appointments/appointment.ts` — add `appointmentType?:
    AppointmentTypeValue` to `Appointment` + `CreateAppointmentInput`; map the
    column in the pg appointment repo (`pg-appointment.ts`) and the in-memory
    repo.
  - `packages/api/src/proposals/execution/handlers.ts` —
    `CreateAppointmentExecutionHandler`: extract `payload.appointmentType`
    (enum-checked) and pass it into the `createAppointment()` call. Thread it
    through the SAME row-write the operator path uses when it holds a slot
    pre-approval (the `createAppointment` call in `create-appointment-task.ts`) so
    both producers persist the type. The execution/row-write layer is the single
    convergence point; inbound-caller DRAFTs (no type) persist NULL.
  - Tests:
    - `packages/api/test/proposals/execution/create-appointment-handler.test.ts`
      — approving a proposal with a type persists it on the appointment.
    - `packages/api/test/integration/appointments.test.ts` (extend) — **Docker
      integration** asserting the real `appointment_type` column round-trips and
      the CHECK rejects an out-of-set value.
- **Approach:** Mirror how `notes` / `timezone` flow from payload → input →
  row. Keep the column nullable; existing rows and untyped bookings stay null.
- **Patterns to follow:** migration `109_users_mobile_number` (ALTER + idempotent
  `IF NOT EXISTS`); column mapping in `pg-appointment.ts`.
- **Test scenarios:**
  - Happy path: payload `appointmentType: 'install'` → appointment row
    `appointment_type = 'install'`.
  - Edge: missing type → row null; the CHECK rejects `'emergency'`.
  - Integration: insert + select the column under tenant context; cross-tenant
    select returns nothing (RLS already covered by the users/appointments
    policies — assert column presence + CHECK here).
- **Verification:** `npm run test:integration -- appointments` green; the column
  exists with the CHECK; execution handler persists the type.

### U3. Emit + validate `appointmentType` in the appointment task (+ cassettes)
- **Goal:** The LLM proposes the type on the create-appointment path; it's
  enum-validated and rides into the proposal payload. Booking now carries type.
- **Requirements:** R1, R3.
- **Dependencies:** U1, U2.
- **Files:**
  - `packages/api/src/ai/tasks/create-appointment-task.ts` — add
    `appointmentType` to `APPOINTMENT_SYSTEM_PROMPT` (one guidance line + the
    JSON field, with the allowed values) and to `buildPayload`; validate the
    returned value against `appointmentTypeSchema` and drop it when invalid
    (never forward an unconstrained string).
  - `packages/api/src/ai/voice-quality/corpus/cassettes/` — regenerate the
    `create-appointment*` cassettes whose task-call hash changes; confirm the
    intent-classifier cassettes are byte-identical.
  - Tests:
    - `packages/api/test/ai/tasks/create-appointment-task.test.ts` — LLM returns
      `appointmentType: 'repair'` → proposal payload carries it; an invalid
      value (`'foo'`) is dropped, not forwarded.
    - Extend `packages/api/test/voice/operator-voice-golden-path.test.ts` (or the
      new inbound golden path) so a booking asserts the classified type on the
      proposal/row — the R1 "booking carries the type" e2e.
    - `packages/api/test/voice-quality/voice-quality.launch-gate.entry.test.ts`
      — must still pass after cassette regen.
- **Approach:** The task already extracts `dateTimePhrase`/`summary`; add the
  type alongside. Because only this prompt changes, classifier cassettes are
  untouched (confirmed: cassettes are keyed by per-call request hash).
- **Patterns to follow:** the classifier's `pickEnum` validation discipline;
  existing appointment-task extraction + `mockGateway` test shape.
- **Test scenarios:**
  - Happy path: scripted gateway returns a valid type → payload carries it.
  - Error path: invalid/missing type → payload omits it (no crash, no raw
    string).
  - Cassette/launch-gate: classifier cassette hashes unchanged; launch-gate
    green.
- **Verification:** task + golden tests green; `git diff` on cassettes touches
  only create-appointment task entries; launch-gate passes.

### U4. Dispatcher-phone-resolver: ring per-user mobile; business_phone fallback at the call site
- **Goal:** Escalation dials the on-call user's own number when set, advancing
  the rotation past users with no number, with `business_phone` as the
  tenant-level last resort once the rotation is exhausted.
- **Requirements:** R5.
- **Dependencies:** none (column + dial cascade already exist).
- **Files:**
  - `packages/api/src/telephony/dispatcher-phone-resolver.ts` — change
    `createBusinessPhoneDispatcherResolver` (or add
    `createUserPhoneDispatcherResolver`) to accept a `userRepo` and return
    `user.mobileNumber ?? null` — **not** `business_phone`. Keep the
    `DispatcherPhoneResolver` signature. Missing user / repo error → `null` + warn
    (never throw into the cascade).
  - `packages/api/src/ai/skills/escalate-to-human.ts` — at the post-walk
    `!chosen` branch (rotation exhausted, no per-user number found), apply the
    tenant-level `business_phone` fallback so a tenant that hasn't adopted
    per-user numbers still reaches someone. The fallback altitude moves HERE, out
    of the resolver.
  - `packages/api/src/app.ts` — pass `userRepo` to the resolver constructor.
  - Tests: `packages/api/test/telephony/dispatcher-phone-resolver.test.ts` (new)
    + extend `packages/api/test/ai/skills/escalate-to-human.test.ts`.
- **Approach:** The resolver must NOT return `business_phone` for a numberless
  user — `escalateToHuman`'s walk treats `null` as "advance to the next on-call
  user" and non-null as "dial this one", so a per-user `business_phone` fallback
  would pin every call to entry 0 (see Risks). Resolver yields
  per-user-number-or-null; the tenant fallback lives after rotation exhaustion.
  The dial cascade itself is unchanged (already proven per-user in
  `telephony-routes.test.ts` P8-013).
- **Patterns to follow:** existing `createBusinessPhoneDispatcherResolver`; the
  rotation walk + `!chosen` branch in `escalate-to-human.ts`.
- **Test scenarios:**
  - Resolver: user has number → that number; user has none → null; missing user
    / repo throws → null (no throw).
  - Cascade (mixed roster): user A (no number) + user B (number) → walk advances
    to B and dials B's number.
  - Fallback: whole rotation numberless → `business_phone` dialed after exhaustion.
- **Verification:** resolver + escalation handler tests green; existing
  telephony-routes dial tests still green.

### U5. Self-service set-phone API endpoint
- **Goal:** A technician sets/clears their own mobile number (owner can set
  anyone's), normalized + audited.
- **Requirements:** R4.
- **Dependencies:** none (repo method exists).
- **Files:**
  - `packages/api/src/routes/users.ts` (or wherever user routes mount; confirm)
    — `PUT /api/users/me/phone` (self) and an owner-gated
    `PUT /api/users/:id/phone`; normalize via `normalizeMobileE164`, persist via
    `userRepo.setMobileNumber`, emit `user.mobile_number.updated` audit; map the
    `(tenant_id, mobile_number)` unique-index violation to a 409/validation
    error.
  - Tests: `packages/api/test/routes/users-phone.route.test.ts` (new) — self set
    succeeds + audits; a non-owner setting *another* user's number is 403; an
    invalid number is 400; clearing (null) works; duplicate number → 409.
- **Approach:** Mirror the settings-route boundary normalization + audit
  pattern. Gate: `req.auth.userId === targetId || isOwner(req.auth.role)`.
- **Patterns to follow:** `routes/settings.ts` PUT handler (normalize at
  boundary, `createAuditEvent`, Zod parse); `requireAuth`/`requireTenant`.
- **Test scenarios:** happy/self, happy/owner-override, forbidden/other-user,
  invalid-number, clear-to-null, duplicate-number conflict.
- **Verification:** route handler tests green; audit row emitted; number stored
  E.164.

### U6. Technician phone settings UI
- **Goal:** A mobile-first sheet where a technician views/sets their number.
- **Requirements:** R4, R6.
- **Dependencies:** U5.
- **Files:**
  - `packages/web/src/components/settings/TechnicianPhoneSheet.tsx` (new) —
    mirror `BusinessProfileSheet.tsx`: GET current number, PUT to
    `/api/users/me/phone` on save, `formatPhoneForDisplay` for display, inline
    error/success, `min-h-11` tap targets, no 320px overflow.
  - wire it into the settings surface that lists sheets.
  - Tests:
    - `packages/web/src/components/settings/TechnicianPhoneSheet.test.tsx` (new,
      jsdom) — loads current number, sends normalized number in the PUT body,
      surfaces server errors; assert the class-contract (`min-h-11`).
    - `e2e/technician-phone-mobile.spec.ts` (new) — 320px viewport, no
      horizontal overflow, tap target ≥44px (mirror `e2e/booking-mobile.spec.ts`
      / the `estimate-approval-mobile` pattern).
- **Approach:** Reuse the sheet scaffold, `apiFetch`, and `formatPhoneForDisplay`
  helpers verbatim; the only new wiring is the endpoint + label copy.
- **Patterns to follow:** `BusinessProfileSheet.tsx` + its `.test.tsx`;
  `CallRoutingSheet.tsx` `type="tel"` input.
- **Test scenarios:** load populates the field; save PUTs the entered number;
  server 400 shows the message; class-contract asserts `min-h-11`; Playwright
  320px no-overflow + tap target.
- **Verification:** jsdom test + `npm run e2e:smoke` (the new spec) green.

### U7. Integration + golden e2e: escalation dials the selected number
- **Goal:** Prove end to end that a tradesperson's selected number is what
  inbound escalation dials.
- **Requirements:** R5, R6.
- **Dependencies:** U4, U5.
- **Files:**
  - `packages/api/test/integration/users-mobile-number.test.ts` (new, Docker) —
    set a user's `mobile_number` via the repo/endpoint under tenant context;
    confirm the real column + the `(tenant_id, mobile_number)` unique index;
    confirm RLS isolation (a second tenant can't see it).
  - `packages/api/test/telephony/escalation-dials-selected-number.test.ts` (new)
    — wire the REAL `createUserPhoneDispatcherResolver` (U4) with a `userRepo`
    seeded so an on-call user has a `mobile_number`, drive the dial-result
    cascade (mirror `telephony-routes.test.ts` P8-013 `buildDialHarness`), and
    assert the `<Dial>` rings that number; a second case with no number falls
    back to `business_phone`.
- **Approach:** Compose U4's resolver with the existing, already-tested dial
  cascade. The unique-index + RLS checks pin the real column behavior.
- **Patterns to follow:** `telephony-routes.test.ts` P8-013 dial harness;
  `rls-tenant-isolation.test.ts` `asTenant` helper.
- **Test scenarios:** selected-number dial; fallback dial; RLS isolation;
  unique-index conflict.
- **Verification:** `npm run test:integration` green; the dial e2e shows the
  selected number in the TwiML.

## Risks & Dependencies
- **Cassette regeneration (U3).** Touching `APPOINTMENT_SYSTEM_PROMPT` changes
  the create-appointment *task* cassette hashes; the classifier cassettes must
  stay byte-identical. Implementer must run the cassette-regen path and confirm
  the `git diff` is limited to create-appointment task entries and the
  launch-gate stays green. If the regen tooling needs live LLM access, confirm
  how cassettes are produced in CI/dev before starting U3.
- **Inbound-caller DRAFT carries no type.** The inbound FSM builds the
  `create_appointment` proposal at classify time (not via the task handler), so
  type is null on that draft until the appointment task runs at execution. This
  is an accepted non-goal; the R1 e2e asserts type on the operator/task path +
  the persisted row, not the inbound draft.
- **Resolver fallback altitude (U4) — highest Build-2 risk.** The fallback must
  live at the escalation CALL SITE (after rotation exhaustion), not inside the
  resolver. `escalateToHuman`'s walk treats a resolver `null` as "advance to the
  next on-call user" and any non-null as "dial this one". If the resolver returns
  `business_phone` for a numberless user, EVERY rotation entry resolves non-null
  and the walk never advances past entry 0 — per-user selection is silently
  defeated. Resolver → per-user-number-or-null; tenant-level `business_phone`
  applied only after the whole rotation yields nothing. Pin with a mixed-roster
  handler test.
- **Unique-number constraint (U5).** Migration 109's `(tenant_id,
  mobile_number)` partial unique index means two users can't share a number; the
  endpoint must translate the violation into a clean 409/validation error.
- **Migration append-only + immutability (U2).** Migrations concatenate in
  INSERTION order and re-run every boot; append new ones at the END and keep them
  idempotent (`ADD COLUMN IF NOT EXISTS`). Editing an existing migration body
  fails `migration-immutability.test.ts`. Pick the next free key (~`178`);
  duplicate numeric prefixes are tolerated (full string is the key).

## Open Questions (deferred to implementation)
- Exact final enum membership — `estimate | repair | install | maintenance |
  diagnostic` is the recommendation; confirm against product before locking the
  DB CHECK (it must match the Zod enum exactly).
- The precise next migration key (depends on the tree at implementation time).
- Whether user routes live in `routes/users.ts` or are folded into another
  router — confirm the mount point for U5.
- Whether an owner-override endpoint (`PUT /api/users/:id/phone`) is wanted in
  this pass or deferred — default: include it, owner-gated.
