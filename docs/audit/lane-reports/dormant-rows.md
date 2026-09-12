# Dormant rows — Opus TEST-ONLY lane (rows 3.8, 3.11, 4.7, 9.5)

Branch: `cloud/dormant-rows`, cut from `origin/main` @ `137dc559e` (PR #1047). One
commit per row. Run in Claude Code on the web (cloud sandbox), 2026-09-12.

Scope: the four §8 rows the entry audits marked "built and dormant" or unproven.
**No product code touched** — `git diff --stat origin/main...HEAD` is four files, all
under `packages/api/test/integration/`. No money math, pricing, RLS, auth, or
supervisor-gate changes; `credit-tier.ts`'s cap arithmetic is asserted, never edited.
No O-1…O-9 or Q12 question is answered here; where a row needs a decision, this
report drafts the issue text and stops.

**Only Fable states a rung.** Nothing below claims a row moves to a numbered rung.
This is evidence for that decision, not the decision.

## Summary table

| Row | File (new) | What the audit said | What the code says | Evidence class | Tenant grade |
|---|---|---|---|---|---|
| 3.8 | `appointment-confirmation-dispatch-3-8.test.ts` | "only live instantiation is a no-op notifier" | **Half true.** The dormant class is real; the confirmation path is *not* dead — a second implementation is wired and writes the row | PROVEN-REAL-DB | T1 |
| 3.11 | `proposal-expiry-sweep-3-11.test.ts` | "two TTL regimes"; guardrail has zero callers | **Confirmed.** 48 h worker is the only live regime; guardrail is dead code | PROVEN-REAL-DB + STRUCTURAL (negative control) | T2 |
| 4.7 | `lateness-from-truck-location-4-7.test.ts` | evaluator's only importer is type-only | **Confirmed**, and sharper: the evaluator's sole value export has *no* reference anywhere in `src/` | STRUCTURAL (negative control) + REAL-DB-WRITE-ONLY for ingestion | T1 |
| 9.5 | `service-credit-cap-9-5.test.ts` | the only test stubs `pool.connect()` | **Confirmed.** Replaced with a real-Postgres proof; the cap holds at draft and **fails at execute** | PROVEN-REAL-DB | T1 |

Command for every file (from `packages/api/`):

```
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  --reporter=verbose test/integration/<file>
```

Build verification: `npx tsc --project tsconfig.build.json --noEmit` → clean.
`git status --porcelain` → empty.

Each file carries current-behaviour tests that pass as ordinary tests (never
`it.fails` — `it.fails` passes when *any* assertion throws, so it hides setup
regressions) plus exactly one plainly named `it.fails` stating the desired
behaviour.

---

## Row 3.8 — customer confirmation on approval

**Criterion:** an approved `create_appointment`, when executed, writes an
`appointment_confirmation` dispatch row.

### What is wired, and what is not

The G1 note reads *"the only live instantiation is a no-op notifier;
`AppointmentConfirmationNotifier` is never constructed."* The first clause does not
hold. Reading the wiring end to end:

- **`AppointmentConfirmationNotifier`** — `src/notifications/appointment-confirmation-notifier.ts:37`.
  Genuinely dormant: `grep -rn AppointmentConfirmationNotifier packages/api/src`
  returns exactly one hit, its own definition. Nothing in `src/` constructs it.
- **`TransactionalCommsService`** — `src/notifications/transactional-comms-service.ts:95`
  — implements the *same* `SchedulingConfirmationNotifier` interface. Its `enqueue()`
  (line 98) calls `sendAppointmentNotice(…, 'appointment_confirmation', …)` (line 335),
  which writes the dispatch row through `sendCustomerMessage`.
- **The wiring site:** `src/app.ts:1910`, `schedulingNotifier: transactionalComms`,
  inside the `createExecutionHandlerRegistry({…})` call. `transactionalComms` is built
  at **`app.ts:1770-1782`**, guarded by `messageDelivery ? … : undefined`.
- **The no-op** — `NoopSchedulingConfirmationNotifier`,
  `src/proposals/execution/scheduling-notifications.ts:18` — is the *constructor
  default* of `CreateAppointmentExecutionHandler`
  (`src/proposals/execution/handlers.ts:381`). It takes effect only when
  `deps.schedulingNotifier` is `undefined`, i.e. when `messageDelivery` is `null`
  (`app.ts:1328`), i.e. delivery mode `'none'` — **prod/staging with neither Twilio
  nor SendGrid credentials** (`src/notifications/delivery-provider-factory.ts:163-176`).
  Every other environment, dev and test included, gets `InMemoryDeliveryProvider`
  and therefore a live notifier.

So the row's failure is real but conditional on boot-time wiring, and **nothing
records the omission when it happens** — no dispatch row, no audit event, no
owner-visible signal.

**Exact wiring site for the dormant class:** were `AppointmentConfirmationNotifier`
to go live, it would be constructed alongside `transactionalComms` at
`app.ts:1770` and passed at `app.ts:1910` in its place — its
`AppointmentConfirmationNotifierDeps` (`appointment-confirmation-notifier.ts:12`)
names six deps (`delivery`, `appointmentRepo`, `jobRepo`, `customerRepo`,
`settingsRepo`, `dispatchRepo`), all five repos plus `messageDelivery` already in
scope at that point in `createApp`.

**Table/repository:** `message_dispatches`, written by `PgDispatchRepository.create`
(`src/notifications/dispatch-repository.ts:178`, INSERT at line 188).

### Tests

Everything runs through the production execution registry
(`createExecutionHandlerRegistry`) + `ProposalExecutor`, against Pg repos.

- no notifier wired (the `mode: 'none'` boot) → appointment persists, **zero**
  dispatch rows of any entity type for it
- `TransactionalCommsService` wired as `app.ts:1910` wires it → sms + email
  confirmation rows with the right recipients
- the **dormant notifier**, constructed the way `app.ts` would have to → writes the
  same rows; it is a second, unused implementation of behaviour that already ships
- **T1:** a neighbour tenant's booking writes only its own rows; tenant A's row-id
  set is identical before and after
- audit leg: `appointment.created` reads back via `PgAuditRepository.findByEntity`;
  the neighbour tenant reads none of it

### RED (deliberately wrong expectation: asserted 2 confirmation rows)

```
 × CURRENT: with no delivery provider (app.ts mode "none"), an approved create_appointment
   writes the appointment but NO appointment_confirmation dispatch row 32ms
   → expected [] to have a length of 2 but got +0
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

### GREEN

```
 ✓ CURRENT: with no delivery provider (app.ts mode "none") … NO appointment_confirmation dispatch row 28ms
 ✓ CURRENT: the SAME execution through the SAME registry DOES write sms+email … as app.ts:1910 wires it 28ms
 ✓ CURRENT: the dormant AppointmentConfirmationNotifier, constructed the way app.ts would have to, also writes … 15ms
 ✓ CURRENT (T1): a neighbour tenant booking through the live notifier writes only its OWN confirmation rows … 21ms
 ✓ CURRENT: the audit leg reads back through PgAuditRepository.findByEntity … 26ms
 ✓ DESIRED (row 3.8): an approved create_appointment writes an appointment_confirmation dispatch row even when
   app.ts resolves NO delivery provider … 10ms
 Test Files  1 passed (1)
      Tests  5 passed | 1 expected fail (6)
```

### Evidence class / tenant grade

**PROVEN-REAL-DB** — the dispatch write and the `appointment.created` audit event are
both proven against real Postgres. **T1** — a second tenant exists and its write is
invisible to the first. (The "tenant A's row set is byte-identical after tenant B
writes" assertion is T2-shaped but narrow; graded T1 conservatively.)

### Judgment calls

- The instruction expected "constructing the dormant notifier does write it" to be
  the desired-state test. It is not: constructed, the dormant notifier **passes**, so
  it is recorded as a current-behaviour test. The single `it.fails` restates the row's
  own criterion unconditionally instead — it takes no new position.
- The tests wire the raw `InMemoryDeliveryProvider`, not `GatedMessageDelivery`. The
  gate is orthogonal to this row (it decides *whether a send is permitted*, not
  whether the dispatch row is written); fixtures set `smsConsent: true` so a later
  wrapping change cannot silently turn these into suppressions.

### Drafted issue

> **Title:** 3.8 — the customer confirmation has two implementations, one dead, and no record when it is skipped
>
> `AppointmentConfirmationNotifier` (`packages/api/src/notifications/appointment-confirmation-notifier.ts:37`)
> is never constructed anywhere in `src/`. Its behaviour is duplicated by
> `TransactionalCommsService.enqueue` (`transactional-comms-service.ts:95`), which app.ts
> **does** wire as `schedulingNotifier` (`app.ts:1910`). Pinned by
> `test/integration/appointment-confirmation-dispatch-3-8.test.ts`: constructed the way
> app.ts would have to, the dormant class writes exactly the same sms+email
> `message_dispatches` rows the live one does.
>
> Two things to decide:
> 1. **The dead class.** Delete it (with its suppression unit test), or make it the live
>    notifier and retire the duplicated branch in `TransactionalCommsService`. Code
>    hygiene says delete; nothing in the tree depends on the choice.
> 2. **The silent skip.** When `createMessageDeliveryProvider` resolves mode `'none'`
>    (prod/staging with no Twilio and no SendGrid credentials,
>    `delivery-provider-factory.ts:163-176`), `deps.schedulingNotifier` is `undefined`,
>    the handler falls back to `NoopSchedulingConfirmationNotifier` (`handlers.ts:381`),
>    and an approved booking produces **no dispatch row, no audit event, and no
>    owner-visible signal** that the customer was never confirmed. The `it.fails` in that
>    file pins this. Options: record a `status: 'failed'` dispatch row so the omission is
>    visible; emit an audit event; refuse to execute; or accept it and say so in the row.
>
> Row 3.8 cannot be closed either way without (2). Decision is Josh's; this lane only
> proved the behaviour.

---

## Row 3.11 — stale schedule proposals expire

**Criterion:** an unactioned schedule proposal expires when the TTL passes and can be
re-proposed. Open question on the row: "two TTL regimes coexist."

### What is wired, and what is not

- **Live:** `SCHEDULE_PROPOSAL_EXPIRY_MS = 48h` (`src/proposals/proposal.ts:109`),
  applied at creation by `defaultProposalExpiry` (line 120) to the three
  `SCHEDULE_PROPOSAL_TYPES` (line 102). Swept by `runProposalExpirySweep`
  (`src/workers/proposal-expiry-worker.ts:52`), registered hourly at `app.ts:6485-6498`
  with `listTenantIds: () => listAllTenantIds(pool)`.
- **Dead:** `src/ai/guardrails/expiration.ts` — `DEFAULT_EXPIRATION_CONFIG` (lines 11-17)
  sets a 24 h default and a 4 h `create_appointment` TTL. **Zero importers under
  `src/`.** Its only importer in the repo is its own unit test
  (`test/ai/guardrails-expiration.test.ts:8`), which passes 9/9 against code nothing
  calls.

"Two regimes coexist" is true as source and false as behaviour.

### Tests

Behavioural half runs the **production selector** (`listAllTenantIds`, not a
hand-picked list):

- a 50 h-old `create_appointment` card → `status = 'expired'` + a `proposal.expired`
  audit row read back via `findByEntity` (actor `proposal-expiry-worker`, role `system`)
- a same-age `draft_estimate` carries no `expiresAt` and is invisible to the sweep
- **T2:** a neighbour tenant's *fresh* card survives the same pass that expires tenant
  A's stale one; neither tenant reads the other's audit rows
- re-proposal: the new card carries a fresh 48 h window and survives the next sweep;
  the expired card stays terminal and gets no second audit row
- `defaultProposalExpiry('create_appointment', …)` is asserted to be exactly +48 h —
  not the guardrail's 4 h

Structural half: a scanner over every `.ts` under `src/` resolving relative import
specifiers, with a **negative control** — the same scan for
`workers/proposal-expiry-worker` must return `app.ts`, so a scanner that can only
return `[]` cannot pass as proof.

### RED (deliberately wrong: asserted the sweep leaves the stale card pending)

```
 × CURRENT: an unactioned schedule proposal past 48 h expires at real Postgres … 46ms
   → expected 'expired' to be 'ready_for_review'
 Test Files  1 failed (1)
      Tests  1 failed | 4 passed (5)
```

### GREEN

```
 ✓ CURRENT: the live TTL applied at creation is the worker`s 48 h, not the guardrail`s 4 h … 2ms
 ✓ CURRENT: an unactioned schedule proposal past 48 h expires at real Postgres, with its proposal.expired audit row … 46ms
 ✓ CURRENT (T2): a neighbour tenant`s FRESH schedule proposal is untouched by the same sweep pass … 23ms
 ✓ CURRENT: after expiry the operator can re-propose … 31ms
 ✓ STRUCTURAL: ai/guardrails/expiration.ts has NO runtime importer under src/ — negative control … 132ms
 ✓ DESIRED (row 3.11): exactly ONE proposal-TTL regime exists in the tree … 63ms
 Test Files  1 passed (1)
      Tests  5 passed | 1 expected fail (6)
```

### Evidence class / tenant grade

**PROVEN-REAL-DB** (status change + audit event at real Postgres) **plus STRUCTURAL**
(guard test with a planted negative control) for the dead-module claim. **T2** — a
neighbour tenant's data does not change tenant A's answer in the same pass.

**Not T4, deliberately.** §8.0 caps any tenant-iterating capability at rung 4 until
T4, and T4 needs three things: the production selector runs, every eligible tenant is
processed, **and a failure on one does not abort the rest**. The first two are proven
here (`listAllTenantIds` really runs; `outcome.tenants >= 2` with both tenants'
outcomes asserted). The third is not — no tenant is made to throw. A T4 entry for this
sweep belongs in `sweep-tenant-fanout.test.ts` alongside the reminder and
accounting-sync sweeps, and is left to the row's owner.

### Judgment calls

- The sweep uses the real all-tenants selector, so in a shared container it also sees
  tenants seeded by other files. Assertions are scoped to this file's own tenants;
  files run sequentially and each seeds its own, so a later file's proposals are created
  after this file's last sweep.
- **Recommendation, not action:** delete `src/ai/guardrails/expiration.ts` and
  `test/ai/guardrails-expiration.test.ts`. Nothing imports either. This lane did not
  delete them — the row's note asked for the question to be closable one way or the
  other, and it now is.

### Drafted issue

> **Title:** 3.11 — retire the dead second TTL regime in `ai/guardrails/expiration.ts`
>
> The PRD row says "two TTL regimes coexist (48 h in the worker, 24 h default and 4 h for
> `create_appointment` in the guardrail)". Only one runs.
> `test/integration/proposal-expiry-sweep-3-11.test.ts` proves both halves at real
> Postgres: the worker's 48 h regime expires, audits and permits re-proposal; and
> `src/ai/guardrails/expiration.ts` has **zero importers under `src/`** (scanner carries a
> negative control against `workers/proposal-expiry-worker`, which correctly finds
> `app.ts`).
>
> The module's only importer in the repo is its own unit test, which passes 9/9 against
> code nothing calls — exactly the "tested, dead" shape CLAUDE.md's hygiene rule tells us
> to remove. Its numbers actively mislead: a reader would conclude a `create_appointment`
> card dies after 4 hours. It dies after 48.
>
> Recommendation: delete `src/ai/guardrails/expiration.ts` and
> `test/ai/guardrails-expiration.test.ts`, then flip the row's note from "two regimes" to
> "one regime, 48 h". If instead the 4 h TTL for time-sensitive bookings is wanted, that
> is a product change to `defaultProposalExpiry`, not a second module. Either way the
> `it.fails` in the integration file goes green.

