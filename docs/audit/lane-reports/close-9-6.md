# Lane report — 9.6 (End-of-day digest), §8.9 Close, ticket #1013

**Branch:** `cloud/close-9-6` (off `origin/main`) · **TEST-ONLY** — no product code
touched (`git diff --stat origin/main..HEAD -- packages/api/src packages/web/src
packages/mobile/src` is empty). Do NOT claim a rung here — only Fable states
rungs; this report gives evidence class, tenant grade, and raw output.

## Scope

Row 9.6 was `4− (T3·T4)` going in: the write **and both named sections**
("what I wasn't sure about" / "what I learned today") are proven at real
Postgres (`daily-digest-worker.test.ts`, `digest-reflection.test.ts`), the
`digestEnabled` client control shipped (#1010, `e2e/journeys/digest-toggle.spec.ts`
already proved an owner can flip it through real Postgres), but the row was
still capped 4− because **no audit event is asserted** and reachability had
only ever gone as far as the toggle — nobody had proven an owner could see
digest *content*.

This lane's job, per #1013: (1) real Postgres proof of the actual SEND (not
just the stored row) with the audit leg, T3 (two zones, one instant), and the
T4 production-selector citation; (2) hermetic Playwright reachability of the
digest CONTENT itself, not just the switch.

## Part 1 — real Postgres: the digest SEND

**New file:** `packages/api/test/integration/daily-digest-send-9-6.test.ts`

`sweep-tenant-fanout.test.ts`'s existing digest block already proves T3+T4
for the STORAGE half (`emptyComputeDeps`, no delivery wired). It does not
prove a *send* — no dispatch row, no real activity in the payload. This file
wires **real Pg repos throughout** (`PgPaymentRepository`, `PgInvoiceRepository`,
`PgEstimateRepository`, `PgJobRepository`, `PgAppointmentRepository`,
`PgProposalRepository`, `PgCustomerRepository`, `PgSettingsRepository`,
`PgFeedbackResponseRepository`, `PgCorrectionLessonRepository`, `PgAuditRepository`)
plus `InMemoryDeliveryProvider` (the exact provider the hermetic API server
itself constructs — see `createMessageDeliveryProvider`, app.ts:1309 — for any
non-prod/staging environment; not a stub standing in for something absent)
and `PgDispatchRepository`, so "sent" means a real `message_dispatches` row.

### RED (probe), raw output

Two assertions were deliberately inverted to confirmed they exercise real
behaviour rather than being vacuously true, then reverted:

```
 × an enabled sms-channel tenant … gets exactly ONE digest send …
   → expected 1 to be +0 // Object.is equality
 × T3 — two tenants in different timezones …
   → expected 2 to be +0 // Object.is equality

 Test Files  1 failed (1)
      Tests  2 failed | 2 passed | 1 expected fail (5)
```

### GREEN

```
Command (from packages/api):
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  --reporter=verbose test/integration/daily-digest-send-9-6.test.ts

 ✓ an enabled sms-channel tenant with real activity today gets exactly ONE
   digest send, read back from message_dispatches                    156ms
 ✓ digestChannel 'none' is a documented skip — the digest stores but
   sends nothing                                                      43ms
 ✓ a tenant with the digest disabled gets no row and no send at all    20ms
 ✓ T3 — two tenants in different timezones are BOTH due at one instant
   and each gets its OWN send, with no cross-tenant leakage            97ms
 ✓ DESIRED (row 9.6): a digest send writes an audit row via
   PgAuditRepository, read back by entity — it does not (expected fail) 61ms

 Test Files  1 passed (1)
      Tests  4 passed | 1 expected fail (5)
```

### Evidence class & tenant grade

**PROVEN-REAL-DB, T1·T3.** T4 (production tenant selector) is **cited, not
re-proven** — it already exists and is real:

```
$ grep -nE "listTenantIds:\s*async\s*\(\)\s*=>\s*\[" test/integration/sweep-tenant-fanout.test.ts
(no match)
```

The only matches for that stub pattern anywhere in the repo are in
`daily-digest-send-9-6.test.ts` itself (this file's own convenience single/
two-tenant lists — its job is the send/audit gap, not the enumerator) and are
NOT `sweep-tenant-fanout.test.ts`. Re-ran the cited entries for this report:

```
$ RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
    --reporter=verbose test/integration/sweep-tenant-fanout.test.ts -t "per-tenant sweep fan-out"
 ✓ runs on the REAL tenant selector and serves each tenant on its OWN timezone + digest_time
 ✓ keeps going when one tenant throws — the other tenants are still served
 Tests  2 passed | 25 skipped (27)
```

### The finding this row cares about

