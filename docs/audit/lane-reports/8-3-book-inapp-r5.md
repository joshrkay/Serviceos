# §8.3 Book — in-app/owner-browser rung-5 reachability (map #995, ticket #1015)

Branch: `test/8-3-book-inapp-r5`, off `origin/main` (d5996cead). TEST-ONLY —
`git diff --stat origin/main..HEAD -- packages/api/src packages/web/src packages/shared/src`
is empty (verified below). `docs/PRD-v5-as-built.md` not edited. Never
touched pricing/discount/tax math, the supervisor gate, RLS, or auth. **Only
Fable states a rung** — nothing here claims a row moves; this lane delivers
evidence.

Scope: rows 3.2, 3.3, 3.4, 3.5, 3.6, 3.9, 3.11 — the in-app / owner-browser
half of §8.3. NOT this lane: 3.1/3.7/3.10 (phone surface, already gated —
decisions #1119/#1118), 3.8 (decision #1077, PR #1076), 3.12 (STORY NOT MET
— report only, see below).

```
git diff --stat origin/main..HEAD -- packages/api/src packages/web/src packages/shared/src
# (empty)
git diff --stat origin/main..HEAD
#  e2e/fixtures/setup-test-db.ts                        |  17 files changed under e2e/ + docs/audit/lane-reports/
#  e2e/global-setup.ts
#  e2e/global-teardown.ts
#  e2e/journeys/appointment-reminder-sweep-3-9.spec.ts
#  e2e/journeys/dispatch-availability-3-2-3-3.spec.ts
#  e2e/journeys/hold-reaper-3-5.spec.ts
#  e2e/journeys/proposal-expiry-3-11.spec.ts
#  e2e/journeys/public-booking-out-of-hours-3-4.spec.ts
#  e2e/journeys/technician-double-booking-race-3-6.spec.ts
#  docs/audit/lane-reports/8-3-book-inapp-r5/*.png
```

## Harness — three environment findings, fixed within `e2e/` scope

All three are pre-existing local-environment / test-harness issues this
lane hit while trying to run ANY Postgres-backed Playwright spec — not
caused by, and not specific to, this lane's own spec files. Documented here
because they will block other lanes on this same Mac too.

1. **Wrong active Node.** The shell's default `node` (via `which node`) was
   v25.2.1 (homebrew), while `.nvmrc` pins `20.20.2` and `packages/api`'s
   `@types/node` is locked at `20.19.39`. Under the newer runtime's type
   defs, `ts-node`'s in-process type-check of `packages/api/src/index.ts`
   fails hard (`TSError: Uint8Array<ArrayBufferLike>` is not assignable to
   `BlobPart`, `voice-service.ts:258`), so the api webServer never boots.
   Fix: `export PATH="/opt/homebrew/opt/node@20/bin:$PATH"` (a `node@20`
   homebrew formula was already installed) before every command in this
   lane. No product file touched.
2. **No local `node_modules`.** This worktree has no `node_modules` of its
   own; Node's resolution walks up and silently adopts
   `/Users/joshuakay/Serviceos/node_modules` (the main checkout), whose
   installed `@types/node` (26.5.1) doesn't match the locked
   `package-lock.json` (20.19.39) — the SAME symptom as #1, independent of
   which `node` binary runs it. Fix: `npm ci --prefer-offline --no-audit
   --no-fund` inside this worktree (17s, cache-warm; disk stayed at ~2.8GB
   free throughout — see the disk-full npm-install warning in prior
   sessions' notes, not triggered here).
3. **Dynamic `import()` of a `.ts` path fails under Playwright's own
   process, intermittently, at two call sites.** `e2e/global-teardown.ts`
   already carries this exact fix (with its own explanatory comment) for
   its `report-builder` import — the SAME bug was still live at two OTHER
   call sites: `e2e/global-setup.ts`'s `bootstrapEphemeralDb()` (dynamic
   `import('./fixtures/setup-test-db')` /
   `import('./fixtures/seed-journey-fixtures')`) and
   `e2e/fixtures/setup-test-db.ts`'s `applyMigrations()` (dynamic
   `import(SCHEMA_TS_PATH)` against `packages/api/src/db/schema.ts`), plus
   `global-teardown.ts`'s OWN `teardownEphemeralDb()` (dynamic import of
   `./fixtures/setup-test-db` a second time, in the SAME file that already
   knew the fix for its other import). All three now use static imports,
   mirroring the established fix exactly (see the comments left in place).
   Symptom before the fix: `E2E_USE_TEST_DB=true` always failed
   (`SyntaxError: Cannot use import statement outside a module` /
   `Unexpected token 'export'`), silently degrading every journey spec's
   `canRun` gate to a skip. **Files touched (all under `e2e/`, in scope):**
   `e2e/global-setup.ts`, `e2e/global-teardown.ts`,
   `e2e/fixtures/setup-test-db.ts`.