---

## Row 4.7 — lateness from truck location

**Criterion:** given geofence/dwell signals, when evaluated, a lateness state with a
confidence breakdown.

### What is wired, and what is not

- **Wired — the ingestion half.** `POST /api/technician-location`
  (`src/routes/technician-location.ts`, mounted `app.ts:5523`) validates and persists
  pings through `PgTechnicianLocationPingRepository`
  (`src/telemetry/pg-technician-location-ping.ts:22`) into `technician_location_pings`.
- **Not wired — the evaluation half.** `computeDispatchLateness`
  (`src/dispatch/lateness.ts:278`) is the module's **only value export** and is
  referenced by **no file under `src/`**. The module's single importer,
  `src/dispatch/board-query.ts:5`, binds `DispatchLatenessResult` — a type, used only
  in type positions (lines 40, 91, 149, 294, 323). TypeScript elides it at emit, so no
  runtime edge exists at all.
- **Where a lateness state WOULD land:** `DispatchBoardItem.lateness`
  (`board-query.ts:40`) — a field `GET /api/dispatch/board` already serialises —
  populated by the optional `BoardQueryDependencies.getAppointmentLateness` hook
  (`board-query.ts:91`, called at 289 and 317). The seam is already built. The
  production route never supplies the hook: `DispatchRouteDeps`
  (`src/dispatch/routes.ts:29-38`) declares no lateness dependency of any kind.
  The only place the hook is ever set is a unit test
  (`test/dispatch/board-query.test.ts:203`).

