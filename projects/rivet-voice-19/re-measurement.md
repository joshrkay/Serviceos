# Rivet Voice 19 — Read-only re-measurement (FOURTH PASS)

Measured by a fresh, read-only agent. No source or test file was changed to produce this
document; the only file written is this one. All mutation testing was done in a **detached git
worktree** which has been removed (verified: `git worktree list` shows only the main tree).
Scored independently against the C1 done ladder (0 Absent · 1 Specced · 2 Present · 3 Wired ·
4 Proven · 5 Reachable) and the master prompt's own rung-5 bar: *a spoken sentence produces a
persisted row plus an audit event, reachable from a real surface, proven against real Postgres*
— not merely that a handler works given resolved ids.

**Head measured: `42adb1c`** (`docs(rivet-voice-19): correct an overclaiming commit message
(P-29) and record P-30`). Previous pass measured `567e846`.

**Tree state disclosure.** The working tree was clean when this audit began. At **09:37–09:39
UTC, mid-audit**, an agent other than me wrote uncommitted changes into the shared tree:
`packages/api/src/estimates/public-estimate-service.ts`,
`packages/web/src/components/customer/EstimateApprovalPage.tsx`,
`packages/web/src/components/estimates/EstimatesPage.tsx`,
`packages/web/src/components/invoices/InvoicesPage.tsx`, `packages/web/src/lib/estimatePdf.ts`,
plus three new untracked test files. I wrote none of them (I made no Write/Edit call outside this
document). They appear to be the B7.5 AC-6 `unit`-rendering build. **Everything scored below is
the committed state at `42adb1c`.** The in-flight work is disclosed as corroboration of the B7.5
gap, not counted.

---

## Headline

**7 / 19 at rung 5.**

Previous pass: 4/19. Three rows moved up — B7.4, B6.3 and B4.7 — because `446d486`'s resolver
fix and de-arrangement are **real, load-bearing and mutation-verified** (below). Nothing moved
down. Two rows that the previous pass expected to move (B5.3 and, transitively, the reassign
half of the focus corpus) did **not**, because a seventh false green sits underneath them.

| Bucket | Count | Rows |
|---|---|---|
| **Rung 5** | **7** | B4.7, B5.5, B6.3, B7.1, B7.4, B8.1, B8.10 |
| Rung 4 — capped by unratified Part F (F-1, F-2) | 2 | B1.18, B9.1 |
| Rung 4 — proven, not reachable from a realistic spoken sentence | 5 | B1.19, B5.3, B7.5, B7.6, B7.7 |
| Rung 3 — deferred five, unchanged | 5 | B7.8, B7.9, B7.10, B9.4, B9.12 |

Exact arithmetic: 7 + 2 + 5 + 5 = **19**.

---

## THE SEVENTH FALSE GREEN — say it loudly

> **The B5.3 flagship sentence is "Assign *Carlos* to the Johnson job." The integration fixture
> that claims to prove it feeds the resolver `"Carlos Vega"` — the technician's full stored name,
> a surname the transcript never contains. `resolveTechnician` is the **one** resolution path
> `7395d49` and `446d486` did not widen: it is still plain whole-string `similarity()`.
> `similarity('Carlos Vega','Carlos') = 0.583`, under the 0.60 confirm floor → `not_found` → the
> proposal gates on `toTechnicianId` and cannot be approved. The arrangement did not go away in
> `446d486`; it moved off the job and onto the technician.**

### The run's own classifier contract is the witness

The run shipped a launch fixture for the **identical utterance**
(`test/ai/orchestration/intent-classifier.launch-fixtures.test.ts:186-193`):

```ts
file: 'reassign-carlos-johnson-job.json',
stub: { intentType: 'reassign_appointment', confidence: 0.9,
        extractedEntities: { targetTechnicianName: 'Carlos', appointmentReference: 'the Johnson job' } },
```

