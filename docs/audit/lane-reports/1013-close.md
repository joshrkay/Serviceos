# §8.9 Close — Sonnet TEST-ONLY lane (ticket #1013)

Branch: `cloud/close-8-9`, off `origin/main` (137dc55, includes #1010's digest toggle and #1011's weekly-feedback toggle — later than the ad6336d floor named in the brief). One commit per row. Run in Claude Code on the web (cloud sandbox), 2026-09-12.

Scope: TEST-ONLY rows of #1013, Sonnet-class — rows 9.2, 9.3, 9.12, 9.4, plus grading of 9.1/9.8/9.9/9.10. No product code touched: `git diff --stat origin/main..HEAD -- packages/api/src packages/web/src` is empty (verified below). NOT this lane's: 9.5 (money, Opus), 9.6 (digest reachability, browser lane), 9.7 (#1011 PR-3), 9.11.

A prior lane announcement on this ticket (Codex, local worktree `lane/close-8-9`) was withdrawn by the ticket's last comment before this lane started — it never pushed a branch or a commit. Nothing to reconcile.

**Only Fable states a new rung** — nothing in this report claims any row moves to a numbered rung. This is evidence for that decision, not the decision.

## Summary table

| Row | File(s) | Evidence class | Tenant grade | Command |
|---|---|---|---|---|
| 9.2 | `review-request-sweep.test.ts` (extended) | PROVEN-REAL-DB | T4 (cited, sweep-tenant-fanout.test.ts) | `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose <file>` |
| 9.3 | `feedback-review-gating.test.ts` (new) | PROVEN-REAL-DB + honest `it.fails` | T1 | same |
| 9.12 | `conversation-inbox.test.ts` (extended) | PROVEN-REAL-DB (listing isolation only) | T1 (was vacuous) | same |
| 9.4 | `google-reviews-matching.test.ts` (new) | PROVEN-REAL-DB | T1 | same |
| 9.1 / 9.8 / 9.9 / 9.10 | grading only — see below | n/a | see below | grep, no test run |

All commands run from `packages/api/`. Docker-gated via `vitest.integration.config.ts` + `test/integration/global-setup.ts`. `RLS_RUNTIME_ROLE=true` per the harness default.

---

## Row 9.2 — review-request sweep audit leg (G1: 4−)

**File:** `test/integration/review-request-sweep.test.ts` (new `it` appended; no product code touched).

**G1 gap:** the sweep's own write (`jobs.review_request_sent_at`) was already proven at real Postgres, but `runReviewRequestSweep` itself never writes an audit event — it only enqueues `feedback_send`. The audit write actually happens one hop downstream, inside the central consent gate (`GatedMessageDelivery.audit()`, `notifications/gated-message-delivery.ts:346`), and the ONLY prior test of that gate (`test/feedback/feedback-send-worker.test.ts`) wires it with `InMemoryAuditRepository`. Grepped the whole repo for `InMemoryAuditRepository` near `feedback` — that unit test is the sole hit; no integration test drove the sweep's enqueue through the real worker + real gate.

**Fix:** the new test wires the sweep's `queue.send` to the REAL `feedback_send` worker (`createFeedbackSendWorker`), with every dependency backed by its real Pg repository (`PgCustomerRepository`, `PgSettingsRepository`, `PgFeedbackRequestRepository`, `PgDncRepository`) and `GatedMessageDelivery` constructed with `PgAuditRepository` in `enforcement: 'block'`. The seeded customer has `sms_consent: false`, so the gate deterministically throws `SmsSuppressedError('no_consent')` and writes `sms.suppressed` — read back via `auditRepo.findByEntity(tenantId, 'sms_message', customerId)`.

**RED** (deliberate wrong `reason` expectation, `'dnc'` instead of the real `'no_consent'`):
```
 × ... the enqueued feedback_send, once processed by the real gate, writes a real audit_events row (PgAuditRepository) 37ms
   → expected 'no_consent' to be 'dnc' // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
```

**GREEN:**
```
 ✓ column default: tenant_settings.send_review_request defaults TRUE (migration 214)
 ✓ enqueues feedback_send only for the eligible job, stamps it, and is idempotent
 ✓ the enqueued feedback_send, once processed by the real gate, writes a real audit_events row (PgAuditRepository)
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

Evidence class: **PROVEN-REAL-DB** for the audit write on the SUPPRESSED path specifically. T4 for this sweep is cited, not re-proven: `test/integration/sweep-tenant-fanout.test.ts` → "cross-tenant query sweep fan-out (T4)" → "review-request sweep" (lines 1034-1072) drives `runReviewRequestSweep` against a multi-tenant result set and asserts per-tenant enqueue + failure isolation.

**Scope limit (flagged in review, Codex — accurate):** the audit row this test reads back is `sms.suppressed`, written only when the gate REFUSES a send (no consent, here). The codebase has no audit event anywhere for a *successful* customer send through this path — `GatedMessageDelivery.audit()` is only called from its two suppression branches (`gated-message-delivery.ts:246-253`). So this test proves the suppression is audited; it does not prove the successful enqueue/delivery is, because nothing in the product code audits that today. Adding one would be a product-code change, out of this TEST-ONLY lane's scope. Whether that gap caps this row below rung 4 is Fable's call, not this lane's.

Tenant-grade grep (this file):
```
66:  let tenantB: { tenantId: string; userId: string };
76:    tenantB = await createTestTenant(pool);
87:      [tenantB.tenantId],
91:    const idsB = await seedCustomerLocation(pool, tenantB.tenantId, tenantB.userId);
95:    jobOldB = await seedCompletedJob(pool, tenantB.tenantId, idsB, hoursAgo(48)); // opted out
121:        payload.tenantId === tenantA.tenantId || payload.tenantId === tenantB.tenantId,
150:        payload.tenantId === tenantA.tenantId || payload.tenantId === tenantB.tenantId,
173:   * ("cross-tenant query sweep fan-out (T4)" → "review-request sweep",
```
(Pre-existing `tenantA`/`tenantB` isolation in this file; the new test doesn't add its own second-tenant assertion — the audit leg is scoped to one tenant by design, and T4 lives in the cited fan-out file.)

---

## Row 9.3 — review gating (3 → 4)

**File:** `test/integration/feedback-review-gating.test.ts` (new).

Grepped `packages/api/src` first, per the brief, before writing any assertion: `routes/public-feedback.ts` is the whole of the gate. `POST /public/feedback/:token` surfaces `reviewUrls` (google/yelp) only when `rating >= 4`; a 1-3★ response gets `{ ok: true }` with nothing else. That IS the gate — the G1 note ("the unit route enforces '4★+' — align the row's wording with the code") is followed literally: this file proves the `rating >= 4` boundary at real Postgres, not a rating-band routing scheme the code doesn't have.

**RED** (deliberate wrong `rating` metadata expectation on the 3★ case, `1` instead of `3`):
```
 × ... 3★ (unhappy): NO review links in the response, and the audit row reads back at real Postgres 72ms
   → expected 3 to be 1 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 2 passed | 1 expected fail (4)
```
(Two earlier throwaway RED runs while writing this file caught two test-authoring bugs, not product bugs: (1) `PgSettingsRepository.create()` doesn't insert `google_review_url`/`yelp_review_url` — those columns are wired only into the generic `update()` column map (migration 120 added them after `create()`'s INSERT list was written) — fixed by calling `settingsRepo.update()` after `create()`; (2) the audit lookup used the feedback REQUEST's id as `entityId` instead of the feedback RESPONSE's id the route actually audits against — fixed by resolving the response via `responseRepo.findByRequest()` first. Both fixes are visible in the file; noted here so the RED/GREEN pair above isn't read as the only debugging that happened.)

**GREEN:**
```
 ✓ 3★ (unhappy): NO review links in the response, and the audit row reads back at real Postgres
 ✓ 5★ (happy): review links ARE returned, and the audit row reads back at real Postgres
 ✓ T1: a second tenant with NO review-URL settings gets no links on a 5★ — the first tenant's configured URLs never leak across
 ✓ story claim not met in code: a 3★ submission notifies the owner privately (expected fail)
 Test Files  1 passed (1)
      Tests  3 passed | 1 expected fail (4)
```

Evidence class: **PROVEN-REAL-DB** for the rating gate + audit readback; honest `it.fails` for the unproven half.

**Not done / judgment call:** the story's "routed to me privately" half has no active code path anywhere in the repo. Grepped `routes/public-feedback.ts` and all of `src/reputation` (the only other review-adjacent module, and that's Google reviews, not post-job feedback) — there is no push/SMS/email to the owner on a low rating. "Private routing" is implicit only: the response lands in `feedback_responses`, readable solely via the owner's authenticated `GET /api/feedback` (`requirePermission('settings:view')`), and no public link is ever produced for it. Rather than assert something the code doesn't do, this file has one `it.fails` documenting the gap — a real "notify the owner" implementation should turn that test red (failing to fail), which is the signal it's been built.

**Correction (flagged in review by Codex, verified and fixed):** the sentinel originally asserted an invented `feedback_response.owner_notified` audit event. Every other owner-facing push in this codebase (payment received, lead captured, escalation, appointment reminders, …) fans out through the single process-wide `OwnerNotificationService`/`notifyOwner()` seam (`notifications/owner-notifications-instance.ts`), not a bespoke audit row — a real implementation would almost certainly use that same seam (there is no feedback-related `NotificationType` in `@ai-service-os/shared` today, so one would need to be added there). The sentinel now wires `setOwnerNotifications` with a real `OwnerNotificationService` over `InMemoryPushDeliveryProvider` and asserts a push was actually sent, so it will correctly flip red the moment a real implementation routes through the seam that already exists for every other owner notification — verified by temporarily unwrapping `it.fails` and confirming it fails on "0 pushes sent" rather than a fabricated contract.

Tenant-grade grep (this file):
```
162:    const otherTenant = await createTestTenant(pool);
165:      tenantId: otherTenant.tenantId,
178:    const jobId = await createJob(pool, otherTenant);
179:    const req = await requestRepo.create(createFeedbackRequest({ tenantId: otherTenant.tenantId, jobId }));
```

---

## Row 9.12 — unified inbox with reply drafts (4/3, listing isolation only)

**File:** `test/integration/conversation-inbox.test.ts` (extended; existing describe block, one `it` replaced).

**G1 gap:** the file's only T1 test, `does not surface another tenant's threads`, called `listInboxThreads` on a freshly-created SECOND tenant with NOTHING seeded for it, then asserted `.every(...)` over the (necessarily empty) result — vacuously true regardless of whether cross-tenant filtering works. It could not have caught a leak.

**Fix:** replaced it with a real fixture — a neighbour tenant with an actual unanswered (inbound) thread — and assert it surfaces in ITS OWN listing (sanity) but never in the first tenant's.

**RED** (deliberately flipped the cross-tenant assertion to `.toContain(...)` instead of `.not.toContain(...)`):
```
 × ... T1: a neighbour tenant's unanswered thread never appears in another tenant's inbox listing 24ms
   → expected [ …(3) ] to include 'fba73ccc-b465-4134-aa01-5877a57ce8db'
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
```

**GREEN:**
```
 ✓ lists customer + unmatched comms threads with the customer name joined, newest-inbound first
 ✓ T1: a neighbour tenant's unanswered thread never appears in another tenant's inbox listing
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

Evidence class: **PROVEN-REAL-DB** for the listing isolation (now a real T1, not vacuous). This row's other half — "with a reply drafted for me" — is untouched by this lane's testing, corrected below.

**Correction (Fable gate, commit f4da6f9, superseding this lane's original text):** this lane originally added an `it.fails` here claiming "reply drafts" don't exist anywhere in the codebase — that was wrong. `POST /api/conversations/:id/suggest-reply` (`SuggestReplyTask`, `routes/conversations.ts:303`) drafts a reply on demand and is unit-tested; drafts are simply produced on request rather than stored on the thread row, so the `it.fails` recorded a gap that wasn't one (and would have failed for the wrong reason — `threads[0]` undefined on an empty tenant — even before that). Fable's gate commit removed it. The accurate state of this row's second half: the on-demand suggest-reply endpoint is unit-tested only; this lane did not add real-Postgres coverage for it (its own audit/persistence leg, if any, is untouched by this PR).

Tenant-grade grep (this file):
```
190:  it('T1: a neighbour tenant's unanswered thread never appears in another tenant's inbox listing', async () => {
```
(One occurrence, correctly — a single T1 block containing the neighbour-tenant fixture and both assertions.)

---

## Row 9.4 — Google reviews classification + drafting (4/3)

**File:** `test/integration/google-reviews-matching.test.ts` (new).

`test/integration/google-reviews-worker.test.ts` already says explicitly in its own header: "The handler / pagination / proposal-emission logic is covered by test/workers/google-reviews.test.ts against in-memory repos" and the PRD row's own note is "Classification and drafting are unit-only." Read `classifier.ts`, `match-customer.ts`, `draft-public-response.ts`, `draft-private-followup.ts`, and `build-proposal.ts` before writing anything: `classifyReview` is pure (regex, LLM fallback only for the ambiguous middle) and the two draft composers are LLM-only — neither touches a database, so there's nothing to move to real Postgres for them. The ONE DB-touching step in the pipeline is `PgCustomerLoader.findRecentCustomersWithName` (`reputation/match-customer.ts:181-237`, the customers ⋈ jobs ⋈ appointments join) — grepped the whole test tree for `PgCustomerLoader`: zero hits anywhere before this file.

**New file proves, against real Postgres:**
1. the 60-day recency window (a candidate with a 90-day-old appointment is excluded),
2. T1 — an identically-named customer in a NEIGHBOUR tenant never surfaces as a candidate for the first tenant,
3. `matchReviewerToCustomer` resolving a confident match when driven by the real loader (not an injected fake),
4. the full `classify → match → draft` pipeline (real regex classification, real DB-backed match; only the two LLM draft calls are faked, since they're already unit-tested elsewhere) producing a private follow-up + service credit keyed to the REAL matched customer id.

**RED** (deliberate wrong `amountCents` expectation, `1` instead of the real `10000`):
```
 × ... buildReviewResponseProposal: private follow-up + service credit target the REAL matched customer 21ms
   → expected 10000 to be 1 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 4 passed (5)
```

**GREEN:**
```
 ✓ finds a candidate with a recent (within 60d) appointment, tenant-scoped
 ✓ excludes a candidate whose only appointment is OUTSIDE the 60-day window
 ✓ T1: an identically-named customer in a NEIGHBOUR tenant never surfaces as a candidate
 ✓ matchReviewerToCustomer, driven by the REAL PgCustomerLoader, resolves a confident match
 ✓ buildReviewResponseProposal: private follow-up + service credit target the REAL matched customer
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

Evidence class: **PROVEN-REAL-DB** for the customer-matching step specifically (the one DB-touching piece of this pipeline — see file header). The draft composers are faked here (constant strings) and no `ProposalRepository` write is exercised — this file does not prove a persisted, audit-readable `review_response_proposal`, only that the real match feeds the pipeline correctly. Noted in review (Codex) as a caution against reading this as full-pipeline persistence proof; agreed, and scoped that way in this report from the start.

**Not done:** rung 5 needs a connected Google Business Profile — a live OAuth integration against real upstream reviews. Out of scope for this repo's hermetic test harness; not faked. (Matches #1013's own note: "OAuth parked.")

Tenant-grade grep (this file):
```
141:    const neighbourTenant = await createTestTenant(pool);
144:    const neighbourCustomerId = await seedVisitor(neighbourTenant, 'Carlos', 'Diaz', 5);
145:    expect(aCustomerId).not.toBe(neighbourCustomerId);
153:    expect(candidatesForA.map((c) => c.id)).not.toContain(neighbourCustomerId);
```

---

## Rows 9.1 / 9.8 / 9.9 / 9.10 — grading only

Per the brief, this section is grep counts + file:line + a citation of 9.1's T4 entry. No test files touched, no code run beyond `grep`.

**Command run against each file** (as specified):
```
grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" <file>
```

### 9.1 — thank-you SMS (printed 4)

```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" test/workers/thank-you-sms-worker.test.ts
(0 matches)
```
This file is the worker's own single-tenant unit test — correctly zero, since it never claimed fan-out. The literal grep pattern also misses the T4 evidence that DOES exist because it's written with `a`/`b`/`doomed`/`survivor` variable names, not the literal strings the pattern looks for. **The real T4 entry**, confirmed by direct read: `test/integration/sweep-tenant-fanout.test.ts`, `describe('thank-you-SMS sweep', …)` (lines 930-1032) — two real tenants seeded via `seedEligibleTenant()`, dispatched through the REAL `PgJobRepository`/`PgCustomerRepository`/`PgDncRepository`, asserting (a) both tenants' customers are actually SENT to (not merely visited) with each message carrying its OWN tenant's consent/customerId scope (lines 982-1009), and (b) one tenant throwing doesn't stop the other's send (lines 1011-1031). This matches the #1009 G1 resolution's "9.1 confirmed 4 at T4" — no new evidence needed; the grep's 0-count here is a false negative of the pattern, not a gap in the row.

### 9.8 / 9.9 — correction loop (printed 5 / 5)

```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" test/integration/correction-loop.test.ts
5: *   - correction_lessons columns + FORCE RLS isolate across tenants.
145:  it('FORCE RLS isolates correction_lessons across tenants', async () => {
```
2 matches — a real second-tenant assertion, confirmed by direct read at `test/integration/correction-loop.test.ts:145-160`: `it('FORCE RLS isolates correction_lessons across tenants', …)` creates a lesson under `tenant`, then a second `other = await createTestTenant(pool)` and asserts `lessonRepo.findById(other.tenantId, lesson.id)` is null and `lessonRepo.findAppliedForDay(other.tenantId, …)` is empty. This is a genuine T1. Matches the #1009 G1 resolution ("9.8/9.9 → 4 at T1; 5 waits on #1025"). Not this lane's job to add the "second undo is a no-op" case the G1 note also flagged — that's new test authorship, out of this row's "grading only" scope.

### 9.10 — correction-repetition meta-proposal (printed 4)

```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" test/integration/correction-repetition-meta-proposal.test.ts
(0 matches)
```
Confirmed by direct read: `createTestTenant` is called exactly ONCE in this 149-line file (line 72), across both of its `it` blocks — no second tenant is ever seeded, no cross-tenant assertion exists. Single-tenant only. Matches the #1009 G1 resolution ("9.10 → 3, single tenant").

---

## Build + tree verification

```
$ cd packages/api && npx tsc --project tsconfig.build.json --noEmit
(clean — no output)

$ git status --porcelain
(empty)
```

## EVIDENCE — kept Postgres container, second run + row dumps

Per the artifact-before-sign-off rule. Container started fresh (`docker run -d --rm --name evidence-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=serviceos_test -p 127.0.0.1:0:5432 pgvector/pgvector:pg16 -c max_connections=300`, mapped to `127.0.0.1:32768`), migrations applied by `global-setup.ts`'s `EXTERNAL_TEST_DB_URL` path, all four touched files re-run against it in one pass:

```
$ EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32768/serviceos_test RLS_RUNTIME_ROLE=true \
  npx vitest run --config vitest.integration.config.ts --reporter=verbose \
  test/integration/review-request-sweep.test.ts \
  test/integration/feedback-review-gating.test.ts \
  test/integration/conversation-inbox.test.ts \
  test/integration/google-reviews-matching.test.ts

 Test Files  4 passed (4)
      Tests  13 passed | 2 expected fail (15)
```

**Post-gate correction:** the Fable gate (commit f4da6f9) removed `conversation-inbox.test.ts`'s `it.fails` (see Row 9.12 above — it recorded a gap that wasn't one) after this evidence run was captured. Re-run against the same combined set on the current head (`e5bae06`) is:
```
 Test Files  4 passed (4)
      Tests  13 passed | 1 expected fail (14)
```
(the one remaining expected fail is 9.3's owner-notification sentinel). Row dumps below are from the original run and are still valid for the rows they cover (9.2/9.3 audit rows and 9.4/9.12 data rows are unaffected by the removed test).

**Audit rows written by these tests, real tenant ids visible:**
```
$ docker exec evidence-pg psql -U test -d serviceos_test -P pager=off -c \
  "SELECT left(tenant_id::text,8), event_type, entity_type, count(*) FROM audit_events GROUP BY 1,2,3 ORDER BY 2,1;"

   left   |         event_type          |    entity_type    | count
----------+-----------------------------+-------------------+-------
 2f303632 | feedback_response.submitted | feedback_response |     3
 7260eccc | feedback_response.submitted | feedback_response |     1
 410e81ee | sms.suppressed              | sms_message       |     1
(3 rows)
```

**Feedback requests:**
```
  tenant  |  req_id  |  status   |   job
----------+----------+-----------+----------
 2f303632 | 4349dfe9 | submitted | c6f486b4
 2f303632 | ddc8c4f1 | submitted | 834367e6
 7260eccc | 71a6e325 | submitted | 9421265a
 2f303632 | 9fa3030e | submitted | 34c6bb00
 410e81ee | 73a9e8fc | pending   | 98a950c6
(5 rows)
```

**Feedback responses:**
```
  tenant  | resp_id  | rating | comment
----------+----------+--------+---------
 2f303632 | e39d523b |      3 | meh
 2f303632 | 473629d5 |      5 | great!
 7260eccc | fe5d1585 |      5 |
 2f303632 | f243ff73 |      2 |
(4 rows)
```

**Jobs stamped by the review-request sweep:**
```
  tenant  |  job_id  | review_request_sent_at
----------+----------+------------------------
 bb27dbad | d5ec49ba | 2026-06-25 12:00:00+00
 410e81ee | 98a950c6 | 2026-06-25 12:00:00+00
(2 rows)
```

**Conversation threads (unified-inbox entity types only):**
```
  tenant  | conv_id  |         title         |  entity_type
----------+----------+-----------------------+---------------
 959f6310 | 837bee2d | Dana Diaz             | customer
 959f6310 | 446ebc7e | SMS from +15555559001 | sms_unmatched
 959f6310 | 38c22db8 | Robin Rivera          | lead
 4086ab5b | 496d9c5e | Neighbour Nolan       | customer
(4 rows)
```

Container stopped and removed after capture (`docker stop evidence-pg`); no testcontainer leftovers (`docker ps --filter ancestor=pgvector/pgvector:pg16 -q` empty).

## Not done / judgment calls (recap)

- **9.2** — **Scope limit flagged in review (Codex, valid):** the audit row `review-request-sweep.test.ts` reads back is the consent gate's `sms.suppressed` event on the SUPPRESSED path (no consent) — the codebase has no audit event at all for a *successful* customer send on this path, so this proves the refusal is audited, not that a successful enqueue/delivery is. Whether that's enough for a rung move is Fable's call, not this lane's — flagging it rather than resolving it. (The `TELEPHONY_ENABLED` kill-switch pin, also flagged in review, is fixed — see the row 9.2 section above.)
- **9.3** — "routed to me privately" has no active owner-notification code path; documented via `it.fails` that watches the real `OwnerNotificationService`/`notifyOwner()` seam (not an invented audit event — see the row 9.3 section above, corrected in review). A future implementer: this test should go red the moment it's built.
- **9.12** — corrected above: reply drafts exist as an on-demand endpoint (`suggest-reply`), not a stored field; this lane proves only the listing-isolation half.
- **9.4** — rung 5 needs a connected Google Business Profile (live OAuth); out of scope for this harness. **Scope limit flagged in review (Codex, valid):** the classify→match→draft test fakes both draft composers (constant strings) and never invokes a real `ProposalRepository` write — it proves the real-DB CUSTOMER MATCH, not a persisted, audit-readable `review_response_proposal`. The report and PR body already scoped this claim to "the one DB-touching step" (the customer loader); Codex's finding is a caution against reading that as full pipeline persistence proof. Again, the rung call is Fable's.
- **9.1/9.8/9.9/9.10** — grading only, per scope; the two literal-grep false negatives (9.1, 9.10-adjacent naming) are called out above rather than silently reported as "0 matches = no coverage."
- Did not touch 9.5 (money, Opus), 9.6 (browser lane), 9.7 (#1011 PR-3), 9.11 (not assigned) per the brief's scope fence.