### Tests

- **STRUCTURAL** with a negative control: no file under `src/` references
  `computeDispatchLateness`; the same scan for `getDispatchBoardData` finds
  `dispatch/routes.ts`. Also pins that `board-query.ts` imports only the result type.
- ingestion at real Postgres: six dwell pings persist and read back through both
  `listByAppointment` and `listByTechnician`
- **T1:** a neighbour tenant's pings are invisible — tenant A asking for tenant B's
  technician *and* tenant B's appointment gets nothing, both ways
- with those pings in the database, a board built the way the production route builds
  it carries `lateness === undefined` on **every** item
- audit: `appointment.created` reads back via `findByEntity`; no lateness event has
  ever been emitted; the pings themselves are **unaudited** (`findByEntity` for
  `technician_location_ping` returns nothing); the neighbour tenant reads none of it

### RED (deliberately wrong: asserted the board *does* carry lateness)

```
 × CURRENT: with those pings in the database, the dispatch board built the way the production
   route builds it carries NO lateness on any item 11ms
   → expected true to be false
 Test Files  1 failed (1)
      Tests  1 failed | 4 passed | 1 expected fail (6)
```

### GREEN

```
 ✓ STRUCTURAL: computeDispatchLateness … is referenced by NO file under src/; negative control … 118ms
 ✓ CURRENT: a technician location update persists to technician_location_pings … 14ms
 ✓ CURRENT (T1): a neighbour tenant`s pings are invisible to tenant A … 13ms
 ✓ CURRENT: with those pings in the database, the dispatch board … carries NO lateness on any item 6ms
 ✓ CURRENT: the audit trail reads back for the appointment … and a location update writes NO audit row of its own 7ms
 ✓ DESIRED (row 4.7): with dwell pings on the service location, the dispatch board item … carries a lateness state
   and a confidence breakdown 8ms
 Test Files  1 passed (1)
      Tests  5 passed | 1 expected fail (6)
