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
| 3.8 | `appointment-confirmation-dispatch-3-8.test.ts` | "only live instantiation is a no-op notifier" | **Half true.** The dormant class is real; the confirmation path is *not* dead — a second implementation is wired and writes the row. But it skips silently on **two** conditions, one owner-reachable | PROVEN-REAL-DB | T1 + T3 |
| 3.11 | `proposal-expiry-sweep-3-11.test.ts` | "two TTL regimes"; guardrail has zero callers | **Confirmed.** 48 h worker is the only live regime; guardrail is dead code | PROVEN-REAL-DB + STRUCTURAL (negative control) | T2 |
| 4.7 | `lateness-from-truck-location-4-7.test.ts` | evaluator's only importer is type-only | **Confirmed**, and sharper: the evaluator's sole value export has *no* reference anywhere in `src/` | STRUCTURAL (negative control) + PROVEN-REAL-DB for ingestion | T1 |
| 9.5 | `service-credit-cap-9-5.test.ts` | the only test stubs `pool.connect()` | **Confirmed.** Replaced with a real-Postgres proof; the cap holds at draft and **fails at execute** | PROVEN-REAL-DB | T1 |

**Current totals: 24 passed | 4 expected fail (28)** — 3.8 is 6+1, 3.11 is 5+1,
4.7 is 6+1, 9.5 is 7+1. The Evidence section at the bottom was regenerated from a
single run of this head and is the reproducible record.

The per-row **RED / GREEN blocks below are historical** — each is the raw output
captured at the moment that row's TDD cycle ran, kept because the rung ladder asks
for red-before-green. Three review rounds have since added four ordinary tests, so
those per-file counts are lower than the file's current count. They are a log, not
a claim about the checked-in suite.

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

### Review round 2 — the wired path was narrower than claimed (Codex, two P2s)

Both findings correct, and together they narrow this row's positive claim. Fixed
on the same head.

**(a) The gate was missing.** `app.ts:1328-1335` wraps the selected provider in
`GatedMessageDelivery` before `TransactionalCommsService` ever sees it; the tests
passed the raw `InMemoryDeliveryProvider`, so every send succeeded
unconditionally. That is not the production path — consent, DNC and the
`TELEPHONY_ENABLED`/`EMAIL_ENABLED` kill switches all live in that wrapper. Both
helpers now wrap it with the same five deps (`base`, `PgDncRepository`,
`auditRepo`, `enforcement`, `PgConsentEventRepository`), in
**`enforcement: 'block'`** — the strictest mode, the one `shared/config.ts:210-217`
resolves to in prod/staging. The rows still pass, so the claim now holds against
the gate production actually runs.

**(b) A configured provider is NOT sufficient — and this one is owner-reachable.**
`sendAppointmentNotice` returns early when the tenant has
`autoSendAppointmentReminders === false` (`transactional-comms-service.ts:355`),
and the dormant class carries the identical early return
(`appointment-confirmation-notifier.ts:42`). Every test here used tenants with no
settings row, so this path was invisible. Now pinned as a **T3** case — two
tenants, configured differently, in the same run:

- the tenant with the flag off gets **no** confirmation row, provider wired and all
- its differently-configured neighbour, same run, same notifier, **does**
- and the dormant class agrees, so promoting it would not close this path either

That RED came for free: the first version asserted the flag through
`settingsRepo.create`, which does not list `auto_send_appointment_reminders`
among its INSERT columns (`pg-settings.ts:274-280`), so the row landed at the
column's `TRUE` default — `expected true to be false`. The flag only moves
through `update` (`pg-settings.ts:369`), which is also how an owner toggles it.

**This changes the shape of the row's gap.** There are **two** silent skips, not
one: delivery mode `'none'` (a deploy-time condition) and
`autoSendAppointmentReminders = false` (a setting the owner can flip). The second
is arguably worse, because an owner who turns off *reminders* almost certainly
does not intend to turn off *booking confirmations* — one flag governs both, and
nothing tells them. **The PRD cell stamped at `5f93a9d` says the row "holds only
where a delivery provider is configured", which is now known incomplete.** That
cell is Fable's and carries the rung, so this lane has not edited it — raised on
the PR for Fable to amend, and it belongs in issue #1077.

### Review round 3 — the gate inherited ambient kill switches (Codex, P2)