**Nothing in the digest send path ever writes an audit event.**
`DailyDigestWorkerDeps` (`workers/daily-digest-worker.ts`) has no `auditRepo`
field at all. The `auditRepo` inside `DigestComputeDeps` (`digest-service.ts`)
is READ-only — consulted by `computeDigestPayload` to compute the WS22 "N
fixed" reflection *inside* the digest's own content — never written to record
that a send happened. Contrast `thank-you-sms-worker.ts`, which calls
`deps.auditRepo.create(...)` with `notification.thank_you_sms.sent` /
`.suppressed` immediately after its send (`thank-you-sms-worker.ts:391-407`).
The digest has no equivalent. Pinned as `it.fails` (no product code written —
TEST-ONLY lane):

```
it.fails('DESIRED (row 9.6): a digest send writes an audit row via
  PgAuditRepository, read back by entity — it does not', …)
```

### Kept-container dumps (plain `pgvector/pgvector:pg16`, `EXTERNAL_TEST_DB_URL`)

`docs/audit/lane-reports/close-9-6/daily_digests.txt` — 21 rows across this
suite's full-file run (this test's tenants plus the fan-out file's, sharing
the container); representative rows:

```
              tenant_id               | digest_date | sent | jobs | send_attempts
 c3e35fb2-8e62-49ea-8a32-5b426ede6c31 | 2026-06-11  | t    | 1    | 1     ← T1 send
 d665a4b0-b434-4e8a-8fce-9a2a933e409d | 2026-06-11  | f    | 1    | 0     ← 'none' channel: stored, not sent
 42cdc916-6d34-400a-b759-1edd3ab5da2c | 2026-06-11  | f    | 1    | 0     ← 'none' channel: stored, not sent
 e4d41113-2792-4fc3-8287-7e6bda3c2d3d | 2026-06-11  | f    | 0    | 0     ← digest disabled: no row action beyond the check itself
 9050b9d7-691d-47eb-9641-e7808a5634fa | 2026-06-11  | t    | 2    | 1     ← T3 Phoenix tenant, its OWN count (2), not Chicago's (1)
```

`message_dispatches.txt` — 12 rows, every one `channel=sms status=sent
provider=in-memory idempotency_key=daily_digest:2026-06-11:1of1` (short
payload → exactly one segment, matching "exactly ONE digest send").

`audit_events_daily_digest.txt` — **0 rows.** The gap, visible at the DB:

```
 tenant_id | event_type | entity_type | entity_id
-----------+------------+-------------+-----------
(0 rows)
```

### `digestChannel: 'none'` — documented, not a hermetic-environment artifact

`sendDigestSms`'s comment says `'none' — digest is stored for the web view;
no SMS`, and the contract only allows `'sms' | 'none'` (`contracts.ts:585`) —
this is an intentional product mode, asserted directly rather than treated as
a hermetic-environment limitation. The one scenario the ticket names —
"delivery provider absent (mode none)" — does NOT occur for the SMS channel
in this environment: `createMessageDeliveryProvider` returns
`InMemoryDeliveryProvider` (never `null`) for any non-prod/staging
environment (app.ts:1296-1318), so a `digestChannel: 'sms'` tenant always
gets a real send attempt here. `'none'` is a tenant CHOICE, not an
environment ceiling — captured as its own test, not folded into the "absent
provider" framing.

## Part 2 — reachability: the digest CONTENT (rung-5 shape)

**Extended:** `e2e/journeys/digest-toggle.spec.ts` (append-only — the
existing toggle-persistence test is untouched and still passes).

New test: *"an owner enables the digest, real activity happens, the sweep
runs, and the digest content is reached on /digest — a neighbour tenant's
activity never appears (T2)"*.

Flow, entirely through shipped surfaces + one worker tick:

1. Two tenants bootstrapped through the real Clerk-webhook + onboarding-identity
   flow (no SQL, no fixture shortcut) — the owner under test, and a neighbour.
2. Owner flips "Daily digest" in Settings (same UI control as the existing
   toggle spec) — `PUT /api/settings` confirmed `< 300`.
3. `digestTime`/`digestChannel`/`ownerPhone` set via the real, authenticated
   API to the tenant's own current local time (so the sweep run seconds later
   finds it due, instead of waiting out the real 15-minute production
   interval) — same mechanism the story's acceptance criterion describes
   ("at its local digest time"), just compressed for test speed.
4. Real activity: the owner completes **1** job, the neighbour completes
   **2**, both through `POST /api/customers` → `/api/locations` → `/api/jobs`
   → `/api/jobs/:id/transition` (walking the real state machine:
   `new → scheduled → in_progress → completed` — `job-lifecycle.ts`'s
   `JOB_STATUS_TRANSITIONS` refuses a direct `new → completed` hop, caught
   during RED).
5. **The sweep runs the way the product's ops path runs it**: this file
   imports `runDailyDigestSweep` — the *same function* app.ts's leader-locked
   `setInterval` calls (app.ts:6038-6119) — and invokes it directly against
   the *same* `DATABASE_URL` Postgres the API webServer is pointed at, with
   real Pg repos built the identical way app.ts builds them. This is a worker
   tick, not an admin route or SQL: there is no HTTP endpoint that fires the
   sweep early, and waiting out the real interval is not viable in CI.
6. Owner opens `/digest` in a real (chromium project, real Postgres,
   `CLERK_DEV_HMAC_TOKENS`) browser and the "Jobs completed" card reads
   **exactly 1** — never the neighbour's 2.

### RED, then GREEN

First run hit two real gaps, fixed in sequence (both are genuine
product-behaviour discoveries the test walked into, not test-authoring
typos):

```
Error: complete job -> 400
```
→ `new → completed` is not a valid one-hop transition
(`JOB_STATUS_TRANSITIONS`); fixed by walking `scheduled → in_progress →
completed`.

```
Error: digest sweep sent count -> {"tenants":2,"generated":2,"sent":0,…}
```
→ `sendDigestSms` refuses with no `owner_phone` on file (by design — same
early-return `'none'` uses); fixed by setting `ownerPhone` via the real
settings API, exactly what a normally-provisioned owner has.

GREEN, both tests in the file:

```
Command:
CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=<testcontainer> \
  E2E_USE_TEST_DB=true VITE_CLERK_PUBLISHABLE_KEY=pk_test_… \
  QA_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  npx playwright test e2e/journeys/digest-toggle.spec.ts --project=chromium --retries=0

  2 passed (1.0m)