```

### Evidence class / tenant grade

**STRUCTURAL** (guard test with a negative control) for the absent runtime edge —
the claim the row turns on. The ingestion leg is **REAL-DB-WRITE-ONLY (4−)**: the write
is proven at real Postgres and there is no audit leg to prove, because location pings
emit no audit event. **T1** for both.

### Judgment calls

- The structural test asserts on the *symbol*, not the import specifier. `board-query.ts`
  does import from `./lateness`, so an import-specifier scan would report a false
  positive; a value export with no textual reference anywhere in `src/` cannot have a
  runtime caller. Strictly stronger than the row's "type-only import" phrasing.
- The fixture appointment is deliberately in the past (started 90 min ago, due to end 30
  min ago) — the shape an evaluator would call late. `createAppointment` logs
  "Appointment is scheduled in the past" to stderr; that is the domain warning hook
  firing as designed, not a failure.
- No opinion is offered on whether to wire or retire. The `it.fails` states the row's
  criterion at the field where the answer would land, and nothing more.

### Drafted issue (the wire-or-retire decision)

> **Title:** 4.7 — decide: wire the dispatch lateness evaluator, or retire it
>
> `computeDispatchLateness` (`packages/api/src/dispatch/lateness.ts:278`) is a complete,
> unit-tested (24/24) geofence/dwell evaluator producing a lateness state, a confidence
> score and a three-part confidence breakdown. **Nothing calls it.** It is the module's
> only value export and no file under `packages/api/src` references it; the single import
> of the module (`board-query.ts:5`) binds only the result *type*, which TypeScript
> elides at emit. Pinned structurally, with a negative control, in
> `test/integration/lateness-from-truck-location-4-7.test.ts`.
>
> The two halves either side of it are real:
> - **Signals in.** `POST /api/technician-location` persists pings to
>   `technician_location_pings` via `PgTechnicianLocationPingRepository`. Proven at real
>   Postgres in that file, tenant-scoped (T1).
> - **A place to put the answer.** `DispatchBoardItem.lateness` (`board-query.ts:40`),
>   populated by the optional `getAppointmentLateness` hook (`board-query.ts:91`, called
>   at 289/317) and served by `GET /api/dispatch/board`.
>
> The missing piece is one adapter: read this appointment's recent pings + its service
> location, call `computeDispatchLateness`, return the result — then pass it as
> `getAppointmentLateness` from the dispatch route. `DispatchRouteDeps`
> (`routes.ts:29-38`) would need the ping repo and the location repo added.
>
> **Decision needed (Josh):**
> 1. **Wire it** — the adapter above, plus: where does the owner *see* it (board badge?
>    proactive notice?), does `autoNotifyCustomer` ever fire without approval (it must
>    not — everything customer-facing goes through the proposal gate), and what does the
>    board cost per query with a ping read per appointment?
> 2. **Retire it** — delete `src/dispatch/lateness.ts`, its 24 unit tests, the
>    `lateness` field on `DispatchBoardItem`, and the `getAppointmentLateness` hook, and
>    mark 4.7 not-built rather than built-and-dormant.
>
> Row 4.7 stays at whatever "built and dormant" earns until this is decided. This lane
> takes no position; the `it.fails` in the integration file goes green under (1) and is
> deleted under (2).

---

## Row 9.5 — service credits without over-giving

**Criterion:** $80 already issued in 12 months and a $50 tier proposed ⇒ the credit is
**omitted, not zeroed**.

### What is wired, and what is not

- `PgServiceCreditRepository.sumIssuedInLast12Months`
  (`src/reputation/pg-service-credit.ts:80`) runs the rolling-window aggregate under
  `withTenant`, so RLS scopes it.
- `buildReviewResponseProposal` (`src/reputation/build-proposal.ts:141-163`) calls it at
  **draft** time, feeds the total to `applyCreditCap` (`src/reputation/credit-tier.ts:74`)
  and leaves `serviceCredit` at its `null` initialiser when the capped amount is 0 —
  the omission the row asks for.
- `app.ts` wires the Pg repo into both that path and `ReviewResponseExecutionHandler`
  (`src/proposals/execution/review-response-handler.ts:121`).
- **Not wired:** any cap check at **execution** time. `executeServiceCredit`
  (`review-response-handler.ts:334-356`) inserts whatever the payload carries, with no
  re-read of the rolling sum. `build-proposal.ts`'s own header admits it: *"a delayed
  approval after a separate credit was issued in the meantime is still capped at-execute
  by the issuance path (today the handler does not re-check; documented as a known
  trade-off in the handler)"* — the at-execute cap it refers to does not exist.

The row's prior evidence, `test/reputation/pg-service-credit.test.ts`, stubs
`pool.connect()` by its own header. That proves the SQL string was assembled; it cannot
prove `service_credits` has an `issued_at` column, that `NOW() - INTERVAL '12 months'`
excludes what the caller believes, or that RLS scopes the SUM.

### Tests

- cap arithmetic **asserted, never changed**: `CREDIT_CAP_CENTS_PER_12_MONTHS === 10000`,
  `creditTierForReview('specific_complaint', 2) === 5000`,
  `applyCreditCap(5000, 8000) === 0`, and the documented "exactly at the cap is allowed"
  edge
- $50 + $30 seeded **inside** the window and $80 seeded 13 months **outside** it →
  `sumIssuedInLast12Months` returns exactly $80 while all three rows sit in the table,
  so the window did the excluding, not an empty ledger
- the built proposal's `serviceCredit` is **`null`**, and no `"amountCents":0` appears
  anywhere in the payload; the rest of the proposal is intact (omission, not suppression)
- the ledger is byte-identical before and after the draft
- **T1:** a neighbour tenant's $80 does not count here, and asking for another tenant's
  customer returns **0** — another tenant's credits are not merely uncounted, they are
  unreadable. A third tenant with a clean customer still draws the full $50, so the
  omission is the cap firing, not credits being globally off
- executing the capped proposal through the production registry issues no credit; the
  `review_response.executed` audit row reads back via `findByEntity` with `subResults`
  empty; the neighbour tenant reads none of it

### RED (deliberately wrong: asserted a zeroed credit component instead of omission)

```
 × CURRENT: with $80 in the window and a $50 tier, the built proposal OMITS the credit —
   serviceCredit is null, not an amountCents of 0 8ms
   → expected null to deeply equal { …(3) }
   - Expected: { "amountCents": 0, "approved": false, "customerId": "…" }
   + Received: null
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed | 1 expected fail (7)
```

**A second RED, and a real trap avoided.** On the first two runs the `it.fails`
*passed* — vitest reported `Error: Expect test to fail`. It was not the product
refusing the over-cap credit; `service_credits` carries FKs to `proposals(id)` **and**
`google_reviews(id)`, and the fixtures held both only in memory, so every credit insert
died on a foreign key and was swallowed by the handler's per-sub-action try/catch.
An "assert no credit was issued" test would have passed for entirely the wrong reason.
Fixed by persisting the proposal through `PgProposalRepository` and the review through
`PgReviewRepository.upsert`. Run once as a plain `it` to confirm the failure reason:

```
 × DESIRED (row 9.5): a $50 credit approved after the customer crossed the cap is refused at
   EXECUTION time too, not just omitted at draft time 32ms
   → expected 14000 to be less than or equal to 10000