`'Carlos'`. The resolution fixture for the same sentence
(`test/integration/fixtures/rivet-voice-19-focus.json:37,43`) says `'Carlos Vega'`. **Two
fixtures for one sentence disagree about what the classifier produces, and only the one that
contradicts the classifier contract passes.** No LLM can extract a surname that is not in the
transcript; the launch fixture is the correct model of reality and the integration fixture is
not.

### The production code

`packages/api/src/ai/resolution/pg-entity-resolver.ts:924-945` — `resolveTechnician`, verbatim,
at HEAD:

```sql
SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS full_name, role,
       similarity(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), $2) AS score
  FROM users
 WHERE tenant_id = $1 AND role IN ('technician','dispatcher','owner') AND deleted_at IS NULL
   AND similarity(TRIM(...), $2) > $3
```

No `strict_word_similarity`. Compare `resolveCustomer` (`:218-222`) and `resolveJob`
(`:302-306`), both of which `7395d49`/`446d486` gave
`GREATEST(similarity, strict_word_similarity)` for **exactly this reason**, documented in their
own comments (`:196-217`, `:266-281`). Thresholds unchanged: `TAU_ENT = 0.8`,
`TAU_ENT_CONFIRM_LOW = 0.6` (`ai/resolution/entity-resolver.ts:44,56`).

### Measured, not argued

`pgvector/pgvector:pg16` + `pg_trgm`, throwaway container:

| expression | score | outcome |
|---|---|---|
| `similarity('Carlos Vega','Carlos Vega')` *(what the fixture speaks)* | **1.000** | resolved ✅ |
| `similarity('Carlos Vega','Carlos')` *(what a real transcript yields)* | **0.583** | below 0.60 → **`not_found`** ❌ |
| `strict_word_similarity('Carlos','Carlos Vega')` *(the fix, not applied here)* | 1.000 | would resolve |

### Mutation test (detached worktree, since removed)

Changed **only** the fixture — `"targetTechnicianName": "Carlos Vega"` → `"Carlos"` — nothing
else:

```
FAIL b5-3-reassign-appointment: expected [ 'toTechnicianId' ] to deeply equal []
FAIL b5-3-negative-named-reference-must-not-fall-back:
     payload.toTechnicianId: expected undefined to be '933606ce-…'
```

`ReassignAppointmentTaskHandler` (`ai/tasks/voice-extended-tasks.ts:446-455`) pushes
`'toTechnicianId'` onto `missingFields` when the name did not resolve, so the drafted proposal is
**not approvable** and the spoken sentence produces no row.

### It is untested everywhere, not just here

Every technician-resolution test in the repo speaks a **full** name:
`test/integration/entity-resolution.test.ts:225` (`'Carlos Rodriguez'`), `:241`
(`'Mikhail Petrovski'`), `:255` (`'Dana Whitfield'`), `:273` (`'Ghost Departed'`), `:281`
(`'Priya Natarajan'`), `:292` (`'Felix Okonkwo'`). The AC-4 picker test added by `446d486`
(`:666-680`) states the arrangement in its own comment — *"deliberately IDENTICAL full names …
instead of depending on a first-name-only fuzzy score landing in a particular confidence
band"* — which per `docs/solutions/test-failures/a-fixture-arranged-to-pass-proves-nothing.md`
is a defect report, not a design note. **Not one test resolves a technician by the first name a
person actually says.**

**Blast radius:** `TECHNICIAN_REF_INTENTS` =
`{reassign_appointment, add_crew_member, remove_crew_member}`
(`ai/agents/customer-calling/entity-resolution.ts:127-131`). The latter two are deferred, so the
only scored casualty is **B5.3**, which stays at 4. **The fix is one `GREATEST(...,
strict_word_similarity($2, full_name))` in `resolveTechnician`, mirroring `resolveCustomer`.**

---

## What DID move — and it is genuine

`446d486`'s two halves both hold up under adversarial checking.