```

Screenshots (real browser, real Postgres):
`docs/audit/lane-reports/close-9-6/01-digest-enabled.png` (Settings, toggle
flipped) and `02-digest-content-reached.png` (`/digest` page: "Today you
brought in $0 and completed 1 job." / "JOBS COMPLETED — 1" — the owner's own
number, never the neighbour's 2).

### Evidence class & tenant grade — Part 2

**PROVEN-REAL-DB, T1·T2, hermetic-browser-reached.** T2 (a neighbour
tenant's activity never appears) is proven both at the DB (`ownerDigestRow.payload.jobsCompletedCount
=== 1` polled mid-run) and, more importantly for reachability, **in the
rendered browser page** — the screenshot shows `1`, not `3` and not `2`.

## Build & cleanliness

```
$ cd packages/api && npx tsc --project tsconfig.build.json --noEmit
(clean — no output)

$ git status --porcelain
?? docs/audit/lane-reports/close-9-6/
?? packages/api/test/integration/daily-digest-send-9-6.test.ts
 M e2e/journeys/digest-toggle.spec.ts

$ git diff --stat origin/main..HEAD -- packages/api/src packages/web/src packages/mobile/src
(empty)
```

No product code touched. `docs/PRD-v5-as-built.md` not edited (Fable's call).

## Judgment calls

- **`InMemoryDeliveryProvider` as the "real" delivery provider**, not a
  stub-in-place-of-absent. It is the actual class the hermetic API server
  constructs for any non-prod/staging environment (`createMessageDeliveryProvider`).
  Using anything else in the integration test would test a code path the
  product never runs in this environment.
- **Job activity via `new → scheduled → in_progress → completed`**, not a
  direct write, to stay inside "no SQL, no admin route" for the e2e leg and
  inside "real activity, not a stub" for the integration leg (a raw
  `jobRepo.create({status:'completed'})` in the Vitest file is a direct
  repository write under test infrastructure convention already used
  throughout `sweep-tenant-fanout.test.ts`, not a story-facing action, so it
  stayed there; the e2e leg walks the real API state machine because it is
  proving reachability through shipped surfaces).
- **`digestTime`/`ownerPhone` set via direct API PUT**, not only the UI
  toggle, in the e2e leg — the UI only has an on/off switch (#1010's scope);
  there is no shipped UI control for digest time or owner phone, so reaching
  a "due" instant without a 15-minute real-world wait requires the same real,
  authenticated `PUT /api/settings` the shipped toggle itself calls.
- **The sweep is invoked as a direct function call**, not through an HTTP
  route, in both the integration test and the e2e leg. This is deliberate:
  it is literally the same function app.ts's `setInterval` calls (a worker
  tick), and no ops-facing HTTP route to fire it early exists. Inventing one
  would be product code in a TEST-ONLY lane.

## Not done / out of scope

- **The audit-event gap is surfaced, not fixed** (TEST-ONLY lane; no product
  code). Mirrors `notification.thank_you_sms.sent`'s pattern — an `auditRepo`
  field on `DailyDigestWorkerDeps` plus one `.create()` call after a
  successful segment send would close it.
- Rung is **not claimed**. Only Fable states rungs, against the four §12.4d
  checks and the §8.0 caps.
- Weekly-feedback (9.7), review-gating (9.3), etc. are out of this ticket's
  remaining scope (9.6 only, per this lane's brief) — see #1013 for their
  own lane history.
