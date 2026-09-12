# Owner-surfaces rung-5 browser reachability — Sonnet lane report

Branch: `cloud/owner-surfaces-r5` off `origin/main` (`137dc559ed8f87a02a9345554c57cc5c44cf65c3`).

Scope: **BROWSER-REACHABILITY only** — hermetic Playwright, real Postgres,
no product code changes (`packages/api/src` / `packages/web/src`
untouched). Rung 5 per `docs/PRD-v5-as-built.md` §8.0: a hermetic
Playwright run reaches the capability on the surface the story names — no
SQL setup, no platform-admin route, no env-var shortcut — with a second
tenant in the same run (T2; T3 where per-tenant config is involved). Do
not claim rungs here — only Fable/the map owner states a new rung.

Infra used throughout:

```bash
TESTCONTAINERS_RYUK_DISABLED=true npx tsx e2e/fixtures/setup-test-db.ts
# → export DATABASE_URL=postgres://test:test@localhost:<port>/serviceos_e2e_test
```

then, per spec:

```bash
CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=<that url> \
  E2E_USE_TEST_DB=true \
  VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
  QA_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  npx playwright test <spec> --project=chromium --reporter=line
```

`E2E_USE_TEST_DB=true`'s `global-teardown.ts` **truncates every table** at
the end of each `npx playwright test` process, so every spec below polls
Postgres directly (via `psql "$DATABASE_URL"`, shelled out from inside the
test itself) and writes the result to a `.snapshot.txt` file **during the
run**, before teardown fires. Screenshots are taken before, and after a
full `page.reload()`, in every browser-facing spec.

All five specs pass individually. Combined "everything at once" runs were
not attempted — nothing in this lane needs cross-spec state, and running
them separately matches how `E2E_USE_TEST_DB`'s per-process teardown
already forces isolation.

---

## 1. Row 4.1 — dispatch board (`e2e/journeys/dispatch-board.spec.ts`, new)

**Command:**
```bash
npx playwright test dispatch-board.spec.ts --project=chromium --reporter=line
```

**What it does:** bootstraps owner A (hermetic webhook + `DEV_AUTH_BYPASS`
unsigned-JWT, `PUT /api/onboarding/identity` with `timezone: 'Etc/UTC'`),
seeds 3 jobs via the real schedule-on-create `POST /api/jobs` (2 today, 1
tomorrow, all unassigned), then bootstraps owner B in the **same run**
with 1 job today. Asserts `GET /api/dispatch/board?date=<today>` for A
contains exactly A's 2 today-jobs, not tomorrow's, and not B's; then
drives the real `/dispatch` page in the browser for both A (2
`appointment-card`s) and B (1, in an isolated browser context).

**RED** (deliberately asserted tomorrow's job WOULD appear on today's board):
```
Error: tomorrow's job A3 must NOT be on today's board
Expected: true
Received: false
  1 failed
```

**GREEN** (corrected):
```
  1 passed (1.1m)
```

**Reached:** full reachability — real `/dispatch` page, real
`GET /api/dispatch/board`, real Postgres. **Tenant grade: T2** — a second
tenant (B) exists in the same run and its job never appears in, nor
changes the count of, A's board (`boardAJobIds.size === 2` asserted
explicitly, not just "contains A's jobs").

**DB snapshot** (`4.1-dispatch-board-appointments.snapshot.txt`):
```
  tenant  |                job_id                |    scheduled_start     |  status
----------+--------------------------------------+------------------------+-----------
 2fa7eb54 | 9f10ab52-c41c-46ea-a254-32eb6f308f7c | 2026-09-12 09:00:00+00 | scheduled
 2fa7eb54 | efb0774c-4ac8-4dde-b495-d6d13a770512 | 2026-09-12 14:00:00+00 | scheduled
 2fa7eb54 | 49668923-6dd0-4b1c-a7ff-512d5071e74b | 2026-09-13 12:00:00+00 | scheduled
 ceac1b0c | 66c774ec-1381-4862-a709-627b5fe94834 | 2026-09-12 10:00:00+00 | scheduled
(4 rows)
```
(`2fa7eb54…` = tenant A: 2 today (09:00/14:00 UTC) + 1 tomorrow; `ceac1b0c…` = tenant B: 1 today.)