```

$40 prior + a $50 draft + another $50 issued before approval = **$140 against a $100
cap**, written to the ledger at execute.

### GREEN

```
 ✓ ASSERTS (unchanged): the cap is $100 per 12 months and $80 prior + a $50 tier overflows it … 1ms
 ✓ CURRENT: sumIssuedInLast12Months at real Postgres counts only the in-window credits — $80 … 4ms
 ✓ CURRENT: with $80 in the window and a $50 tier, the built proposal OMITS the credit — serviceCredit is null … 5ms
 ✓ CURRENT: building that proposal leaves the ledger byte-identical — a capped draft issues nothing 6ms
 ✓ CURRENT (T1): a neighbour tenant`s $80 does not count against this tenant … 13ms
 ✓ CURRENT: executing the capped proposal through the production registry issues no credit, and the
   review_response.executed audit row reads back via findByEntity 24ms
 ✓ DESIRED (row 9.5): a $50 credit approved after the customer crossed the cap is refused at EXECUTION time too … 32ms
 Test Files  1 passed (1)
      Tests  6 passed | 1 expected fail (7)
```

### Evidence class / tenant grade

**PROVEN-REAL-DB** — the ledger write, the rolling-window read, the omission, and the
`review_response.executed` audit event are all proven against real Postgres. **T1** — a
neighbour tenant's ledger is both uncounted and unreadable.

