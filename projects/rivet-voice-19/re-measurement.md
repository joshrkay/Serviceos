# Rivet Voice 19 — Read-only re-measurement (THIRD PASS)

Measured by a fresh, read-only agent. No source or test file was changed to produce this
document; the only file written is this one. Scored independently against the C1 done ladder
(0 Absent · 1 Specced · 2 Present · 3 Wired · 4 Proven · 5 Reachable) and the master prompt's
own rung-5 bar: *a spoken sentence produces a persisted row plus an audit event, reachable from
a real surface, proven against real Postgres* — not merely that a handler works given resolved
ids.

**Head measured: `567e846`** (`test(B5.5): de-arrange the en-route integration fixture too`).

**Tree state disclosure.** The working tree was dirty at the start of this audit
(`tenant-settings-proposer.ts`, `en-route-voice.ts`, later `pricing-extractor.ts`), went clean,
and then **HEAD advanced under me during the measurement** to `d4ed0ec` — two further commits
(`1562d25 fix(B5.5): bare "on my way" picks the nearest visit, not the earliest`,
`d4ed0ec test(B1.19): prove the team-member gate clears through the real edit path`) — plus an
**uncommitted +285-line change to `packages/api/src/ai/resolution/pg-entity-resolver.ts`** that
adds a `LEFT JOIN customers` and `strict_word_similarity(needle, c.display_name)` to job
resolution. That in-flight change is, as far as I can tell, precisely the fix for the finding
below. **Everything scored here is the committed state at `567e846`.** The in-flight work is
disclosed as corroboration, not counted.

---

## Headline

**4 / 19 at rung 5.**

Previous pass: 11/19. This is not eleven regressions — **nothing regressed**. It is one
systemic finding (below) that invalidates the single piece of evidence seven rows were resting
on, plus a strict re-application of the brief's own hand-built-payload rule to two rows Part E
had graded generously.

| Bucket | Count | Rows |
|---|---|---|
| **Rung 5** | **4** | B5.5, B7.1, B8.1, B8.10 |
| Rung 4 — capped by unratified Part F (F-1, F-2) | 2 | B1.18, B9.1 |
| Rung 4 — proven, not reachable from a realistic spoken sentence | 8 | B1.19, B4.7, B5.3, B6.3, B7.4, B7.5, B7.6, B7.7 |
| Rung 3 — deferred five, unchanged | 5 | B7.8, B7.9, B7.10, B9.4, B9.12 |

Exact arithmetic: 4 + 2 + 8 + 5 = **19**.

---

## THE FIFTH FALSE GREEN — and it is the biggest one

> **Say it loudly: `test/integration/rivet-voice-19-focus.test.ts` — the one suite built
> specifically to prove "the spoken sentence PRODUCES the resolved id" — seeds every job with
> `summary` set to the literal spoken phrase. In production that column never contains the
> spoken phrase, so four of this run's flagship sentences resolve to nothing.**

### The arrangement

`test/integration/rivet-voice-19-focus.test.ts:182-187`, in the fixture's own words:

> *"Seeds a customer + location + job whose `summary` is set to the **EXACT text** the case's
> extractedEntities reference — the same technique `test/integration/entity-resolution.test.ts`'s
> AC-3 suite uses — to get a **deterministic score-1.0 trigram match**."*

The seeds (`:307`, `:314`, `:325-326`):

```ts
seedJob('Patel',   'the Patel job');     // utterance: "Note on the Patel job — wants morning visits"
seedJob('Johnson', 'the Johnson job');   // utterance: "Assign Carlos to the Johnson job"
seedJob('Garcia',  'the Garcia job');    // utterance: "Move the Garcia job to Thursday at 10"
```

Per `docs/solutions/test-failures/a-fixture-arranged-to-pass-proves-nothing.md`: *"Never let a
test's own comment explain why the data was shaped to match the query. That comment is a defect
report."* This is that comment, verbatim, and it is worse than the four prior instances — those
planted a **name** in a searched column; this plants **the entire spoken phrase, definite
article included**, to force similarity 1.000.

