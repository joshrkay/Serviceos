# §8.4 lane — technician's own surfaces, reached hermetically (rows 4.4, 4.5, 4.6 tap leg, 4.11)

Branch: `test/8-4-technician-surfaces` off `origin/main` (d8122045533f3f71a3fc94bc3c81663159e44e11).
Lane: TEST-ONLY (`e2e/`, `playwright.config.ts`, `docs/audit/lane-reports/`). No product code under
`packages/api/src` or `packages/web/src` was changed.

## The blocker — issue #1086 (harness, not product) — CLOSED for the technician-day route

**Root cause (confirmed).** `packages/api/src/app.ts` wires the DB-authoritative authorization
loader only when `pool && !isDevAuthBypassEnabled()`. Every real-Postgres Playwright project that
existed before this lane (`chromium`'s legacy pair, `chromium-devauth`) forces
`DEV_AUTH_BYPASS=true` on its api webServer so the owner's unsigned-JWT bootstrap works — so under
those projects `req.auth.canonicalUserId` is **never** populated, and the SEC-22 same-technician
guard in `packages/api/src/dispatch/routes.ts` (`technicianId !== req.auth!.canonicalUserId`) is
vacuously true for **any** id, including a technician's own.

**RED — reproduced against the OLD harness** (`--project=chromium`, `DEV_AUTH_BYPASS=true`):

```
CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=$DBU E2E_USE_TEST_DB=true \
VITE_CLERK_PUBLISHABLE_KEY=pk_test_... STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... \
npx playwright test e2e/journeys/_tmp-red-1086-technician-day-view.spec.ts --project=chromium --retries=0 --workers=1
```
Server log, Carlos's OWN request under the old harness:
```
GET /api/dispatch/technician/931b1a61-5150-4dde-a2a0-8db10c3b0762/appointments?date=2026-09-12
response: {"status":403,...}
```
`KNOWN GAP — Carlos's own technician-day request should succeed` — `test.fail()` fired as expected
(the harness bug was present). 1 passed (the expected-failure), 1 failed for an unrelated browser
binary mismatch (fixed by `npx playwright install chromium`) before the GREEN run.

**Fix — harness-only, `playwright.config.ts`.** Added a THIRD Playwright project,
`chromium-noauthbypass` (own api+web pair, ports 3002/5175, overridable via
`E2E_NOAUTHBYPASS_API_PORT`/`E2E_NOAUTHBYPASS_WEB_PORT`, gated by `E2E_NOAUTHBYPASS`). Its api
webServer env (`noAuthBypassApiServerEnv`) inherits `CLERK_DEV_HMAC_TOKENS=true` from the invoking
shell but explicitly leaves `DEV_AUTH_BYPASS` **unset** — so against a real Postgres
(`E2E_USE_TEST_DB=true`) the DB-authoritative loader IS wired, exactly like production. Since the
owner can no longer use the unsigned-JWT bypass shortcut, `technician-day-view.spec.ts` (and the
three new specs) bootstrap the owner through the real Clerk webhook, then mint the owner an
HMAC-signed session too (tenant id read back via a read-only `SELECT` — no writes, no bypass — see
`bootstrapOwnerTenant` in each spec). `NO_AUTH_BYPASS_SPECS` is a single source of truth: those spec
files are excluded from `chromium`'s `testIgnore` and are the only ones `chromium-noauthbypass`
matches, so there is no double-run against the wrong port and no drift between the two lists.

**GREEN — same capability, new harness:**
```
CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=$DBU E2E_USE_TEST_DB=true \
VITE_CLERK_PUBLISHABLE_KEY=pk_test_... STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... \
npx playwright test e2e/journeys/technician-day-view.spec.ts --project=chromium-noauthbypass --retries=0 --workers=1
```
```
GET /api/dispatch/technician/d163fc77-e7ae-4c2b-b8f5-ae37f7ff5f06/appointments?date=2026-09-12
response: {"status":200,...}          <- Carlos's OWN id, from his own browser session
GET /api/dispatch/technician/acd529f9-9af6-4dee-9515-dd778fe0e0ab/appointments?date=2026-09-12
response: {"status":403,...}          <- tenant B's technician id, refused
2 passed
```

## Legs proven (all under `--project=chromium-noauthbypass`)

### 4.4 — own day view (`e2e/journeys/technician-day-view.spec.ts`)
- Carlos's own `GET /api/dispatch/technician/:id/appointments` → **200**, containing the 23:00
  America/Los_Angeles job (row: `scheduled_start=2026-09-13 06:00:00+00`,
  `timezone=America/Los_Angeles` → renders as **11:00 PM** on the tenant-local day).
- Real browser: `/technician/day` renders the appointment card
  (`docs/audit/lane-reports/8-4-technician-surfaces/4.4-technician-day-own-appointments.png`).
- Tenant B's technician id from Carlos's own session → **403 FORBIDDEN** (SEC-22 held).
- No uncaught page errors.

### 4.5 — "on my way" tap (`e2e/journeys/on-my-way-tap.spec.ts`)
- Carlos taps `technician-day-on-my-way`; button flips to "Customer notified ✓"
  (`4.5-on-my-way-tap-notified.png`).
- Postgres: `appointment.en_route_triggered` audit row, actor = Carlos's Clerk sub, actor_role =
  `technician` (DB-resolved, not just the token claim) — `4.5-en-route-audit-a.snapshot.txt`.
- `delay_notice_state` row exists, keyed `${appointmentId}:en_route` — `4.5-delay-notice-state-a.snapshot.txt`.
- T2: tenant B's technician's own tap produces its own audit + state rows; A's tenant has zero
  audit rows referencing B's appointment.
- **Product bug found (not fixed — TEST-ONLY lane):** the `delay_notice_state` row settles at
  `status = 'failed'`, never `'sent'`. Cause: `packages/api/src/notifications/delay-notifications.ts:546`
  and `:569` call `captureDispatchEvent(..., 'en_route_notice_sent' | 'en_route_notice_failed', ...)`,
  but `packages/api/src/db/schema.ts`'s `105_create_dispatch_analytics` migration (~line 2775)
  CHECKs `dispatch_analytics.event_type` against `'assigned','reassigned','rescheduled','canceled',
  'conflict_detected','delay_notice_sent','delay_notice_failed'` — **neither** `en_route_notice_*`
  value is listed. Every "on my way" delivery throws
  `new row for relation "dispatch_analytics" violates check constraint "dispatch_analytics_event_type_check"`
  at the analytics-recording step, which sits inside the SAME try/catch as the delivery, so the
  catch handler overwrites the just-set `'sent'` status back to `'failed'`. 100% reproducible
  (confirmed via two independent tenants). Pinned with `test.fail()` in the same file
  ("KNOWN GAP — en-route delivery should record analytics + settle 'sent'"), asserting
  `dispatch_analytics` never gets an `en_route_notice_sent` row — this is a REAL finding for
  Fable/Josh to ticket, not filed by this lane.

### 4.6 — running-late "in one tap" (`e2e/journeys/running-late-chip.spec.ts`)
**Story NOT met by the product.** The only "chip row" matching the ticket's description
(`packages/web/src/components/jobs/TechJobView.tsx`'s "Running behind?" card, `isRunningBehind`/
`delayMinutes` state at lines 684–685, the Yes/No + 10/15/20/60 buttons at ~1085–1123) is **dead
UI**: neither state variable is read anywhere else in the file, and `advanceStatus()` (the file's
only function that calls `apiFetch`, lines 808–843) never references them. Proven with a live
network capture: navigated Carlos to `/jobs/:id?view=tech`, tapped "Yes" then "20", and asserted
**zero** matching `/api/*` requests fired (screenshot: `4.6-chip-row-no-api-call.png`). The one
technician-facing surface that DOES call `POST /api/appointments/:id/running-late`
(`TechnicianDayView.tsx:533 markRunningLate()`) is reachable only through its own GPS-triggered
two-step delay-prompt dialog — the opposite of "no second dialog" — and is out of scope for a
one-tap chip proof. `packages/api/test/integration/running-late.test.ts` already proves that route's
real-Postgres behavior once its dialog is reached; this lane does not re-prove it. Pinned with
`test.fail()` ("KNOWN GAP — tapping a delay chip should be the one-tap confirm..."), which attempts
the desired flow (tap chip → expect `POST .../running-late`) and correctly times out. **Filed for
Fable/Josh, not filed by this lane.**

### 4.11 — told when assigned (`e2e/journeys/technician-assignment-notification.spec.ts`)
- Owner drags an unassigned appointment onto Carlos's lane on the real `/dispatch` board (same
  drag mechanic as `dispatch-drag-proposal.spec.ts`) → `POST /api/proposals` → `reassign_appointment`
  proposal in `draft`. Carlos's lane needed an ANCHOR appointment already assigned to him for the
  lane to render at all (`dispatch/board-query.ts`'s `technicianAppointments` map only includes
  technicians with ≥1 appointment that day — a technician with zero gets no lane, not an empty one;
  this is existing, correct board behavior, not a bug — the fixture seeds one).