Correct, and a direct consequence of round 2's fix. `GatedMessageDeliveryDeps.env`
defaults to `process.env` (`gated-message-delivery.ts:190`) and the switches are
read per send (`isOutboundChannelEnabled`, line 112), so a shell or CI job
exporting `TELEPHONY_ENABLED=false` or `EMAIL_ENABLED=false` would suppress the
send and fail the POSITIVE assertions — the rows would look unwritten for a
reason with nothing to do with this row. Both channels are now pinned on
explicitly via an injected `env`. The kill switches' own behaviour stays where it
already lives, `killswitch-production-config.test.ts`.

### Evidence class / tenant grade

**PROVEN-REAL-DB** — the dispatch write and the `appointment.created` audit event are
both proven against real Postgres, now through `GatedMessageDelivery` in `'block'`
mode as production wires it. **T1**, and **T3** after review round 2 — two tenants
with different `autoSendAppointmentReminders` settings each get their own correct
result in the same run. (The "tenant A's row set is byte-identical after tenant B
writes" assertion is T2-shaped but narrow; not claimed.)

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

### Review round 2 — the re-propose leg bypassed the production action (Codex, P2)

Correct. The test minted a fresh proposal through `proposalRepo.create`, which
proves a new card survives a sweep and says nothing about the criterion's second
clause — "and can be re-proposed". If `reproposeProposal`
(`src/proposals/actions.ts:830`, behind `POST /api/proposals/:id/re-propose`)
stopped accepting expired cards, copying their intent, applying a fresh expiry or
emitting `proposal.reproposed`, the test would still have passed.

Now it calls the real action on the expired card and asserts what it produces:
intent carried forward (type, payload, summary), a live `draft` with a fresh 48 h
window, persisted (not just returned), `proposal.reproposed` audited against the
NEW card naming `sourceProposalId`, and the action REFUSING a card that is not
expired (`Only an expired proposal can be re-proposed`).

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
- audit: ingestion through the **real router** emits
  `technician_location.batch_ingested` against the `technician` entity, read back
  via `findByEntity`; `appointment.created` reads back too; **no** lateness or
  delay event has ever been emitted on either entity; the neighbour tenant reads
  none of it

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
the claim the row turns on. The ingestion leg is **PROVEN-REAL-DB** (corrected in
review round 3, below): the write AND its `technician_location.batch_ingested`
audit event are both proven at real Postgres, through the production router.
**T1** for both.

### Review round 1 — order-dependent fixtures (xhawk-ai, medium)

The bot found that `seedDwellPings(tenantA)` was called inside the first
behavioural `it`, and three later tests asserted against those pings — so a
filtered or reordered run failed before exercising what it claimed to pin.
Verified by reproducing it:

```
$ npx vitest run … -t "neighbour tenant" test/integration/lateness-from-truck-location-4-7.test.ts
 × CURRENT (T1): a neighbour tenant`s pings are invisible to tenant A …
   → expected [] to have a length of 6 but got +0
```

Correct, and squarely this file's fault. Both tenants' pings now seed in
`beforeAll`, and every test asserts against fixture data rather than data a
previous `it` happened to create. Re-verified per test under `-t`:

```
-t "technician location update persists" → 1 passed | 5 skipped
-t "neighbour tenant"                    → 1 passed | 5 skipped
-t "carries NO lateness"                 → 1 passed | 5 skipped
-t "audit trail reads back"              → 1 passed | 5 skipped
```

### Review round 2 — the fixture was not actually a geofence signal (Codex, P2)

Correct, and a good catch about what a future green would mean. The service
location was seeded with no `latitude`/`longitude`, so the pings sat on `SITE`
while the address they were supposed to be dwelling at had no coordinates at all.
An evaluator keyed on a located address would skip this appointment entirely —
and then BOTH the `lateness === undefined` assertion and the `it.fails` would stay
green while the wiring worked correctly for every located customer. The test would
have quietly stopped meaning anything at the exact moment the row was closed.

The location now carries `SITE.lat`/`SITE.lng`, and `beforeAll` asserts they
round-tripped, so the fixture is a geofence signal rather than a set of rows that
resemble one.

### Review round 3 — I asserted an absence that does not hold (Codex, P2). **Correction.**

This one was my error, not a fragility. The test read
`findByEntity(tenant, 'technician_location_ping', pings[0].id)`, got nothing, and
concluded "the pings are unaudited". But **no such entity type exists**: the
production route emits `technician_location.batch_ingested` against the
`technician` entity (`emitLocationBatchAudit`,
`routes/technician-location.ts:106`, with `auditRepo` supplied by `app.ts`). The
test also bypassed the route entirely via `pingRepo.insertMany`, so it could not
have seen the event even had it queried the right entity. An empty result from a
query that can only ever return empty is not evidence of anything.

That wrong claim propagated: into this report, and from it into the PRD cell for
4.7 ("real Postgres, T1, **no audit event**"). Both are corrected here; the PRD
cell is Fable's and is flagged on the PR rather than edited.

The test now drives the **real router** (express + the same `auditRepo` app.ts
passes), asserts a 201, and reads `technician_location.batch_ingested` back via
`findByEntity` on the `technician` entity, with the neighbour tenant reading none
of it. The absence that genuinely belongs to this row is stated separately and
correctly: **no lateness or delay event on either the appointment or the
technician**, because nothing evaluates the pings.

**This upgrades the ingestion leg from REAL-DB-WRITE-ONLY (4−) to
PROVEN-REAL-DB** — the write and its audit event are both proven. It does not
move the row: 4.7 turns on the evaluation half, which is still absent.

### Review round 4 — the dwell fixture was not production-shaped (Codex, P2)

Correct, and the same class of defect as the coordinates one — a fixture that
looks right and could not have come from production. `app.ts:5528-5531` supplies
`isAppointmentAssignedToTechnician` to the location router, so
`sanitizeAppointmentIds` (`routes/technician-location.ts:50`) STRIPS the
`appointmentId` from any ping naming an appointment the submitting technician is
not assigned to. Neither seeded appointment had an assignment, and the pings were
inserted directly via `insertMany` — so the fixture held appointment-linked pings
production could never produce, and an evaluator reading pings by appointment
would find nothing. The `it.fails` could have stayed red after the row was
correctly wired.

Fixed on three fronts:
- each tenant now seeds a **real technician user** (`assignTechnician` refuses any
  other role) and a **primary assignment** on the appointment
- `seedDwellPings` ingests through the **production router** — the same
  repository, assignment gate and audit repo `app.ts` wires — not `insertMany`
- `beforeAll` asserts the six pings came back still linked to the appointment,
  i.e. they survived the gate

And, because "the ids survived" would also be true of an ABSENT gate, a
**positive control**: a ping naming an appointment this technician is not
assigned to is accepted (201) with its `appointment_id` stripped to NULL, read
raw from the table. If the gate ever stops being wired in this harness, that
assertion fails.

### Review round 4 — the two PRD cells, corrected (Codex, two P2s)

Both cells were wrong, both traceable to this report, and Codex asked for them to
be fixed rather than only flagged. Corrected — **factual clauses only. Every rung
number and tenant grade is exactly as Fable set it** (3.8 stays `4 (T1)`, 4.7
stays `2 — dormant, pinned`). Codex's alternative for 3.8, "or lower the
unconditional criterion's grade", is a rung judgement and was NOT taken; it stays
Fable's.

- **3.8** — the qualification now reads "holds only where a delivery provider is
  configured **and** the tenant has not set `autoSendAppointmentReminders =
  false`", and the note body carries the T3 evidence plus the point that this
  second skip is owner-reachable.
- **4.7** — "no audit event" replaced with what the router actually does
  (`technician_location.batch_ingested` on the `technician` entity, ingestion leg
  PROVEN-REAL-DB), naming the correction and what the absent audit really is
  (lateness/delay, on either entity).

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

### Review round 1 — the `it.fails` could green for the wrong reason (xhawk-ai, medium)

The bot's second finding is the sharper one, and it generalises past this file:
**assertions inside an `it.fails` cannot protect it.** The execute-time `it.fails`
ignored the execution result, so a future FK, schema or RLS error inside
`executeServiceCredit` — caught by the handler as `{kind: 'credit', ok: false}` —
would leave the ledger under the cap and turn the test green while proving
nothing. That is the exact trap this lane already fell into once during
development; the bot is right that nothing stopped it recurring.

The bot suggested asserting the execution outcome before the ledger total. Adding
those assertions *inside* the `it.fails` would not have worked — `it.fails` passes
when **any** assertion throws, the guard included. So the scenario moved into a
shared helper that asserts nothing, and the guard now lives in an **ordinary
passing test** where a broken precondition fails loudly:

```
CURRENT: the cap is enforced at DRAFT time only — a credit approved after the customer
crossed the cap IS inserted at execution, and the credit sub-action reports ok
  → result.success === true
  → the review_response.executed audit sub-result is {kind:'credit', ok:true}, no error, with an id
  → that row is really in service_credits, $50, review_id not null
  → total === 14000, and > CREDIT_CAP_CENTS_PER_12_MONTHS
```

The `it.fails` now calls the same helper and asserts only `total <= cap`.

**Proof the guard works.** Temporarily patched the helper to pass an unpersisted
`reviewId`, reproducing the swallowed-FK case the bot described:

```
 × CURRENT: the cap is enforced at DRAFT time only … → expected false to be true
 × DESIRED (row 9.5): … → Expect test to fail
```

The ordinary test fails loudly on `creditSubResult.ok`; the `it.fails` would have
silently greened on its own. Patch reverted; both green again.

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

**Regenerated after review round 5** (the earlier block showed a 26-test run and
pre-route dumps, which no longer matched the checked-in files — Codex, P2). Every
number and row below comes from one run of the current head against a fresh
container.

Container:

```
docker run -d --rm -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=serviceos_test -p 127.0.0.1:0:5432 \
  pgvector/pgvector:pg16 -c max_connections=300
→ port 32769
```

All four files against it:

```
cd packages/api && RLS_RUNTIME_ROLE=true \
  EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32769/serviceos_test \
  npx vitest run --config vitest.integration.config.ts \
  test/integration/appointment-confirmation-dispatch-3-8.test.ts \
  test/integration/proposal-expiry-sweep-3-11.test.ts \
  test/integration/lateness-from-truck-location-4-7.test.ts \
  test/integration/service-credit-cap-9-5.test.ts

 Test Files  4 passed (4)
      Tests  24 passed | 4 expected fail (28)
   Duration  5.94s
```

### `audit_events`, grouped by tenant and event

```
              tenant_id               |             event_type             | entity_type | n
--------------------------------------+------------------------------------+-------------+---
 6acc7e07-7941-4677-8662-debafc832e4a | appointment.created                | appointment | 1
 718ec867-c50b-4810-8eb3-1f036ef479e1 | appointment.created                | appointment | 5
 7cb11a29-983e-4b46-8e38-79a2f8484db7 | appointment.created                | appointment | 2
 7d8f0b43-b2cb-4790-b4ae-173258b1a72b | appointment.created                | appointment | 1
 ce7dea36-2a28-45c8-bf6b-f143900bc1dd | appointment.created                | appointment | 2
 116b71da-239a-4cfb-9bd9-7f479bc8da97 | proposal.executed                  | proposal    | 1
 452b471a-290e-4485-b9da-d14237237121 | proposal.executed                  | proposal    | 1
 67e8da85-8fc1-4d0a-817d-513f76cca136 | proposal.executed                  | proposal    | 1
 718ec867-c50b-4810-8eb3-1f036ef479e1 | proposal.executed                  | proposal    | 5
 7cb11a29-983e-4b46-8e38-79a2f8484db7 | proposal.executed                  | proposal    | 2
 ce7dea36-2a28-45c8-bf6b-f143900bc1dd | proposal.executed                  | proposal    | 2
 bc16aaf2-d0c9-4d7b-8391-1b3d7e5bbb38 | proposal.expired                   | proposal    | 3
 bc16aaf2-d0c9-4d7b-8391-1b3d7e5bbb38 | proposal.reproposed                | proposal    | 1
 116b71da-239a-4cfb-9bd9-7f479bc8da97 | review_response.executed           | proposal    | 1
 452b471a-290e-4485-b9da-d14237237121 | review_response.executed           | proposal    | 1
 67e8da85-8fc1-4d0a-817d-513f76cca136 | review_response.executed           | proposal    | 1
 6acc7e07-7941-4677-8662-debafc832e4a | technician_location.batch_ingested | technician  | 1
 7d8f0b43-b2cb-4790-b4ae-173258b1a72b | technician_location.batch_ingested | technician  | 3
(18 rows)
```

Tenant map — 3.8: `718ec867…` Alpha, `7cb11a29…` Bravo, `ce7dea36…` Quiet (the
`autoSendAppointmentReminders = false` tenant). 3.11: `bc16aaf2…` A,
`bd211398…` B. 4.7: `7d8f0b43…` Alpha, `6acc7e07…` Bravo. 9.5: `67e8da85…`
Alpha, `82bd9117…` Bravo, `b994700b…` Charlie, `452b471a…` Echo,
`116b71da…` Delta.

Three rows read on their own:
- `proposal.expired` and `proposal.reproposed` land in **exactly one** tenant —
  the neighbour's fresh card was never touched, and the re-propose went through
  the production action
- `technician_location.batch_ingested` appears for **both** 4.7 tenants: the
  audit leg this lane originally and wrongly reported as absent
- Quiet (`ce7dea36…`) has two `appointment.created` and two `proposal.executed`
  and **no dispatch rows at all** (below) — the owner-reachable silent skip

### `message_dispatches` (row 3.8)

```
              tenant_id               |       entity_type        | channel |         recipient          | provider  | status
--------------------------------------+--------------------------+---------+----------------------------+-----------+--------
 718ec867-c50b-4810-8eb3-1f036ef479e1 | appointment_confirmation | email   | alpha-e34b25b1@example.com | in-memory | sent
 718ec867-c50b-4810-8eb3-1f036ef479e1 | appointment_confirmation | sms     | +16025555798               | in-memory | sent
 718ec867-c50b-4810-8eb3-1f036ef479e1 | appointment_confirmation | email   | alpha-e34b25b1@example.com | in-memory | sent
 718ec867-c50b-4810-8eb3-1f036ef479e1 | appointment_confirmation | sms     | +16025555798               | in-memory | sent
 718ec867-c50b-4810-8eb3-1f036ef479e1 | appointment_confirmation | email   | alpha-e34b25b1@example.com | in-memory | sent
 718ec867-c50b-4810-8eb3-1f036ef479e1 | appointment_confirmation | sms     | +16025555798               | in-memory | sent
 7cb11a29-983e-4b46-8e38-79a2f8484db7 | appointment_confirmation | email   | bravo-df5369f9@example.com | in-memory | sent
 7cb11a29-983e-4b46-8e38-79a2f8484db7 | appointment_confirmation | sms     | +16025552647               | in-memory | sent
 7cb11a29-983e-4b46-8e38-79a2f8484db7 | appointment_confirmation | email   | bravo-df5369f9@example.com | in-memory | sent
 7cb11a29-983e-4b46-8e38-79a2f8484db7 | appointment_confirmation | sms     | +16025552647               | in-memory | sent
(10 rows)
```

Written through `GatedMessageDelivery` in `enforcement: 'block'`, as production
wires it. Alpha ran five executions and shows six rows (three × two channels):
the two with no notifier — mode `'none'` and the `it.fails` — contributed
nothing. **Quiet is absent from this table entirely**: two bookings executed, a
provider wired, and not one confirmation row, because one settings flag governs
both reminders and booking confirmations.

### `proposals` (row 3.11 + the 9.5 anchors)

```
              tenant_id               |      proposal_type       |      status      | past_ttl
--------------------------------------+--------------------------+------------------+----------
 116b71da-239a-4cfb-9bd9-7f479bc8da97 | review_response_proposal | draft            |
 116b71da-239a-4cfb-9bd9-7f479bc8da97 | review_response_proposal | executed         |
 452b471a-290e-4485-b9da-d14237237121 | review_response_proposal | draft            |
 452b471a-290e-4485-b9da-d14237237121 | review_response_proposal | executed         |
 67e8da85-8fc1-4d0a-817d-513f76cca136 | review_response_proposal | draft            |
 67e8da85-8fc1-4d0a-817d-513f76cca136 | review_response_proposal | executed         |
 82bd9117-385f-498f-87f0-e59bb06d480e | review_response_proposal | draft            |
 b994700b-b375-47d2-b346-183808257869 | review_response_proposal | draft            |
 bc16aaf2-d0c9-4d7b-8391-1b3d7e5bbb38 | create_appointment       | draft            | f
 bc16aaf2-d0c9-4d7b-8391-1b3d7e5bbb38 | create_appointment       | expired          | t
 bc16aaf2-d0c9-4d7b-8391-1b3d7e5bbb38 | create_appointment       | expired          | t
 bc16aaf2-d0c9-4d7b-8391-1b3d7e5bbb38 | draft_estimate           | ready_for_review |
 bc16aaf2-d0c9-4d7b-8391-1b3d7e5bbb38 | reschedule_appointment   | expired          | t
 bd211398-6ee7-493f-ad94-c5e13b9c68b7 | create_appointment       | ready_for_review | f
(14 rows)
```

Every `past_ttl = t` row is `expired`; every `past_ttl = f` row is still live,
including the neighbour tenant's (`bd211398…`). The `draft` `create_appointment`
on `bc16aaf2…` is the card `reproposeProposal` minted — a fresh 48 h window, and
it survived the next sweep. The `draft_estimate` carries a NULL `expires_at` and
was never a candidate.

### `service_credits` (row 9.5)

```
              tenant_id               |             customer_id              | amount_cents | issued_on  | in_window | has_review
--------------------------------------+--------------------------------------+--------------+------------+-----------+------------
 116b71da-239a-4cfb-9bd9-7f479bc8da97 | 29277db9-e49a-4bad-81b6-001fbd7abd3c |         4000 | 2026-09-02 | t         | f
 116b71da-239a-4cfb-9bd9-7f479bc8da97 | 29277db9-e49a-4bad-81b6-001fbd7abd3c |         5000 | 2026-09-11 | t         | f
 116b71da-239a-4cfb-9bd9-7f479bc8da97 | 29277db9-e49a-4bad-81b6-001fbd7abd3c |         5000 | 2026-09-12 | t         | t
 452b471a-290e-4485-b9da-d14237237121 | f537c837-a3a0-4946-9f4c-01466a5679bf |         4000 | 2026-09-02 | t         | f
 452b471a-290e-4485-b9da-d14237237121 | f537c837-a3a0-4946-9f4c-01466a5679bf |         5000 | 2026-09-11 | t         | f
 452b471a-290e-4485-b9da-d14237237121 | f537c837-a3a0-4946-9f4c-01466a5679bf |         5000 | 2026-09-12 | t         | t
 67e8da85-8fc1-4d0a-817d-513f76cca136 | 894c3469-0e05-48cd-8e7a-4e9ea3e995e8 |         8000 | 2025-08-12 | f         | f
 67e8da85-8fc1-4d0a-817d-513f76cca136 | 894c3469-0e05-48cd-8e7a-4e9ea3e995e8 |         3000 | 2026-02-24 | t         | f
 67e8da85-8fc1-4d0a-817d-513f76cca136 | 894c3469-0e05-48cd-8e7a-4e9ea3e995e8 |         5000 | 2026-08-13 | t         | f
 82bd9117-385f-498f-87f0-e59bb06d480e | d27d940c-bf70-4ea8-8a87-2e2d646123c1 |         8000 | 2026-08-13 | t         | f
(10 rows)
```

Alpha (`67e8da85…`): $30 + $50 in window = **$80**, with the 2025-08-12 $80 out
of window — and **no fourth row**, because the $50 tier was omitted rather than
issued. Bravo (`82bd9117…`): its own $80, uncounted against Alpha. Charlie
(`b994700b…`) drew the full $50 at draft and has **no ledger row** — a proposal
is not an issuance. Echo (`452b471a…`) and Delta (`116b71da…`) each hold
$40 + $50 + $50 = **$140 in window against a $100 cap**, the last row carrying a
`review_id`: the over-cap credit written at execution time, once as the ordinary
guard test and once as the `it.fails`.

### `technician_location_pings` (row 4.7)

```
              tenant_id               |            technician_id             | pings | linked | stripped
--------------------------------------+--------------------------------------+-------+--------+----------
 6acc7e07-7941-4677-8662-debafc832e4a | c3e539dd-7ee4-461f-beb1-778b46df3f92 |     4 |      4 |        0
 7d8f0b43-b2cb-4790-b4ae-173258b1a72b | 9f18395c-1c92-47fe-b5ba-ce20145f9c7c |     8 |      6 |        2
(2 rows)
```

All ingested through the production router. Tenant Alpha's 8 = the 6 dwell pings
(still **linked**, so they survived the assignment gate), plus one that never
named an appointment, plus the positive control naming an appointment this
technician is not assigned to — **stripped to NULL by
`sanitizeAppointmentIds`**, which is the gate visible in the table. And, per the
board assertion above, not one lateness state derived from any of them.

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