### The production code it hides

`packages/api/src/ai/resolution/pg-entity-resolver.ts:153-186` (`resolveJob`, at `567e846`):

```sql
SELECT id, summary, status, similarity(summary, $2) AS score
  FROM jobs
 WHERE tenant_id = $1 AND similarity(summary, $2) > $3   -- SIMILARITY_PREFILTER = 0.3 (:32)
```

`jobs.summary` is the **only** column consulted. There is no join to `customers`. Thresholds:
`TAU_ENT = 0.8`, `TAU_ENT_CONFIRM_LOW = 0.6` (`ai/resolution/entity-resolver.ts:44,56`); below
0.6 → `not_found`. Named appointment references route through the same function
(`resolveAppointment` → `resolveJob` → `resolveAppointmentsForJobs`, `:330-360`). The non-voice
fallback `candidatesForReference` is the same column by ILIKE
(`ai/resolution/reference-candidates.ts:41,101-113`; `jobs/pg-job.ts:225` maps `search` →
`summary`/`job_number`).

### Measured, not argued

I ran `pg_trgm` in a throwaway `pgvector/pgvector:pg16` container and computed the real scores:

| `similarity(reference, jobs.summary)` | score | outcome |
|---|---|---|
| `'the Patel job'` vs **`'the Patel job'`** *(the fixture)* | **1.000** | resolved ✅ |
| `'the Patel job'` vs `'Patel — seasonal service'` *(the seed `add-note-voice-execution.test.ts:94` itself uses)* | **0.207** | below the 0.3 **prefilter** — not even a candidate ❌ |
| `'the Patel job'` vs `'Water heater repair'` | 0.033 | `not_found` ❌ |
| `'the Garcia job'` vs `'AC repair'` | 0.000 | `not_found` ❌ |
| `'the Johnson job'` vs `'Annual maintenance'` | 0.000 | `not_found` ❌ |

A summary that merely *contains* the customer's name still fails. Only a summary that **is** the
utterance passes.

### What production actually writes into `jobs.summary`

The work, never the customer: `proposals/execution/handlers.ts:480`
(`summary: jobTitle || proposal.summary`) and `:980`
(`payload.summary … || proposal.summary || lineItems[0].description`). No product path ever
stores "the Patel job".

### Consequence, and why it is not a graceful degradation

`not_found` yields zero candidates, so there is no `voice_clarification` picker and no confirm —
the operator gets a card with `Needs: targetId` and **Approve disabled**
(`packages/web/src/components/shared/AIProposalCard.tsx:417-420,503`). The only recovery is the
assistant surface's edit-then-approve text box (`routes/assistant.ts:692,708`), i.e. typing a job
id. `resolve-entity` (`InboxPage.tsx:668-674`) only fires for **ambiguous** candidates, which
never exist here. Nothing is lost — and nothing happens.

### Why the item-level integration tests do not save these rows

The focus suite's own header (`rivet-voice-19-focus.test.ts:11-16`) concedes it:
`add-note-voice-execution.test.ts`, `log-time-entry-execution.test.ts`,
`reassign-appointment-voice.test.ts`, `reschedule-appointment-voice.test.ts` and
`cancel-appointment-voice.test.ts` **all hand-supply the resolved id on
`TaskContext.existingEntities`**. They prove execution given ids — rung 4 exactly. The arranged
corpus was the only resolution proof.

### Rows affected

B7.4 · B6.3 · B5.3 · B4.7 (move/cancel legs) · B7.7 (its gate lift consumes the same
router-resolved `jobId`).

### Corroboration

This is the **same defect, third occurrence**. P-18 fixed it for the nudge by traversing
customer → jobs → estimates (`81a68b8`). P-22 fixed it for en-route by matching the linked
customer (`26f2345`, `dispatch/en-route-voice.ts:99-101,160-173` — substring match on
displayName/companyName/first+last, which is the *right* shape). Neither fix reached the shared
`PgEntityResolver` that every other voice intent depends on. The uncommitted work now on disk
generalizes it — which is the fix this finding calls for.