**Screenshots:** `4.1-dispatch-board-owner-a-before-reload.png`,
`4.1-dispatch-board-owner-a-after-reload.png`.

**Judgment calls:**
- Used `timezone: 'Etc/UTC'` for both tenants specifically to make
  "today"/"tomorrow" a pure UTC-calendar-date question — no DST/offset
  arithmetic needed for THIS row (the 23:00-local timezone-boundary case
  is exercised separately and deliberately in row 4.4).
- Seeded jobs unassigned (no `technicianId`) so they land in
  `unassignedAppointments` — the row's acceptance criterion is about the
  board's date scoping, not technician lanes (that's row 4.2/4.4's
  concern).

---

## 2. Row 4.2 — drag to propose (`e2e/journeys/dispatch-drag-proposal.spec.ts`, new)

**Command:**
```bash
npx playwright test dispatch-drag-proposal.spec.ts --project=chromium --reporter=line
```

**What it does:** bootstraps an owner, invites + webhook-joins a
technician (Carlos-equivalent), seeds two appointments in his lane via
`POST /api/jobs` with `technicianId`, then in the real `/dispatch` UI
drags the earlier `appointment-card` (native HTML5 `dragTo`, Chromium) to
the last `technician-lane-gap` in the same lane, confirms the
`confirm-proposal-dialog`, and clicks through. Asserts the resulting
`POST /api/proposals` response is `status: 'draft'` /
`proposalType: 'reschedule_appointment'`, that the `appointments` row is
byte-for-byte unchanged (polled from Postgres immediately before and
after the drag), that it shows in the owner's `/api/proposals/inbox`, and
that a second tenant bootstrapped in the same run never sees it in its
own inbox.

Two real infra fixes needed along the way (both test-only):
1. `sourceCard.dragTo(lastGap)` initially hung because the welcome/what's-new
   walkthrough modal intercepted pointer events — fixed by seeding
   `localStorage` (`walkthrough.welcome.v1` / `walkthrough.whatsnew.lastSeen`)
   before `page.goto`, mirroring `digest-toggle.spec.ts`'s existing idiom.
2. `GET /api/proposals/inbox`'s `data` array items are
   `{ proposal, urgency, reason }` (from `prioritizeProposals`), not bare
   proposal objects — the inbox assertions read `p.proposal.id`, not `p.id`.

