# Rivet Voice 19 — Read-only re-measurement

Measured by a fresh, read-only agent per `projects/rivet-voice-19/re-measurement-brief.md`.
No source file was changed to produce this document. All commands were actually run
(Docker-gated integration tests included); results below reflect what executed, not what
the run log claims.

Initial pass was measured at commit `bdd5e20` (branch head when this task started). A
mid-task coordinator message flagged two fixes that landed afterward (`152c5e9`
fix + `7d8fbd4` doc), which were re-verified against the new head. **Final head measured:
`7d8fbd4`.** Where the two commits changed a conclusion, that is called out inline; they
did not change any conclusion except to confirm B1.19's cap stands for an independent
reason (see B1.19 below).

## Headline

**9 / 19 at rung 5.**

Arithmetic, shown rather than asserted:

| Bucket | Count | Rows |
|---|---|---|
| Already at rung 5 in Part E, untouched this run | 2 | B7.1, B7.7 |
| This run's "focus eight" + "restoration four" claimed as rung-5-reaching | 12 | B7.4, B5.3, B8.10, B6.3, B5.5, B1.18, B7.5, B1.19, B4.7, B7.6, B8.1, B9.1 |
| **Verified rung 5** out of that claimed 12 | **7** | B7.4, B5.3, B8.10, B6.3, B5.5, B7.6, B8.1 |
| Capped below 5 — Part F unratified (F-1, F-2) | 2 | B1.18 (→4), B9.1 (→4) |
| Capped below 5 — B7.4 failure-class recurrence found by this measurement | 1 | B1.19 (→3) |
| Capped below 5 — a per-leg proof gap found by this measurement | 1 | B4.7 (→4) |
| Confirmed incomplete (agent cancelled mid-run) | 1 | B7.5 (→2) |
| Deferred five — confirmed unchanged | 5 | B7.8, B7.9, B7.10, B9.4, B9.12 (all →3, matching Part E) |

9 = 2 (unchanged rung-5) + 7 (newly verified rung-5). This is **below** the brief's
anticipated 12–14 range. That range was computed before B7.5's incompleteness was known
and before this measurement's two additional findings (B1.19's team-member sub-flow, B4.7's
create-leg gap). Both are explained in detail below with file:line evidence; I am reporting
what I measured, not adjusting toward the target.

**Part F ratification status:** entries F-1 (B9.1 two-step issuance) and F-2 (B1.18
lock-as-tap) in `docs/PRD-v4-part-F-decisions.md` are both marked **PROPOSED**, written by
the implementation run itself. Neither carries any product-owner sign-off, timestamp, or
approval marker anywhere in the repo. Per the brief's rule ("documentation alone restores
nothing... a Part F entry written by this run is not ratification"), both rows are **red**
regardless of code quality, and are reported at the technical rung the code actually
supports (4 for each — see rows below) rather than at 5.

## 19-row table

Prior rung = `docs/PRD-v4-part-E-state.md` §5. New rung = this measurement, `7d8fbd4`.