---

## Secondary finding — the customer leg has a narrower version of the same problem

`resolveCustomer` (`pg-entity-resolver.ts:115-150`) searches the **right** column
(`customers.display_name`) but with the same τ_ent = 0.8 / confirm-floor 0.6 on plain
`similarity()`. Measured:

| spoken → stored | score | outcome |
|---|---|---|
| `Garcia` → `Garcia` *(fixture shape)* | 1.000 | resolved |
| `Patel` → `Raj Patel` | 0.600 | mid-band → confirm (acceptable, one tap) |
| `Garcia` → `Maria Garcia` | 0.583 | **just under the floor → `not_found`** |
| `Khan` → `Khan Household` | 0.333 | `not_found` |

That last row matters for B8.10: the de-arranged nudge fixture speaks
`SPOKEN_CUSTOMER_NAME = 'Khan Household'` (`test/integration/estimate-nudge.test.ts:320,467,486`)
— the customer's **exact** `display_name`. The master prompt's own sentence is *"Nudge the
**Khan** estimate"*, which scores 0.333 and does not resolve. The fixture's utterance was
adjusted to fit the data. I did **not** drop B8.10/B8.1 below 5 for this, because the query hits
the correct column and degrades to a confirm/picker for most real names — but it is a real,
one-line-fixable gap and it belongs in the fix list.

---

## Third finding — free-text document references can never lift the gate

Independent of resolution quality, both edit tasks **always** gate on a free-text reference by
design; only a **repo-verified UUID** lifts the gate:

- `ai/tasks/estimate-edit-task.ts:427-462` — *"Free-text reference (resolved or not) — always
  gated."*
- `ai/tasks/job-edit-task.ts:309-341` — identical.

A verified UUID can only arrive via `existingEntities`, i.e. from `PgEntityResolver` —
`resolveEstimate` (`:236-246`) is **exact `estimate_number` match only**, no fuzzy path at all.
So "Add three capacitors to the **Smith** estimate" is structurally ungateable; only "…to
estimate EST-1042" can work, and **no test exercises that phrasing** (both proofs pass a UUID:
`update-estimate-execution.test.ts:173`, `spoken-parts-edit-unit-execution.test.ts` LLM reply
`estimateReference: estimateId`). This caps B7.6 and B7.5, and is the second independent reason
B7.7 cannot hold rung 5.

---

## 19-row table

Prior rung = second-pass re-measurement at `5f71f79`. New rung = this pass at `567e846`.

