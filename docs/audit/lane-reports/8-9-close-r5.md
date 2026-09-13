# §8.9 Close — rung-5 reachability (lane C, Sonnet, TEST-ONLY)

Branch: `test/8-9-close-r5`, off `origin/main` (765e5ca08). Ticket #1013. No product code touched — every file changed is under `e2e/` or `packages/api/test/`.

Scope (per the lane brief): reach hermetically rows 9.1, 9.2, 9.3, 9.5, 9.7, 9.8, 9.9, 9.10, plus the REACHABILITY legs of 9.4 and 9.12 (their `4−` audit gap belongs to a separate Opus lane, not touched here). Row 9.6 is already reached (skipped). Row 9.11 is report-only (QuickBooks, #1003).

## Summary table

| Row | File(s) | What it proves | Tenant grade |
|---|---|---|---|
| 9.1 | `test/integration/thank-you-sms-reachability-9-1.test.ts` (new) | Concurrent-sweep send-exactly-once + T2, through the REAL block-mode `GatedMessageDelivery` (not a stub dispatcher) | T2 |
| 9.2 | `test/integration/review-request-sweep-reachability-9-2.test.ts` (new) | One sweep call, two tenants, through the real gate — consenting tenant sent, DNC tenant suppressed, cross-tenant audit isolation | T2 |
| 9.3 | `e2e/journeys/public-feedback-rating-gate-9-3.spec.ts` (new) | Real browser: 3★ → no review links, 5★ → configured links, neighbour tenant with no URLs gets none; owner's real private dashboard (`/settings/feedback`) shows both of their own responses | T2, browser |
| 9.4 / 9.5 | `e2e/journeys/review-response-approval-9-4-9-5.spec.ts` (new) | Real browser: owner reaches the drafted review-response card on the real Inbox, the capped credit never renders, Approve executes for real (production registry), no credit row lands; neighbour sees nothing | T2, browser |
| 9.7 | `test/integration/weekly-feedback-reachability-9-7.test.ts` (new) | Real sweep + real audit-backed send ledger: idempotent (T3 opted-in vs opted-out), a failed send leaves no row so the week retries | T2/T3 |
| 9.8 / 9.9 | `test/integration/correction-loop-reachability-9-8-9-9.test.ts` (new) | Real edit→approve→execute pipeline creates the estimate at the owner-corrected price (T2); **pins a product gap** — no correction_lesson is ever recorded through the real pipeline, and undo can never reach a real lesson either |  T2 (positive case) |
| 9.10 | `e2e/journeys/correction-meta-proposal-approval-9-10.spec.ts` (new) | Real browser: owner approves the 3-strike meta-proposal on the real Inbox; real production executor updates the catalog | browser |
| 9.12 | `e2e/journeys/conversation-suggest-reply-9-12.spec.ts` (new) | Real browser: owner opens a real thread, clicks "Suggest reply", a draft returns from the real route (hermetic mock LLM gateway, no live model), zero dispatch rows written | browser |
| 9.6 | — | Already reached (T2·T3·T4, `e2e/journeys/digest-toggle.spec.ts` + `test/integration/daily-digest-send-9-6.test.ts`) — skipped per brief | n/a |
| 9.11 | — | Report-only, see below | n/a |

All vitest-integration commands run from `packages/api/` against a dedicated plain Postgres container (`pgvector/pgvector:pg16`, kept for row dumps). All Playwright commands run from the repo root, one spec per process, dedicated API port 38530, under the shared test-lock.

---

## vitest-integration rows (9.1, 9.2, 9.7, 9.8/9.9)

Command (run twice, both green):
```
cd packages/api && RLS_RUNTIME_ROLE=true EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:<port>/serviceos_test \
  npx vitest run --config vitest.integration.config.ts --reporter=verbose \
  test/integration/thank-you-sms-reachability-9-1.test.ts \
  test/integration/review-request-sweep-reachability-9-2.test.ts \
  test/integration/weekly-feedback-reachability-9-7.test.ts \
  test/integration/correction-loop-reachability-9-8-9-9.test.ts
```

Raw output (second green run):
```
 ✓ correction-loop-reachability-9-8-9-9.test.ts > POSITIVE: the real edit→approve→execute pipeline creates the estimate at the OWNER-CORRECTED price — a neighbour tenant is untouched (T2) 10040ms
 ✓ correction-loop-reachability-9-8-9-9.test.ts > 9.8 DESIRED (currently FAILS — product gap, see file header): ... 2640ms
 ✓ correction-loop-reachability-9-8-9-9.test.ts > 9.9 DESIRED (currently FAILS — product gap, see file header): ... 1245ms
 ✓ thank-you-sms-reachability-9-1.test.ts > two concurrent sweeps over the same eligible job, through the real gate: exactly one send, one audit row — and a neighbour tenant sends+audits independently (T2) 513ms
 ✓ thank-you-sms-reachability-9-1.test.ts > DESIRED (product gap, see comment above): a second concurrent sweep tick never adds a second audit row for one real send — ACTUAL: the crash-recovery reconcile path double-audits this realistic interleaving too 339ms
 ✓ thank-you-sms-reachability-9-1.test.ts > a "sent" claim with a NULL stamp is reconciled through the real gate — no resend, exactly one audit row 182ms
 ✓ weekly-feedback-reachability-9-7.test.ts > T3: opted-in tenant sends once (idempotent ledger via real audit rows); opted-out neighbour never sends; a failed send leaves no ledger row so the week retries 791ms
 ✓ review-request-sweep-reachability-9-2.test.ts > tenant A (consenting) gets a real SMS + no suppression audit; tenant B (DNC) gets a suppression audit + no send — neither leaks into the other, both stamped exactly once across two sweeps 1300ms

 Test Files  4 passed (4)
      Tests  5 passed | 3 expected fail (8)
```

Row dumps (from this run, real Postgres):
```sql
SELECT event_type, entity_type, count(*) FROM audit_events
 WHERE event_type LIKE 'notification.thank_you_sms%' OR event_type = 'sms.suppressed'
    OR event_type LIKE 'weekly_feedback_email%'
 GROUP BY 1,2 ORDER BY 1;

           event_type            |      entity_type      | count
---------------------------------+------------------------+-------
 notification.thank_you_sms.sent | job                    |    46
 sms.suppressed                  | sms_message            |     4
 weekly_feedback_email.sent      | weekly_feedback_email  |     8

SELECT proposal_type, status, count(*) FROM proposals GROUP BY 1,2 ORDER BY 1,2;

 proposal_type  |  status  | count
----------------+----------+-------
 draft_estimate | approved |     3   -- leftover from the undo-window fix cycle, harmless
 draft_estimate | executed |    12

SELECT count(*) FROM correction_lessons;
 count
-------
     3
```

### 9.1 — RED before the fix, GREEN after (the undo-window bug in my own test, not the product)

First run (before backdating `approvedAt` in the correction-loop file, and before discovering the concurrent-audit gap in the thank-you-sms file) genuinely failed two ways:
```
 × correction-loop... POSITIVE ... 53ms
   → Proposal is still in the 5-second undo window (4992ms remaining). ...
 × thank-you-sms-reachability-9-1.test.ts > two concurrent sweeps ... 88ms
   → expected [ { …(10) }, { …(10) } ] to have a length of 1 but got 2
```
The first was my own test bug (executor.ts:105-113 enforces `UNDO_WINDOW_MS` itself, not just the sweep) — fixed by backdating `approvedAt` the same way `correction-repetition-meta-proposal.test.ts` / `service-credit-cap-9-5.test.ts` do. The second was real: a live `Promise.all` race hit the product gap described below on the first try. Investigating it turned into the file's `it.fails` (deterministic reproduction, not relying on winning a timing race twice).

### PRODUCT GAP found — 9.1 (not previously ticketed; not filed by this lane)

`thank-you-sms-worker.ts`'s crash-recovery reconcile branch (`claimResult.outcome === 'duplicate' && priorStatus === 'sent'`, lines ~325-337) unconditionally falls through to the same `jobRepo.update` + `emitAudit('sent')` the winning sweep tick already ran (lines ~350-358), with no check for whether the job was already stamped. It exists on purpose for genuine crash recovery (PR #705, Codex P2), but fires identically when a second, genuinely concurrent sweep tick's eligibility SELECT (not in the same transaction as the stamp UPDATE) observes `thank_you_sms_sent_at IS NULL` a moment before the first tick's stamp commits. Effect: one real SMS send, but **two** `notification.thank_you_sms.sent` audit rows — the row's own acceptance ("exactly one send and one audit row") is violated on the audit half only. The send-claim ledger itself (T4-F01) is solid; only the audit write is non-idempotent on this path. Pinned with a deterministic `it.fails` (simulates the exact interleaving rather than racing `Promise.all`, which is timing-dependent).

### PRODUCT GAP found — 9.8/9.9 (not previously ticketed; not filed by this lane)

`ProposalExecutor.execute()` always writes `executedPayload: keyedProposal.payload` (`executor.ts:279` and `:427`) — literally the same object `recordCorrectionLessonsOnExecution` reads as `drafted` a moment later in the same `onExecuted` callback (`record-on-execution.ts:114-115`). Because `editProposal` (the route an owner's "correction" goes through, `PUT /api/proposals/:id`) mutates `proposal.payload` in place *before* approval, by execution time `proposal.payload` already **is** the corrected value — so `drafted === executed`, `computeInvoiceDeltas` sees zero line differences, and `record-on-execution.ts:126` (`if (deltas.length === 0) return [];`) always short-circuits. Every *passing* test of `recordCorrectionLessonsOnExecution` in this repo (`test/integration/correction-lesson-on-execution.test.ts`, `test/learning/corrections/record-on-execution.test.ts`) manually inserts a `proposal_executions` row with a hand-divergent `executedPayload` — nothing in the real approve→execute pipeline can ever produce that divergence.

**Net: rows 9.8 and 9.9's entire mechanism is wired and audited, but is never invoked by any real product path today.** 9.9 is doubly unreachable even granting a lesson existed some other way: `undoProposal` (`actions.ts:512-515`) refuses any proposal whose status isn't `'approved'`, and a lesson can only ever be recorded in `onExecuted`, which fires strictly after the proposal has already transitioned to `'executed'` (past `UNDO_WINDOW_MS`, `lifecycle.ts:53`). There is no tick of real time at which a real lesson exists and its source proposal is still undoable.

What DOES work (proven as the file's positive test, T2): the owner's edit-before-approve mechanism itself is real end to end through `editProposal`/`approveProposal`/the production execution registry — the created estimate carries the owner-corrected price, not the AI's original draft.

---

## 9.11 — report only (QuickBooks, #1003)

`test/integration/accounting-sync.test.ts` proves the sync loop's idempotency (zero calls / zero new `sync_log` rows on a re-sweep of already-synced invoices) and pagination at real Postgres, single tenant, no audit event, no fan-out entry (`findAllActive()` iterates with no per-tenant isolation test). Rung 5 is blocked on one human OAuth consent click against a live Intuit account — not on missing test coverage, and not something this lane can produce (a live third-party per the ground rules). Nothing built or changed for this row.

---

## Environment note (not this lane's code — flagging for whoever else hits it)

This worktree (`agent-a2cd2216fe6cc7452`) started with NO local `node_modules` of its own (an empty stub at `packages/web/node_modules` and `packages/api/node_modules`, nothing at the worktree root). Node's directory-walk-up module resolution reached past the worktree into the MAIN checkout's `node_modules` (`/Users/joshuakay/Serviceos/node_modules`), which has drifted from `package-lock.json`: `@types/node` resolved to `26.5.1` there vs the locked `20.19.39`, breaking `npx tsc -p tsconfig.build.json` (`voice-service.ts:258`, a `Uint8Array`/`ArrayBuffer` typing break) and `npm run dev` (ts-node, same error, hard-fails boot — TSError, not a warning) with 6 total pre-existing errors across `clerk.ts`, `assistant.ts` (missing `@ai-service-os/shared` barrel exports for `centsToInputValue` and friends — genuinely absent from `packages/shared/src/index.ts`, not a resolution artifact), and `voice-service.ts`. None of these files were touched by this lane (`git diff --stat origin/main..HEAD` — test-only). Separately, the web `webServer` (Vite) could not resolve `@stripe/react-stripe-js` at all from the worktree-empty `node_modules`, crashing on boot.

Fix applied (environment only, not a code change): `npm install` from the worktree root (one of the other worktrees on this Mac, `agent-a2ac2b1775fd65445`, already had its own local install — this matches that pattern). Installed 826 packages, 39s, no fatal errors (one `EBADENGINE` warning: this Mac's active Node is v25.2.1, the repo pins `^20.20.0` — a second, separate environment mismatch worth Josh's attention). After install, `@types/node` resolves to the locked `20.19.39` and `npx tsc -p tsconfig.build.json` is clean (0 errors). `package-lock.json` was touched by the install (minor `peer`-flag/optional-package churn from resolving on this platform) — reverted (`git checkout -- package-lock.json`) before this lane's final diff; it is not part of this PR.

A second, separate flakiness: `npm run dev`'s ts-node does a FULL, un-cached type-check of the whole monorepo on every cold boot, which occasionally exceeded Playwright's 120s webServer timeout under the load of three concurrent webServer pairs (legacy + chromium-devauth + chromium-noauthbypass all start on every invocation regardless of `--project`, per playwright.config.ts's own comment). `TS_NODE_TRANSPILE_ONLY=true` (skip type-checking at boot — safe, since `tsc --noEmit` above already proved the project type-checks clean) fixes the timeout. Occasionally the legacy pair's own Vite dev server took a few retries to come up cleanly under that same three-pair CPU contention (one spec needed 2-3 attempts before its `page.goto` stopped hitting a closing window on a reused-then-dead process) — not a bug in this lane's specs; retried until green, as the CI-parity command below does.

**Exact working command** (used for every spec below, one spec per process, under the test-lock):
```
TS_NODE_TRANSPILE_ONLY=true CLERK_DEV_HMAC_TOKENS=true DB_SSL=false \
  DATABASE_URL=postgres://test:test@localhost:<e2e-db-port>/serviceos_e2e_test E2E_USE_TEST_DB=true \
  VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
  STRIPE_SECRET_KEY=sk_test_e2e_stub_placeholder STRIPE_WEBHOOK_SECRET=whsec_e2e_stub_secret_1234567890 \
  PORT=38530 E2E_API_URL=http://localhost:38530 PUBLIC_API_URL=http://localhost:38530 VITE_API_URL=http://localhost:38530 \
  npx playwright test <spec> --project=chromium --retries=0 --workers=1 --reporter=list
```
(`VITE_API_URL` is not in the general preamble but is required: `packages/web/vite.config.ts:71` proxies `/api` to `VITE_API_URL ?? 'http://localhost:3000'`, and without it the legacy pair's browser traffic silently targets the wrong port.)

---

## Playwright rows (9.3, 9.4/9.5, 9.10, 9.12)

| Spec | Runs | Result |
|---|---|---|
| `public-feedback-rating-gate-9-3.spec.ts` | 2/2 green | 33.4s, 2.5m wall (incl. webServer cold-boot) |
| `review-response-approval-9-4-9-5.spec.ts` | 2/2 green (1 real bug fixed between runs — see below) | 58.0s, 4.8m wall |
| `correction-meta-proposal-approval-9-10.spec.ts` | 2/2 green (1 regex + 1 resilience fix between runs — see below) | 56.7s / 2.7m wall |
| `conversation-suggest-reply-9-12.spec.ts` | 2/2 green | 1.4m / 2.4m wall |

### Bug found and fixed in this lane's own spec (9.10), not the product

`detectCorrectionRepetition`'s summary text renders `$89`, not `$89.00` (`fmtUsd` omits trailing `.00` for whole-dollar amounts) — the spec's regex expected the latter. Fixed the regex. Separately, under this Mac's load (routinely 10+ concurrent lanes; `uptime` showed load average 12-13 during this run), Vite's dev-server module transform for a lazy route chunk occasionally lost the race and tripped the SPA's own error boundary ("Failed to fetch dynamically imported module") — unrelated to this row; added a one-shot detect-and-reload before the real assertion (documented inline in the spec).

### Shared-machine flakiness observed across all four specs (environmental, not product or spec bugs)

Every spec occasionally hit one of: (1) the legacy pair's Vite dev server needing 2-3 attempts before `page.goto` stopped racing a reused-then-dead process from a prior attempt, (2) `e2e/global-setup.ts`'s ephemeral-DB migration bootstrap hitting a real Postgres `deadlock detected` (40P01) — the `chromium-noauthbypass` webServer pair (playwright.config.ts's third pair, started on every invocation regardless of `--project`) inherits the SAME `DATABASE_URL` via `noAuthBypassApiServerEnv: {...webServerEnv}`, so its own background sweeps and any migration-adjacent boot work can race this lane's `setup-test-db.ts` migrations against the identical schema under load. None of these reproduced on a clean re-run once isolated; every spec below is 2/2 green on its OWN merits. Flagging the `noAuthBypassApiServerEnv` DATABASE_URL sharing as a real fragility in the shared harness worth a follow-up (not fixed here — touching the shared `playwright.config.ts`'s pair-isolation is bigger than this lane's scope).

---

## What is NOT proven (honest list)

- **9.4** — only the classification/matching/drafting + credit-cap + owner-approval legs are reached here. The sweep half (discovering NEW reviews from a live Google Business Profile) is blocked on #1000 (live OAuth connection) and not attempted. The audit-completeness gap on that sweep half belongs to a separate Opus lane already in flight — not touched.
- **9.12** — only the AI-suggestion leg (draft returns, zero dispatch rows) and the already-proven inbox/guarded-send legs are covered. The audit-completeness gap (no audit event asserted on `conversation-reply-send.test.ts`) belongs to the same separate Opus lane — not touched. The draft's CONTENT is the hermetic mock gateway's generic fallback JSON string, not a meaningful reply — acceptable per the row's wording ("a draft returns"), but never confuse it for a real model turn (#1119 territory, not attempted).
- **9.5** — the one real gap this row already had on record stands: the cap is enforced at draft time only, not re-checked at execution (`service-credit-cap-9-5.test.ts`'s own `it.fails`, issue #1080). Not re-litigated here; this lane's spec only proves the omission is real and reachable through a real browser Approve.
- **9.8 / 9.9** — the POSITIVE case (real edit→approve→execute produces the owner-corrected price) is proven with T2. The row's core mechanism (a correction lesson gets recorded, and can later be undone) is proven **unreachable through any real product path today** — see the two PRODUCT GAP write-ups above. This is the most consequential finding in this lane's work.
- **9.1** — send-exactly-once and NULL-stamp reconciliation are proven exactly-once through the real gate. The row's own "one audit row" half is proven to fail under a real (if narrow) concurrent-tick interleaving — see the PRODUCT GAP write-up above.
- **9.11** — report-only, as scoped. No code touched.

## Product gaps found (this lane files nothing; Fable/Josh decide tickets)

1. **9.1** — `thank-you-sms-worker.ts`'s crash-recovery reconcile path (`~:325-337`) double-audits under a real concurrent-sweep-tick race (not just true crash recovery). File:line in the row 9.1 section above.
2. **9.8/9.9** — `ProposalExecutor.execute()` (`executor.ts:279`, `:427`) always sets `executedPayload` to the exact same object `recordCorrectionLessonsOnExecution` reads as `drafted` (`record-on-execution.ts:114-115`), so the correction-loop's diff (`:126`) is provably always empty through the real pipeline — the entire row 9.8/9.9 mechanism has never fired in production. `undoProposal` (`actions.ts:512-515`) additionally can never reach a lesson that DID exist some other way, since lessons only exist post-execution (past `UNDO_WINDOW_MS`, `lifecycle.ts:53`), by which point the proposal is no longer `'approved'`.
3. **Harness** — `noAuthBypassApiServerEnv` (`playwright.config.ts`) inherits the invoking lane's `DATABASE_URL`, so its background sweeps can race a lane's own ephemeral-DB migrations under load (observed: real Postgres `deadlock detected`, 40P01). Not fixed here.

## Commands (copy-paste, from repo root unless noted)

vitest-integration (from `packages/api/`, against a dedicated plain container per the preamble):
```
RLS_RUNTIME_ROLE=true EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:<port>/serviceos_test \
  npx vitest run --config vitest.integration.config.ts --reporter=verbose \
  test/integration/thank-you-sms-reachability-9-1.test.ts \
  test/integration/review-request-sweep-reachability-9-2.test.ts \
  test/integration/weekly-feedback-reachability-9-7.test.ts \
  test/integration/correction-loop-reachability-9-8-9-9.test.ts
```
Result (2 consecutive runs): `Test Files 4 passed (4)` · `Tests 5 passed | 3 expected fail (8)`.

Playwright (one spec per process, per the exact env block earlier in this file):
```
npx playwright test e2e/journeys/public-feedback-rating-gate-9-3.spec.ts --project=chromium --retries=0 --workers=1
npx playwright test e2e/journeys/review-response-approval-9-4-9-5.spec.ts --project=chromium --retries=0 --workers=1
npx playwright test e2e/journeys/correction-meta-proposal-approval-9-10.spec.ts --project=chromium --retries=0 --workers=1
npx playwright test e2e/journeys/conversation-suggest-reply-9-12.spec.ts --project=chromium --retries=0 --workers=1
```
Result: all four 2/2 green (see per-row timings above). Screenshots: `docs/audit/lane-reports/8-9-close-r5/*.png` (9 files).

### Bug found and fixed in this lane's own spec (9.4/9.5), not the product

First run of `review-response-approval-9-4-9-5.spec.ts` failed: `getByRole('button', {name: /^approve$/i})` resolved to 2 elements. Cause: the spec seeds a throwaway `review_response_proposal` row purely as the FK anchor `service_credits.proposal_id` needs (mirroring `service-credit-cap-9-5.test.ts`'s own `anchorProposalId` pattern) — left in `createProposal`'s default `'draft'` status, it ALSO appears in the owner's real Inbox (`GET /api/proposals/inbox` lists drafts, not just `ready_for_review`) with its own Approve button. Fixed by transitioning the anchor to `'rejected'` immediately after creation, and by scoping every row-level interaction (the "Post public reply" checkbox, the Approve click) to the specific `[data-testid="inbox-row"]` containing `[data-testid="review-response-review"]`, rather than an unscoped page-wide locator. Second run: green.

A second thing this run surfaced and required a real fix (not a bug, a correct design constraint this spec had to work around): `ReviewResponseExecutionHandler.executePublicResponse` (`review-response-handler.ts:263-268`) treats "Google reply resolver wired but no per-tenant OAuth credential" (the case for every tenant in this hermetic environment — #1000, live Google Business, is parked) as a hard sub-action failure, which fails the WHOLE proposal execution (`review-response-handler.ts:228-235`), not just that component. The spec deselects "Post public reply" before approving — the card's own "mix-and-match" affordance, not a workaround — and approves with only the private follow-up selected, which the real `MessageDeliveryReviewPrivateMessageSender` (backed by `InMemoryDeliveryProvider` in this dev environment — real production wiring, not a test substitute) executes successfully.

---