### Judgment calls

- The LLM classifier, customer matcher and the two drafting calls are stubbed through
  the override hooks `BuildReviewResponseProposalDeps` already declares for exactly that.
  The credit leg — the only thing this row is about — is the real `PgServiceCreditRepository`
  against Postgres.
- Money-adjacent discipline: nothing in `credit-tier.ts`, `build-proposal.ts` or
  `pg-service-credit.ts` was edited. The cap constant and `applyCreditCap`'s
  strict-overflow edge are read and asserted.
- The `it.fails` reports a gap the source comments already acknowledge. Closing it is a
  product decision, drafted below, not taken here.

### Drafted issue

> **Title:** 9.5 — the service-credit cap is enforced at draft time only; a delayed approval can exceed it
>
> `applyCreditCap` runs inside `buildReviewResponseProposal`
> (`packages/api/src/reputation/build-proposal.ts:153`) when the proposal is **drafted**.
> `ReviewResponseExecutionHandler.executeServiceCredit`
> (`src/proposals/execution/review-response-handler.ts:334-356`) inserts
> `component.amountCents` verbatim with no re-read of `sumIssuedInLast12Months`.
>
> So: a $50 credit drafted while the customer sits at $40, approved a week later after
> another $50 has landed, executes into a **$140** rolling total against a **$100** cap.
> Reproduced at real Postgres in `test/integration/service-credit-cap-9-5.test.ts`
> (`it.fails`, observed: `expected 14000 to be less than or equal to 10000`).
>
> `build-proposal.ts`'s own header calls this a known trade-off and says the issuance path
> caps it at execute. It does not — there is no cap check on that path.
>
> The draft-time behaviour the row actually asks for is correct and now proven: with $80
> in the window and a $50 tier the credit is **omitted** (`serviceCredit: null`), not
> zeroed, and no `"amountCents":0` reaches the owner's approval UI. This issue is only
> about the execute-time window.
>
> **Decision needed (Josh):** re-check the rolling sum inside `executeServiceCredit` and
> refuse (or clamp — but clamping reintroduces the "$0 credit" the row exists to avoid, so
> refuse-and-surface looks right), or accept the window and document it on the row.
> Either way, "the handler does not re-check" should stop being described as capped.

---

## Evidence — plain container, all four files, then SQL

Container:

```
docker run -d --rm -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=serviceos_test -p 127.0.0.1:0:5432 \
  pgvector/pgvector:pg16 -c max_connections=300
→ ce9245cb313a…  port 32768
```

Re-run of all four files against it:

```
cd packages/api && RLS_RUNTIME_ROLE=true \
  EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32768/serviceos_test \
  npx vitest run --config vitest.integration.config.ts --reporter=verbose \
  test/integration/appointment-confirmation-dispatch-3-8.test.ts \
  test/integration/proposal-expiry-sweep-3-11.test.ts \
  test/integration/lateness-from-truck-location-4-7.test.ts \
  test/integration/service-credit-cap-9-5.test.ts

 Test Files  4 passed (4)
      Tests  21 passed | 4 expected fail (25)
   Duration  5.57s
```

### `audit_events`, grouped by tenant and event

```
              tenant_id               |        event_type        | entity_type | n
--------------------------------------+--------------------------+-------------+---
 34a4bd46-aba9-4546-a7d1-ef8e2812857d | appointment.created      | appointment | 1
 90623f3c-24ae-46d0-8e82-9ed88a6feb7e | appointment.created      | appointment | 1
 92ad1d66-a532-4714-95f3-3df81605ded9 | appointment.created      | appointment | 1
 a90be2f5-53e6-40fa-9cb7-8018e5ff35f9 | appointment.created      | appointment | 5
 52af7079-a5fb-4a81-9ed2-6adb4fa77f94 | proposal.executed        | proposal    | 1
 92ad1d66-a532-4714-95f3-3df81605ded9 | proposal.executed        | proposal    | 1
 a90be2f5-53e6-40fa-9cb7-8018e5ff35f9 | proposal.executed        | proposal    | 5
 fa90ad5f-d712-407e-9f70-63883e1aba7c | proposal.executed        | proposal    | 1
 ed629ea8-6d9a-4d65-b4d3-e8065dc7d4c2 | proposal.expired         | proposal    | 3
 52af7079-a5fb-4a81-9ed2-6adb4fa77f94 | review_response.executed | proposal    | 1
 fa90ad5f-d712-407e-9f70-63883e1aba7c | review_response.executed | proposal    | 1
(11 rows)
```