**The de-arrangement is real.** `rivet-voice-19-focus.test.ts` now seeds ordinary summaries —
`'AC repair'` (`:349`), `'Water heater replacement'` (`:356-359`), `'Seasonal maintenance'`
(`:369-372`) — with the customer's name only on the customer row, and a **first-declared guard
case** (`:427-450`) asserts for all three seeds that the spoken surname appears in neither
`summary` nor `job_number`, and that it *does* reach the customer row. The fixture's
`extractedEntities` carry bare free text (`"jobReference": "the Patel job"`), never ids.

**The resolver fix is load-bearing.** Mutation test in the detached worktree — multiplied the two
`strict_word_similarity` terms in `resolveJob`'s `SCORE_EXPR` (`:302-306`) by zero, leaving the
`LEFT JOIN customers` (`:317-319`) in place:

```
× b7-4-add-note            expected [ 'targetId' ]      to deeply equal []
× b5-3-reassign-appointment expected [ 'appointmentId' ] to deeply equal []
× b6-3-log-time-entry       expected [ 'jobId' ]         to deeply equal []
× b4-7-reschedule-appointment expected [ 'appointmentId' ] to deeply equal []
× b4-7-cancel-appointment     expected [ 'appointmentId' ] to deeply equal []
```

Five of six positive cases die without it. This is not a test passing for the wrong reason.

**B8.10's arrangement genuinely migrated back out of the sentence.** `7395d49` changed the spoken
name to `SPOKEN_CUSTOMER_NAME = 'Khan'` (`test/integration/estimate-nudge.test.ts:339`) against
`CUSTOMER_DISPLAY_NAME = 'Khan Household'` (`:322`), and added a sibling suite pinning
`'Khan'` → `'Aisha Khan'` (surname-last) and `'Khan'` ↛ `'Priya Khanna'` (prefix-sharing,
`:742-760`). Measured: `strict_word_similarity('Khan','Khan Household') = 1.000`,
`('khan','Khanna Enterprises') = 0.500` — resolves the right one, refuses the wrong one.

**Production wiring is real, not harness-only.** `app.ts:1723-1745` (recording → transcription →
`queue.send('voice_action_router', …)`) → `app.ts:2882-2884` (worker registered) →
`app.ts:2749,2808,2811` (`entityResolver: sharedEntityResolver`, `jobRepo`, `appointmentRepo`),
where `sharedEntityResolver` is `AliasFirstEntityResolver` over `PgEntityResolver`
(`app.ts:2723-2727`) and delegates on any reference with no alias
(`ai/resolution/alias-first-entity-resolver.ts:48-51`). The SCH-03 `jobId` anchor survives the
delegation at runtime (`entity-resolution.ts:404-409` spreads it onto the same object).

---

## Findings that carried over unchanged