| # | Requirement | Part E | 2nd pass | **New** | Moved? | One-line justification (file:line) |
|---|---|---|---|---|---|---|
| B1.18 | Brand voice captured, then locked | 3 | 4 | **4** | no | `docs/PRD-v4-part-F-decisions.md:19-31` (F-2) still **PROPOSED**; brief rule caps at 4 regardless of code. Execution proof itself is sound (`test/integration/update-brand-voice-voice-execution.test.ts`, 4/4). |
| B1.19 | Conversational onboarding | 3 | 4 | **4** | no | Team-member leg still needs a human-typed email; `abff9c7` makes the invite *reach* the teammate but does not make email voice-capturable. Two NEW gates landed since the last pass (`c5454a0` no-hourly-rate, `b9ba8db` no-vertical-pack; `test/ai/orchestration/onboarding-conversation-no-hourly-rate.test.ts`), i.e. *more* human input required, not less. Audit gap partially closed: `user.invitation_created` now asserted at `test/proposals/onboarding-execution-handlers.test.ts:103` (mocked, not integration). |
| B4.7 | Book / move / cancel by speaking | 3 | 4 | **4** | no (new basis) | Create leg's drafting proof is now genuine — `9afe9c7` scripts a **hallucinated** `customerId` the resolver must beat (`fixtures/rivet-voice-19-focus.json` b4-7-create-appointment). But move/cancel resolve "the Garcia job" through `pg-entity-resolver.ts:167-171` and are proven only by the arranged `seedJob('Garcia','the Garcia job')` (`rivet-voice-19-focus.test.ts:325`). Two of three verbs unreachable. |
| B5.3 | Assign work (reassign) by speaking | 3 | **5** | **4** ▼ | **yes, 5→4** | Only resolution proof is `seedJob('Johnson','the Johnson job')` (`rivet-voice-19-focus.test.ts:314`); `reassign-appointment-voice.test.ts` hand-supplies `existingEntities.appointmentId`. Realistic summary → 0.000. The B5.3 negative pin ("Fitzgerald" must not fall back) is real and still valuable — it just proves the *absence* of a wrong answer, not the presence of a right one. |
| B5.5 | "On my way" by app / SMS / voice | 3 | 5 | **5** | no | **The one item whose resolution is realistic and de-arranged.** `en-route-voice.ts:99-101,160-173` matches the linked customer by substring across displayName/companyName/first+last; `test/integration/en-route-voice.test.ts:163-166` seeds `summary: 'AC repair'` for customer `Jamie Garcia` and `:215-225` asserts up front that "garcia" is absent from summary and job number. Ran: 3/3 green. Wired in production (`app.ts:2872-2881` passes `customerRepo`/`jobRepo`/`appointmentRepo` to the router worker; `app.ts:2307` SMS keyword; `voice-action-router.ts:1356-1419`). |
| B6.3 | Time entries by voice | 3 | **5** | **4** ▼ | **yes, 5→4** | `log-time-entry-execution.test.ts` is a clean rung-4 proof (row 120min + audit + cross-tenant + P&L rollup) but hand-supplies `jobId`; "Clock 2 hours on the Patel job" resolves only against `seedJob('Patel','the Patel job')`. Its *own* sibling seed `'Patel — water heater'` (`:112`) scores 0.207 — below the prefilter. |
| B7.1 | Push-to-talk from any screen | 5 | 5 | **5** | no | UI capability, no entity-resolution leg. `git diff 5b5538d..567e846 --name-only` — no touch to `Shell.tsx`/`VoiceBar.tsx`. |
| B7.4 | Job notes dictated | 3 | **5** | **4** ▼ | **yes, 5→4** | The contract fix is real and well-tested (`add-note-voice-execution.test.ts` 3/3: verbatim body, one audit event, cross-tenant negative) — but it hand-supplies `jobId` (`:94` seeds `summary: 'Patel — seasonal service'`, which scores 0.207 and would itself fail). The requirement's own sentence, "Note on the Patel job", cannot resolve for any realistic tenant. |
| B7.5 | Parts by speaking (name + qty + unit) | 0 | 2 | **4** ▲ | **yes, 2→4** | Genuine two-rung move. The last pass's finding ("no live path carries a unit to a row") is fixed: `be4d87a` stamps the catalog unit in `edit-action-grounding.ts` and removes the `normalizeDraftLineItems` whitelist drop (`handlers.ts`); `76f40fa` mirrors it for invoices. `test/integration/spoken-parts-edit-unit-execution.test.ts` drives the **real** `EstimateEditTaskHandler` + real `PgCatalogItemRepository` + real grounding → production registry → asserts the raw `estimate_line_items.unit` column, catalog-beats-LLM, uncatalogued-stays-NULL, audit event, cross-tenant negative (`:239,296,323,359,401`) — and `unit:'each'` is a value the test's LLM mock never supplies, so it cannot pass with grounding broken. Capped below 5: a **spoken** unit is deliberately unrepresentable (catalog is the only source — AC-3's "two hours of labor" gets no unit unless catalogued), the customer approval page renders no unit (`components/customer/EstimateApprovalPage.tsx` — no `unit`; AC-6 half-built), C1 has no parts/unit row (`voice-payload-contract.test.ts:311-351`), and targeting a named document is ungateable (third finding). |
| B7.6 | Spoken line-item to existing estimate | 3 | **5** | **4** ▼ | **yes, 5→4** | `update-estimate-execution.test.ts` is a real first-ever proof of `UpdateEstimateExecutionHandler` — but its drafting leg passes `estimateReference: estimateId`, a **UUID** (`:173`). No spoken sentence produces a UUID, and free text never lifts the gate (`estimate-edit-task.ts:427-462`). The only workable phrasing (exact estimate number) is untested. |
| B7.7 | Job status by voice | 5 | 5 | **4** ▼ | **yes, 5→4 (overturns a Part E green)** | Two independent grounds. (1) `test/integration/update-job-execution.test.ts:221` **hand-builds** `payload: { jobId, status }` — the drafting task is never driven, so by the brief's own rule the drafting leg is unproven. (2) Gate lift requires a repo-verified UUID (`job-edit-task.ts:309-341`) sourced from the same summary-only resolver; the free-text fallback is the same column by ILIKE (`reference-candidates.ts:101-113`). Part E's own note already flagged "gate lift is LLM-echo-dependent" (`PRD-v4-part-E-state.md:132`); the prompt carries no job list (`job-edit-task.ts:344-351`), so the echo can only come from `existingEntities`. Not caused by this run. |
| B7.8 | Expense by voice *(deferred)* | 3 | 3 | **3** | no | `git diff 5b5538d..567e846 -- voice-extended-tasks.ts` touches no `LogExpenseTaskHandler` line. |
| B7.9 | Read-only lookups *(deferred)* | 3 | 3 | **3** | no | No handler touched; only cassette regenerations (see integrity §2). |
| B7.10 | Crew add/remove *(deferred)* | 3 | 3 | **3** | no | No `AddCrewMember`/`RemoveCrewMember` line changed. |
| B8.1 | Estimate from spoken description | 3 | 5 | **5** | no | `draft-estimate-execution.test.ts` drives the real `EstimateTaskHandler` (`:167`) with catalog grounding overriding the LLM's price. Resolution is by `customers.display_name` — the correct column, degrading to a confirm/picker. Flagged: surname-only against a stored full name can fall just under the 0.6 floor (0.583). |
| B8.10 | Nudge by voice | 3 | 5 | **5** | no | The third false green is genuinely fixed: `81a68b8` adds `send_estimate_nudge` to `CUSTOMER_REF_INTENTS` (`ai/agents/customer-calling/entity-resolution.ts:54`) and traverses customer → jobs → estimates; the fixture no longer plants the name in `customer_message` (`estimate-nudge.test.ts:398-407`), the real `PgEntityResolver` runs (`:460-470`), 11/11 green. Flagged: the utterance was changed to the customer's exact `display_name` ("Khan **Household**"), so "Nudge the Khan estimate" (0.333) is still unproven and would not resolve. |
| B9.1 | Invoice from a spoken sentence | 3 | 4 | **4** | no | `docs/PRD-v4-part-F-decisions.md:1-17` (F-1) still **PROPOSED**; capped at 4 by the brief's non-negotiable rule. Proof leg (cross-tenant negative on the issue transition) exists. |
| B9.4 | Batch invoice *(deferred)* | 3 | 3 | **3** | no | No touch. |
| B9.12 | Reminder + late fee *(deferred)* | 3 | 3 | **3** | no | No touch. |

▼ = moved down. ▲ = moved up.

**Movement summary:** down — B5.3, B6.3, B7.4, B7.6, B7.7 (all from the fifth false green
and/or hand-built drafting legs). Up — B7.5 (2 → 4). Unchanged — everything else.

---

## Integrity checks

### 1 · D-013 — INTACT

`git diff 5b5538d..567e846` on the four enforcement sites:

| Site | Diff |
|---|---|
| `routes/assistant.ts` | **empty** |
| `ai/voice-turn/create-voice-turn-processor.ts` | **empty** |
| `ai/tasks/proposal-approval-task.ts` | **empty** |
| `workers/voice-action-router.ts` | **+102 / −0** — additive only, zero deletions |

Every added line in the router belongs to the `en_route` block and the `customerRepo` thread;
grepping the diff for `approve|reject|edit_proposal|isVoiceApproval|RV-071|RV-225|ownerSession`
returns **nothing**. All gates present at HEAD: `voice-action-router.ts:1423-1434`
(RV-071/RV-225 hard routing gate), `routes/assistant.ts:1057-1079`
(`assistant.voice_approval_refused`), `create-voice-turn-processor.ts:2040+` (ownerSession
origin), `proposal-approval-task.ts`. **`proposals/surface.ts` diff is empty** —
`S1_ALLOWED_PROPOSAL_TYPES` was never widened, so the two deleted Layer-1 fixtures (#8b/#8c)
left no production trace. No verdict here rests on a caller-reachability claim the allowlist
refuses.

### 2 · Deferred five + boot-guard + UTC datetime — STILL DEFERRED

- No `AddCrewMemberTaskHandler` / `RemoveCrewMemberTaskHandler` / `LogExpenseTaskHandler` /
  `ApplyLateFeeTaskHandler` / `SendPaymentReminderTaskHandler` / `BatchInvoiceTaskHandler` line
  changed in `voice-extended-tasks.ts`; the only diff hits are two comment references.
- **Cassettes: 66 changed, `M` = 66, `A` = 0.** Verified directly
  (`git diff 5b5538d..567e846 --name-status -- src/ai/voice-quality/corpus/cassettes | awk … | uniq -c`).
  The `log-expense-*` and eleven `lookup-*` filenames are regenerations (the cassette key is a
  sha256 over the full system prompt, so adding any intent re-keys the corpus), not new
  deferred-path fixtures. `npm run voice-quality` → **67/67, `launchGate.pass=true`** — same
  count as the pre-run baseline, confirming no fixture was added or removed on net.
- Boot-guard default-fail (C2) and the live-call UTC datetime fix: no implementation found.
  **Flag per the master prompt:** no focus item's fixture depends on the live-call datetime bug —
  the one spoken-datetime path (B4.7 reschedule / create) threads an explicit tenant timezone
  and a fixed `now` (`rivet-voice-19-focus.test.ts:76-78`, asserting
  `scheduledStart: 2026-08-06T15:00:00.000Z` for "Thursday at 10 AM" in `America/Chicago`).

### 3 · Held commits — three, all auth-surface, all isolated

| Commit | Subject | Files | Verdict |
|---|---|---|---|
| `4db3e13` | `[HELD: auth] fix(proposals): dispatchers cannot approve config-writing proposals` | `proposals/actions.ts`, `brand-voice-handler.ts`, `handlers.ts`, `onboarding-handlers.ts` + tests | Isolated — authorization only |
| `370c0fe8` | `[HELD: auth] fix(proposals): audit the approver of a config write, not the drafter` | `db/schema.ts` (migration 266, `proposals.executed_by_role`), `actions.ts`, `pg-proposal.ts`, `proposal.ts`, `execution-worker.ts` + tests | Isolated — attribution + one nullable column |
| `abff9c7` | `[HELD: auth] fix(B1.19): a spoken team-member invite must actually reach the teammate` | `app.ts`, `handlers.ts`, `onboarding-handlers.ts`, `routes/users.ts`, new `users/invite-team-member.ts` + tests | Isolated — user provisioning |

`git log … -- proposals/actions.ts db/migrations routes/users.ts` returns **only these three
commits**, so no unheld commit touched the money/RLS/auth surface. One nit: `fd99030
test(db): snapshot migration 266` is the immutability snapshot for `370c0fe8`'s migration and
merged unheld — test-only, but it is the reviewer's tripwire for that held migration and would
ideally travel with it.

### 4 · Part F — F-1 and F-2 both still PROPOSED

| Entry | Subject | Status | Consequence |
|---|---|---|---|
| F-1 | B9.1 issuance semantics (two-step reading) | **PROPOSED** | **B9.1 cannot exceed 4** |
| F-2 | B1.18 lock-as-tap amendment | **PROPOSED** | **B1.18 cannot exceed 4** |
| F-3 | B5.5 direct audited status act | RECORDED | — |
| F-4 | B7.5 parts land on billing documents | RECORDED | — |
| F-5 | B1.19 wizard remains default | RECORDED | — |
| F-6 | Deferred-set integrity | RECORDED | — |

No ratification marker (sign-off, timestamp, approver) exists anywhere in the repo for F-1 or
F-2. Both caps applied.

### 5 · Gates, re-run by me at `567e846`

| Gate | Result |
|---|---|
| `npx tsc --project tsconfig.build.json --noEmit` | exit 0 |
| `npx vitest run` (api unit) | **1059 files / 12167 tests passed**, 5 files + 12 tests skipped, 6 expected-fail, 38 todo |
| `npm run voice-quality` | 67/67, `launchGate.pass=true` |
| C1 `voice-payload-contract.test.ts` | 37/37 |
| Integration (Docker, real container verified spinning up): `rivet-voice-19-focus`, `estimate-nudge`, `en-route-voice`, `spoken-parts-edit-unit-execution`, `voice-inbound-appointment` | 5 files / 35 tests passed |

Everything the run claims is green **is** green. The problem is not red tests; it is what two of
the green ones are testing.

---

## What a fix would need

Ordered by leverage.

1. **Resolve a job by its linked customer, in the shared resolver.** `resolveJob`
   (`pg-entity-resolver.ts:153-186`) must `LEFT JOIN customers c ON c.id = j.customer_id` and
   score against `display_name` as well as `summary` — the generalization of the fix
   `26f2345` already shipped for en-route and `81a68b8` shipped for the nudge. *(An uncommitted
   change on disk now does exactly this, including `strict_word_similarity`, which also lifts
   the surname problem in §Secondary. Not counted here; verify and re-measure once committed.)*
2. **De-arrange `rivet-voice-19-focus.test.ts`.** Replace `seedJob('Patel','the Patel job')`
   with an ordinary summary (`'Seasonal service'`), and add the same up-front guard
   `en-route-voice.test.ts:215-225` uses — assert the spoken token is absent from `summary` and
   `job_number` — so the planting cannot creep back. Do the same for
   `entity-resolution.test.ts:433,541`. Mutation-test both.
3. **Fix the customer confirm floor.** `similarity('Garcia','Maria Garcia') = 0.583` falls just
   under `TAU_ENT_CONFIRM_LOW = 0.6`, so a surname against a stored full name is `not_found`
   instead of a one-tap confirm. `strict_word_similarity`, or word-level matching, fixes it.
   Then change `estimate-nudge.test.ts:320` to speak `'Khan'`, not `'Khan Household'`.
4. **Give a `not_found` reference a picker.** Today it is a dead card (Approve disabled, no
   candidates, no resolve-entity path). Emitting a short candidate list — or a searchable
   entity picker on the review card — turns every one of these failures into the one-tap
   outcome the north star describes.
5. **Prove the workable document phrasing.** No test speaks an estimate/invoice *number*, which
   is the only phrasing that can lift `estimate-edit-task.ts:427-462`. Add one, or make an
   unambiguous free-text match lift the gate deliberately (a security decision, not a bug fix).
6. **B7.5 residue:** render `unit` on `EstimateApprovalPage.tsx` (AC-6 is half-built), add a
   parts/unit row to `voice-payload-contract.test.ts`, and record in Part F that a **spoken**
   unit is out of scope by design (the catalog is the only source) so the requirement's text
   and the build agree.
7. **B7.7 needs a drafting-leg proof at all** — `update-job-execution.test.ts:221` hand-builds
   its payload; nothing drives `JobEditTaskHandler` against real Postgres.
8. **B1.19's `user.invitation_created`** is asserted only in a mocked test
   (`onboarding-execution-handlers.test.ts:103`); the real-Postgres completion path still has
   row proof without audit proof.
9. **Ratify or reject F-1 and F-2.** Two rows are sitting at 4 purely for want of a signature.

---

## Claims that did not survive verification

1. **`rivet-voice-19-focus.test.ts`'s central claim** — *"the corpus proves the spoken free-text
   reference produces the resolved id end to end"* (fixture JSON `description`). It proves that
   only for a tenant whose job summary is the utterance. **This is the fifth false green.**
2. **`entity-resolution.test.ts`'s AC-3 suite** — same technique, cited by the focus suite as
   precedent (`:433`, `:541`). The precedent is the problem.
3. **B8.10's "de-arranged" claim** is true of the *estimate* (the name is genuinely out of
   `customer_message`) but the utterance was moved to the customer's exact `display_name`. The
   arrangement migrated from the data to the sentence.
4. **B7.6's restoration to rung 5** rests on a drafting leg fed a UUID
   (`update-estimate-execution.test.ts:173`) — the brief's own rule excludes it.
5. **Part E's B7.7 rung 5** does not hold up: its cited proof hand-builds the payload.

Everything else the run claimed reproduced exactly: the C1 red→green transition, the
D-013 posture, the held-commit isolation, the cassette-regeneration explanation, the deferred
five, B7.5's unit plumbing and its money-safety assertions, B5.5's de-arrangement, and B4.7's
hallucinated-id create-leg proof.

---

## Commands run (all re-runnable, all read-only)

```bash
git rev-parse HEAD; git status --short; git log --oneline 5f71f79..HEAD
git diff 5b5538d..567e846 --stat -- packages/
git diff 5b5538d..567e846 -- packages/api/src/routes/assistant.ts \
  packages/api/src/ai/voice-turn/create-voice-turn-processor.ts \
  packages/api/src/ai/tasks/proposal-approval-task.ts packages/api/src/proposals/surface.ts   # empty
git diff 5b5538d..567e846 -- packages/api/src/workers/voice-action-router.ts | grep -c '^+'   # 102, 0 deletions
git diff 5b5538d..567e846 --name-status -- packages/api/src/ai/voice-quality/corpus/cassettes \
  | awk '{print $1}' | sort | uniq -c                                                        # 66 M, 0 A
git log --oneline --grep='^\[HELD:' 5b5538d..567e846
git log --oneline 5b5538d..567e846 -- packages/api/src/proposals/actions.ts \
  packages/api/src/routes/users.ts                                                           # only HELD commits

cd packages/api
npx tsc --project tsconfig.build.json --noEmit                                                # exit 0
npx vitest run                                                                                # 1059 files / 12167 tests
npm run voice-quality                                                                         # 67/67, launchGate.pass=true
npx vitest run test/proposals/voice-payload-contract.test.ts                                  # 37/37
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  test/integration/rivet-voice-19-focus.test.ts test/integration/estimate-nudge.test.ts \
  test/integration/en-route-voice.test.ts test/integration/spoken-parts-edit-unit-execution.test.ts \
  test/integration/voice-inbound-appointment.test.ts                                          # 35/35

# The measurement that decided the headline — pg_trgm scores, throwaway container
docker run --rm -d --name simprobe -e POSTGRES_PASSWORD=x pgvector/pgvector:pg16
docker exec simprobe psql -U postgres -c "CREATE EXTENSION pg_trgm;"
docker exec simprobe psql -U postgres -c "
  SELECT similarity('the Patel job'::text,'the Patel job'::text),          -- 1.000  (fixture)
         similarity('the Patel job'::text,'Patel — seasonal service'::text),-- 0.207 (below prefilter)
         similarity('the Garcia job'::text,'AC repair'::text),              -- 0.000
         similarity('Khan'::text,'Khan Household'::text),                   -- 0.333
         similarity('Garcia'::text,'Maria Garcia'::text);"                  -- 0.583
docker rm -f simprobe
```