Tenant map: `a90be2f5…`/`92ad1d66…` = row 3.8 Alpha/Bravo. `34a4bd46…`/`90623f3c…` =
row 4.7 Alpha/Bravo. `ed629ea8…`/`cd8b513f…` = row 3.11 A/B. `52af7079…`/`d8df4575…`/
`291b5199…` = row 9.5 Alpha/Bravo/Charlie; `fa90ad5f…` = row 9.5 "Delta", the
`it.fails` tenant. Note the expiry audit rows land in **exactly one** tenant — the
neighbour's fresh card was never touched.

### `message_dispatches` (row 3.8)

```
              tenant_id               |       entity_type        | channel |         recipient          | provider  | status
--------------------------------------+--------------------------+---------+----------------------------+-----------+--------
 92ad1d66-a532-4714-95f3-3df81605ded9 | appointment_confirmation | email   | bravo-edc320f7@example.com | in-memory | sent
 92ad1d66-a532-4714-95f3-3df81605ded9 | appointment_confirmation | sms     | +16025551851               | in-memory | sent
 a90be2f5-53e6-40fa-9cb7-8018e5ff35f9 | appointment_confirmation | email   | alpha-5750da06@example.com | in-memory | sent
 a90be2f5-53e6-40fa-9cb7-8018e5ff35f9 | appointment_confirmation | sms     | +16025554620               | in-memory | sent
 a90be2f5-53e6-40fa-9cb7-8018e5ff35f9 | appointment_confirmation | email   | alpha-5750da06@example.com | in-memory | sent
 a90be2f5-53e6-40fa-9cb7-8018e5ff35f9 | appointment_confirmation | sms     | +16025554620               | in-memory | sent
 a90be2f5-53e6-40fa-9cb7-8018e5ff35f9 | appointment_confirmation | email   | alpha-5750da06@example.com | in-memory | sent
 a90be2f5-53e6-40fa-9cb7-8018e5ff35f9 | appointment_confirmation | sms     | +16025554620               | in-memory | sent
(8 rows)
```

Alpha ran **five** executions (`appointment.created` n=5, `proposal.executed` n=5):
three with a notifier wired (live, dormant, audit test) and two with none (the
`mode: 'none'` test and the `it.fails`). Three × two channels = the six rows above.
The two no-provider executions contributed **nothing** — that is the row's gap, in the
table.

### `proposals` (row 3.11 + the 9.5 anchors)

```
              tenant_id               |      proposal_type       |      status      | past_ttl
--------------------------------------+--------------------------+------------------+----------
 291b5199-30e2-4d05-b27f-67ead1feeef7 | review_response_proposal | draft            |
 52af7079-a5fb-4a81-9ed2-6adb4fa77f94 | review_response_proposal | draft            |
 52af7079-a5fb-4a81-9ed2-6adb4fa77f94 | review_response_proposal | executed         |
 cd8b513f-5e42-405b-b53f-ad9ab5becbe9 | create_appointment       | ready_for_review | f
 d8df4575-6ec8-4157-9698-9c1548175cbc | review_response_proposal | draft            |
 ed629ea8-6d9a-4d65-b4d3-e8065dc7d4c2 | create_appointment       | expired          | t
 ed629ea8-6d9a-4d65-b4d3-e8065dc7d4c2 | create_appointment       | expired          | t
 ed629ea8-6d9a-4d65-b4d3-e8065dc7d4c2 | create_appointment       | ready_for_review | f
 ed629ea8-6d9a-4d65-b4d3-e8065dc7d4c2 | draft_estimate           | ready_for_review |
 ed629ea8-6d9a-4d65-b4d3-e8065dc7d4c2 | reschedule_appointment   | expired          | t
 fa90ad5f-d712-407e-9f70-63883e1aba7c | review_response_proposal | draft            |
 fa90ad5f-d712-407e-9f70-63883e1aba7c | review_response_proposal | executed         |
(12 rows)
```

Every `past_ttl = t` row is `expired`; every `past_ttl = f` row is still
`ready_for_review` — including the neighbour tenant's (`cd8b513f…`). The
`draft_estimate` has a NULL `expires_at` and was never a candidate.

### `service_credits` (row 9.5)

