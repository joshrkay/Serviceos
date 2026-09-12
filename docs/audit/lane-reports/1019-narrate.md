# §8.6 Narrate — lane report (#1019, child of map #995)

Lane: `cloud/narrate-8-6`. Scope: Sonnet-class, TEST-ONLY rows of #1019 (6.9, 6.2, 6.4,
6.3/6.5/6.6/6.7, 6.1). No product code touched (`packages/api/src`, `packages/web/src`
unchanged). No claims of a new rung — that is Fable's call per #1019's own rules; this
report states what moved (evidence class, T-grade) and hands the numbers up.

Base: `origin/main` at `a306aa7` (includes PR #1029, #1035, and the #1038 merge). Input:
the G1 grades from ticket #1006 comments on #1019, quoted per-row below.

---

## Row 1 — 6.9 materials by voice (G1: 4− → audit event added)

**File:** `packages/api/test/integration/material-items.test.ts`
**G1 finding:** "25/25 real-DB write at T1, no audit event → add it → 4."

**What was added:** a new test driving the REAL voice-drafted payload
("three-quarter copper, twenty feet" → `materialDescription: '3/4" copper pipe, sold by
the foot'`, `materialQuantity: 20`) through `AddMaterialTaskHandler` → the real approval
gate (`approveProposal`) → the production execution registry
(`createExecutionHandlerRegistry` + `ProposalExecutor`), then reads the audit event back
through `PgAuditRepository.findByEntity` — the read path G1 flagged as missing. Asserts
both the NUMBER (`quantity = 20`, a real integer column, `typeof === 'number'`) and the
UNIT ("foot"/"3/4", carried in `description` since `material_items` has no separate unit
column) survive the round trip.

**Command:**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/material-items.test.ts
```

**RED** (deliberately wrong expectations: `quantity` expected `999`, audit events expected
`0`):
```
 × ... persists quantity and the spoken unit, and emits a readable material.requested audit event
   → expected 20 to be 999 // Object.is equality
AssertionError: expected 20 to be 999 // Object.is equality
 Tests  1 failed | 25 passed (26)
```

**GREEN:**
```
 ✓ ... add_material end-to-end: task -> approve -> execute -> material_items + audit (#1019 6.9) > persists quantity and the spoken unit, and emits a readable material.requested audit event 47ms
 Test Files  1 passed (1)
      Tests  26 passed (26)
```

**Evidence class:** real Postgres write (`material_items`) + real Postgres audit
read-back through `PgAuditRepository.findByEntity` — T1 held (this row was not asked to
move tenant-grade, only to close the audit gap).

**Tenant-grade grep** (`grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants"`):
```
382:  it('does not mark another tenant\'s item purchased (repo-level tenant check, cross-tenant-null)', ...
385:      description: 'cross-tenant guard',
512:    it('cannot INSERT a material_items row attributed to another tenant (WITH CHECK)', ...
```
(pre-existing T1 guards; unchanged by this row)

---

## Row 2 — 6.2 voice → typed validated proposal (G1: 3 → T0, since raised)

**File:** `packages/api/test/integration/voice-inbound-appointment.test.ts`
**G1 finding:** "`voice-inbound-appointment` was T0; PR #1043 (#1014) has since added a T2
test to that file."

**Pre-flight check (per the lane brief):** confirmed on `origin/main` that PR #1043's test
("books the spoken sentence end to end: free text → PgEntityResolver → REAL drafting task
→ approve → production execution registry") is present and already proves: transcript →
real router → real resolver → real task handler → approve → real execution → persisted
appointment + audit row + a second-tenant negative. What it did NOT prove: (a) that the
drafted payload actually **passes its Zod contract** (`createAppointmentPayloadSchema`),
and (b) that a **malformed utterance is refused** — no malformed proposal row.

**What was added:**
1. One assertion in the existing golden-path test: `createAppointmentPayloadSchema.safeParse(payload).success === true` on the drafted `create_appointment` payload — the P2-002 AI-safety-gate schema itself, not a hand-rolled shape check.
2. A new test driving a **low-confidence** classification (`confidence: 0.3`, below `CLASSIFIER_CONFIDENCE_THRESHOLD = 0.6` in `intent-classifier.ts`) through the real router via `PgProposalRepository` (real Postgres, not `InMemoryProposalRepository`): asserts the `proposals` table carries exactly one row for that tenant and it is `voice_clarification`, never `create_appointment`; that the clarification itself passes `validateProposalPayload('voice_clarification', ...)`; that no audit event was written (nothing executed); and that a second tenant's own mumble gets its own independent clarification.

**Command:**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/voice-inbound-appointment.test.ts
```

**RED** (contract check flipped to expect failure; clarification proposalType flipped to
expect `create_appointment`):
```
 × ... books the spoken sentence end to end ...
   → expected true to be false // Object.is equality
 × ... refuses a low-confidence ("malformed") utterance: ...
   → expected 'voice_clarification' to be 'create_appointment' // Object.is equality
 Tests  2 failed | 2 passed (4)
```

**GREEN:**
```
 ✓ routes a dialed number to its tenant via the real phoneE164 column
 ✓ persists the spoken reason to appointments.notes only after approval + execution
 ✓ books the spoken sentence end to end: free text → PgEntityResolver → REAL drafting task → approve → production execution registry
 ✓ refuses a low-confidence ("malformed") utterance: no create_appointment row, only a contract-validated voice_clarification, isolated per tenant
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

**Evidence class:** real Postgres for both legs — the golden path (appointment + audit
row) and the new negative path (`PgProposalRepository`, real `proposals` table SELECT,
real `audit_events` SELECT showing zero rows).

**Tenant-grade grep:**
```
549:    const otherTenant = await createTestTenant(pool);
625:    expect(await pgProposalRepo.findByTenant(otherTenant.tenantId)).toHaveLength(0);
629-635: (second tenant's own mumble, asserted independent)
```
Grade: **T2 confirmed still holds** (PR #1043's test) + the new negative test adds its own
independent two-tenant assertion. Not claiming a rung — only reporting the row now has
both halves of "a mumble can't become a malformed invoice" pinned at real Postgres.

---

## Row 3 — 6.4 ask where a job stands → an answer, not a proposal (G1: 4 at T1)

**File:** `packages/api/test/integration/update-job-execution.test.ts`
**G1 finding:** T1, same reachability gap as 6.2's original state. Ticket ask: confirm the
READ path (`lookup_jobs`) writes NO proposal and NO mutation at real Postgres, **keep
T1**, report the grep.

**Judgment call:** the ticket's map table cites this file for 6.4, but the file contains
zero references to `lookup_jobs`/lookup/read-only material before this change — it is
entirely about the `update_job` WRITE leg. The read story ("ask where a job stands") lives
in `ai/skills/lookup-jobs.ts` (doc comment: *"Read-only, bypasses the proposals
pipeline"*), which had a unit test (`test/ai/skills/lookup-jobs.test.ts`, mocked repo) but
no real-Postgres proof and no negative assertion on the `proposals` table. Added a new
describe block to `update-job-execution.test.ts` (the file the map names) so the WRITE and
READ legs for the same "Garcia job" story sit side by side.

**What was added (first pass):** seed a real job; call `lookupJobs()` directly against a
real `PgJobRepository`; assert the answer is `found` with the real status; assert
`SELECT count(*) FROM proposals WHERE tenant_id = $1` is `0` both BEFORE and AFTER the
call; assert the job row (`status`, `updated_at`) is byte-for-byte unchanged after.

**Review finding addressed (xhawk-ai bot, PR #1048, Medium/Testing,
`update-job-execution.test.ts:886-889`):** *"This calls `lookupJobs()` directly, so the
test cannot catch the production regression it claims to guard:
`voice-action-router` could route a `lookup_jobs` utterance into `proposalRepo` before
or instead of `executeLookupAnswer`, and this test would still pass because the raw skill
has no proposal repository dependency to write through."* Verified as real: the router's
`isLookupIntent(...)` branch (`voice-action-router.ts`) is exactly the routing decision the
direct-call test cannot see. **Fix pushed:** a second test drives the REAL
`createVoiceActionRouterWorker` with a scripted `lookup_jobs` classification and a REAL
`PgProposalRepository`, plus a real `voice_recordings` row so "the worker returns an
answer" is a real column read-back (mirroring `voice-lookup-answer.test.ts`'s two-phase
contract) rather than an inferred side effect. Building this test surfaced an
undocumented-to-me wiring requirement — the E-lane answer surface only activates when
`deps.lookupAnswers` (a separate `VoiceLookupAnswerDeps` bag) is truthy; omitting it makes
the router silently `'skipped'` instead of answering, which is itself the reason the fix's
own RED run below is informative (it caught a *test wiring* gap, not a production one,
before the assertions were even meaningful).

**Command:**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/update-job-execution.test.ts
```

**RED, first pass** (proposal count after flipped to expect `1`):
```
 × ... answers "where does the Garcia job stand?" with no proposal row and no mutation to the job
   → expected +0 to be 1 // Object.is equality
 Tests  1 failed | 11 passed (12)
```

**RED, router-driven test — attempt 1** (`lookupAnswers` omitted; caught before the
deliberate-wrongness even mattered):
```
 × ... the REAL router routes a "how is the Garcia job" transcript to the answer path — the proposals table never moves
   → expected 'skipped' to be 'pending' // Object.is equality
```

**RED, router-driven test — attempt 2** (`lookupAnswers: {}` added; `answerStatus`
deliberately flipped to `'pending'`, proposal count after deliberately flipped to `1`):
```
 × ... the REAL router routes a "how is the Garcia job" transcript to the answer path — the proposals table never moves
   → expected 'answered' to be 'pending' // Object.is equality
 Tests  1 failed | 12 passed (13)
```

**GREEN (final, both tests):**
```
 ✓ ... answers "where does the Garcia job stand?" with no proposal row and no mutation to the job
 ✓ ... the REAL router routes a "how is the Garcia job" transcript to the answer path — the proposals table never moves
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

**Evidence class:** real Postgres negative assertion on the direct-skill-call test, PLUS a
real-router-level negative assertion (real `PgProposalRepository`, real `voice_recordings`
answer read-back) that also proves the routing decision, not just the skill's own
dependency shape. T1 held per the ticket's instruction (not asked to raise tenant grade on
this row).

**Tenant-grade grep:**
```
11: * completion effects, the job.updated audit event, and the cross-tenant
234:  it('does not expose the job to another tenant (scoped read) and a cross-tenant jobId fails cleanly', ...
248:        summary: 'cross-tenant attempt',
258:    // The row is untouched — no cross-tenant write leaked through.
765:  it('cross-tenant: the same sentence resolves to nothing for another tenant, and a borrowed jobId stays GATED', ...
```
(pre-existing on the WRITE leg; neither READ-leg test has a cross-tenant assertion of its
own — consistent with "keep T1", not raise it)

---

## Row 4 — 6.3, 6.5, 6.6, 6.7 (confirmed 4 at T1)

### 6.3 — lift to T2: neighbour's "Henderson" job is never a candidate

**File:** `packages/api/test/integration/entity-resolution.test.ts`

**What was added:** the existing `kind: job` block already proved cross-tenant isolation
against a **stranger** tenant with no matching data (`never resolves a job by customer
name across tenants`) — which cannot catch a query that forgot a `tenant_id` filter on one
leg of the customer → job traversal and silently UNIONed a neighbour's row in. Added a test
where BOTH tenant A and a neighbour genuinely have a "Henderson" job: tenant A must resolve
to its own (never the neighbour's), and — forcing tenant A's own reference into
`'ambiguous'` via a second same-surname customer inside tenant A — the neighbour's job must
never ride along in the candidate list either.

**Command:**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/entity-resolution.test.ts
```

**RED** (resolved-candidate assertion flipped to expect the neighbour's id):
```
 × ... a neighbour tenant's "Henderson" job is never a resolution candidate for tenant A (#1019 6.3)
AssertionError: expected 'e9825e25-...' to be '02b7c74d-...' // Object.is equality
 Tests  1 failed | 94 skipped (95)
```

**GREEN:**
```
 Test Files  1 passed (1)
      Tests  95 passed (95)
```

**Evidence class:** real Postgres, two independently-seeded tenants sharing a surname, in
one run, both the `resolved` fast path and the forced `ambiguous` picker path.
**T-grade: T1 → T2.**

### 6.7 — lift to T3: two tenants hear their own numbers, in one run

**File:** `packages/api/test/integration/voice-lookup-answer.test.ts`

**What was added:** every existing test in this file round-trips a hand-built
`VoiceLookupAnswer` literal — real for the JSONB column, never a real COMPUTED number.
Added a suite that seeds two tenants with genuinely different outstanding invoice balances
($45.00 and $9,999.00), drives `executeLookupAnswer` (the production entry point the router
calls) for `lookup_balance` against real Postgres for BOTH tenants in one run, asserts each
answer carries only its own figure (and that the two are provably different — not merely
"each has some number"), then persists and re-reads each through the same two-phase
`recordAnswer` contract this file already pins.

**Command:**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/voice-lookup-answer.test.ts
```

**RED** (tenant A's expected figure flipped to tenant B's):
```
 × ... two tenants with different balances each hear their own figure, in one run
AssertionError: expected 4500 to be 99900 // Object.is equality
 Tests  1 failed | 6 passed (7)
```

**GREEN:**
```
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

**Evidence class:** real Postgres invoices for two tenants, computed (not hand-built)
figures, one run, plus the real JSONB persistence round-trip. **T-grade: T1 → T3.**

### 6.5 / 6.6 — report only, no code change (cheap-lift check found nothing cheap)

Per the ticket: report the grep counts and file:line; do not add code unless cheap. Both
already carry cross-tenant coverage; lifting either past T1 would need new fixtures
(a second differently-configured tenant exercised in the SAME run, matching 6.7's shape)
which is not a "where cheap" change — left as `docs/audit/blocked-on-josh.md`-free, simply
not attempted, and named below under "not done."

**`update-estimate-execution.test.ts`** (6.5):
```
42: *      another tenant, and the estimate is not readable/editable by another
389:  it('cross-tenant negative: the spoken reference does not resolve from another tenant, and the estimate is not readable or editable there', ...
399:    // The SAME sentence, spoken inside another tenant, resolves nothing —
415:    // The execution handler itself refuses a cross-tenant target: scoping
440:        summary: 'cross-tenant attempt',
```
5 matches, T1 (single stranger-tenant negative; no second CONFIGURED tenant in one run).

**`add-note-voice-execution.test.ts`** (6.6):
```
179:  it('does not expose the note to another tenant (scoped read)', ...
```
1 match, T1.

**`log-expense-job-link.test.ts`** (6.6):
```
(no matches)
```
0 matches — T0 on the tenant axis; this file has no cross-tenant assertion at all today.

---

## Row 5 — 6.1 push-to-talk on every screen

**G1 finding:** 6.1a — 3 (jsdom, `VoiceBar.hint.test.tsx`, unchanged this lane). 6.1b — 2,
**zero tests** for `useVoiceSession` / `VoiceSessionPanel`.

**Files added:**
- `packages/web/src/hooks/useVoiceSession.test.ts`
- `packages/web/src/components/assistant/VoiceSessionPanel.test.tsx`

**`useVoiceSession.test.ts`** covers: `start()` posts `/api/voice/sessions` and applies
`sessionId`/`state`/`greetingText`; `send()` is a no-op with no active session (never posts
`/input`); `send()` posts input and applies the returned `state`/`ttsText`/`proposalIds`;
`end()` resets full session-scoped state (`sessionId`, `state`, `proposalIds`,
`lastTtsText`) so a fresh `start()` is possible; the SSE line handler dedupes a redelivered
`proposal_created` event and applies an `'ended'` event. Fetch is stubbed directly
(matching the `useDispatchBoardStream.test.tsx` pattern for the SSE leg); the Clerk mock
comes from the repo's global `test-setup.ts`.

**Command:**
```
cd packages/web && npx vitest run --reporter=verbose src/hooks/useVoiceSession.test.ts
```

**RED** (4 assertions deliberately flipped — `sessionId`, `send()`'s applied
`proposalIds`, the SSE dedup result, and the SSE `ended` event):
```
 × start() posts /api/voice/sessions and applies the session id, state, and greeting
   → expected 'sess-1' to be 'WRONG' // Object.is equality
 × send() posts input and applies the returned state, TTS text, and proposal ids
   → expected [ 'prop-1' ] to deeply equal [ 'WRONG' ]
 × a redelivered proposal_created SSE event is deduped, not appended twice
   → expected [ 'prop-dup', 'prop-2' ] to deeply equal [ 'prop-dup', 'prop-dup', 'prop-2' ]
 × an SSE "ended" event marks the session ended
   → expected true to be false // Object.is equality
 Tests  4 failed | 2 passed (6)
```

**GREEN:**
```
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

**`VoiceSessionPanel.test.tsx`** mocks `useVoiceSession` (isolating rendering/interaction
from the hook, now covered separately above) and covers: the pre-session "Start session"
affordance and its `isStarting` disabled state; the state badge + agent's last TTS text
once a session exists; typed-and-submitted text calling `send()` with the exact draft and
clearing the input; a whitespace-only draft never enabling Send; `End` calling `end()`; the
`ended` state disabling input/Send/End and swapping the placeholder; the queued-proposal
count rendering only once at least one exists.

**Command:**
```
cd packages/web && npx vitest run --reporter=verbose src/components/assistant/VoiceSessionPanel.test.tsx
```

**RED** (4 assertions deliberately flipped — `start()` call count, `send()`'s argument,
`end()` call count, the proposal count text):
```
 × shows only "Start session" before a session exists, and calls start() on click
   → expected "vi.fn()" to be called 2 times, but got 1 times
 × typing and submitting calls send() with the drafted text and clears the input
   → expected "vi.fn()" to be called with arguments: [ 'WRONG TEXT' ] (received 'book Thursday at 10')
 × clicking End calls end()
   → expected "vi.fn()" to be called 2 times, but got 1 times
 × shows the queued-proposal count only when at least one exists
   → Unable to find an element with the text: Proposals queued: 3
 Tests  4 failed | 4 passed (8)
```

**GREEN:**
```
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

**`coverage-sweep` check (report only — no new Playwright sweep written, per scope):**
read `e2e/coverage-sweep.spec.ts` and `e2e/helpers/coverage-sweep-routes.ts` in full.
`coverage-sweep` is a generic walk of every authenticated route asserting (a) the route
loads to network-idle without a page/console error, (b) every primary button has SOME
wired effect (navigation, HTTP call, or new DOM), and (c) no page-initiated fetch/XHR
returns an unexpected 4xx/5xx. **It contains zero references to a voice/recorder control
anywhere** (`grep -rn "VoiceBar|voice-bar|data-testid=\"voice" e2e/` → no matches). It does
NOT assert that a push-to-talk / recorder control is present, mounted, or reachable on any
route, let alone every authenticated one. The 6.1 rung-5 claim cannot be supported by this
project as it stands — a real reachability proof for 6.1a/6.1b would need a NEW assertion
(not sweep) checking the recorder control renders on a representative sample of
authenticated routes, which is out of this lane's TEST-ONLY-row scope and not written here.

---

## Evidence run (artifact-before-sign-off)

Kept container: `docker run -d --rm -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=serviceos_test -p 127.0.0.1:0:5432 pgvector/pgvector:pg16 -c max_connections=300`
(mapped to host port 32768 for this run).

Final green run of every touched integration file against that kept container:
```
EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32768/serviceos_test \
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose \
  test/integration/material-items.test.ts \
  test/integration/voice-inbound-appointment.test.ts \
  test/integration/update-job-execution.test.ts \
  test/integration/entity-resolution.test.ts \
  test/integration/voice-lookup-answer.test.ts

 Test Files  5 passed (5)
      Tests  144 passed (144)
```

### `audit_events` — grouped by tenant/event_type/entity_type

```
   left   |        event_type         |  entity_type  | count
----------+---------------------------+---------------+-------
 a953288c | appointment.created       | appointment   |     1
 cbde9d2d | appointment.created       | appointment   |     1
 554145a4 | invoice.auto_drafted      | proposal      |     1
 cbde9d2d | job.created               | job           |     1
 24468dd8 | job.status_changed        | job           |     3
 554145a4 | job.status_changed        | job           |     3
 7b16e707 | job.status_changed        | job           |     6
 24468dd8 | job.updated               | job           |     3
 554145a4 | job.updated               | job           |     1
 7b16e707 | job.updated               | job           |     1
 e524f623 | material.requested        | material_item |     1
 7b16e707 | proposal.approved         | proposal      |     2
 e524f623 | proposal.approved         | proposal      |     1
 24468dd8 | proposal.executed         | proposal      |     3
 554145a4 | proposal.executed         | proposal      |     1
 7b16e707 | proposal.executed         | proposal      |     1
 a953288c | proposal.executed         | proposal      |     1
 cbde9d2d | proposal.executed         | proposal      |     1
 e524f623 | proposal.executed         | proposal      |     1
 7b16e707 | proposal.execution_failed | proposal      |     1
(20 rows)
```
`e524f623` is the 6.9 test's tenant — its `material.requested` row is the audit event that
row proves.

### `material_items` — the 6.9 row, tenant id visible

```
                  id                  |              tenant_id               |               description               | quantity |  status
--------------------------------------+--------------------------------------+------------------------------------------+----------+-----------
 ... (36 fixture rows from material-items.test.ts's other suites) ...
 9277dcfb-fd22-475e-ba90-c1cc59b6285a | e524f623-fc6c-4806-b9d6-8addb3c8ef9f | 3/4" copper pipe, sold by the foot      |       20 | pending
(37 rows)
```
`quantity = 20` (the number) and `description` carries `foot`/`3/4` (the unit) — exactly
the "three-quarter copper, twenty feet" utterance, round-tripped through real Postgres.

### `proposals` — the 6.9/6.2/6.4/6.3 rows, tenant ids visible

```
                  id                  |              tenant_id               |    proposal_type    |      status
--------------------------------------+--------------------------------------+----------------------+------------------
 24a0f440-01f3-405f-b364-1044bb400b69 | 7b16e707-605b-4baa-b0f4-dc8f827bd394 | update_job          | executed
 97686904-0a9f-47c2-b1b0-5dd956c86361 | 7b16e707-605b-4baa-b0f4-dc8f827bd394 | update_job          | execution_failed
 6f376601-8051-4430-bbb2-664dac96f904 | 68b791ff-6f49-421a-9f6e-93818ec513e0 | update_job          | draft
 b0b6c482-6c1a-4110-b6d8-2cf2b6794e75 | e524f623-fc6c-4806-b9d6-8addb3c8ef9f | add_material        | executed
 d16a52f7-2522-4d29-9ef5-b5fa455d06d2 | d6cf51c1-d757-4929-94eb-ff03e271caf0 | voice_clarification | draft
 e127320d-e538-44a2-a258-75cd3e95d085 | 5e960772-22ee-48b8-979d-e9a145212712 | voice_clarification | draft
(6 rows)
```
The two `voice_clarification` rows (tenants `d6cf51c1…` and `5e960772…`) are the 6.2
malformed-utterance test's two tenants — note there is **no `create_appointment` row for
either tenant** in this table: the low-confidence utterance never became a malformed
proposal. `add_material` `executed` for `e524f623…` is the 6.9 row's proposal. The 6.4
lookup-only tenant deliberately does not appear in this table at all — that absence IS the
row's proof (no proposal row for the read path).

### `invoices` — the 6.7 row's two figures, tenant ids visible

```
              tenant_id               | amount_due_cents | status
--------------------------------------+------------------+--------
 a6a441d2-fb40-4851-9d2e-dbec6456ef9e |             4500 | open
 8c776c00-6bb7-4fcd-9bac-ea6723ef336b |           999900 | open
```
Two different tenants, two different real balances ($45.00 / $9,999.00), computed by
`executeLookupAnswer`/`lookupBalance` from real invoice rows in one run.

Container stopped and removed after the dump (`docker stop <cid>`).

---

## Build verification

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit   # clean, no output
cd packages/web  && npx tsc --noEmit                                # clean, no output
git status --porcelain                                              # empty (after each commit)
```

---

## Not done / judgment calls

1. **6.4's proving file.** The map table names `update-job-execution.test.ts` for 6.4, but
   that file is entirely about the `update_job` WRITE leg; the actual read-only story
   (`lookup_jobs`) lives in `ai/skills/lookup-jobs.ts` with only a mocked unit test. Added
   the new negative-assertion test to `update-job-execution.test.ts` as the ticket's map
   instructs (WRITE and READ legs for the same job, side by side) rather than opening a new
   file — flagged here in case the map's file attribution was itself stale.

2. **6.5 / 6.6 not lifted past T1.** Both already carry a single-stranger-tenant negative;
   lifting either to T2/T3 (a genuinely CONFIGURED second tenant exercised in the SAME run,
   matching 6.3's/6.7's shape) is not a "where cheap" change on either file — it would need
   new fixtures (a second estimate/note/expense scenario). Reported the grep, did not
   attempt the lift. `log-expense-job-link.test.ts` has ZERO cross-tenant assertions today
   (0 matches) — this is the weakest of the four and the best next candidate if #1019 or a
   follow-up wants to spend the budget on it.

3. **6.1 rung-5 claim still unsupported.** Added the missing unit tests for
   `useVoiceSession`/`VoiceSessionPanel` per scope, but confirmed `coverage-sweep` has NO
   assertion anywhere that a recorder/push-to-talk control renders on every (or any)
   authenticated route. Per the ticket's explicit instruction, did NOT write a new
   Playwright sweep. 6.1a (`VoiceBar.hint.test.tsx`) is unchanged by this lane and stays at
   its G1 grade of 3 (jsdom only).

4. **6.2's Zod-contract assertion is additive, not a new code path.** The golden-path test
   (PR #1043) already implicitly relied on the payload being valid (it executes end to end
   through production handlers that would reject a malformed payload); the new assertion
   makes that reliance an explicit, first-class check against the same schema the P2-002
   gate uses, rather than exercising new behavior.

5. **No rows appended to `docs/audit/blocked-on-josh.md`.** Nothing in this lane hit a
   product decision, credential, or hardware blocker — every row was resolvable inside the
   TEST-ONLY scope.

6. **Money/pricing/RLS/auth/migrations/supervisor gate:** not touched, per scope. No test
   in this lane exposed a defect in any of those areas.
