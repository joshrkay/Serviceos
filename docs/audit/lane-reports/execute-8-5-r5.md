# Lane report — §8.5 execute-8-5-r5: rung-5 reachability for rows 5.2 and 5.3

**Ticket:** #1018 (child of wayfinder map #995) · **Branch:** `cloud/execute-8-5-r5` off `origin/main`
**Lane:** Sonnet, test-only (nothing touched under `packages/api/src` or `packages/web/src`)
**Scope:** row 5.2 (photos attached to the job, before/after pairing) and row 5.3 (log hours by
voice), rung-5 reachability only — 5.4/5.1/5.5 out of scope, per #1018's own routing.

Per the ticket: **only Fable states a new rung.** This report states commands, raw output, reached/
not-reached with the exact stop point, tenant grade, and judgment calls — not a rung.

---

## Row 5.2 — "before/after photos attached to the job, before/after pairing survives"

**Spec:** `e2e/journeys/job-photo-attach.spec.ts`
**Surface named by the story:** the technician job screen (`TechJobView.tsx`'s camera sheet).

### Command

```bash
TESTCONTAINERS_RYUK_DISABLED=true npx tsx e2e/fixtures/setup-test-db.ts   # -> export DATABASE_URL=...
CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=<url> E2E_USE_TEST_DB=true \
  VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
  QA_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  npx playwright test e2e/journeys/job-photo-attach.spec.ts --project=chromium --reporter=line --retries=0
```

### Reached / not-reached

**Reached, end to end, real camera capture included:**
- Owner tenant bootstrapped via a signed `user.created` webhook; technician invited, joined via a
  second signed webhook, bound to the browser with a tenant-scoped HMAC session
  (`CLERK_DEV_HMAC_TOKENS`) — same pattern as `accept-invitation.spec.ts`.
- Owner creates a customer, a location, and a job scheduled today and assigned to the technician
  in one `POST /api/jobs` call (schedule-on-create).
- Technician's browser reaches `TechJobView` (`/jobs/:id?view=tech`), opens the real camera sheet
  (`CameraCapture.tsx`), and captures a real photo via Chromium's fake video device
  (`--use-fake-device-for-media-stream`) — a real `getUserMedia` stream, drawn to a real
  `<canvas>`, encoded as a real JPEG data URL.
- The real presign → PUT → attach pipeline runs; the photo appears in the gallery as `Before`.
- `job_photos`, the RV-005 shadow `attachments` row, and exactly the two expected
  `job.photo.upload_requested` / `job.photo.attached` audit events were polled directly from
  Postgres mid-run (before end-of-run truncation).
- The photo survives a full page reload (not just optimistic UI).
- T1: a second tenant's owner, via the real API, gets `200 []` listing tenant A's job's photos and
  `404` attaching tenant A's `fileId` to their own job.

**NOT reached — two genuine stop points, neither faked around:**

1. **The technician's own day view (`GET /api/dispatch/technician/:id/appointments`) 403s for
   every technician session in this harness, unconditionally.** This is a real bug, found while
   writing this spec, not a spec bug:
   - `packages/api/src/app.ts:5269` wires the DB-authoritative authorization loader (which resolves
     `req.auth.canonicalUserId`) only when `pool && !isDevAuthBypassEnabled()`.
   - The `chromium` project's shared webServer config hardcodes `DEV_AUTH_BYPASS: 'true'`
     (`playwright.config.ts`'s `apiWebServerEnv`) — required by the owner-bootstrap-via-webhook
     technique this whole spec family (including `accept-invitation.spec.ts`) depends on. That
     disables the loader for the **entire process**, for every session, regardless of how that
     session authenticated.
   - `verifyClerkSession`'s `CLERK_DEV_HMAC_TOKENS` decode path (`auth/clerk.ts:459-464`) never
     sets `canonicalUserId` itself — only `dev-auth-bypass.ts`'s owner-only `ensureDevOwnerUser`
     path does.
   - So an invited technician's HMAC session — the **only** hermetic technique this codebase's own
     specs use to authenticate a non-owner tenant member against real Postgres — can never have
     `canonicalUserId` populated here, and `dispatch/routes.ts:217-225`'s SEC-22 IDOR guard
     (`technicianId !== req.auth!.canonicalUserId`) always 403s as a result.
   - Confirmed directly: `GET /api/dispatch/technician/<the technician's own real id>/appointments`
     → `403 {"error":"FORBIDDEN","message":"Technicians may only view their own appointments"}`.
   - **This blocks every story whose surface is "the technician's own day view," not just this
     row** — worth its own ticket. Pinned as a passing characterization assertion in the spec
     (mirrors the "SECURITY GAP FOUND, NOT FIXED" pattern in
     `telephony-e1-signed-webhook.spec.ts:371-403`), with a screenshot
     (`5.2-day-view-403-bug.png`). The lane worked around it by navigating directly to
     `/jobs/:id?view=tech` (the URL the day-view card would itself produce) with the same real
     technician session — `GET /api/jobs/:id` has no `canonicalUserId` gate, only `jobs:view` +
     tenant scoping — so the capability under test (photo attach) was still reached with a fully
     real technician session; only the in-app *discovery* step was skipped.

2. **"Before/after pairing" is not reachable through the named surface at all.**
   `TechJobView.tsx:922` hardcodes every still photo captured through this screen's camera sheet
   to category `'before'`:
   ```ts
   const category: JobPhotoCategory = m.type === 'video' ? 'other' : 'before';
   ```
   The only component with an upload-time category selector is `JobPhotoUploader.tsx`
   (`data-testid="job-photo-category-select"`), which is **not wired into `TechJobView`** — it is
   mounted solely on the disconnected `/jobs/:id/photos` page
   (`packages/web/src/pages/jobs/JobPhotos.tsx`), whose own header comment says the integration
   into the canonical job detail "is intentionally deferred per the story's constraint." Nothing on
   the technician job screen links to it. The spec asserts this negative directly
   (`job-photo-category-select` has zero matches on `TechJobView`) rather than reaching for that
   other page and mislabeling it "the technician job screen."

**A third, smaller finding (not a stop point):** the hermetic storage provider in this harness
(`DevStorageProvider`) accepts the presigned PUT with a 2xx but discards the bytes — the DB rows
and the presign/attach contract are proven for real; the round-tripped image bytes are not (visible
in the screenshots as a broken-image icon with alt text `"before photo"`).

### Tenant grade

T1. G4 grep:
```
517:    const otherTenantId = otherMe.tenant_id!;
518:    expect(otherTenantId).not.toBe(tenantId);
```
(plus the cross-tenant list/attach assertions at lines ~505-536). No per-tenant *configuration*
divergence is exercised by this capability, so T2/T3 don't apply here.

### Polled rows (mid-run, real Postgres)

- `job_photos`: 1 row, `category='before'`, correct `tenant_id`/`job_id`.
- `attachments` (RV-005 shadow): 1 row, `kind='photo'`, `category='before'`.
- `audit_events`: exactly `job.photo.upload_requested` and `job.photo.attached`, no more.

### Screenshots

`docs/audit/lane-reports/execute-8-5-r5/`:
- `5.2-day-view-403-bug.png` — the day view's "Failed to load appointments" state (the bug above).
- `5.2-camera-sheet-before-done.png` — the real camera sheet after a fake-device capture, before
  tapping Done.
- `5.2-after-upload.png` — the technician screen showing the persisted photo, `Before` chip
  selected, category filter row visible (confirming those chips are filters, not an upload-time
  picker).
- `5.2-after-reload.png` — the same, after a full page reload.

### TDD

RED (planted `expect(photoRow.rows[0].category).toBe('after')` against the real captured photo):
```
Error: expect(received).toBe(expected) // Object.is equality
Expected: "after"
Received: "before"
```
GREEN: reverted to `.toBe('before')` — `1 passed (1.1m)`.

### Judgment calls

- `scheduledStart` is computed as `now + 5 minutes` rather than a fixed tenant-local hour, to land
  inside "today" in the tenant's `America/Chicago` timezone without a timezone library; this is
  wrong only within ~5 minutes of local midnight (accepted risk, noted in the spec).
- Wrote a local `blockHostsOutsideAppAndApi` instead of importing the shared
  `e2e/helpers/api-mocks/shell`'s `blockExternalHosts`: that helper only allows the web app's own
  origin, which silently aborts the photo upload's PUT (the dev storage provider's presigned URL is
  on the API's own origin/port, not the web app's) — found empirically when the presign call
  succeeded but no PUT ever reached the server log. Kept local to this spec rather than editing the
  shared helper (used by many other specs) for a two-row test-only lane.
- Continued past the day-view 403 via direct URL navigation rather than stopping the whole row at
  that point, since the capability under test (photo attach) is not what's broken — judged this as
  the more useful signal than a shorter, less complete run.
- xhawk-ai review (round 1) found `canRun` didn't require `DATABASE_URL` itself — fixed. Codex
  review (round 2) found `canRun` didn't require `CLERK_DEV_HMAC_TOKENS=true` either: without it,
  the technician's HMAC-signed bearer token is neither valid RS256 nor decoded by the HMAC dev
  path, so `DEV_AUTH_BYPASS`'s unsigned-JWT fallback (which never checks signatures) blindly
  decodes the token's payload and auto-bootstraps the technician sub as the owner of a brand-new,
  unrelated tenant — a confusing wrong-tenant failure instead of a clean skip. Fixed; re-ran
  against real Postgres afterward — still `1 passed`.

---

## Row 5.3 — "log my hours by talking"

**Spec:** `e2e/journeys/log-time-by-voice.spec.ts`
**Surface named by the story:** the phone, per the hermetic phone-surface definition from research
#1004 (self-signed Twilio-shaped webhook, tenant's own auth token, real `/api/telephony/*` routes).

### Command

```bash
DATABASE_URL=postgres://test:test@localhost:<port>/serviceos_e2e_test \
E2E_USE_TEST_DB=true \
TWILIO_ACCOUNT_SID=AC00000000000000000000000000000001 TWILIO_AUTH_TOKEN=<any> \
TWILIO_FROM_NUMBER=+15125550000 TWILIO_DEFAULT_TENANT_ID=<uuid> \
TENANT_ENCRYPTION_KEY=<64 hex chars> PUBLIC_API_URL=http://localhost:3000 \
TWILIO_MEDIA_STREAMS_ENABLED=false \
npx playwright test --project=chromium e2e/journeys/log-time-by-voice.spec.ts --reporter=line --retries=0
```

(`E2E_USE_TEST_DB=true` and `TWILIO_MEDIA_STREAMS_ENABLED=false` were added after a second Codex
review round found the run guard didn't require the disposable-DB flag, and that the Gather-path
gate missed `resolveMediaStreamsEnabled`'s ElevenLabs/Deepgram auto-enable branch — see "Judgment
calls" below.)

### Reached / not-reached

**Reached:**
- Tenant A provisioned exactly as a real Twilio onboarding leaves it (owner, `tenant_settings`,
  one `tenant_integrations` row with the DID + encrypted auth token) plus a technician `users` row
  whose `mobile_number` is the caller's number.
- A signed `POST /api/telephony/voice` from that number reaches the real route, resolves the caller
  to the technician via `resolvePhoneActor` (confirmed in the server log: `"phone actor resolved at
  session establishment", "via":"mobile"`), and creates a real `voice_sessions` row under the
  correct tenant.
- A signed `POST /api/telephony/gather` with `SpeechResult: "log two hours on the Garcia job"`
  reaches the real classifier pipeline (`classifyIntent`) and returns `200` with a re-prompting
  `<Gather>` (the call stays open, doesn't error).
- T1: tenant B's technician calling tenant B's DID with the identical utterance creates its own,
  separately-tenant-scoped `voice_sessions` row; tenant A's state (audit row count, job-profit
  labor minutes) is provably unchanged by B's call.

**NOT reached — exact seam, found while writing this spec, and it is a real capability gap, not a
harness artifact:**

`classifyIntentRaw` (`packages/api/src/ai/orchestration/intent-classifier.ts`) short-circuits
before any LLM call for a fixed, enumerated set of phrasings (`lookup_estimates`,
`lookup_job_profit`, `create_appointment`, `issue_invoice`, `update_job`, `add_crew_member`,
`apply_late_fee`, …). **`log_time_entry` has no such matcher anywhere in that file.** So the
utterance falls through to the real LLM call at `intent-classifier.ts:2772`
(`gateway.complete({ taskType: 'classify_intent', ... })`).

`createLLMGateway` (`ai/gateway/factory.ts:100-108`) throws without `AI_PROVIDER_API_KEY`; the app
avoids that crash at boot (`app.ts:1257-1258`) by falling back to `createHermeticMockLLMGateway()`
whenever the key is unset — the same no-key posture a normally-provisioned CI/local run has, not
something this spec injects. That gateway's `scriptHermeticResponse()` for `classify_intent`
(`ai/providers/mock.ts:160-196`) only scripts `create_customer`, `draft_estimate`, and
`create_invoice`; everything else — `log_time_entry` included — falls through to
`{"intentType":"unknown","confidence":0.2}`, far below `TAU_INT` (0.75).

`handleGather` (`telephony/twilio-adapter.ts:2392-2417`): confidence below `TAU_INT` or
`intentType === 'unknown'` never reaches a task handler at all — the FSM takes the
low-intent-confidence repair path instead. No `log_time_entry` proposal is drafted;
`LogTimeEntryTaskHandler` / `LogTimeEntryExecutionHandler` never run; no `time_entries` row is
written; no matching audit event fires.

Getting past this needs **either** a live `AI_PROVIDER_API_KEY` (a credential this hermetic run
legitimately does not have — blocked-on-Josh territory, #1000) **or** a deterministic matcher added
to `classifyIntentRaw`/the hermetic mock — a `packages/api/src` change this test-only lane is
explicitly forbidden from making. So: this spec proves everything hermetically reachable up to that
seam, then pins the stop — no proposal, no `time_entries` row, no audit event, and the job-profit
query for the named job is unchanged. Per the lane's own rule ("if it yields a proposal that needs
approval, approve it") — it never yields one, so that step is documented as unreached, not skipped
silently.

### Tenant grade

T1. G4 grep:
```
265:  let tenantB: TenantFixture;
349:    tenantB = await provisionTenant({
370:    expect(sessionRow.rows[0].tenant_id).toBe(tenantB.tenantId);
389:    const bRows = await timeEntryRows(tenantB.tenantId, tenantB.jobId);
391:    const bAudit = await timeEntryAuditRows(tenantB.tenantId);
```
No per-tenant configuration divergence exercised (both tenants configured identically), so T3
doesn't apply to this row's stopped-short capability.

### Polled rows (mid-run, real Postgres)

- `voice_sessions`: one row per call, correctly tenant-scoped.
- `time_entries`: 0 rows for the named job, both tenants (the honest stop).
- `proposals` (`proposal_type = 'log_time_entry'`): 0 rows.
- `audit_events` (`event_type LIKE 'time_entry.%'`): 0 rows, both tenants, before and after B's
  call.
- `getJobProfit` (`packages/api/src/jobs/job-profit.ts`) for tenant A's job: `laborMinutes` = 0,
  unchanged across B's call.

### TDD

RED (planted `expect(after.rows).toHaveLength(1)` — the naive expectation that the utterance
became a real time entry):
```
Error: expect(received).toHaveLength(expected)
Expected length: 1
Received length: 0
Received array:  []
```
GREEN: reverted to the honest `.toHaveLength(0)` — `3 passed (1.1m)`.

### Judgment calls

- Fixed `A_SUBACCOUNT`/`B_SUBACCOUNT` constants (mirrored from
  `telephony-e1-signed-webhook.spec.ts`'s literal SIDs) caused a spurious 403 on a rerun against the
  same kept-alive testcontainer: `resolveTwilioAuthTokenForSubaccount` resolves the signing
  credential by `AccountSid` alone, no `ORDER BY`, so a second run's row could be picked over the
  first's with a mismatched decrypted token. Fixed by deriving both the SID and the auth token from
  a fresh `crypto.randomBytes` value per process. Documented inline as a lesson for the next
  spec that copies this provisioning pattern.
- No browser used — matches `telephony-e1-signed-webhook.spec.ts`'s own reasoning: the caller here
  is Twilio, not a person at a screen.
- Codex review (round 1) found three run-guard gaps, all fixed: `dbReady` didn't require
  `E2E_USE_TEST_DB=true` (a persistent DATABASE_URL would get real, uncleaned rows — this is what
  actually activates `global-teardown.ts`'s BYO truncate path, confirmed in the re-run log);
  nothing guarded against `AI_PROVIDER_API_KEY` being set (would silently hit a live, paid LLM);
  nothing guarded against `TWILIO_MEDIA_STREAMS_ENABLED=true` (breaks `sessionIdFromTwiml`'s
  parsing). Codex review (round 2), after those fixes, found the first two guards were still
  incomplete: the live-LLM-key check only inspected this Playwright process's own env, missing a
  key set in `packages/api/.env` (the API webServer boots via `node --env-file-if-exists=.env`,
  a separate source) — fixed by reading that file directly and failing closed if present; and the
  Media Streams check only tested `!== 'true'`, missing `resolveMediaStreamsEnabled`'s unset/auto
  branch (auto-enables when the full ElevenLabs/Deepgram stack is configured) — fixed by importing
  and calling the real resolver instead of re-deriving its logic. Re-ran against real Postgres
  after each round — still `3 passed`.

---

## Not done / out of scope

- Row 5.1 (glove/daylight contract), 5.4 (device reconnect), 5.5 (Stripe Terminal) — not this
  lane's rows per #1018's routing (5.5 is a separate Opus money lane).
- The day-view `canonicalUserId` bug (row 5.2 finding #1) is not fixed — test-only lane, and the
  fix (either wiring the authorization loader independently of `DEV_AUTH_BYPASS`, or a different
  hermetic technician-auth technique) is a product/harness decision, not this lane's to make.
- The `log_time_entry` classifier gap (row 5.3) is not fixed — needs either a real
  `AI_PROVIDER_API_KEY` (credential, #1000) or a `packages/api/src` change (out of scope).
- Did not attempt row 5.2's 'after' photo via the disconnected `/jobs/:id/photos` page — that page
  is real and reachable by a technician session, but is not "the technician job screen" the story
  names, so exercising it would not have been an honest rung-5 claim for this row.

## Build verification

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```
Clean (no output, exit 0). No files under `packages/api/src` or `packages/web/src` were touched by
this lane.