| Requirement | Prior | New | Evidence I personally ran/verified | What's missing below 5 |
|---|---|---|---|---|
| **B1.18** Brand voice captured, then locked | 3 | **4** | `packages/api/src/proposals/execution/brand-voice-handler.ts`; `packages/api/src/proposals/contracts/brand-voice.ts` (no `lock` key exists in the schema — verified by reading the file); integration `test/integration/update-brand-voice-voice-execution.test.ts` — ran, **4/4 pass**: version row persisted, exactly one `brand_voice.updated` audit event with actor, cross-tenant scoped-read returns nothing, cooldown fails honestly (never silent skip). | **RED per brief rule**: Part F entry F-2 is PROPOSED, not ratified (`docs/PRD-v4-part-F-decisions.md:31-43`, no ratification marker anywhere). Capture leg is genuinely proven (rung 4); "locked by voice" is impossible by design (no schema key can express it), so under the *literal, unamended* requirement text the row can never reach 5 without ratifying F-2's redefinition of "locked" as by-tap. |
| **B1.19** Conversational onboarding, 10–15 exchanges, clarification loop | 3 | **3** | `test/integration/onboarding-conversation-parity.test.ts` — ran, **passes**, incl. real audit rows for identity/pack/schedule/template and cross-tenant negative. BUT same file, lines 388–409: `onboarding_team_member` proposals are **approved**, then **execution fails** (`result.success` is `false`, `error` contains `'handler_not_wired'`) — asserted by the test itself as intentional. Web fix `packages/web/src/components/auth/ProtectedRoute.tsx` (commit `152c5e9`) + `ProtectedRoute.test.tsx` — ran, **12/12 pass** (was 10) — genuinely fixes a real deadlock (identity-writing proposals lived behind the very gate their approval was supposed to open). `useOnboardingConversation.test.ts` — ran, **6/6 pass** — fixes a real tenant-switch session bug. | Team-member capture reproduces the **exact B7.4 failure-class shape** the brief names explicitly: "Approves but cannot execute is rung 3, not 5." That the failure is *honest* (audited as `proposal.execution_failed`, no fabricated row) doesn't change the shape — the proposal reaches `approved` and then cannot execute. Since the row's own ACs include team capture, the conjunctive row is capped at 3, matching Part E's own precedent for B4.7. Also: no `onboarding_*` payload carries a timezone (an honest gap, not independently disqualifying, but consistent with "not the whole chain"). **The P-8/P-9 web fixes are real and necessary but orthogonal to this cap** — they fix reachability of the FSM itself, not the team-member execution failure. Measured before AND after `152c5e9`; the cap is unchanged either way. |
| **B4.7** Book / move / cancel by speaking | 3 | **4** | `test/integration/reschedule-appointment-voice.test.ts` (3/3) and `cancel-appointment-voice.test.ts` (4/4) — ran, both pass: row change, exactly one audit event with correct actor, cross-tenant negative, AND (via `rivet-voice-19-focus.test.ts`, 8/8 pass) drafting/resolution proof through the real router + `PgEntityResolver` for both verbs. `cancel-appointment-voice.test.ts:310` also sweeps every trust-tier × confidence × supervisor combo through `decideInitialStatus`, with a positive control, proving `cancel_appointment` never auto-approves. | Own finding, not in the run's claims: `test/integration/voice-inbound-appointment.test.ts` (the **create** leg's cited proof) — ran, 2/2 pass — has **no cross-tenant negative test** (grepped the file; only match for "cross" is an unrelated comment about a different lookup path). Under the brief's strict per-leg rung-4 bar, one of the three verbs in this conjunctive requirement lacks the full row+audit+cross-tenant triple, so the row is capped at 4, not 5, despite reschedule/cancel now being fully proven. |
| **B5.3** Assign work (reassign) by speaking | 3 | **5** | `test/integration/reassign-appointment-voice.test.ts` — ran, **5/5 pass**: resolver-provided ids, `appointment.technician_assigned` audit, feasibility gate rejects real conflicts, staleness gate rejects stale baseline, cross-tenant negative. `test/integration/rivet-voice-19-focus.test.ts` — ran, **8/8 pass**, incl. the negative case proving a NAMED reference that matches nothing resolves to `not_found` and never falls back to the tenant's soonest appointment (direct `PgEntityResolver` call AND full router run both assert this). | — |
| **B5.5** "On my way" by app/SMS/voice | 3 | **5** | `test/integration/en-route-voice.test.ts` — ran, **3/3 pass**: `appointment.en_route_triggered` audit with TECH actor (not generic system), real `delay_notice_state` dispatch row, idempotence on a second utterance (same row reused), cross-tenant negative (tenant B tech resolves to "no appointment," zero audit rows). `test/sms/tech-status/en-route-keyword.test.ts` + `test/dispatch/en-route-voice.test.ts` — ran, **19/19 pass**. `git diff origin/main...HEAD -- packages/api/src/workers/voice-action-router.ts` — confirmed additive-only (97 insertions, 0 deletions), branch fires only on `en_route` classification, sits before the RV-071/225 D-013 gate but doesn't affect it. | — |
| **B6.3** Time entries by voice | 3 | **5** | `test/integration/log-time-entry-execution.test.ts` — ran, **4/4 pass**: 120-min row with resolved jobId, exactly one `time_entry.logged_completed` audit with actor, cross-tenant scoped-read negative, `getJobProfit` labor rollup reflects the entry. `rivet-voice-19-focus.test.ts` includes `log_time_entry` in its 5-op corpus (drafting/resolution via real router). | — |
| **B7.1** Push-to-talk from any screen | 5 | **5** (unchanged) | `git diff origin/main...HEAD --name-only` — confirmed no touch to `Shell.tsx`/`VoiceBar` paths; this run made no change here. | — |
| **B7.4** Job notes dictated | 3 | **5** | `test/integration/add-note-voice-execution.test.ts` — ran, **3/3 pass**: note row with verbatim body, exactly one note-created audit with actor, cross-tenant negative. `test/ai/tasks/add-note-voice-task.test.ts` — ran, **37/37 pass**, incl. the permanent regression pin that the pre-fix `targetReference`-without-`targetId` shape can no longer be produced. `test/proposals/voice-payload-contract.test.ts` — ran, **37/37 pass** (C1 red→green transition verified structurally: the run log's captured RED failure message matches the code's stated pre-fix defect). `rivet-voice-19-focus.test.ts` proves the drafting/resolution leg via the real router. | — |
| **B7.5** Parts by speaking (name + qty + unit) | 0 | **2** | Confirmed independently, not taken on the run log's word: migration exists (`packages/api/src/db/schema.ts:6476-6479`, `'265_line_items_unit'`, nullable `unit TEXT` on both line-item tables). Grepped and confirmed **absent**: `unit` field on `lineItemSchema` (`packages/shared/src/contracts/money.ts:20-47` — only `unitPriceCents` exists); `unit` on billing-engine `LineItem` (`packages/api/src/shared/billing-engine.ts:19-58`); any read/write of the column in `catalog-resolver.ts` (grepped — zero matches for a bare `unit` key, only `unitPriceCents`); any parts/materials intent, classifier field, or UI (grepped repo-wide for `spoken-parts`, `SpokenPart` — no matches). No `catalogUnitSchema` exists anywhere despite the migration comment referencing it. | A nullable column that nothing in application code reads or writes. Scored 2 (Present, unreachable) rather than 1, since actual migration code did ship and would run in production — but zero drafting, resolution, classifier, or UI work exists. Cannot be rung 5; the run's own admission of "at best 1–2" is accurate. |
| **B7.6** Spoken line-item to existing estimate | 3 | **5** | `test/integration/update-estimate-execution.test.ts` — ran, **3/3 pass**: new line item persisted with correct integer-cent totals, exactly one `estimate.updated` audit event, cross-tenant negative (scoped-read AND a forged cross-tenant execute attempt). First-ever exercise of `UpdateEstimateExecutionHandler` via the production registry (confirmed: Part E found zero files imported it before). | — |
| **B7.7** Job status by voice | 5 | **5** (unchanged) | `git diff origin/main...HEAD --name-only` — confirmed no touch to `job-edit-task.ts` / `update-job-execution.test.ts` paths. | — |
| **B7.8** Expense by voice *(deferred)* | 3 | **3** (unchanged) | `git diff origin/main...HEAD --name-only` — no file under `LogExpenseTaskHandler`'s path touched; C1 pins its current gating (`voice-payload-contract.test.ts:520-526`, ran, passes). | Deferred per master prompt; unchanged, as required. |
| **B7.9** Read-only lookups by voice *(deferred)* | 3 | **3** (unchanged) | `git diff origin/main...HEAD --name-only` — no touch to voice-lookup files. | Deferred; unchanged. |
| **B7.10** Crew add/remove by voice *(deferred)* | 3 | **3** (unchanged) | `git diff origin/main...HEAD -- packages/api/src/ai/tasks/voice-extended-tasks.ts` — read the diff directly; the only hunk touching this file's `RemoveCrewMemberTaskHandler` region is unchanged context around the `add_note` rewrite, not an edit to the class itself. C1 pins current gating (`voice-payload-contract.test.ts:587-604`, ran, passes). | Deferred; unchanged. |
| **B8.1** Estimate from spoken description or photo | 3 | **5** | `test/integration/draft-estimate-execution.test.ts` — ran, **3/3 pass**: estimate persisted with catalog-grounded integer-cents lines (LLM's 14950¢ overridden by the seeded catalog's 15000¢, `pricingSource: 'catalog'`), exactly one `estimate.created` audit event, cross-tenant negative. Drafted through the real `EstimateTaskHandler`, executed through the production registry (`createExecutionHandlerRegistry`, not constructed directly) — closes the exact false-positive Part E flagged (a comment-only citation). | — |
| **B8.10** Nudge by voice | 3 | **5** | `test/integration/estimate-nudge.test.ts` — ran, **11/11 pass**: the voice-specific describe block constructs `TaskContext.existingEntities: { customerName: 'Khan' }` (free text, not a hand-fed id) and lets the real `SendEstimateNudgeTaskHandler` resolve it against a real Postgres `estimateRepo` query — this is genuine resolution proof, not a hand-built payload. Confirms: real dispatch row, `proposal.executed` + `estimate.reminder_sent` audit events, 48h cooldown holds under a second voice-approved nudge (records suppressed outcome, sends nothing), cross-tenant negative. | — |
| **B9.1** Invoice from a spoken sentence | 3 | **4** | `test/integration/draft-invoice-execution.test.ts` — ran, **7/7 pass** (cents + audit + cross-tenant, pre-existing Part E bar). `test/integration/issue-invoice-conversation-resolution.test.ts` — ran, **3/3 pass**, including the **newly added** cross-tenant negative on the issue transition (Part E explicitly flagged this as missing; now present, lines 244-299: scoped read returns nothing AND a forged cross-tenant execute is rejected). Both legs of the two-step flow are now fully proven. | **RED per brief rule**: Part F entry F-1 is PROPOSED, not ratified. Both draft and issue legs have real rung-4 proof, but whether the two-utterance/two-tap flow satisfies "issued from a spoken sentence" is exactly the unresolved interpretation question F-1 poses — without ratification the row can't be credited at 5. |
| **B9.4** Batch invoice by voice *(deferred)* | 3 | **3** (unchanged) | `git diff origin/main...HEAD --name-only` — no touch to `BatchInvoiceTaskHandler`'s path. C1 pins current gating (`voice-payload-contract.test.ts:374-393`, ran, passes). | Deferred; unchanged. |
| **B9.12** Reminder + late fee by voice *(deferred)* | 3 | **3** (unchanged) | `git diff origin/main...HEAD --name-only` — no touch to `ApplyLateFeeTaskHandler`/`SendPaymentReminderTaskHandler` paths. C1 pins current gating (`voice-payload-contract.test.ts:656-669`, ran, passes). | Deferred; unchanged. |