**Free-text document references still cannot lift the gate.** Only a **repo-verified UUID** does:
`ai/tasks/estimate-edit-task.ts:427-460` (*"Free-text reference (resolved or not) — always
gated"*) and `ai/tasks/job-edit-task.ts:309-341` (identical). `resolveEstimate`
(`pg-entity-resolver.ts:396-415`) is exact `estimate_number` match only. So "Add three capacitors
to the **Smith** estimate" is structurally ungateable, and no test speaks an estimate/invoice
*number* — the one phrasing that could work. Caps **B7.6**, **B7.5**, and is the second
independent reason **B7.7** cannot hold rung 5.

**B7.7 still has no drafting-leg proof at all.** `test/integration/update-job-execution.test.ts:221`
hand-builds `payload: { jobId, status: 'canceled' }`; grep confirms **zero** integration tests
import `JobEditTaskHandler`. Gate lift would require the LLM to echo the resolver's UUID out of
the "Classifier hints" blob (`job-edit-task.ts:347-348`) — non-deterministic by construction.

**B7.5 AC-6 is half-built at HEAD.** `packages/web/src/components/customer/EstimateApprovalPage.tsx`
renders no `unit` (only `unitPriceCents`, `:49,842`), and C1 has no parts/unit row
(`test/proposals/voice-payload-contract.test.ts:311-351` — `update_invoice`/`update_estimate`
line items carry `description/quantity/unitPrice/category`, no `unit`). *(The uncommitted
mid-audit changes on disk appear to be exactly this build; not counted.)*

**B1.19's team leg still requires a typed email.** `d4ed0ec` improved the parity test by driving
the real `editProposal` → `approveProposal` path
(`test/integration/onboarding-conversation-parity.test.ts:450-484`) — but what it now proves is
that an **operator types `carlos@example.com`** to clear the gate. That is *more* evidence for the
cap, not less. `user.invitation_created` is still asserted only in a mocked test
(`test/proposals/onboarding-execution-handlers.test.ts:103`); the real-Postgres audit assertions
cover `tenant.identity_set` / `tenant.pack_activated` / `estimate_template.created` /
`proposal.execution_failed` (`onboarding-conversation-parity.test.ts:523-546`), not the
invitation.

---

## 19-row table

Prior rung = third-pass re-measurement at `567e846`. New rung = this pass at `42adb1c`.

| # | Requirement | 3rd pass | **New** | Moved? | One-line justification (file:line evidence) |
|---|---|---|---|---|---|
| B1.18 | Brand voice captured, then locked | 4 | **4** | no | `docs/PRD-v4-part-F-decisions.md:33-45` (F-2) still **PROPOSED**; the brief's rule caps at 4 regardless of code. Execution proof itself is sound (`test/integration/update-brand-voice-voice-execution.test.ts`, in the 192-file green run). |
| B1.19 | Conversational onboarding | 4 | **4** | no | Team-member leg still needs a human-typed email — now proven so, through the real edit path (`onboarding-conversation-parity.test.ts:450-484`). `user.invitation_created` audit still only mocked (`test/proposals/onboarding-execution-handlers.test.ts:103`). |
| B4.7 | Book / move / cancel by speaking | 4 | **5** ▲ | **yes, 4→5** | All three legs now close against real Postgres. Create: single-file end-to-end (`voice-inbound-appointment.test.ts:370-527` — free text → real `PgEntityResolver` → real drafting task with a **hallucinated** `customerId` the resolver must beat → approve → production registry → row + one audit with actor + cross-tenant negative). Move/cancel: resolution proven on realistic seeds (`rivet-voice-19-focus.test.ts:369-372` seeds `'Seasonal maintenance'` for `Jamie Garcia`; guard at `:427-450`; mutation-verified load-bearing) and execution proven at the same `existingEntities.appointmentId` seam (`reschedule-appointment-voice.test.ts`, `cancel-appointment-voice.test.ts`). |
| B5.3 | Assign work (reassign) by speaking | 4 | **4** | no (new reason) | **Seventh false green.** Appointment half is genuinely fixed; the **technician** half is not. Fixture speaks `'Carlos Vega'` (`fixtures/rivet-voice-19-focus.json:43,178`) while the run's own classifier fixture says `'Carlos'` (`intent-classifier.launch-fixtures.test.ts:192`). `resolveTechnician` (`pg-entity-resolver.ts:930-943`) is plain `similarity()`; `similarity('Carlos Vega','Carlos') = 0.583 < 0.60` → `not_found` → `missing.push('toTechnicianId')` (`voice-extended-tasks.ts:453`). Mutation-confirmed. |
| B5.5 | "On my way" by app / SMS / voice | 5 | **5** | no | Still the most honestly-resolved item. Improved since last pass, not weakened: `daeb490` bounds the **named** branch to the tenant-local service day (`dispatch/en-route-voice.ts:233-246` — a named reference used to ETA-text a customer a day early), `1562d25` picks the visit nearest *now* rather than earliest (`:267-286`). Customer-linked matching + up-front absence guard unchanged (`test/integration/en-route-voice.test.ts`). |
| B6.3 | Time entries by voice | 4 | **5** ▲ | **yes, 4→5** | "Clock 2 hours on the Patel job" now resolves against a realistic seed (`rivet-voice-19-focus.test.ts:349` = `'AC repair'`, customer `Ravi Patel`; `strict_word_similarity('patel','Ravi Patel') = 1.000`), mutation-verified. Execution half unchanged and sound: `log-time-entry-execution.test.ts` — row `durationMinutes:120` + resolved `jobId`, one `time_entry.logged_completed` audit with actor, cross-tenant negative, P&L rollup. |
| B7.1 | Push-to-talk from any screen | 5 | **5** | no | UI capability, no entity-resolution leg. `git diff 5b5538d..42adb1c` touches no `Shell.tsx`/`VoiceBar.tsx`. |
| B7.4 | Job notes dictated | 4 | **5** ▲ | **yes, 4→5** | The requirement's own sentence — "Note on the Patel job — wants morning visits" — now produces `targetKind:'job'`, the resolved `targetId` and `missingFields: []` against an ordinarily-summarized job (`rivet-voice-19-focus.test.ts:349`, fixture `:6-30`); killing the customer traversal fails this case. Execution: `add-note-voice-execution.test.ts` drives the **real** `AddNoteTaskHandler` (`:119`) → approve → execute → note row with the verbatim body, one note audit with actor, cross-tenant negative. |
| B7.5 | Parts by speaking (name + qty + unit) | 4 | **4** | no | Unchanged at HEAD. Unit plumbing to the row is real (`spoken-parts-edit-unit-execution.test.ts`), but a **spoken** unit is unrepresentable (catalog is the only source), the customer approval page renders no unit (`EstimateApprovalPage.tsx:49,842`), C1 has no parts/unit row (`voice-payload-contract.test.ts:311-351`), and a named document is ungateable (`estimate-edit-task.ts:427-460`). |
| B7.6 | Spoken line-item to existing estimate | 4 | **4** | no | Unchanged. `update-estimate-execution.test.ts:173` still feeds the drafting leg a **UUID** as `estimateReference`; no spoken sentence produces one, free text never lifts the gate (`estimate-edit-task.ts:459`), and `resolveEstimate` is exact-number-only (`pg-entity-resolver.ts:396-415`). |
| B7.7 | Job status by voice | 4 | **4** | no | Unchanged. `update-job-execution.test.ts:221` hand-builds the payload; **no** integration test imports `JobEditTaskHandler`. Gate lift needs a repo-verified UUID (`job-edit-task.ts:319-330`) that can only arrive by LLM echo of the hints blob (`:347-348`). |
| B7.8 | Expense by voice *(deferred)* | 3 | **3** | no | `git diff 5b5538d..42adb1c -- voice-extended-tasks.ts` touches no `LogExpenseTaskHandler` line. |
| B7.9 | Read-only lookups *(deferred)* | 3 | **3** | no | No handler touched; the `lookup-*` filenames in the diff are cassette regenerations (integrity §2). |
| B7.10 | Crew add/remove *(deferred)* | 3 | **3** | no | No `AddCrewMember`/`RemoveCrewMember` line changed. (Note: they share the broken `resolveTechnician` — the seventh false green would bite them too if built.) |
| B8.1 | Estimate from spoken description | 5 | **5** | no | `draft-estimate-execution.test.ts` drives the real `EstimateTaskHandler` with catalog grounding overriding the LLM price. The prior pass's flag — surname-vs-full-name at 0.583 — is now **fixed** by `resolveCustomer`'s `GREATEST` (`pg-entity-resolver.ts:218-222`); `strict_word_similarity('Garcia','Maria Garcia') = 1.000`. Strengthened. |
| B8.10 | Nudge by voice | 5 | **5** | no | Strengthened. The utterance is now the surname a person says — `SPOKEN_CUSTOMER_NAME = 'Khan'` (`estimate-nudge.test.ts:339`) against `display_name = 'Khan Household'` (`:322`) — resolved through the production router path with the real resolver (`:483-490`), then real task handler → approve → execute → dispatch row + audit + 48h cooldown + cross-tenant negative. Prefix-sharing negative pinned (`:752-760`). |
| B9.1 | Invoice from a spoken sentence | 4 | **4** | no | `docs/PRD-v4-part-F-decisions.md:11-25` (F-1) still **PROPOSED**; capped at 4 by the brief's non-negotiable rule. Proof leg exists (`issue-invoice-conversation-resolution.test.ts:244-310`, cross-tenant negative on the issue transition). |
| B9.4 | Batch invoice *(deferred)* | 3 | **3** | no | No touch. |
| B9.12 | Reminder + late fee *(deferred)* | 3 | **3** | no | No touch. |

▲ = moved up. Nothing moved down.

**Movement summary:** up — B7.4, B6.3, B4.7 (all 4 → 5), each because `446d486`'s customer
traversal is real and its de-arrangement holds under mutation. Everything else unchanged.
**B5.3 did not move**, which is the single most consequential line in this document: the run's
own commit message for `446d486` implies the reassign case is closed ("Mutation-tested:
disabling the customer join fails four cases across reassign, reschedule and cancel"), and that
is true of the *appointment* half only.

---

## Integrity checks

### 1 · D-013 — INTACT

`git diff 5b5538d..42adb1c` on the enforcement sites:

| Site | Diff |
|---|---|
| `routes/assistant.ts` | **empty** |
| `ai/voice-turn/create-voice-turn-processor.ts` | **empty** |
| `ai/tasks/proposal-approval-task.ts` | **empty** |
| `proposals/surface.ts` | **empty** |
| `workers/voice-action-router.ts` | **+102 / −0** — additive only, zero deletions |

Grepping the router diff for `approve|reject|edit_proposal|isVoiceApproval|RV-071|RV-225|
ownerSession` returns **nothing**. All gates present at HEAD: `voice-action-router.ts:1423-1434`
(RV-071/RV-225 hard routing gate), `routes/assistant.ts:1057-1079`
(`assistant.voice_approval_refused`), `create-voice-turn-processor.ts:3137-3160` (ownerSession
origin), `proposal-approval-task.ts`. **`S1_ALLOWED_PROPOSAL_TYPES` was never widened** —
`proposals/surface.ts:43-52` is byte-identical to the baseline, still eight entries, still no
money/send/approval type. No verdict above rests on a caller-reachability claim the allowlist
refuses.

### 2 · Deferred five + boot-guard + UTC datetime — STILL DEFERRED

- No `AddCrewMemberTaskHandler` / `RemoveCrewMemberTaskHandler` / `LogExpenseTaskHandler` /
  `ApplyLateFeeTaskHandler` / `SendPaymentReminderTaskHandler` / `BatchInvoiceTaskHandler` line
  changed in `voice-extended-tasks.ts`; the only diff hits are two prose comment references
  (`:353`, `:606`).
- **Cassettes: 66 changed, `M` = 66, `A` = 0** — re-verified independently
  (`git diff 5b5538d..42adb1c --name-status -- …/cassettes | awk '{print $1}' | sort | uniq -c`).
  `npm run voice-quality` → **67/67, `launchGate.pass=true`**, same script count as baseline, so
  no fixture was added or removed on net. The regeneration explanation (sha256 cassette key over
  the full system prompt) reproduces.
- Boot-guard default-fail (C2): **no implementation found** — no `bootGuard`/`default-fail`
  symbol exists; the only "boot guard" hits are the pre-existing TTS/media-streams guards
  (`shared/config.ts:358`, `ai/tts/tts-provider.ts:221`).
- Live-call UTC datetime fix: **still deferred**. **Flagged per the master prompt:** no focus
  item's fixture depends on it. The one spoken-datetime path (B4.7 create/reschedule) threads an
  explicit tenant timezone and a fixed `now` (`rivet-voice-19-focus.test.ts:76-78`) and asserts
  `scheduledStart: 2026-08-06T15:00:00.000Z` for "Thursday at 10 AM" in `America/Chicago`.

### 3 · Held commits — three, all auth-surface, all isolated; nothing new

`git log --oneline --grep='^\[HELD:' 5b5538d..42adb1c` returns the same three as the prior pass:
`4db3e13`, `370c0fe8`, `abff9c7` — all `[HELD: auth]`, all isolated to authorization /
attribution / user provisioning. **The two new commits this pass touch nothing held-worthy:**
`git diff 2702faf..42adb1c --name-only` is exactly `pg-entity-resolver.ts` + four test files +
`run-log.md`. No money, no RLS, no auth. Same nit as before: `fd99030 test(db): snapshot
migration 266` is the immutability tripwire for `370c0fe8`'s held migration and merged unheld.

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
F-2. Both caps applied. Two rows sit at 4 purely for want of a signature.

### 5 · Gates, re-run by me at `42adb1c`

| Gate | Result |
|---|---|
| `npx tsc --project tsconfig.build.json --noEmit` | **exit 0** |
| `npx vitest run` (api unit) | **1059 files / 12168 tests passed**, 5 files + 12 tests skipped, 6 expected-fail, 38 todo |
| `npm run test:integration` (full, Docker, RLS role on) | **192 files / 1026 tests passed**, exit 0 |
| `npm run voice-quality` | **67/67**, `launchGate.pass=true` |
| C1 `voice-payload-contract.test.ts` | **37/37** |
| `npm run test:voice-fixtures` | **22/22** |

Everything the run claims is green **is** green. The problem, again, is not red tests — it is
what one of the green ones is testing.

---

## Claims that did not survive verification

1. **`446d486`'s claim that the focus suite is de-arranged** is true of the *jobs* and false of
   the *technician*: `fixtures/rivet-voice-19-focus.json:43,178` still speaks a name the
   transcript does not contain. **This is the seventh false green.**
2. **`446d486`'s commit message** — *"Mutation-tested: disabling the customer join fails four
   cases across reassign, reschedule and cancel"* — is accurate but incomplete as a claim about
   B5.3: the reassign case has a second resolution leg the mutation does not touch, and that leg
   is the arranged one. (Same genus as the P-29 overclaim the run itself corrected in `42adb1c`.)
3. **`entity-resolution.test.ts`'s AC-4 picker test** (`:666-680`) states in its own comment that
   full names were chosen to avoid "a first-name-only fuzzy score landing in a particular
   confidence band." That band is where the product actually lives.

Everything else the run claims reproduced exactly: the C1 posture, D-013, the held-commit
isolation, the cassette-regeneration explanation, the deferred five, B5.5's de-arrangement and
its two new bug fixes, B8.10's migrated-back-out arrangement, and B4.7's hallucinated-id create
leg.

---

## What each remaining gap would need

Ordered by leverage.

1. **B5.3 — one line.** Give `resolveTechnician` (`pg-entity-resolver.ts:930-943`) the same
   `GREATEST(similarity(full_name, $2), strict_word_similarity($2, full_name))` that
   `resolveCustomer` (`:218-222`) already has, then change
   `fixtures/rivet-voice-19-focus.json:43,178` to speak `"Carlos"` and add a guard case asserting
   no seeded technician's *first* name is unique-enough to matter — i.e. seed a second
   `Carlos <other surname>` and pin that it clarifies rather than guesses. Mutation-test it.
   Also add a first-name case to `entity-resolution.test.ts`'s technician block, where six tests
   currently speak full names.
2. **B7.7 needs a drafting-leg proof at all.** Nothing drives `JobEditTaskHandler` against real
   Postgres. Until it does, `update-job-execution.test.ts:221`'s hand-built payload is the only
   evidence and the brief excludes it.
3. **Give a `not_found` reference a picker.** `toResult` (`pg-entity-resolver.ts:973-988`) returns
   `not_found` with zero candidates, so the review card has Approve disabled and no
   resolve-entity path. Emitting a short candidate list turns every resolution miss into the
   one-tap outcome the north star describes, and would have made the seventh false green a
   degradation instead of a dead end.
4. **B7.6 / B7.5 — prove the workable document phrasing, or widen the gate deliberately.** No
   test speaks an estimate/invoice *number*, the only phrasing that lifts
   `estimate-edit-task.ts:427-460`. Either add one, or make an unambiguous free-text match lift
   the gate — a security decision, not a bug fix.
5. **B7.5 residue.** Render `unit` on `EstimateApprovalPage.tsx` (AC-6), add a parts/unit row to
   `voice-payload-contract.test.ts:311-351`, and record in Part F that a **spoken** unit is out
   of scope by design so the requirement's text and the build agree. *(Uncommitted work on disk
   at audit time appears to cover the first of these.)*
6. **B1.19 — the invitation audit.** `user.invitation_created` is asserted only under a mock
   (`onboarding-execution-handlers.test.ts:103`); the real-Postgres completion path has row proof
   without audit proof. Separately, the team leg cannot be voice-only until an email is
   capturable by voice — which may be a Part F scoping entry rather than a build.
7. **Ratify or reject F-1 and F-2.** B9.1 and B1.18 are otherwise built and proven.
8. **Deferred five, boot-guard C2, live-call UTC** — out of this run's scope, unchanged, and
   correctly so.

---

## Commands run (all re-runnable; all read-only against the main tree)

```bash
git rev-parse HEAD; git status --short; git log --oneline 567e846..HEAD
git show 446d486 --stat; git show 7395d49 --stat
git diff 5b5538d..HEAD -- packages/api/src/routes/assistant.ts \
  packages/api/src/ai/voice-turn/create-voice-turn-processor.ts \
  packages/api/src/ai/tasks/proposal-approval-task.ts packages/api/src/proposals/surface.ts   # empty
git diff 5b5538d..HEAD --numstat -- packages/api/src/workers/voice-action-router.ts           # 102 / 0
git diff 5b5538d..HEAD --name-status -- packages/api/src/ai/voice-quality/corpus/cassettes \
  | awk '{print $1}' | sort | uniq -c                                                         # 66 M, 0 A
git log --oneline --grep='^\[HELD:' 5b5538d..HEAD
git diff 2702faf..HEAD --name-only                                                            # resolver + 4 tests + run log

cd packages/api
npx tsc --project tsconfig.build.json --noEmit          # exit 0
npx vitest run                                          # 1059 files / 12168 tests
npm run test:integration                                # 192 files / 1026 tests, exit 0
npm run voice-quality                                   # 67/67, launchGate.pass=true
npx vitest run test/proposals/voice-payload-contract.test.ts   # 37/37
npm run test:voice-fixtures                             # 22/22

# pg_trgm scores — throwaway container, removed afterwards
docker run --rm -d --name simprobe2 -e POSTGRES_PASSWORD=x pgvector/pgvector:pg16
docker exec simprobe2 psql -U postgres -c "CREATE EXTENSION pg_trgm;"
docker exec simprobe2 psql -U postgres -c "
  SELECT similarity('Carlos Vega','Carlos'),              -- 0.583  ← under the 0.60 floor
         similarity('Carlos Vega','Carlos Vega'),         -- 1.000  ← what the fixture speaks
         strict_word_similarity('Carlos','Carlos Vega'),  -- 1.000  ← the un-applied fix
         strict_word_similarity('patel','Ravi Patel'),    -- 1.000
         similarity('AC repair','the Patel job'),         -- 0.000
         strict_word_similarity('Khan','Khan Household'), -- 1.000
         strict_word_similarity('khan','Khanna Enterprises'); "  -- 0.500
docker rm -f simprobe2

# Mutation tests — DETACHED WORKTREE ONLY, removed and verified gone
git worktree add --detach "$WT" HEAD
#   (a) fixture: "targetTechnicianName": "Carlos Vega" -> "Carlos"
#       => 2 failures: expected [ 'toTechnicianId' ] to deeply equal []
#   (b) resolver: resolveJob's two strict_word_similarity terms * 0
#       => 5 failures across add_note / reassign / log_time_entry / reschedule / cancel
git worktree remove --force "$WT"; git worktree prune; git worktree list   # main tree only
```