4. **Sibling-lane port collision on the DEFAULT web port (5173), not just
   the api port the preamble already calls out.** `playwright.config.ts`'s
   "legacy" `chromium` webServer pair has no port override knob (confirmed:
   `E2E_WEB_PORT` does not exist on this branch), and `reuseExistingServer:
   !isCI` (true in dev) means Playwright silently ADOPTS whatever is
   already answering on `http://localhost:5173` — including another
   worktree's leftover `vite` dev server (observed live: PID bound to 5173
   with `cwd=.../worktrees/agent-ab86b43b743e1cda7/packages/web`, a
   different lane, not cleaned up between its own runs). Every spec that
   navigates the browser to a page issuing same-origin `/api/*` fetches
   (e.g. the public `/book` page) then silently proxies to THAT OTHER
   LANE'S api port, producing "We could not load available times" with
   zero requests reaching this lane's own api log — confusing, and NOT
   fixable by killing the other process (forbidden: "never kill processes
   on ports you did not start", and it may still be in active use). Fix:
   self-manage a DEDICATED api+web pair on ports 38570/38571 (`node
   packages/api ... PORT=38570` and `vite --port 38571 --host 127.0.0.1
   --strictPort`, both backgrounded outside Playwright), then invoke
   Playwright with `E2E_BASE_URL=http://127.0.0.1:38571` so it skips its
   own webServer management entirely (`skipWebServer =
   !!process.env.E2E_BASE_URL`, playwright.config.ts). Each of the 6 new
   spec files' `canRun` gate was adjusted to accept a LOCALHOST
   `E2E_BASE_URL` (this self-managed pair) rather than treating any
   `E2E_BASE_URL` as "a remote deployed env, skip" — documented inline in
   each file. This deviates from the lane brief's literal fallback
   ("otherwise keep the default web port and rely on the lock") because
   the brief's assumption — every lane kills its own dev servers between
   runs — was empirically false at the time of this run; the lock alone
   does not protect against a STALE server left over from an earlier,
   already-finished run.
5. **`/api/public/booking` rate limit (5 req/min/IP, `app.ts:3053-3078`) is
   real and was hit repeatedly during manual diagnosis** (curling the proxy
   by hand to isolate finding #4 above). Restarting the self-managed api
   process resets its in-memory limiter instantly — cheaper than waiting
   out the 60s window, and used between every run of a spec that POSTs to
   that route (3.4, 3.5).

**Final per-spec harness** (one spec file per process, run from repo root):
```
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
npm ci --prefer-offline --no-audit --no-fund   # once, this worktree

export DOCKER_HOST=unix:///Users/joshuakay/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
DBU=$(TESTCONTAINERS_RYUK_DISABLED=true npx tsx e2e/fixtures/setup-test-db.ts | grep -oE 'postgres://[^ ]+' | tail -1)

# Dedicated, self-managed pair (finding #4) — backgrounded, restarted between
# runs of any spec touching /api/public/booking (finding #5):
(cd packages/api && PORT=38570 E2E_API_URL=http://localhost:38570 PUBLIC_API_URL=http://localhost:38570 \
  VITE_API_URL=http://localhost:38570 DB_SSL=false DATABASE_URL=$DBU NODE_ENV=dev DEV_AUTH_BYPASS=true \
  CLERK_WEBHOOK_SECRET=whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA== npm run dev &)
(cd packages/web && VITE_API_URL=http://localhost:38570 \
  VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
  npx vite --port 38571 --host 127.0.0.1 --strictPort &)

E2E_BASE_URL=http://127.0.0.1:38571 E2E_API_URL=http://localhost:38570 \
DB_SSL=false DATABASE_URL=$DBU E2E_USE_TEST_DB=true \
VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
STRIPE_SECRET_KEY=sk_test_e2e_stub_placeholder STRIPE_WEBHOOK_SECRET=whsec_e2e_stub_secret_1234567890 \
npx playwright test <spec> --project=chromium --retries=0 --workers=1
```
Every spec below was run twice green with this exact harness (raw pass
lines quoted per row); logs archived under `/tmp/lanek_evidence/` for this
session (not committed — see the PR body for the full transcripts).

---

## Row 3.2 — "offered times respect my actual working day" (T2)

**File:** `e2e/journeys/dispatch-availability-3-2-3-3.spec.ts` (combined
with 3.3 — identical HTTP surface, `GET /api/dispatch/availability`).

Drives the REAL, fully-booted `app.ts` through a real Clerk webhook +
onboarding-identity bootstrap (never the isolated-router/fake-auth
construction the underlying integration test uses). Tenant A (Mon–Fri
08:00–17:00, 30-min buffer) books a real 10:00–11:00 appointment through the
real API; the buffered window (09:30–11:30) is proven removed from the
offered slots, the unaffected 08:00 slot stays offered, and every offered
slot for A stays inside 08:00–17:00. Tenant B (same hours shape, empty
calendar, separate real browser context) is offered the IDENTICAL 10:00
slot A's own booking blocked for A — T2, A's calendar never blocks B's.

**Honest gap, matching the row's own note:** "the web app never calls this
endpoint; only mobile does" (`scheduling/routes.ts`'s own doc-comment). No
SPA route renders this response, so there is no `page.goto()` here — the
owner's real, authenticated BROWSER session (installClerkStub-bound) issues
the request directly, the strongest reachability available for a route
with no dedicated web UI.

**Command:** harness above, `e2e/journeys/dispatch-availability-3-2-3-3.spec.ts`.
**Result:** 1 passed (1.1m), 1 passed (48.0s).

---

## Row 3.3 — "told when offered times are just defaults" (T1)

Same file/run as 3.2. A COLD tenant (real Clerk webhook bootstrap, NEVER
completes `PUT /api/onboarding/identity`) is told `timezoneSource` /
`businessHoursSource` are `'default'`, with ≥2 notes matching
`/not configured/i`, and its own fallback timezone
(`America/New_York`, `DEFAULT_TIMEZONE`) never leaks tenant A's real
`Etc/UTC` (T1, same run).

**FINDING (product behaviour, not a test bug — see the spec's own inline
comment for the full trace):** `bufferSource` is **not** `'default'` for
this cold tenant, unlike the isolated-router integration test's "zero
tenant_settings row" case. The real `user.created` Clerk webhook handler
(`packages/api/src/auth/clerk.ts:622`) calls `ensureTenantSettings`
(`packages/api/src/settings/settings.ts:1154`) for EVERY real tenant at
signup, before onboarding ever runs. That insert deliberately leaves
`timezone`/`businessHours` unset (nullable) but never touches
`jobBufferMinutes`, whose column is `NOT NULL DEFAULT 30`
(migration 098) — so a real tenant's settings row has `job_buffer_minutes
= 30` from the instant it's born, and
`findBookableSlotsDetailed`'s bufferSource check
(`input.bufferMinutes != null`, `booking-availability.ts:314`) can only
ever see "configured." A genuinely `bufferSource: 'default'` response is
reachable only via a hand-built tenant that skips `ensureTenantSettings`
entirely — impossible through the real onboarding surface. Asserted here as
the row's REAL, reachable behaviour (`bufferSource: 'tenant'`,
`bufferMinutes: 30`), not the isolated test's idealized one.

**Command/result:** same run as row 3.2 (1 passed / 1.1m, 1 passed / 48.0s).

---

## Row 3.4 — "a booking POST cannot take a slot the calendar wouldn't have offered" (T2)

**File:** `e2e/journeys/public-booking-out-of-hours-3-4.spec.ts`.

Real browser loads tenant A's public `/book` page (Mon–Fri 08:00–17:00);
the picker's own near-term window never even reaches the far-future instant
below (checked). The "gaming" attack bypasses the picker entirely: a
crafted `POST /api/public/booking/:tenantId` for a Saturday 10:00 slot —
out of hours for tenant A, genuinely in hours for tenant B (Sat/Sun
09:00–13:00 only, T2) — is refused for A with `400 VALIDATION_ERROR /
"Selected time is outside booking hours"` and provably creates NO
customer/job/appointment (customer-count read-back before/after, via the
real API). The IDENTICAL instant posted to tenant B's OWN endpoint succeeds
(201) — the guard reads EACH tenant's own hours, not a global block.
Control: a genuinely in-hours POST for tenant A on the same weekday still
succeeds.

**Command:** harness above, `e2e/journeys/public-booking-out-of-hours-3-4.spec.ts`.
**Result:** 1 passed (3.9s), 1 passed (3.8s).

---

## Row 3.5 — "a slot held while I decide, and released if I don't" (T2)

**File:** `e2e/journeys/hold-reaper-3-5.spec.ts`.

A REAL held appointment is created through the SAME public `/book` surface
2.9/3.4 use (no SQL). The owner's real, authenticated `/dispatch` session
renders it with the amber "hold" badge (`appointment-hold-badge`) and
status `scheduled`. `runHoldReaperSweep` — the IDENTICAL function
`app.ts`'s leader-locked 15-minute `setInterval` invokes — is called
directly against the real Postgres the api webServer is also pointed at (a
worker tick, not an admin route; waiting out 15 real minutes in CI is not
viable), with an injected clock 1 minute past the hold's REAL
`holdExpiryAt` (read back from the appointment record, not guessed).
Reaped: the appointment durably reads `status: 'canceled'`,
`holdPendingApproval: false`, with an `appointment.hold_expired` audit row;
a second sweep at the same clock is a no-op (idempotent). "An expired hold
stops blocking the slot" is proven on the SAME real
`GET /api/dispatch/availability` route row 3.2 exercises — the 10:00 window
reappears. The SAME owner browser, reloaded, shows the hold badge gone and
status `canceled` (screenshot). T2 — a neighbour tenant's STILL-LIVE hold
(seeded via the production `createAppointment` domain function directly,
with an explicit far-future expiry — the same technique
`hold-reaper.test.ts`'s own T2 leg uses, not raw SQL) is read back
untouched (`scheduled` / `holdPendingApproval: true`), zero
`hold_expired` audit rows.

**Test-design note (fixed while building this spec):** the first draft used
all-day (00:00–23:59) business hours for simplicity; `GET
/api/dispatch/availability` never exposes a `maxSlots` query param and
`findBookableSlotsDetailed` defaults to the first 6 open slots
(30-min granularity) — with all-day hours those 6 are all pre-dawn, so
10:00 would never appear in EITHER the "blocked" or "free" response for a
reason unrelated to the hold. Switched to 08:00–17:00 (10:00 is the 5th
slot when free) so the assertions test the hold, not response truncation.

**Command:** harness above, `e2e/journeys/hold-reaper-3-5.spec.ts`.
**Result:** 1 passed (5.7s), 1 passed (4.9s).

---

## Row 3.6 — "impossible to double-book Carlos" (T2)

**File:** `e2e/journeys/technician-double-booking-race-3-6.spec.ts`.

Two genuinely CONCURRENT `POST /api/jobs/:id/schedule` requests (an owner
assigning the SAME technician to the SAME window on two DIFFERENT, already
-existing jobs) through the real, fully-booted `app.ts` — never a bare
in-process `assignTechnician()` call the way
`technician-double-booking-race.test.ts` proves it. Exactly one succeeds
(200); the other is rejected as a conflict (409). The real `/dispatch`
board (both via the API and, in the owner's real browser, visually —
screenshot) shows EXACTLY one appointment in the technician's lane for the
raced window — the loser's schedule attempt left no partial state. T2 — a
SECOND tenant's own concurrent race, same run, its own technician/customers
/window, resolves to its own single winner, unaffected by tenant A's race
(and vice versa, re-checked after).

**PRODUCT GAP FOUND (file:line), not this row's own subject, discovered
while building this test:** `getNextJobNumber`
(`packages/api/src/jobs/pg-job.ts:330`) computes a tenant's next job number
via `SELECT COUNT(*)::int + 1 FROM jobs WHERE tenant_id = $1` with no
locking. Two CONCURRENT `POST /api/jobs` calls for a BRAND-NEW tenant's
first two jobs both read `COUNT(*) = 0`, both compute `job_number =
'JOB-0001'`, and the loser's raw Postgres unique-violation is never mapped
to a clean error anywhere in the `createJob` call chain — it surfaces as a
bare `500 INTERNAL_ERROR` ("An unexpected error occurred", the generic
fallback in `shared/errors.ts:98-99`), with the underlying error never
logged anywhere (confirmed: no stack trace in the api process's own logs).
This is a DIFFERENT race than the technician-assignment one this row is
about (it happens at job CREATION, before scheduling/assignment is ever
reached) but is real and concurrency-triggered. Reproduced directly (first
draft of this spec raced `POST /api/jobs` — job creation + schedule bundled
— and hit exactly this 500 before the fix; the final spec creates both jobs
SEQUENTIALLY first, then races only `POST /:id/schedule`, which has no
job-number allocation in its path, avoiding the confound). **Not filed as
an issue by this lane** (Fable files); flagged here with the exact seam.

**Command:** harness above, `e2e/journeys/technician-double-booking-race-3-6.spec.ts`.
**Result:** 1 passed (4.3s), 1 passed (3.6s).

---

## Row 3.9 — "customers reminded the day before" (T1·T3·T4 kept)

**File:** `e2e/journeys/appointment-reminder-sweep-3-9.spec.ts`.

A real owner (Chicago tz) signs in, registers a real push device
(`POST /api/devices`), books a real job+appointment through the
authenticated API, and sees it on the real `/dispatch` board before the
reminder fires (screenshot). `runAppointmentReminderSweep` — the SAME
function `app.ts`'s hourly `setInterval` invokes — runs directly against
real Postgres (a worker tick, not an admin route), with the REAL tenant
enumerator (`listAllTenantIds`) and an INJECTED clock exactly
`APPOINTMENT_REMINDER_LEAD_MS` before a FIXED, mid-day-UTC appointment
instant (clock-safe by construction — never depends on wall-clock time at
run time, unlike a relative "due in 24h" which could straddle a tenant-
local midnight depending on when the spec happens to run). Owner push
fires for the real appointment id with a durable, offset-agnostic dispatch
row; the customer SMS reminder fires for Chicago AND a Phoenix tenant due
at the SAME instant in a DIFFERENT owner-configured timezone (T3), each
scoped to its own tenant (cross-tenant dispatch-row leak checked both
ways). A THIRD, quiet tenant with nothing due for 10 days is reached by the
SAME real enumerator in the SAME pass and left with zero reminder rows,
without breaking the sweep for the other two (T4 — `sweepResult.failed ===
0`). A second sweep call does not double-send (idempotent).

**Command:** harness above, `e2e/journeys/appointment-reminder-sweep-3-9.spec.ts`.
**Result:** 1 passed (5.2s), 1 passed (4.0s).

---

## Row 3.11 — "stale schedule proposals expire ... can be re-proposed" (T2 kept)

**File:** `e2e/journeys/proposal-expiry-3-11.spec.ts`.

A real owner drags a real appointment card on the real `/dispatch` board —
the EXACT mechanism `dispatch-drag-proposal.spec.ts` proves for row 4.2 —
producing a genuine `reschedule_appointment` draft with the product's real
48h clock (`expiresAt` read from the real `POST /api/proposals` response,
never guessed). The real `/inbox` shows it as an ordinary pending row.
`runProposalExpirySweep` — the SAME function `app.ts`'s `setInterval`
invokes — runs directly against real Postgres with an injected clock 1
minute past that REAL 48h expiry (waiting out 48h in CI is not viable) and
the real tenant enumerator. Durable proof: the proposal reads back
`status: 'expired'` with its `proposal.expired` audit row. The owner's
SAME real browser, reloaded, shows the card moved into "Expired schedule
proposals"; clicking the real "Re-propose" button (`POST
/:id/re-propose`) mints a fresh draft with a NEW 48h clock (`expiresAt`
strictly later than the original) — proven via a REAL reload +
`GET /api/proposals/inbox` read-back, not the client's own optimistic
local-state removal (which is a one-shot UI nicety, not a durable
contract — the original source stays permanently `expired` and correctly
keeps reappearing in the expired section on every subsequent poll/reload,
since re-proposing supersedes it rather than deleting or un-expiring it;
the first draft of this spec asserted the stale-card's DISAPPEARANCE and
flaked against exactly this). T2 — a neighbour tenant's OWN fresh schedule
proposal (seeded via the SAME production `createProposal` domain function
with an explicit far-future expiry — the underlying integration test's own
technique, not raw SQL) is swept in the SAME pass and reads back
untouched (`draft`, zero audit rows), confirmed on ITS OWN real `/inbox`
page in a fresh browser context.

**Command:** harness above, `e2e/journeys/proposal-expiry-3-11.spec.ts`.
**Result:** 1 passed (5.9s), 1 passed (5.6s).

---

## Row 3.12 — report only (STORY NOT MET, per the section file)

Not touched by this lane beyond reading the section file. Current cell is
**2** with the notes already pinning the gap precisely: the three
booking-*creation* paths call `createAppointment` with no feasibility
check at all (`ai/scheduling/place-hold.ts:111`); `checkFeasibility` is
only wired from `scheduling/routes.ts` and `reassignment-handler.ts`
(dispatch-side moves), never the creation path. #1015's own
`place-hold-feasibility-gap.integration.test.ts` already pins this with a
real-Postgres control + an honest `it.fails`. Nothing to add from the
in-app surface — this is a backend wiring gap, not a reachability gap.

---

## What is NOT proven

- **3.3's `bufferSource: 'default'` case** is unreachable via any real,
  webhook-onboarded tenant (see the finding under row 3.3) — only the
  isolated-router integration test's hand-built zero-settings-row tenant
  can show it. Not a test gap; a structural consequence of
  `ensureTenantSettings` + the `job_buffer_minutes` schema default.
- **3.6's job-number allocator race** (`pg-job.ts:330`) is a real,
  concurrency-triggered 500 for a brand-new tenant's first two concurrent
  job creations — found while building this spec, unrelated to the row's
  own subject (worked around, not fixed, per TEST-ONLY scope).
- Everything else in this section's 7 rows reached the real surface end to
  end as described above; no row here needed a model turn, a live
  third-party, or a missing product feature to complete.

## Tenant grades

3.2: T2. 3.3: T1 (+ the bufferSource finding). 3.4: T2. 3.5: T2. 3.6: T2.
3.9: T1·T3·T4 (kept, per the brief). 3.11: T2 (kept, per the brief).

## Files changed

- `e2e/journeys/dispatch-availability-3-2-3-3.spec.ts` (new)
- `e2e/journeys/public-booking-out-of-hours-3-4.spec.ts` (new)
- `e2e/journeys/hold-reaper-3-5.spec.ts` (new)
- `e2e/journeys/technician-double-booking-race-3-6.spec.ts` (new)
- `e2e/journeys/appointment-reminder-sweep-3-9.spec.ts` (new)
- `e2e/journeys/proposal-expiry-3-11.spec.ts` (new)
- `e2e/global-setup.ts` (harness fix — static import, see finding #3)
- `e2e/global-teardown.ts` (harness fix — static import, see finding #3)
- `e2e/fixtures/setup-test-db.ts` (harness fix — static import, see finding #3)
- `docs/audit/lane-reports/8-3-book-inapp-r5/*.png` (screenshots)
- `docs/audit/lane-reports/8-3-book-inapp-r5.md` (this file)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