## The eight-focus-fixture placement question (rivet-voice-19-focus.test.ts)

Verified `packages/api/src/proposals/surface.ts` directly: `S1_ALLOWED_PROPOSAL_TYPES`
(lines 43-52) contains only `create_customer`, `create_appointment`, `create_booking`,
`create_job`, `reschedule_appointment`, `draft_estimate`, `callback`, `voice_clarification`.
`add_note`, `reassign_appointment`, `log_time_entry`, `send_estimate_nudge`,
`update_brand_voice`, `cancel_appointment` are all genuinely absent — confirmed these are
legitimately operator-only (S2) acts, not caller-reachable ones, so placing their fixtures
in an inbound-customer-call corpus (Layer-1) would indeed have been a category error, not
just a harness convenience.

**I find the substitution adequate, with one caveat.** `rivet-voice-19-focus.test.ts`
drives the real `createVoiceActionRouterWorker` with a real `PgEntityResolver` against
seeded Postgres — this is a stronger proof of resolution than the Layer-1 harness (which
the run correctly notes has no entity resolver wired at all) and genuinely closes the gap
decision #9 describes. I ran it (8/8 pass) and independently confirmed the two false-green
fixtures the run says it deleted are in fact gone: `git diff origin/main...HEAD -- packages/api/src/proposals/surface.ts`
is empty (no allowlist widening), and no `S1_ALLOWED_PROPOSAL_TYPES` reference appears in
`text-mode-driver.ts`. The caveat: this sibling harness only covers 5 of the "focus eight"
ops (`add_note`, `reassign_appointment`, `log_time_entry`, `reschedule_appointment`,
`cancel_appointment` — confirmed by the corpus's own sanity-check test, line 449-463). It
does **not** cover `send_estimate_nudge`, `update_brand_voice`, or the onboarding intents —
those three get their resolution proof by a different, also-legitimate mechanism (the task
handler's own real-repo lookup, in the case of B8.10; no resolution needed for B1.18;
conversation-turn state machine, not entity resolution, for B1.19). None of the three fall
back to a hand-built payload, so the standard ("payload must come from the real task
handler") is met in every case I checked, just via more than one mechanism.

## Deferred five — integrity check

`git diff origin/main...HEAD --name-only -- packages/api/src packages/web/src` — read the
full 90-file list directly. Confirmed no file under any deferred handler's path
(`AddCrewMemberTaskHandler`, `RemoveCrewMemberTaskHandler`, `LogExpenseTaskHandler`,
`ApplyLateFeeTaskHandler`, `SendPaymentReminderTaskHandler`, `BatchInvoiceTaskHandler`) is
touched. Read the actual diff hunks in `voice-extended-tasks.ts` (the one file shared with
deferred handlers) line by line — the only real edits are to `AddNoteTaskHandler` and the
reschedule/cancel/reassign/nudge handlers; `RemoveCrewMemberTaskHandler` appears only as
unchanged diff-context. **No scope violation. All five deferred rows confirmed unchanged
at rung 3, matching Part E exactly.**

## D-013 integrity check

`git diff origin/main...HEAD -- packages/api/src/routes/assistant.ts packages/api/src/ai/voice-turn/create-voice-turn-processor.ts packages/api/src/ai/tasks/proposal-approval-task.ts`
— empty, confirming byte-untouched as claimed. `workers/voice-action-router.ts` IS modified
(+97/-0, additive only) for B5.5's `en_route` branch; read the diff, confirmed it fires only
on `classification.intentType === 'en_route'` and sits structurally before, not inside, the
RV-071/225 approval gate.

## On the ProtectedRoute deadlock fix (commit `152c5e9`) — the coordinator asked for scepticism here

The fix is real and necessary: before it, `OnboardingGuard` redirected every non-`/onboarding`
path (including `/inbox`, where approvable proposals live) back to `/onboarding` until the
identity step was done — and the identity step is *written by* approving one of the
conversation's own proposals. That is a genuine deadlock, not a cosmetic bug: a brand-new
tenant using only the conversational path had no way to ever open the CRM. `ProtectedRoute.test.tsx`
ran, 12/12 pass (was 10).

**I am skeptical the fix is scoped as narrowly as it could be.** It exempts the entire
`/inbox` and `/proposals` routes from the soft gate — not just the onboarding-emitted
proposals. For a genuinely brand-new tenant this is low-risk (there is usually nothing else
in the queue yet), but the exemption as written would also expose any *other* proposal that
happened to exist (e.g., a voice channel already live, or a second team member's activity)
before identity is confirmed — the general proposal review surface, including job/customer/
price details on unrelated cards, rather than only the onboarding completion cards. A
narrower fix (filtering the gate exemption to onboarding-sourced proposals specifically, or
routing the completion panel to a dedicated mini-review view) would close the same deadlock
without widening general CRM visibility. I'd flag this as a candidate follow-up, not a
blocker — it doesn't change any rung score above, since B1.19's cap is independently driven
by the team-member execution failure, not by this fix's precision.

## Claims that did not survive verification

This section is not empty.

1. **B1.19 claimed as one of the "focus eight" reaching rung 5** (implicit in the run
   log's "This run claims the eight focus items reached rung 5" framing, brief line 41,
   and the DoD ledger's unqualified "✅ green" for both the backend and web halves). Did
   not survive: `onboarding-conversation-parity.test.ts` itself proves that
   `onboarding_team_member` proposals reach `approved` and then fail execution
   (`handler_not_wired`) — the exact shape the brief names as the B7.4 failure class,
   which the brief says scores 3, not 5. Scored 3.

2. **B4.7 claimed as fully "restored"** with the implication of rung 5 (DoD ledger:
   "✅ restored"). Reschedule and cancel are genuinely restored to full rung-4 proof. But
   the create leg's own cited test (`voice-inbound-appointment.test.ts`, unchanged by this
   run and not re-scrutinized by it) has no cross-tenant negative — a gap this
   measurement found, not one the run flagged. Scored 4, not 5.

Nothing else I checked failed to hold up: every audit-event assertion, every cross-tenant
negative, the C1 red→green transition, the D-013 untouched-file claims, the deferred-five
integrity, the S1-allowlist non-widening claim, the `record_payment` gating deviation, and
the test-count claims I spot-checked (18, 20, 8, 11, 4, 3, 22, 12, 6, 37, etc. — all matched
exactly) all reproduced exactly as the run log describes.

## Commands run (all re-runnable)

```bash
# Environment / diff checks
git log --oneline -5
git status --short
git branch --show-current
git diff origin/main...HEAD -- packages/api/src/routes/assistant.ts packages/api/src/ai/voice-turn/create-voice-turn-processor.ts packages/api/src/ai/tasks/proposal-approval-task.ts
git diff origin/main...HEAD --stat -- packages/api/src/workers/voice-action-router.ts
git diff origin/main...HEAD --name-only -- packages/api/src packages/web/src
git diff origin/main...HEAD -- packages/api/src/ai/tasks/voice-extended-tasks.ts
git diff origin/main...HEAD -- packages/api/src/proposals/surface.ts
git show --stat 152c5e9
git show --stat 7d8fbd4

# Build verification
cd packages/api && npx tsc --project tsconfig.build.json --noEmit

# Docker-gated integration tests (RLS_RUNTIME_ROLE=true, vitest.integration.config.ts)
cd packages/api
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  test/integration/rivet-voice-19-focus.test.ts \
  test/integration/add-note-voice-execution.test.ts \
  test/integration/log-time-entry-execution.test.ts \
  test/integration/reassign-appointment-voice.test.ts

RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  test/integration/estimate-nudge.test.ts \
  test/integration/en-route-voice.test.ts \
  test/integration/update-brand-voice-voice-execution.test.ts

RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  test/integration/reschedule-appointment-voice.test.ts \
  test/integration/cancel-appointment-voice.test.ts \
  test/integration/draft-estimate-execution.test.ts \
  test/integration/update-estimate-execution.test.ts \
  test/integration/issue-invoice-conversation-resolution.test.ts \
  test/integration/draft-invoice-execution.test.ts

RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  test/integration/voice-inbound-appointment.test.ts

# Individual per-file counts (used to cross-check the combined runs above)
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/add-note-voice-execution.test.ts
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/log-time-entry-execution.test.ts
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/reassign-appointment-voice.test.ts
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/rivet-voice-19-focus.test.ts
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/estimate-nudge.test.ts
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/update-brand-voice-voice-execution.test.ts
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/en-route-voice.test.ts
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/reschedule-appointment-voice.test.ts
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/cancel-appointment-voice.test.ts
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/draft-estimate-execution.test.ts
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/update-estimate-execution.test.ts
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/issue-invoice-conversation-resolution.test.ts
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/draft-invoice-execution.test.ts

# Unit / contract tests
cd packages/api
npx vitest run test/proposals/voice-payload-contract.test.ts
npx vitest run test/ai/tasks/add-note-voice-task.test.ts
npx vitest run test/ai/tasks/complaint-task.test.ts
npx vitest run test/sms/tech-status/en-route-keyword.test.ts test/dispatch/en-route-voice.test.ts
npm run test:voice-fixtures

# Web
cd packages/web
npx vitest run src/components/onboarding/v2/steps/ConversationStep.test.tsx src/components/onboarding/v2/steps/ConversationStep.layout.test.tsx src/hooks/useOnboardingConversation.test.ts
npx vitest run src/components/auth/ProtectedRoute.test.tsx
npx vitest run src/hooks/useOnboardingConversation.test.ts

# Schema / contract greps (B7.5)
grep -n "unit" packages/shared/src/contracts/money.ts
grep -rn "interface LineItem" packages/api/src
grep -n "unit" packages/api/src/ai/resolution/catalog-resolver.ts
grep -n "line_items_unit\|265\b" packages/api/src/db/schema.ts
```