- Owner clicks **Approve** on the real `/inbox` page → `POST /api/proposals/:id/approve` → `200`,
  `status: "approved"`.
- **Finding (not a bug, a discovered mechanic):** approval does **not** execute synchronously.
  `packages/api/src/proposals/actions.ts`'s `approveProposal` only flips status to `'approved'`
  (D9 undo window, `UNDO_WINDOW_MS = 5000` in `proposals/lifecycle.ts`) — a DETACHED 1-second
  execution sweep (`app.ts`'s `runExecutionSweep` interval, gated on `shouldRunWorkers` /
  `PROCESS_ROLE=all`, the default) is what actually calls `ReassignAppointmentExecutionHandler` →
  `assignTechnician` once the undo window closes. The spec polls Postgres (up to 12s) rather than
  reading once — see `pollUntil`'s doc comment in the spec file.
- Postgres: exactly one `appointment.technician_assigned` audit row naming Carlos
  (`4.11-technician-assigned-audit-a.snapshot.txt`), and `appointment_assignments` now names Carlos
  as primary technician for that appointment (`4.11-assignment-row-a.snapshot.txt`).
- T2: tenant B's identical flow assigns its OWN technician; tenant A has zero audit rows
  referencing B's appointment.
- Screenshots: `4.11-before-drag.png`, `4.11-after-approve.png` (Inbox empty — "Nothing waiting" —
  confirming the proposal left the pending queue on approval).