**RED** (deliberately asserted the drag WOULD mutate the appointment's `scheduledStart`):
```
Error: appointment start must NOT change until the proposal is approved
Expected: not "2026-09-12T09:00:00.000Z"
  1 failed
```

**GREEN** (corrected):
```
  1 passed (1.0m)
```

**Reached:** full reachability — the real drag gesture in a real browser,
the real `POST /api/proposals`, real Postgres before/after comparison, and
the real `/api/proposals/inbox` read.
`test/integration/dispatch-drag-proposal.test.ts` (#1017) already proved
this at the router level (stamped `req.auth`, no browser); this spec adds
the same proof from the actual UI gesture. **Tenant grade: T1** — tenant B
(bootstrapped in the same run) never sees the proposal.

No audit-event assertion is made on this path: `test/integration/dispatch-drag-proposal.test.ts`
already carries a documented, `it.skip`'d RED for this (issue #1040 —
neither `routes/proposals.ts` nor `create-scheduling.ts` emits
`proposal.created` on this path yet); repeating that RED here would be
redundant, not new information.

**DB snapshot** (before/after, byte-identical):
```
                  id                  |  status   |    scheduled_start     |         updated_at
--------------------------------------+-----------+------------------------+----------------------------
 8672d2ce-f5ca-45ff-8ce6-2f9e44668164 | scheduled | 2026-09-12 09:00:00+00 | 2026-09-12 19:47:49.045+00
```
(identical row, both snapshots — `4.2-drag-proposal-appointment-before.snapshot.txt` / `-after.snapshot.txt`)

**Screenshots:** `4.2-drag-proposal-before-drag.png`, `4.2-drag-proposal-after-drag.png`.

**Judgment calls:**
- Dragged within the SAME lane (`reschedule_appointment`) rather than
  across lanes or into the unassigned queue: `routes/proposals.ts`'s
  `SUPPORTED_TYPES` allowlist does not include `cancel_appointment` (the
  unassigned-drop type) — that drop would 400 `UNSUPPORTED_PROPOSAL_TYPE`
  server-side, a separate, real gap worth its own row rather than folding
  into this one. Not asserted here; noted for the map owner.
- Did not click "Approve" in the inbox (the ticket names this "a bonus,
  not required") — the row's guarantee is proposal-created +
  appointment-unmutated, both proven.

---

## 3. Row 4.4 — technician day view (`e2e/journeys/technician-day-view.spec.ts`, new)

**Command:**
```bash
npx playwright test technician-day-view.spec.ts --project=chromium --reporter=line
```

**What it does:** bootstraps owner A + technician Carlos (invite +
webhook-join + HMAC tenant-scoped token, mirroring
`accept-invitation.spec.ts`), sets tenant A's timezone to
`America/Los_Angeles`, and schedules a job at **23:00 America/Los_Angeles
local, today** (computed via the same `tenantWallClockToUtc` arithmetic
`packages/web/src/utils/formatInTenantTz.ts` uses, duplicated inline since
it's pure `Intl` math with no React dependency). Bootstraps tenant B +
its own technician in the same run. Asserts the 23:00-local job appears
in the day query, that Carlos's session requesting tenant B's technician
id gets `403 FORBIDDEN`, and drives the real `/technician/day` page.

**RED** (deliberately asserted the 23:00-local job would NOT appear):
```
Error: 23:00-local job must be on Carlos's day
Expected: false
Received: true
  1 failed
```

**GREEN** (corrected):
```
  1 passed (1.1m)
```

**Reached / not reached — a confirmed, root-caused lane limitation (not a
product defect):**

- **Reached:** the day-boundary/timezone data guarantee — the 23:00-local
  job is included when queried via `GET
  /api/dispatch/technician/:id/appointments?date=<tenant-local-date>` —
  proven over the real HTTP route at real Postgres. Also reached: the
  SEC-22 cross-tenant refusal — Carlos's own authenticated session
  requesting **tenant B's** technician id gets `403 FORBIDDEN`
  (`{"error":"FORBIDDEN","message":"Technicians may only view their own
  appointments"}`), and the `/technician/day` route itself renders (SPA
  shell, no 404).
- **NOT reached:** proving that Carlos's OWN request (his own technician
  id) **succeeds**. It also 403s, in this harness. Root cause, traced in
  `packages/api/src/app.ts` and `packages/api/src/auth/dev-auth-bypass.ts`:
  the DB-authoritative authorization loader that populates
  `req.auth.canonicalUserId` is wired only when `pool &&
  !isDevAuthBypassEnabled()`. Every hermetic real-Postgres spec's api
  webServer in this repo's `playwright.config.ts` runs with
  `DEV_AUTH_BYPASS=true` **unconditionally** (`apiWebServerEnv`, set
  firmly, not `?? inherited`) — required for the owner's hermetic
  unsigned-JWT bootstrap this entire lane depends on. Carlos authenticates
  via a real, verified HMAC token (`CLERK_DEV_HMAC_TOKENS`), so
  `devAuthBypass` skips him too (`if (req.auth) return next()` — it only
  fills in for genuinely unsigned tokens it handles itself). Net effect:
  `canonicalUserId` is `undefined` for **every** technician-role request in
  this whole lane, so `technicianId !== req.auth!.canonicalUserId` is
  vacuously true for ANY id — including a technician's own. This means the
  lane can prove the guard **fails closed** (refuses), but not that it
  **positively admits** a matching technician. This is a test-harness
  artifact, not a production behavior: production never sets
  `DEV_AUTH_BYPASS=true`, so the loader is always wired there and
  `canonicalUserId` is always DB-resolved from the real Clerk session.
  The underlying data guarantee (23:00-local inclusion) is instead proven
  through the OWNER's session, which the same guard exempts entirely
  (`role === 'technician'` is the only gate).
  **Post-review revision:** this gap is now captured as its own test —
  `'KNOWN GAP — Carlos's own technician-day request should succeed
  (expected to fail under this harness)'` — using `test.fail(true,
  reason)` around the CORRECT/desired assertion (`200` + the appointment
  visible), per CLAUDE.md/testing-strategy.md's own convention for a
  confirmed defect ("a real defect gets a failing test marked
  `test.fail()`"). An automated reviewer (xhawk-ai) correctly flagged the
  original version — a hard `expect(...).toBe(403)` on the main test —
  for locking the bug in as the "passing" contract: if the harness gap is
  ever closed, that assertion would keep passing on the NEW, wrong
  reason, or need a manual update. `test.fail()` inverts this: the test
  now asserts what SHOULD happen, currently fails as expected, and will
  flip to an "unexpectedly passed" CI failure the moment the gap closes —
  a self-flagging TODO instead of a silently stale assertion.
- The browser assertion for Carlos's own `/technician/day` page therefore
  honestly asserts `technician-day-error` is visible (the 403 surfaces as
  the page's error state) rather than a populated appointment list — a
  true statement about current behavior in this lane, not an invented
  pass.

**Tenant grade: T1** for the refusal (tenant B's technician id, from
Carlos's tenant-A session, is refused); the day-boundary data guarantee is
proven single-tenant (Carlos's own tenant) since it's read via the owner
route, not cross-tenant by nature.

**DB snapshot** (`4.4-technician-day-appointment.snapshot.txt`):
```
                  id                  |    scheduled_start     |      timezone       |            technician_id
--------------------------------------+------------------------+---------------------+--------------------------------------
 809f8080-0fb9-4984-88aa-7f7bfaccaca8 | 2026-09-13 06:00:00+00 | America/Los_Angeles | 375e7cb2-5f73-4777-87d2-01683ff8f0fd
```
(23:00 PDT on 2026-09-12 = 06:00 UTC on 2026-09-13 — confirms the UTC-day-boundary crossing the story is about.)

**Screenshots:** `4.4-technician-day-before-reload.png`, `4.4-technician-day-after-reload.png` (both show the honest error state, per the gap above).

**Judgment call:** did not attempt to work around the `DEV_AUTH_BYPASS`
limitation (e.g., by patching `playwright.config.ts` to disable it for
just this spec) — that would touch shared test infrastructure every other
hermetic spec in this repo depends on, for a workaround whose blast radius
wasn't scoped in this lane's brief. Flagging for the map owner instead:
either accept T1-via-owner-session as the ceiling this lane can prove, or
a follow-up lane could add a `chromium`-project-scoped variant with the
loader wired (`DEV_AUTH_BYPASS=false` + a real/HMAC-verified owner session
instead of the unsigned-JWT bootstrap) to close this specific gap.

---

## 4. Row 1.2 — onboarding identity in the browser (`e2e/journeys/onboarding-identity.spec.ts`, new)

**Command:**
```bash
npx playwright test onboarding-identity.spec.ts --project=chromium --reporter=line
```

**What it does:** seeds tenant B's identity FIRST (via API, distinct
values) as the T2 control. Bootstraps a genuinely fresh owner (tenant A,
onboarding not started), drives the real `/onboarding` `IdentityStep`
form in the browser — fills "Business name", "Hourly rate", and "Service
area radius in miles" — and submits. Polls `tenant_settings` and
`audit_events` directly from Postgres. Then resubmits `PUT
/api/onboarding/identity` directly (the form itself never omits
`serviceAreaRadius` — its `useState<number>` always has a value — so the
omit-tri-state leg, #874, is driven against the same real route the form
posts to, not just the form) with the key omitted, and confirms the
stored radius is kept. Re-reads tenant B's settings at the end to confirm
they're untouched.

Two infra fixes needed (both test-only, not product code):
1. `getByLabel('Hourly rate')` couldn't resolve — that `Field` wraps its
   `Input` in a `$ … /hour` flex `<div>`, so `Field`'s generated
   `htmlFor`/`id` lands on the wrapper div, not the `<input>` itself.
   Fixed with an XPath locator relative to the label text
   (`Service area radius in miles` works fine via `getByLabel` because
   that `<input>` carries its OWN `aria-label`, independent of `Field`).
2. `IdentityStep` pre-loads any existing settings asynchronously on mount
   and overwrites form state when it resolves; a `.fill()` that races
   ahead of that pre-load gets silently clobbered back to the
   webhook-bootstrapped default business name. Fixed by waiting for the
   submit button to become enabled (which only happens once the pre-load
   sets `loaded = true`) before typing.

**RED** (deliberately asserted omitting `serviceAreaRadius` would reset it):
```
Error: omitting serviceAreaRadius must KEEP the stored value
Expected: 1
Received: 42
  1 failed
```

**GREEN** (corrected):
```
  1 passed (2.0m)
```

**Reached:** full reachability — real `/onboarding` form submission →
real `PUT /api/onboarding/identity` → real `tenant_settings` row + real
`tenant.identity_set` audit event, both polled from Postgres. The
omit-tri-state leg reached at the live API (not just the mocked-DB unit
test `test/integration/onboarding-identity.test.ts`). **Tenant grade: T2**
— tenant B, seeded with different values BEFORE tenant A's work, is
re-read at the end and confirmed unchanged (`businessName`,
`hourlyRateCents`, AND `serviceAreaRadius` all still B's original values).

**DB snapshot** (`1.2-onboarding-identity-tenant-settings.snapshot.txt`):
```
              tenant_id               |        business_name        | hourly_rate_cents | service_area_radius |    timezone
--------------------------------------+-----------------------------+-------------------+---------------------+----------------
 8a07eea1-837c-4be7-b348-0a9345069312 | Onboarding Browser E2E HVAC |             15000 |                  42 | UTC
 fe32b0d9-3e68-4f4d-bfe4-b340313c4bd2 | Tenant B Untouched HVAC     |              9900 |                  99 | America/Denver
```
Audit (`1.2-onboarding-identity-audit-events.snapshot.txt`):
```
              tenant_id               |     event_type      |   entity_type   |              entity_id
--------------------------------------+---------------------+------------------+--------------------------------------
 8a07eea1-837c-4be7-b348-0a9345069312 | tenant.identity_set | tenant_settings | 8a07eea1-837c-4be7-b348-0a9345069312
```

**Screenshots:** `1.2-onboarding-identity-before-submit.png`, `1.2-onboarding-identity-after-reload.png`.

**Judgment calls:**
- `timezone` ended up `UTC` in the persisted row for tenant A even though
  the form's Select defaulted to the browser's detected timezone
  (`detectBrowserTimezone()`) — Chromium in this sandbox resolves its
  `Intl` timezone to UTC, and the spec never touched the Select. Not a
  bug: the acceptance criterion is about `serviceAreaRadius`, not
  timezone selection.
- Did not attempt to also click through the SAME form a second time (the
  omit-leg is API-only, per the UI's own always-sends-a-number behavior
  documented above) — driving that specific omission through the browser
  form is not possible without a product change, so it isn't invented
  around.

---

## 5. Row 1.11 — invite → accept, re-run + T2 leg (`e2e/journeys/accept-invitation.spec.ts`, modified)

**Command:**
```bash
npx playwright test accept-invitation.spec.ts --project=chromium --reporter=line
```

**Re-run of the existing 2 tests — cited, not duplicated.** First re-run
attempt found a genuine flake in the FIRST test ("an unauthenticated visit
does not land on the technician day view") — `page.goto` timed out
waiting for the `load` event:
```
TimeoutError: page.goto: Timeout 15000ms exceeded.
  navigating to "http://localhost:5173/accept-invitation?invitation_id=…", waiting until "load"
  1 failed
  1 passed (1.7m)
```
Root cause: `index.html` eagerly loads a blocking Google Fonts stylesheet
and a Pendo `<script>` from external hosts; in this network-sandboxed
environment those never resolve, stalling `load`. This test was the ONE
spec in the file (and one of very few in the whole suite) that never
called `blockExternalHosts` before navigating — every sibling test here,
and every other real-Postgres journey spec in this repo, already does.
Confirmed by manually starting the API+Vite dev servers ahead of time
(`reuseExistingServer: true` picks them up) to rule out a cold-Vite-compile
explanation — the second, heavier test in the same file (multiple
`page.goto` calls, DOES call `blockExternalHosts`) passed cleanly on every
attempt, only the external-host-unblocked one hung. Fixed with a one-line,
test-only addition (`await blockExternalHosts(page, baseURL!)`, matching
the file's own established idiom) — re-run GREEN:
```
  2 passed (33.9s)
```

**T2 leg — two new tests added to the same file:**

**(a) Cross-tenant invitation token.** Tenant A exists in the same run.
Tenant B invites a technician, producing a REAL `invitation_id` scoped to
tenant B. A signed `user.created` webhook is sent carrying that real
`invitation_id` but a **forged** `public_metadata.tenant_id` claiming
tenant A. Per `packages/api/src/webhooks/routes.ts`'s join logic (read,
not modified): the tenant is resolved from `pending_invitations.tenantId`
(the DB row the real `invitation_id` points at), never from the payload's
`tenant_id` claim — so the invitee joins tenant B, never tenant A.

**RED** — n/a for this test as a deliberately-wrong-then-fixed pair (the
correctness of the join-resolution logic was verified by reading the
webhook handler first, per the agent research this lane commissioned;
this test asserts the DB-recorded behavior directly). It passed on first
write, verified by manual trace of `webhooks/routes.ts`'s
`pending.tenantId`-authoritative resolution (cited by file/line in the
spec's own comments) rather than a synthetic RED — flagged here rather
than silently presented as TDD'd, per the "raw output kept" honesty bar.

**GREEN** (part of the 4-test run below):
```
[3/4] … T2 — tenant B's invitation token does not open tenant A's join
  (passed)
```

**(b) Last owner cannot be demoted (UI).** A sole owner opens `/settings`
→ "Team members" → edits their own row → selects "Dispatcher" → clicks
Save. Asserts `PATCH /api/users/:id` returns `400`, an alert renders in
the dialog, the row still shows "Owner", and `/api/me` confirms the role
is unchanged.

**RED** (deliberately asserted the demotion would succeed with `200`):
```
Error: demoting the only owner must be refused, not succeed
Expected: 200
Received: 400
  1 failed
```
(Needed one infra fix along the way: the "what's new" walkthrough modal
intercepted the "Team members" button click — same `localStorage`
suppression idiom used in rows 4.1/4.2/4.4.)

**GREEN** (all 4 tests in the file, together):
```
[1/4] an unauthenticated visit does not land on the technician day view … passed
[2/4] an invited technician follows the invite link and lands on their own day view … passed
[3/4] T2 — tenant B's invitation token does not open tenant A's join … passed
[4/4] T2 — the last owner cannot be demoted from the members page (UI) … passed
  4 passed (34.6s)
```

**Reached:** full reachability for both T2 legs — real webhook join
resolution, real `/settings` → Team members UI, real `PATCH
/api/users/:id`. **Tenant grade: T2** for (a) (two tenants, B's own
invitation resolves correctly despite A's forged claim); the last-owner
guard (b) is inherently single-tenant (there's no cross-tenant angle to
"can the sole owner demote themselves") — T0 by the map's own vocabulary,
which is what the row asks for.

**Screenshots:** `1.11-last-owner-demote-before.png`, `1.11-last-owner-demote-after.png`.

**Judgment calls:**
- Fixed the pre-existing `blockExternalHosts` gap in the FIRST existing
  test rather than reporting it as an unreproducible flake — it's a
  one-line, test-only change matching the file's own established pattern,
  not a product-code change, and re-running the row without it would have
  been a less honest "re-run" than fixing an obvious environment-coupling
  gap in the test itself.
- For the cross-tenant invitation test, additionally confirmed via
  `/api/me` that the technician's real session (bound to tenant B) shows
  `tenant_id: B` — the join webhook's own `{ joined: tenantId }` response
  is the primary evidence, this is corroboration through a second, unrelated
  code path.
- **Post-review revision:** the same automated reviewer (xhawk-ai) flagged
  that the original "tenant A never sees this user" check
  (`expect(forgedMe.status()).toBeLessThan(500)`, hitting `/api/me` with a
  forged tenant-A-claiming token) proves nothing — `/api/me` under
  `DEV_AUTH_BYPASS` would happily echo a `200` for a forged tenant claim
  with no DB membership check, so a false membership could pass the same
  assertion. Replaced with a direct Postgres read: `count(*) FROM users
  WHERE clerk_user_id = techSub AND tenant_id = tenantA` must be `0`, and
  the same query against tenant B must be `1` — the only assertion a false
  membership could not also satisfy.

---

## Files changed on this branch

- `e2e/journeys/dispatch-board.spec.ts` (new)
- `e2e/journeys/dispatch-drag-proposal.spec.ts` (new)
- `e2e/journeys/technician-day-view.spec.ts` (new)
- `e2e/journeys/onboarding-identity.spec.ts` (new)
- `e2e/journeys/accept-invitation.spec.ts` (modified — one-line
  `blockExternalHosts` fix to its first test + two new T2-leg tests
  appended)
- `docs/audit/lane-reports/owner-surfaces-r5/*.png` / `*.snapshot.txt`
  (screenshots + Postgres snapshots referenced above)
- This report.

No files under `packages/api/src` or `packages/web/src` were touched.

## Build verification

```
$ cd packages/api && npx tsc --project tsconfig.build.json --noEmit
(clean — no output)
```

## Not done / open items for the map owner

1. **Row 4.4's technician-self-access gap** (§3 above) — this hermetic
   lane cannot positively prove a technician's OWN request succeeds,
   only that the guard fails closed for everyone under
   `DEV_AUTH_BYPASS=true`. Not invented around; the day-boundary data
   guarantee is proven via the owner's session instead, and the gap
   itself is now a `test.fail()`-marked test that will flag itself
   (as an unexpected pass) once fixed.
2. **Row 4.2's `cancel_appointment` gap** (§2 above) — dropping a card
   into the unassigned queue would 400 `UNSUPPORTED_PROPOSAL_TYPE`
   server-side (`routes/proposals.ts`'s `SUPPORTED_TYPES` allowlist
   excludes it). Noted, not tested here — out of this row's stated scope
   (same-lane reschedule was the guarantee under test).
3. **Row 4.2's missing `proposal.created` audit event** — already tracked
   as issue #1040 with an `it.skip`'d RED in
   `test/integration/dispatch-drag-proposal.test.ts`; not repeated here.
4. Do not claim rungs from this report — only Fable/the map owner states
   a new rung per row.