```
              tenant_id               |             customer_id              | amount_cents | issued_on  | in_window | has_review
--------------------------------------+--------------------------------------+--------------+------------+-----------+------------
 52af7079-a5fb-4a81-9ed2-6adb4fa77f94 | b334ab29-1ea8-4fb1-a64a-c28f5f87ac0c |         8000 | 2025-08-12 | f         | f
 52af7079-a5fb-4a81-9ed2-6adb4fa77f94 | b334ab29-1ea8-4fb1-a64a-c28f5f87ac0c |         3000 | 2026-02-24 | t         | f
 52af7079-a5fb-4a81-9ed2-6adb4fa77f94 | b334ab29-1ea8-4fb1-a64a-c28f5f87ac0c |         5000 | 2026-08-13 | t         | f
 d8df4575-6ec8-4157-9698-9c1548175cbc | dd368c7f-2c61-4bb6-9119-5b8ff8b31e91 |         8000 | 2026-08-13 | t         | f
 fa90ad5f-d712-407e-9f70-63883e1aba7c | 28a27709-d58b-4d84-af6b-e51a42672d8c |         4000 | 2026-09-02 | t         | f
 fa90ad5f-d712-407e-9f70-63883e1aba7c | 28a27709-d58b-4d84-af6b-e51a42672d8c |         5000 | 2026-09-11 | t         | f
 fa90ad5f-d712-407e-9f70-63883e1aba7c | 28a27709-d58b-4d84-af6b-e51a42672d8c |         5000 | 2026-09-12 | t         | t
(7 rows)
```

Tenant `52af7079…` (Alpha): $30 + $50 in window = **$80**, with the 2025-08-12 $80 out
of window — and **no fourth row**, because the $50 tier was omitted rather than issued.
Tenant `d8df4575…` (Bravo): its own $80, which did not count against Alpha. Tenant
`fa90ad5f…` (Delta, the `it.fails`): $40 + $50 + $50 = **$140 in window against a $100
cap**, the last row carrying a `review_id` — that is the over-cap credit written at
execution time, visible in SQL.

### `technician_location_pings` (row 4.7)

```
              tenant_id               |            technician_id             | pings | acc | avg_lat  |  avg_lng
--------------------------------------+--------------------------------------+-------+-----+----------+------------
 34a4bd46-aba9-4546-a7d1-ef8e2812857d | c7efe14d-16f5-4951-9c61-d99b0ceb7a5f |     6 |   8 | 33.44843 | -112.07398
 90623f3c-24ae-46d0-8e82-9ed88a6feb7e | d8aa60ba-81f6-4cab-bf1c-792fa21fab80 |     4 |   8 | 33.44842 | -112.07399
(2 rows)
```

Six dwell pings for tenant A parked on the service location, four for the neighbour —
and, per the board assertion above, not one lateness state derived from any of them.

---

## Falsifier greps (§8.0's "how to confirm a grade")

```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" \
    test/integration/appointment-confirmation-dispatch-3-8.test.ts
93:  let tenantB: SeededTenant;
270:    tenantB = await seedTenant('Bravo');
320:      tenantB,
324:    const rowsB = await confirmationRows(tenantB.tenant.tenantId, appointmentB);
326:    expect(rowsB.find((r) => r.channel === 'sms')?.recipient).toBe(tenantB.phone);
350:      tenantB.tenant.tenantId,

$ grep -nE "…" test/integration/proposal-expiry-sweep-3-11.test.ts
110:  let tenantB: TestTenant;
152:    tenantB = await createTestTenant(pool);
197:    const freshB = await seedProposal(tenantB, 'create_appointment', { ageHours: 1 });
206:    expect((await proposalRepo.findById(tenantB.tenantId, freshB.id))?.status).toBe(
209:    const bEvents = await auditRepo.findByEntity(tenantB.tenantId, 'proposal', freshB.id);
212:    const crossTenant = await auditRepo.findByEntity(tenantB.tenantId, 'proposal', staleA.id);

$ grep -nE "…" test/integration/lateness-from-truck-location-4-7.test.ts
103:  let tenantB: SeededTenant;
222:    tenantB = await seedTenant('Bravo');
268:    await seedDwellPings(tenantB, 4);
280:      tenantB.technicianId,
285:      tenantB.appointmentId,
290:      tenantB.tenant.tenantId,
291:      tenantB.appointmentId,
337:      tenantB.tenant.tenantId,

$ grep -nE "…" test/integration/service-credit-cap-9-5.test.ts
85:  let tenantB: SeededTenant;
211:    tenantB = await seedTenant('Bravo');
220:    await issueCredit(tenantB, 8000, new Date(Date.now() - 30 * DAY_MS));
274:      tenantB.tenant.tenantId,
275:      tenantB.customerId,
279:    // Tenant B asking about TENANT A's customer sees zero — another tenant's
282:      tenantB.tenant.tenantId,
365:      tenantB.tenant.tenantId,
```

## Final state

```
$ npx tsc --project tsconfig.build.json --noEmit
TSC BUILD CLEAN

$ git status --porcelain
(empty)

$ git diff --stat origin/main...HEAD
 .../appointment-confirmation-dispatch-3-8.test.ts  | 377 +++++++++++++++++
 .../lateness-from-truck-location-4-7.test.ts       | 372 +++++++++++++++++
 .../integration/proposal-expiry-sweep-3-11.test.ts | 274 +++++++++++++
 .../integration/service-credit-cap-9-5.test.ts     | 446 +++++++++++++++++++++
 4 files changed, 1469 insertions(+)
```

## What this lane did NOT do

- Did not delete `src/ai/guardrails/expiration.ts` or `src/dispatch/lateness.ts`,
  despite recommending a decision on both. Recommend, don't delete.
- Did not touch `packages/api/src` or `packages/web/src` at all.
- Did not change any money arithmetic. The $100 cap and `applyCreditCap`'s edge
  behaviour are asserted, not authored.
- Did not answer any O-1…O-9 or Q12 question.
- Did not claim a rung for any row.