- **Not proven (honestly, per §12.4d):** the push/SMS delivery to Carlos. `assignTechnician`'s push
  goes through `OwnerNotificationService.notifyUser`, which reads `device_tokens` — no device token
  is registered for Carlos in this hermetic harness (would need a real push-provider credential
  exchange this lane cannot fake), and the SMS leg needs `TWILIO_*` credentials the preamble
  explicitly says not to set for a non-phone spec. Both paths are failure-isolated ("a notification
  problem never breaks the assignment write" — `appointments/assignment.ts`), so their absence does
  not affect the audit/assignment proof above, which is the durable, hermetically-provable
  guarantee. Fable/Josh: if the tech-facing notification surface needs proving, it is the push
  (`screen: '/schedule'`), not a notifications list — there is no in-app notifications UI to reach
  instead.

## Observed flakiness (not a product defect, documented honestly)

One of five full-batch runs and one of two isolated reruns of 4.11 hit
`expect(lane).toBeVisible()` timing out after the board's own network fetch had already returned
200 — confirmed via `page.waitForResponse` completing before the assertion. Both failures coincided
with a **sibling lane's** `playwright test` process actively running on this same Mac at the time
(`ps aux` showed `agent-a763ec5eb6b2bd7b9` mid-run); every clean run (3 of 5 full-batch, both
isolated single-file reruns taken alone) coincided with no sibling contention. Consistent with
resource contention (this Mac runs multiple lanes' Chromium + Node processes concurrently), not a
deterministic frontend bug — the same assertion, same fixture shape, same code, passes reliably
when the Mac isn't simultaneously running another lane's heavy Playwright/vitest process. Flagging
for Fable in case other lanes hit the same symptom.

## Commands (exact, reusable)

Setup (once per DB):
```
export DOCKER_HOST=unix:///Users/joshuakay/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
TESTCONTAINERS_RYUK_DISABLED=true npx tsx e2e/fixtures/setup-test-db.ts   # prints DATABASE_URL
```

Per spec (repeat the lock dance from the preamble around each invocation):
```
CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=$DBU E2E_USE_TEST_DB=true \
VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
STRIPE_SECRET_KEY=sk_test_e2e_stub_placeholder STRIPE_WEBHOOK_SECRET=whsec_e2e_stub_secret_1234567890 \
npx playwright test e2e/journeys/technician-day-view.spec.ts e2e/journeys/on-my-way-tap.spec.ts \
  e2e/journeys/running-late-chip.spec.ts e2e/journeys/technician-assignment-notification.spec.ts \
  --project=chromium-noauthbypass --retries=0 --workers=1
```

Final confirmed run (all 4 files, one invocation): **7 passed** (2 of the 7 are `test.fail()` pins
that behave as expected — running-late-chip's KNOWN GAP and on-my-way-tap's KNOWN GAP), `1.3m`–
`1.5m` wall time.

## What is NOT proven

- 4.6's literal acceptance ("chip row is the confirm") — the capability does not exist; pinned, not
  filed (per §12.4d, Fable files it).
- 4.5's SMS delivery settling `'sent'` — blocked on the confirmed `dispatch_analytics` schema bug;
  the audit + state-row-exists proof stands; delivery itself is pinned, not filed.
- 4.11's push/SMS notification delivery to Carlos — external providers, outside hermetic reach; the
  audit + assignment-row proof stands.
- Neither product gap (dispatch_analytics CHECK constraint; TechJobView dead chip row) was fixed —
  this is a TEST-ONLY lane. Both are flagged above with exact file:line for Fable/Josh to ticket.
