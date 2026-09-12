# §8.5 Execute lane report — ticket #1018 (Sonnet, test-only rows)

Branch: `cloud/execute-8-5` (off `origin/main`, `d869cea`).
Scope: rows 5.2, 5.4, 5.1 (test-only), 5.3 (grading only). 5.5 (Stripe
Terminal, money) is the Opus lane, not touched here. No file under
`packages/api/src`, `packages/web/src`, or `packages/mobile/src` was
modified — every change in this lane is a test file, a Playwright config
entry, or this report.

Per #995's map rules: **only Fable states a new rung.** This report reports
commands, raw output, evidence class and tenant grade per row; it does not
claim a rung.

---

## Row 5.2 — before/after photos attached to the job

G1 (#1006, PR #1027): **3** — only in-memory proofs existed
(`test/jobs/job-photos.test.ts`, `test/attachments/*`,
`test/routes/attachments.route.test.ts`, 97/97). No integration test opened
a real pool.

**File:** `packages/api/test/integration/job-photo-round-trip.test.ts` (new)
**Command:**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/job-photo-round-trip.test.ts
```

**What it exercises:** the real `createJobPhotosRouter` (routes/job-photos.ts)
+ `JobPhotoService` + `PgJobPhotoRepository` + `PgFileRepository` +
`PgAttachmentRepository` (RV-005 shadow write) + `PgAuditRepository`, against
a real `pgvector/pgvector:pg16` testcontainer — presign-upload → attach →
list, each step read back directly from Postgres (not just the HTTP
response body).

**TDD (RED → GREEN):** all 9 assertions were first written with a
deliberately wrong expected value, run once (RED, 9/9 failing for the
wrong-value reason only — same 9 tests, same setup), then corrected and
re-run (GREEN, 9/9 passing). Raw output:

RED (excerpt — full log kept in session scrollback):
```
✗ persists a real job_photos row ... rows[0].category toBe('after') → received 'before'
✗ RV-005 shadow-writes ... shadow!.entityType toBe('invoice') → received 'job'
✗ reads the attachment audit event ... attached toHaveLength(0) → received length 1
✗ lists the photo back ... downloadUrl toContain('/nonexistent/') → received '.../get/...'
✗ T1 cannot list ... res.body toEqual([{bogus:true}]) → received []
✗ T1 cannot receive ... attach.status toBe(201) → received 404
✗ T1 cannot read job_photos ... found not.toBeNull() → received null
✗ T1 cannot read attachments ... rows toHaveLength(1) → received []
✗ T1 cannot read audit event ... events toHaveLength(1) → received []
 Test Files  1 failed (1)
      Tests  9 failed (9)
```

GREEN:
```
✓ persists a real job_photos row (read back directly from Postgres) 3ms
✓ RV-005 shadow-writes a real attachments row for the same file + job 4ms
✓ reads the attachment audit event back through PgAuditRepository.findByEntity 9ms
✓ lists the photo back through the real service (GET /photos) 10ms
✓ T1 — a neighbour tenant > cannot list the photo (cross-tenant listing is empty) 8ms
✓ T1 — a neighbour tenant > cannot receive the photo (attach with the same fileId 404s — file invisible under RLS) 18ms
✓ T1 — a neighbour tenant > cannot read the job_photos row directly (PgJobPhotoRepository.findById scoped by tenant) 5ms
✓ T1 — a neighbour tenant > cannot read the shadow attachments row directly (PgAttachmentRepository.listByEntity scoped by tenant) 5ms
✓ T1 — a neighbour tenant > cannot read the audit event directly (PgAuditRepository.findByEntity scoped by tenant) 5ms
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

**Evidence class:** D → real Postgres write + read-back, through the
production service/route/repository stack, no mocked DB, no in-memory
audit repo.

**Tenant grade:** T1 confirmed — `grep -nE "other = await createTestTenant"
test/integration/job-photo-round-trip.test.ts` shows 4 independent
"neighbour tenant" assertions (list, attach, job_photos read, attachments
read, audit read) all resolving empty/null/404 for the second tenant.

**Evidence (artifact-before-sign-off), from the kept plain-Postgres
container** — `docs/audit/lane-reports/1018-execute/`:
- `job_photos_rows.txt` — the one persisted row, tenant id visible.
- `attachments_rows.txt` — the RV-005 shadow row, same tenant/file/job.
- `audit_events_summary.txt` / `audit_events_full.txt` — both
  `job.photo.upload_requested` and `job.photo.attached` events, one tenant.

```
$ docker exec <cid> psql -U test -d serviceos_test -c "SELECT left(tenant_id::text,8), event_type, entity_type, count(*) FROM audit_events GROUP BY 1,2,3 ORDER BY 2,1;"
   left   |         event_type         | entity_type | count
----------+----------------------------+-------------+-------
 2c1cb377 | job.photo.attached         | job         |     1
 2c1cb377 | job.photo.upload_requested | job         |     1
(2 rows)
```

```
$ docker exec <cid> psql -U test -d serviceos_test -c "SELECT tenant_id, job_id, file_id, category, notes, created_at FROM job_photos;"
              tenant_id               |                job_id                |               file_id                | category |     notes     |         created_at
--------------------------------------+--------------------------------------+--------------------------------------+----------+---------------+----------------------------
 2c1cb377-301b-44c2-af2a-56c8fb6ea5f8 | 371cf3da-ce44-4fec-a2b3-67c0c91042ef | 8f1f88cd-ea0f-4683-b9fe-753bb0768665 | before   | front of unit | 2026-09-12 17:20:50.155+00
(1 row)
```

```
$ docker exec <cid> psql -U test -d serviceos_test -c "SELECT tenant_id, entity_type, entity_id, kind, category, source, archived_at FROM attachments;"
              tenant_id               | entity_type |              entity_id               | kind  | category | source | archived_at
--------------------------------------+-------------+--------------------------------------+-------+----------+--------+-------------
 2c1cb377-301b-44c2-af2a-56c8fb6ea5f8 | job         | 371cf3da-ce44-4fec-a2b3-67c0c91042ef | photo | before   | app    |
(1 row)
```

```
$ docker exec <cid> psql -U test -d serviceos_test -c "SELECT id, tenant_id, actor_id, event_type, entity_type, entity_id, metadata FROM audit_events;"
                  id                  |              tenant_id               |               actor_id               |         event_type         | entity_type |              entity_id               |                                                           metadata
--------------------------------------+--------------------------------------+--------------------------------------+----------------------------+-------------+--------------------------------------+------------------------------------------------------------------------------------------------------------------------------
 f50b16b4-5af7-4e57-8228-ddbc45423c37 | 2c1cb377-301b-44c2-af2a-56c8fb6ea5f8 | bcf5316c-5c0e-491e-a62c-cd5f52bf9eda | job.photo.upload_requested | job         | 371cf3da-ce44-4fec-a2b3-67c0c91042ef | {"fileId": "8f1f88cd-ea0f-4683-b9fe-753bb0768665", "filename": "before.jpg", "sizeBytes": 2048, "contentType": "image/jpeg"}
 526c2b46-2ffd-4d10-b1d7-e7be216409ad | 2c1cb377-301b-44c2-af2a-56c8fb6ea5f8 | bcf5316c-5c0e-491e-a62c-cd5f52bf9eda | job.photo.attached         | job         | 371cf3da-ce44-4fec-a2b3-67c0c91042ef | {"fileId": "8f1f88cd-ea0f-4683-b9fe-753bb0768665", "photoId": "1364b937-c46e-4b67-a135-e0a322982657", "category": "before"}
}
```

---

## Row 5.4 — dictated note survives no signal

G1 (#1006): **4− at T1** — `voice-idempotency.test.ts` proved row dedupe
but never checked the audit trail. Device-level reconnect proof is
hardware-blocked (research #1002); not attempted here, and not faked.

**File:** `packages/api/test/integration/voice-idempotency.test.ts`
(existing T1 kept unchanged; added a new test + wired a real
`PgAuditRepository` into `buildApp`, matching how `app.ts` actually wires
`createVoiceRouter(pool-backed voiceRepo, queue, transcribeAudio, auditRepo, ...)`
in production).

**Command:**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/voice-idempotency.test.ts
```

**TDD (RED → GREEN):**

RED (deliberately wrong: expected exactly 1 audit row on a fresh create):
```
× audit trail: the replay does not duplicate whatever audit row(s) the create produced (PgAuditRepository.findByEntity) 18ms
  → AssertionError: expected [] to have a length of 1 but got +0
 Test Files  1 failed (1)
      Tests  1 failed | 4 passed (5)
```

GREEN (corrected to the TRUE current value):
```
✓ same key twice → one row, same recording id, exactly one effective job 52ms
✓ audit trail: the replay does not duplicate whatever audit row(s) the create produced (PgAuditRepository.findByEntity) 24ms
✓ create-then-crash replay (row exists, no job) re-enqueues so the recording can complete 12ms
✓ tenant-isolates the key: the same value in two tenants → two independent rows 22ms
✓ different keys in one tenant → different rows 20ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

**Finding (not fixed — out of scope for this test-only lane):**
`POST /api/voice/recordings` (`packages/api/src/routes/voice.ts`, handler
starting at line 386) never calls `auditRepo.create`. Confirmed by:
```
$ grep -n "auditRepo.create\|createAuditEvent(" packages/api/src/routes/voice.ts
155:          await auditRepo.create(createAuditEvent({   # /stream-token
258:          await auditRepo.create(createAuditEvent({   # /transcribe
```
Neither call site is inside `/recordings`. CLAUDE.md's "All mutations emit
audit events" is violated by this route today — a real, pre-existing gap,
not introduced by this lane. The new test pins the CURRENT (non-compliant)
count (0 audit rows for a fresh voice-recording create) and proves the
replay never grows that count, rather than asserting a compliance claim
that isn't true. Fixing it means adding an `auditRepo?.create(...)` call
after `voiceRepo.create(...)` in that handler — a product-code change to
`packages/api/src/routes/voice.ts`, out of scope for this lane (SCOPE:
"Do NOT touch product code"). Flagging for the next lane / Fable's review.

**Evidence class:** D for the row-dedupe leg (real Postgres,
`voice_recordings` table); the audit leg is D-class evidence of an
absence — a real query against a real table, honestly reporting zero.

**Tenant grade:** T1 unchanged and still passing (`tenant-isolates the
key` test) —
```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" test/integration/voice-idempotency.test.ts
141:  it('tenant-isolates the key: the same value in two tenants → two independent rows', async () => {
```

**Evidence, from the kept plain-Postgres container** —
`docs/audit/lane-reports/1018-execute/voice_recordings_rows.txt`:
```
$ docker exec <cid> psql -U test -d serviceos_test -c "SELECT tenant_id, id, idempotency_key, status, created_by FROM voice_recordings;"
              tenant_id               |                  id                  |               idempotency_key               | status  |              created_by
--------------------------------------+--------------------------------------+---------------------------------------------+---------+--------------------------------------
 ab221636-78fc-4683-bb6c-05c685183a4e | 0a1e8508-4a2b-4fcd-ab2f-5df674f1744e | same-f39f942c-07a9-48ba-93a9-cedfeb569b15   | pending | 07d6756c-9734-44ea-9a42-fa28ba6489ba
 ab221636-78fc-4683-bb6c-05c685183a4e | ba05d8d4-9db2-43ed-bb1c-828314e3c8e7 | audit-c2802ca4-85c8-41f0-abd6-d78f18feb81b  | pending | 07d6756c-9734-44ea-9a42-fa28ba6489ba
 ab221636-78fc-4683-bb6c-05c685183a4e | 1589b4d0-d757-4f2d-86d3-24121f312df9 | crash-b41927aa-b4a0-4022-bfb4-885c01d10365  | pending | 07d6756c-9734-44ea-9a42-fa28ba6489ba
 ab221636-78fc-4683-bb6c-05c685183a4e | 01742c34-7665-4067-8a28-8106e373c192 | shared-bc77a23b-2200-478d-bec0-d7e7d7a28fd1 | pending | 07d6756c-9734-44ea-9a42-fa28ba6489ba
 1c2fafbd-8265-4d0f-99fa-51fdd3a2d9f4 | 20b5e301-1d7f-49f9-b091-f54fea47acfa | shared-bc77a23b-2200-478d-bec0-d7e7d7a28fd1 | pending | de97155a-e18c-49b9-9209-25dda7ef7548
 ab221636-78fc-4683-bb6c-05c685183a4e | 6077e072-62b9-4fb2-a18b-5b9d5b96b8db | diff-a-05c322f5-e82f-4208-8dc1-1539b6349ccf | pending | 07d6756c-9734-44ea-9a42-fa28ba6489ba
 ab221636-78fc-4683-bb6c-05c685183a4e | 402a9bee-c824-488d-8934-688c45829179 | diff-b-17c1d8d4-a29b-467f-b610-d7ebffcec070 | pending | 07d6756c-9734-44ea-9a42-fa28ba6489ba
(7 rows)
```
7 rows for 5 test cases (the tenant-isolation test creates 2 rows, one per
tenant, for the shared key) — no duplicate rows anywhere, and (per the
audit_events dump under row 5.2 above) **zero** matching `audit_events`
rows, confirming the finding above directly against real data.

**Not done:** the device-level reconnect proof stays hardware-blocked per
research #1002 — not attempted, not faked, consistent with the ticket's
own instruction.

---

## Row 5.1 — gloves-on / in-the-sun field screens

G1 (#1006): **NO-COMMAND** — no jsdom class-contract test and no
Playwright viewport spec existed.

### jsdom class-contract tests (new)

**Files:**
- `packages/web/src/pages/technician/TechnicianDayView.layout.test.tsx`
- `packages/web/src/components/jobs/TechJobView.layout.test.tsx`

**Command:**
```
cd packages/web && npx vitest run --reporter=verbose src/pages/technician/TechnicianDayView.layout.test.tsx src/components/jobs/TechJobView.layout.test.tsx
```

**TDD (RED → GREEN), TechnicianDayView (5 assertions flipped to a wrong
class name, e.g. `min-h-99`/`max-w-xxxl`):**
```
RED:
 × the Previous/Next day-nav buttons meet the ≥44px glove target (min-h-11)
 × the Ask AI button and input meet the glove target and use high-contrast text
 × each appointment card's primary actions (View job, On my way, Edit time) meet the glove target
 × the edit-time Save/Cancel controls meet the glove target once the form opens
 × the whole view fits inside a single mx-auto max-w-lg column (no fixed width wider than a 320px phone)
 Test Files  1 failed (1)
      Tests  5 failed (5)

GREEN:
 ✓ the Previous/Next day-nav buttons meet the ≥44px glove target (min-h-11) 70ms
 ✓ the Ask AI button and input meet the glove target and use high-contrast text 10ms
 ✓ each appointment card's primary actions (View job, On my way, Edit time) meet the glove target 17ms
 ✓ the edit-time Save/Cancel controls meet the glove target once the form opens 24ms
 ✓ the whole view fits inside a single mx-auto max-w-lg column (no fixed width wider than a 320px phone) 9ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

**TDD (RED → GREEN), TechJobView (5 assertions flipped, including two
inverted so the CURRENT-STATE pin was proven wrong-then-right too):**
```
RED:
 × the bottom action bar's call/camera icon buttons meet the ≥44px glove target (size-12 = 48px)
 × the "Add photo" action in the Photos section meets the glove target
 × KNOWN GAP: the primary status-advance CTA has no explicit ≥44px class today
 × KNOWN GAP: the quick-action chip grid (Note/Photo/Parts/Issue) has no explicit ≥44px class today
 × the job hero and status bar do not force a fixed width wider than a 320px phone
 Test Files  1 failed (1)
      Tests  5 failed (5)

GREEN:
 ✓ the bottom action bar's call/camera icon buttons meet the ≥44px glove target (size-12 = 48px) 98ms
 ✓ the "Add photo" action in the Photos section meets the glove target 37ms
 ✓ KNOWN GAP: the primary status-advance CTA has no explicit ≥44px class today 106ms
 ✓ KNOWN GAP: the quick-action chip grid (Note/Photo/Parts/Issue) has no explicit ≥44px class today 25ms
 ✓ the job hero and status bar do not force a fixed width wider than a 320px phone 28ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

**Findings (surfaced, not fixed — product code out of scope):** while
pinning the contract, two real gaps turned up in `TechJobView.tsx`
(`packages/web/src/components/jobs/TechJobView.tsx`):
- the main status-advance CTA (`advanceStatus`, both the mid-page button
  around line 1056 and the bottom fixed-bar button around line 1181) has
  no explicit `min-h-11` class — `py-3.5`/`py-3` + `text-sm` likely clears
  44px in a real browser (Playwright evidence below), but the class
  contract this repo's own convention checks for (cf.
  `EstimateApprovalPage.layout.test.tsx`) is absent;
- the Note/Photo/Parts/Issue quick-action chip grid (around line 1129) has
  no explicit `min-h-11` either.

Both are pinned in the new test as the CURRENT (non-compliant) state —
asserted honestly, not glossed over — so a future fix to `TechJobView.tsx`
trips those two assertions instead of the gap going unnoticed. `TechnicianDayView.tsx`, by contrast, is fully compliant: every primary
action already uses the shared `secondaryButtonClass`/`primaryButtonClass`
helpers, both of which carry `min-h-11`.

### Playwright viewport spec (new)

**File:** `e2e/technician-day-mobile.spec.ts` (mirrors
`e2e/estimate-approval-mobile.spec.ts`); registered in the
`chromium-devauth` project's `testMatch` in `playwright.config.ts` (same
pattern as `job-scheduling-mobile.spec.ts`).

**Run:**
```
QA_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  npx playwright test technician-day-mobile.spec.ts --project=chromium-devauth --reporter=list
```
**Result: NOT RUN (environment limitation, not a spec defect) — the
orchestrator runs it locally.** All 4 tests failed identically:
```
TimeoutError: page.goto: Timeout 15000ms exceeded.
```
on `page.goto('/technician/day')`. Before concluding this was a defect in
the new spec, the SAME failure was reproduced against an existing,
unrelated, already-merged spec run under the identical project/command:
```
QA_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  npx playwright test job-scheduling-mobile.spec.ts --project=chromium-devauth --reporter=list
...
✘  job scheduling — mobile viewport › the create-job form fits a 320px viewport with ≥44px controls (20.2s)
✘  job scheduling — mobile viewport › the schedule New-appointment job picker fits 320px with 44px controls (#879) (20.2s)
✘  job scheduling — mobile viewport › a job detail page shows the Schedule panel without overflow (20.3s)
    TimeoutError: page.goto: Timeout 15000ms exceeded.
  3 failed
  1 passed (3.1m)
```
Same `page.goto` timeout, same `chromium-devauth` project, a spec that
was not touched by this lane. This isolates the cause to this sandbox's
`chromium-devauth` webServer pair (devAuthApiServerEnv/devAuthWebServerEnv)
rather than anything in `technician-day-mobile.spec.ts` or
`playwright.config.ts`'s new `testMatch` entry — the API side visibly
answered requests correctly in the server logs (`/api/me` → 200,
`/api/dispatch/technician/.../appointments` → 200/304) while the page
navigation itself never reached Playwright's `load` signal within 15s, for
both specs alike. Per the ticket's own contingency ("if browsers cannot
install, mark it NOT RUN with the error and the orchestrator runs it
locally") — browsers installed and ran fine; the dev-auth stack's
navigation is what did not complete in this sandbox. The spec and its
`chromium-devauth` registration are committed as-is; no code was changed
to route around this, since the failure is not attributable to this
lane's spec.

**Not a rung-5 claim:** per research #1004 (recorded on map #995),
`chromium-devauth` forces in-memory repositories and
`TELEPHONY_ENABLED=false`, so a rung-5 reachability claim run on it would
fail "mocked is not proven." This spec is a 320px layout contract only —
the task's own instruction treats the in-memory webServer as acceptable
for that ("the API webServer boots in-memory for a layout check, which is
acceptable for a layout contract"). No rung is claimed for 5.1 here; only
Fable states a new rung.

---

## Row 5.3 — hours logged by voice (grading only)

G1 (#1006): confirmed **4** at T1. No test changes made — grading only,
per SCOPE.

**Command:**
```
grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" packages/api/test/integration/log-time-entry-execution.test.ts
```

**Output:**
```
217:  it('does not expose the entry to another tenant (scoped read)', async () => {
```

Single match, at `test/integration/log-time-entry-execution.test.ts:217`
— the T1 assertion is `timeEntryRepo.findById(other.tenantId, entryId)`
returning `null` for a freshly created second tenant. No T2+ assertion
exists in this file (no second tenant's own log_time_entry proposal is
drafted/approved/executed) — consistent with G1's "confirmed 4 (T1)."

---

## Tenant-grade grep for every touched integration file

```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" \
    packages/api/test/integration/job-photo-round-trip.test.ts \
    packages/api/test/integration/voice-idempotency.test.ts \
    packages/api/test/integration/log-time-entry-execution.test.ts
```
- `job-photo-round-trip.test.ts`: no literal keyword match — the T1 block
  is named `describe('T1 — a neighbour tenant', ...)` with 5 `it`s, each
  calling `createTestTenant(pool)` for a fresh second tenant (`other`) and
  asserting the cross-tenant read/attach is empty/null/404. Grep on the
  ticket's literal keyword list misses this file only because it uses
  "neighbour tenant" (the ticket's own row-5.2 wording) rather than
  "another tenant" — the T1 substance (a second `createTestTenant` call,
  scoped reads that come back empty) is present and passing (see the GREEN
  run above).
- `voice-idempotency.test.ts:141` — `tenant-isolates the key: the same
  value in two tenants → two independent rows`.
- `log-time-entry-execution.test.ts:217` — as above.

---

## Build verification

```
$ cd packages/api && npx tsc --project tsconfig.build.json --noEmit
(clean, no output)

$ cd packages/web && npx tsc --noEmit
(clean, no output)
```

## Not done / judgment calls

1. **5.4 device-level reconnect proof** — hardware-blocked per research
   #1002; not attempted, not faked. Row stays short of a device-level T2+
   proof; the audit-trail gap it also surfaced is a separate, addressable
   finding (above).
2. **5.4 missing audit emission on `POST /api/voice/recordings`** — a real
   product-code gap (`packages/api/src/routes/voice.ts`), found while
   writing the test-only assertion. Not fixed (SCOPE: no product code in
   this lane). Test pins the current (non-compliant) state rather than
   asserting something untrue.
3. **5.1 `TechJobView.tsx` missing `min-h-11` on the main status CTA and
   the quick-action chip grid** — same treatment: found, pinned honestly
   as a known gap, not fixed (product code out of scope).
4. **5.1 Playwright run — NOT RUN.** `page.goto` timed out against the
   `chromium-devauth` webServer pair in this sandbox; reproduced
   identically on an untouched, pre-existing spec
   (`job-scheduling-mobile.spec.ts`), so this is an environment limitation
   here, not a defect in the new spec or config entry (both committed
   as-is). The orchestrator runs it locally per the ticket's own
   contingency.
5. **5.3** — grading only, as scoped; no test changes.
6. **5.5** (Stripe Terminal) — explicitly not this lane's row; left for
   the Opus lane.

No rung is claimed by this report for any row — only Fable states a new
rung, per #995.
