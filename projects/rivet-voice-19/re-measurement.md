# Rivet Voice 19 — Read-only re-measurement (FIFTH PASS)

Measured by a fresh, read-only agent. No source or test file was changed to produce this
document; the only file written is this one. All mutation testing was done in a **detached git
worktree**, which has been removed and verified gone (`git worktree list` shows only the main
tree). Scored independently against the C1 done ladder (0 Absent · 1 Specced · 2 Present ·
3 Wired · 4 Proven · 5 Reachable) and the master prompt's own rung-5 bar: *a spoken sentence
produces a persisted row plus an audit event, reachable from a real surface, proven against real
Postgres* — not merely that a handler works given resolved ids.

**Head measured: `a14c2d7`** (`test(B1.19): the timezone and email gate proofs`) — the commit the
brief named. Previous pass measured `42adb1c`.

**Tree state disclosure (again, and it matters this time).** The tree was clean at `a14c2d7` when
this audit began. **Mid-audit the branch advanced to `c6fbcdc`** (`fix(B1.19): send the browser
timezone from the conversational client`) — written by an agent other than me; I made no
Write/Edit call outside this document. By the time I finished writing, the branch had advanced
twice more — to `005d549` (`fix(B4.7, B5.3): an unmatched explicit clock time refuses, never
falls through`), with further uncommitted edits to `packages/api/src/invoices/public-invoice-service.ts`
and `run-log.md` in flight. **Everything scored below is the committed state at `a14c2d7`.**
`c6fbcdc` is analysed separately in the addendum because it is the fix for this pass's headline
finding; `005d549` hardens B4.7/B5.3 rows that are already at rung 5 and cannot raise the number;
the uncommitted work is disclosed and counted for nothing. This branch is being written by
multiple agents concurrently, and any number in this document decays the moment it is published —
re-derive before relying on it.

---

## Headline

**10 / 19 at rung 5.** Previous pass: 7/19.

Three rows moved up — **B5.3, B7.6, B7.7** — and each move was mutation-verified by me, not
accepted on a passing test. Nothing moved down.

| Bucket | Count | Rows |
|---|---|---|
| **Rung 5** | **10** | B4.7, B5.3, B5.5, B6.3, B7.1, B7.4, B7.6, B7.7, B8.1, B8.10 |
| Rung 4 — capped by unratified Part F (F-1, F-2) | 2 | B1.18, B9.1 |
| Rung 4 — real gap remaining | 2 | B1.19, B7.5 |
| Rung 3 — deferred five, unchanged | 5 | B7.8, B7.9, B7.10, B9.4, B9.12 |

Exact arithmetic: 10 + 2 + 2 + 5 = **19**.

## The ceiling, stated before the detail

`docs/PRD-v4-part-E-state.md:364` (Part E run-log #24) removed the pre-award of B9.1 and B1.18.
`docs/PRD-v4-part-F-decisions.md:12` (F-1) and `:31` (F-2) are **both still marked PROPOSED —
awaiting ratification**. No sign-off, timestamp or approver marker for either exists anywhere in
the repo. Therefore:

> **The honest ceiling for this run is 12/19** = 19 − 5 deferred − 2 capped by unratified Part F.
> B9.1 and B1.18 cannot exceed rung 4 however good their code is, and their code *is* good
> (B1.18's execution proof and B9.1's issue-leg cross-tenant negative both exist and are green).
> **12 is the ceiling, not a failure.**

**10/19 is two short of that ceiling.** The two rows short are B1.19 and B7.5, and both are
described precisely below.

---

## THE EIGHTH FALSE GREEN — say it loudly

> **At the audited head `a14c2d7`, `fac9e4f` claims to "capture the tenant timezone
> conversationally". Nothing in production could send it.** The server learned to accept
> `clientTimezone` (`routes/onboarding-conversation.ts:38,68` →
> `ai/orchestration/onboarding-conversation.ts:433` →
> `ai/tasks/onboarding/tenant-settings-proposer.ts:190`), and the same commit made
> `isIdentityDone` *require* a timezone. But `packages/web` was outside that commit's scope:
> `git show a14c2d7:packages/web/src/hooks/useOnboardingConversation.ts | grep clientTimezone`
> returns **nothing**. Every real conversational onboarding would have hit the new gate on every
> turn — the fix made the conversational path strictly worse than the form wizard, which is the
> exact outcome the commit's own reasoning said it was avoiding.

### Why this is a *false green* and not merely an incomplete build

The web suite was green — and it was green **because it asserted the bug**. At `a14c2d7`:

```
packages/web/src/hooks/useOnboardingConversation.test.ts:39
  expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
:119  expect.objectContaining({ body: JSON.stringify({ sessionId: 'sess-3' }) }),
:231  expect.objectContaining({ body: JSON.stringify({ sessionId: 'sess-other' }) }),
```

Three assertions pinning that the client sends **no timezone**, byte-exact, at the moment the
server began requiring one. This is the same genus as the seven before it, in its purest form
yet: not a fixture arranged to pass, but a *contract assertion frozen against the old behaviour*
while the other half of the system moved. A reviewer reading either side alone sees green.

The integration proof did not catch it either, because it supplies the field itself:
`test/integration/onboarding-conversation-parity.test.ts` passes `clientTimezone` into the
orchestrator directly. Server-side test green, client-side test green, feature dead in between —
**nothing in the suite spanned the seam**.

**Status:** fixed at `c6fbcdc`, which lands the hook change and — correctly — *updates* the three
body assertions to expect the field rather than loosening them (`useOnboardingConversation.test.ts`
now derives `BROWSER_TZ` from `Intl` so the tests pin that it is genuinely sent). That commit
landed while this audit was running and is **not** part of the scored head. Its effect is in the
addendum.

### Second finding on the same row, NOT fixed by `c6fbcdc`

Master prompt B1.19 AC-5 requires an **"explicitly confirmed"** timezone, "never guessed —
regression pin stays green". What ships is a **silently browser-detected** zone: the hook reads
`Intl.DateTimeFormat().resolvedOptions().timeZone` and posts it; the conversation never surfaces
it, never reads it back, and never asks the owner to confirm it. The form wizard at least renders
it in a select the owner can see and change (`IdentityStep`). The conversational path has no such
moment. This is defensible (it is not *guessed* by the server, and the never-default rule holds —
absent ⇒ gate, never a fallback), but it is **not** "explicitly confirmed", and no Part F entry
amends AC-5 to say so. Recorded, not scored as a lie.

---

## What DID move, and why I believe it

Three rows moved. I re-derived each by reading the diff, then killed a mutant for each in the
detached worktree. All three mutants died.

### B5.3 — 4 → 5. The seventh false green is genuinely fixed.

`7fbff6e` gives `resolveTechnician` the `GREATEST(similarity, strict_word_similarity)` shape
`resolveCustomer` already had (`pg-entity-resolver.ts:222-226`, applied at `:1126`+), and — the
half that matters — **changes the fixture to speak what the transcript contains**:
`test/integration/fixtures/rivet-voice-19-focus.json:43,178` now say `"Carlos"`, not
`"Carlos Vega"`. The contradiction with the run's own classifier launch fixture
(`intent-classifier.launch-fixtures.test.ts:192`, `'Carlos'`) is resolved in favour of the
classifier, which was the correct model of reality.

The seed is honest: `rivet-voice-19-focus.test.ts:355` seeds `Carlos Vega` as a `users` row and
`:356-359` gives Dana Johnson a job summarised `'Water heater replacement'`; the first-declared
guard (`:427-450`) fails first if any spoken surname ever reappears in a summary or job number.

**Mutation test (mine, detached worktree, since removed):** replaced `TECH_SCORE_EXPR` with plain
`similarity(...)`, nothing else.

```
FAIL b5-3-reassign-appointment: payload.toTechnicianId … expected undefined to be '3302…'
FAIL b5-3-negative-named-reference-must-not-fall-back: payload.toTechnicianId … expected undefined
2 failed | 9 passed
```

Load-bearing. Execution is proven at the resolved-id seam by
`test/integration/reassign-appointment-voice.test.ts` (row change, feasibility gate asserted to
have run, staleness gate, `appointment.technician_assigned` audit, cross-tenant negative) — the
same composite standard on which the previous pass awarded B4.7 rung 5.

### B7.6 — 4 → 5. The ungateable free-text reference is gateable.

`9bed666` fixes three dead halves at once: `resolveEstimate` gains the customer → jobs →
estimates traversal (`pg-entity-resolver.ts:547`+) with a **separate** `ESTIMATE_DOC_STOPWORDS`
set so `"the Garcia estimate"` reduces to the needle `garcia` that actually clears the 0.60 floor;
`estimate-edit-task.ts:497-500` lifts the gate for a router-resolved id **after** `findById`
confirms it; and `estimates.customer_message` is deliberately *not* matched — the column the
nudge false green was planted in.

`test/integration/update-estimate-execution.test.ts` was rewritten to stop feeding the drafting
leg a UUID. It now speaks `"the Garcia estimate"`, resolves it through the real
`PgEntityResolver` via the real `resolveVoiceEntityReferences` (`:246-253`), drafts against a
scripted reply carrying a **hallucinated** `estimateId` (`:257`), asserts the resolver's id won
(`:289-290`), asserts the gate lifted (`:293`), executes through
`createExecutionHandlerRegistry` (`:320`) and then asserts the **row** (qty 2, `unit 'hour'`,
catalog price 9500 beating the model's 9400, correct recomputed totals, version 2), **one**
`estimate.updated` audit, and a three-way cross-tenant negative (the sentence resolves nothing
in tenant B; scoped read null; a forged cross-tenant execute refused).

Anti-arrangement is explicit: the customer's surname appears nowhere on the job summary
(`'AC condenser replacement'`) or the estimate's `customer_message`, and
`test/integration/entity-resolution.test.ts` asserts a literal zero-row count for
`estimate_number/customer_message/summary ILIKE '%garcia%'` before resolving.

**Mutation test (mine):** severed the traversal (returned `not_found` for a non-empty needle).
`3 failed (3)` — every test in the file dies. Load-bearing.

### B7.7 — 4 → 5. The gate no longer depends on an LLM echoing a UUID.

`19090b9` makes `UpdateJobTaskHandler` read the router-resolved `jobId` and verify it against the
repo before trusting it (`job-edit-task.ts:363`), and tightens the fail-closed branch to delete
*any* id-shaped `payload.jobId` rather than only the losing candidate.

The new suite in `test/integration/update-job-execution.test.ts:427-778` is the strongest proof
in the run. Three independent anti-vacuity devices: (1) `:624-639` proves the ILIKE display-text
search returns **zero** rows for the spoken name, so the old fallback cannot reach the job;
(2) a prefix decoy customer `Marco Garcialopez` (`:594-600`) would make a loose matcher ambiguous;
(3) the scripted drafting reply hallucinates a `jobId` (`:450`) that must lose. Then: the payload
carries the resolver's id and `missingFields` is `[]` (`:660-666`); the real `approveProposal` →
production registry → **`jobs.status = 'completed'`, `completed_at` non-null**, plus `job.updated`
*and* `job.status_changed` audits (`:671-720`); an **illegal** transition ("the Raman job",
seeded `scheduled`) resolves and drafts but is refused at execution with the row untouched
(`:723-757`); and a cross-tenant block where even a *handed* real `jobId` stays gated (`:759-778`).

**Mutation test (mine):** made `resolvedJobIdFrom` return `undefined`. `3 failed | 8 passed`.
Load-bearing.

### Rows that were already 5 and got stronger

- **B5.5** — `436fe49` fixes a genuine P1 in the run's own code: `referenceMatchesText` was
  bidirectional substring containment, so *"the Ann job"* matched a customer named *"Joanne"* and
  a lone eligible appointment resolves without asking — a wrong-customer **outbound ETA text**.
  Now whole-token runs with possessive stripping (`dispatch/en-route-voice.ts:110-131`). Second:
  `resolveTodayBoundary` fell back to UTC when the tenant zone was missing, so an evening
  reference in a Pacific tenant could reach the next local day; it now returns `null` and both
  callers decline (`en-route-voice.ts:446`, `sms/tech-status/en-route-keyword.ts:110`). The
  fixtures had **no** tenant zone and were passing *because of* the fallback — including tenant B
  in the cross-tenant negative, which would have started passing for the wrong reason. That is an
  honest self-report of a near-miss false green, and it was corrected properly.
- **B4.7** — `9bed666` also closes a P1 the same author introduced: `resolveAppointmentByClockTime`
  passed `undefined` to `resolveDateTime`, which silently substitutes `America/New_York`
  (`resolve-datetime.ts:161`), so "cancel the 2pm" in a Phoenix tenant could match the
  Eastern-equivalent instant and feed a wrong `appointmentId` into an irreversible action. Now a
  **terminal** `not_found` (`pg-entity-resolver.ts:853`), with a CONTROL test proving the same
  fixture *does* resolve once the tenant states Eastern — so the refusals are the missing zone,
  not an unmatchable appointment (`entity-resolution.test.ts`, four cases).

---

## The two rows short of the ceiling

### B1.19 — 4. Two reasons, one of them now fixed off-head.

At `a14c2d7`: the eighth false green above. The invitation-audit gap the previous pass flagged
**is** closed — `7e49319` asserts `user.invitation_created` against real Postgres with
`entity_type`, `entity_id`, `actor_id`, `metadata.email`, a null `clerkInvitationId`, and a
cross-tenant negative on both the invitation and its audit
(`onboarding-conversation-parity.test.ts:519-551`). Timezone parity is genuinely proven in the
same file (`:357-376` both paths write the same column; `:379-439` a zoneless conversation
**gates** and leaves the column NULL rather than guessing). The surface is real
(`ConversationStep.tsx` + `useOnboardingConversation.ts`, `OnboardingShell.tsx:297`), the `tools`
capture state exists (`onboarding-conversation.ts:349,624`), and the AC-8 Playwright journey
asserts the exchange count lands in [10,15] (`e2e/journeys/onboarding-v2-conversation.spec.ts:149`).

What holds it at 4 at the scored head is that the timezone capture was **unreachable from the
real surface** — which is precisely the clause rung 5 turns on. The remaining, unfixed item is
AC-5's "explicitly confirmed" wording versus a silently browser-detected zone.

The team-member leg still needs a human-typed email. I do **not** count that against it any more:
`fac9e4f` makes it an honest, schema-enforced gate (`proposals/contracts/onboarding.ts`, the same
`trim().email().max(320)` rule as `inviteUserSchema`), and `a14c2d7`'s
`onboarding-conversation-team-email.test.ts` proves the previous shape — an approvable card that
died at execution because `carlos` cleared the gate — is gone. Typing one field on a review card
is inside the proposal/approval model, not outside it.

### B7.5 — 4. The chain closes for catalogued lines; the requirement's own word does not.

Real progress, all of it verified: `ea46e5a` fixes **silent data loss** (editing any line item
replaces every row, and `lineItemSchema` did not declare `unit`, so Zod stripped it and an
untouched line's unit became NULL — `shared/contracts.ts:122`), carries the unit to the customer
(`public-estimate-service.ts` `PublicEstimateView.unit`), and renders it on the estimates page,
invoices page, customer approval page and the PDF, pinned by a jsdom class-contract test and a
320px Playwright spec. `update-estimate-execution.test.ts` now proves a **spoken sentence** puts a
`unit` on a persisted row with an audit event and a cross-tenant negative.

What keeps it at 4 is the requirement's own text — *"structured name + quantity + **unit**"* —
against the shipped design: **a spoken unit on an uncatalogued line is deliberately stripped**
(`ai/resolution/catalog-resolver.ts:486-506`, `delete next.unit`). The unit is a catalog fact by
design, so for a 1–3-truck shop with a thin catalog, the common case — the master prompt's own
flagship sentence, *"Add three 45-microfarad capacitors to the Smith estimate"* — persists name
and quantity and **no unit** unless that exact capacitor is already in the catalog. Two
corroborating gaps: the only test that speaks the capacitor sentence
(`spoken-parts-edit-unit-execution.test.ts:250`) still hands the drafting leg
`estimateReference: <UUID>` — the arrangement `9bed666` removed from the sibling file — so
*(spoken part) × (spoken document reference)* is nowhere co-proven; and C1 still carries no
`unit` on any parts payload row (`test/proposals/voice-payload-contract.test.ts:270,285,321,347`),
so master prompt AC-7 is unmet.

This is the most movable row in the document. **One Part F entry** recording "a spoken unit is out
of scope; the catalog is the sole source" would amend the requirement's text to match a
deliberate, well-argued build — the same instrument F-1 and F-2 use — and B7.5 would be a 5.
Documentation alone restores nothing *elsewhere*, but here the disagreement genuinely is between
the requirement's wording and a design decision, not between a claim and the code.

---

## 19-row table

Prior rung = fourth-pass re-measurement at `42adb1c`. New rung = this pass at `a14c2d7`.

| # | Requirement | 4th pass | **New** | Moved? | One-line justification (file:line evidence) |
|---|---|---|---|---|---|
| B1.18 | Brand voice captured, then locked | 4 | **4** | no | `docs/PRD-v4-part-F-decisions.md:31` (F-2) still **PROPOSED**; capped at 4 by the brief's non-negotiable rule regardless of code. Execution proof itself is sound (`test/integration/update-brand-voice-voice-execution.test.ts`, green in the 193-file run). |
| B1.19 | Conversational onboarding | 4 | **4** | no (reasons swapped) | **Eighth false green**: at `a14c2d7` the server requires `clientTimezone` (`tenant-settings-proposer.ts:190`) and no client sends it — `git show a14c2d7:packages/web/src/hooks/useOnboardingConversation.ts` has no such field, while `useOnboardingConversation.test.ts:39` pins `body: JSON.stringify({})`. The invitation-audit gap **is** closed (`onboarding-conversation-parity.test.ts:519-551`, real PG). AC-5's "explicitly confirmed" zone is still browser-detected silently. |
| B4.7 | Book / move / cancel by speaking | 5 | **5** | no | Held and strengthened: the zone-defaulting P1 on the clock-time branch is now a terminal refusal (`pg-entity-resolver.ts:853`) with a control test proving the refusal is the missing zone, not an unmatchable appointment (`entity-resolution.test.ts`, 5 cases incl. NULL zone, garbage zone, name-bearing clock ref). Create/move/cancel proofs unchanged and green. |
| B5.3 | Assign work (reassign) by speaking | 4 | **5** ▲ | **yes, 4→5** | Seventh false green fixed: `TECH_SCORE_EXPR` = `GREATEST(similarity, strict_word_similarity)` (`pg-entity-resolver.ts:222-226`) and the fixture now speaks `"Carlos"` (`fixtures/rivet-voice-19-focus.json:43,178`), matching the classifier contract. Mutation-verified by me: reverting to plain `similarity` fails 2 cases. Execution + feasibility + staleness + audit + cross-tenant at `reassign-appointment-voice.test.ts`. |
| B5.5 | "On my way" by app / SMS / voice | 5 | **5** | no | Strengthened by two real P1 fixes: whole-token name matching so "the Ann job" no longer ETA-texts "Joanne" (`en-route-voice.ts:110-131`), and a zoneless tenant now declines a service day instead of falling back to UTC (`:446`, `en-route-keyword.ts:110`). The fixtures that were passing *because of* the UTC fallback now seed a real zone. |
| B6.3 | Time entries by voice | 5 | **5** | no | Untouched since the previous pass; `log-time-entry-execution.test.ts` (row `durationMinutes:120` + resolved `jobId`, one `time_entry.logged_completed` audit with actor, cross-tenant negative, P&L rollup) green in the 193-file run. |
| B7.1 | Push-to-talk from any screen | 5 | **5** | no | `git diff 5b5538d..a14c2d7 -- packages/web/src/components/Shell.tsx …/voice …/VoiceBar.tsx` is empty. UI capability, no resolution leg. |
| B7.4 | Job notes dictated | 5 | **5** | no | Unchanged; `add-note-voice-execution.test.ts` + focus case `b7-4-add-note` (fixture `rivet-voice-19-focus.json:6-30`, realistic seed `'AC repair'` at `:349`) both green. |
| B7.5 | Parts by speaking (name + qty + unit) | 4 | **4** | no (new reason) | Big advance — silent data loss fixed (`shared/contracts.ts:122`), unit on the customer view + PDF + 320px specs, and a **spoken** sentence now persists `unit 'hour'` with audit + cross-tenant (`update-estimate-execution.test.ts`). But a spoken unit on an **uncatalogued** line is stripped by design (`catalog-resolver.ts:506`), the capacitor sentence still drafts from a UUID (`spoken-parts-edit-unit-execution.test.ts:250`), and C1 has no `unit` row (`voice-payload-contract.test.ts:270-347`). |
| B7.6 | Spoken line-item to existing estimate | 4 | **5** ▲ | **yes, 4→5** | `resolveEstimate` traverses customer → jobs → estimates (`pg-entity-resolver.ts:547`+) and the task lifts the gate on a repo-verified router id (`estimate-edit-task.ts:497`). `"the Garcia estimate"` → resolver beats a hallucinated id → row + one `estimate.updated` audit + three-way cross-tenant negative (`update-estimate-execution.test.ts`). Mutation-verified by me: severing the traversal fails all 3. |
| B7.7 | Job status by voice | 4 | **5** ▲ | **yes, 4→5** | The gate no longer needs an LLM to echo a UUID (`job-edit-task.ts:363`). `"the Garcia job"` → real resolver past a prefix decoy → payload carries the resolver id, `missingFields []` → real `approveProposal` → production registry → `status='completed'` + `job.updated` + `job.status_changed` audits; illegal transition refused with the row untouched; cross-tenant gated even when handed a real id (`update-job-execution.test.ts:427-778`). Mutation-verified by me: 3 fail. |
| B7.8 | Expense by voice *(deferred)* | 3 | **3** | no | No `LogExpenseTaskHandler` line changed in `voice-extended-tasks.ts` across `5b5538d..a14c2d7`; the only diff hits are prose comments. |
| B7.9 | Read-only lookups *(deferred)* | 3 | **3** | no | No handler touched; the `lookup-*` filenames in the diff are cassette regenerations (integrity §2). |
| B7.10 | Crew add/remove *(deferred)* | 3 | **3** | no | No `AddCrewMember`/`RemoveCrewMember` line changed. (They share `resolveTechnician`, so they inherit its fix — and its missing overflow guard, §Findings.) |
| B8.1 | Estimate from spoken description | 5 | **5** | no | Unchanged; `draft-estimate-execution.test.ts` drives the real `EstimateTaskHandler` with catalog grounding overriding the LLM price. Green. |
| B8.10 | Nudge by voice | 5 | **5** | no | Unchanged and green; the new `resolveEstimate` traversal now also serves `send_estimate_nudge` (`ESTIMATE_DOC_INTENTS`, `entity-resolution.ts:86-90`) with no regression — `estimate-nudge.test.ts` green in the 193-file run. |
| B9.1 | Invoice from a spoken sentence | 4 | **4** | no | `docs/PRD-v4-part-F-decisions.md:12` (F-1) still **PROPOSED**; capped at 4 by the brief's rule. Proof leg exists (`issue-invoice-conversation-resolution.test.ts`, cross-tenant negative on the issue transition). |
| B9.4 | Batch invoice *(deferred)* | 3 | **3** | no | No touch. |
| B9.12 | Reminder + late fee *(deferred)* | 3 | **3** | no | No touch. |

▲ = moved up. Nothing moved down.

---

## Integrity checks

### 1 · D-013 — INTACT

`git diff 5b5538d..a14c2d7` on the enforcement sites returns **no rows at all** for
`routes/assistant.ts`, `ai/voice-turn/create-voice-turn-processor.ts`,
`ai/tasks/proposal-approval-task.ts` and `proposals/surface.ts` — all four byte-untouched.
`workers/voice-action-router.ts` is **+102 / −0**, additive only, zero deletions, and grepping
that diff for `isVoiceApproval|isVoiceEdit|ownerSession|RV-071|RV-225|approve_proposal|
reject_proposal|edit_proposal` returns **nothing**. Both RV-071/RV-225 gate markers still present
at head.

**`S1_ALLOWED_PROPOSAL_TYPES` was never widened** — `proposals/surface.ts` is byte-identical to
the baseline; still eight entries, still no money/send/approval type. Checked against the three
rows that moved: `reassign_appointment` (B5.3), `update_estimate` (B7.6) and `update_job` (B7.7)
are all **deliberately excluded** from the caller allowlist and named in its exclusion comment
(`surface.ts:36-40`). No verdict above rests on a caller-surface reachability claim the product
refuses; all three are operator-surface intents reached through the recorder → `voice_action_router`
path, which is production-wired (`app.ts` recording → transcription → `queue.send`, worker
registered, `entityResolver: sharedEntityResolver`, and `existingEntities` threaded at
`voice-action-router.ts:1592-1610`).

### 2 · Deferred five + boot-guard C2 + live-call UTC — STILL DEFERRED

- No `AddCrewMemberTaskHandler` / `RemoveCrewMemberTaskHandler` / `LogExpenseTaskHandler` /
  `ApplyLateFeeTaskHandler` / `SendPaymentReminderTaskHandler` / `BatchInvoiceTaskHandler` line
  changed in `voice-extended-tasks.ts`; only prose comment references appear in the diff.
- **Cassettes: 66 changed, `M` = 66, `A` = 0** — re-verified independently
  (`git diff 5b5538d..a14c2d7 --name-status -- …/cassettes | awk '{print $1}' | sort | uniq -c`).
  `npm run voice-quality` → **67/67, `launchGate.pass=true`**, same script count as baseline, so
  nothing was added or removed on net. Regenerations, not work.
- Boot-guard default-fail (C2): **no implementation found** — no `bootGuard` / `default-fail`
  symbol exists anywhere in `packages/api/src`. Still deferred.
- Live-call UTC datetime fix: **still deferred, and flagged per the master prompt.** No focus
  item's fixtures depend on it — B4.7's spoken-datetime path threads an explicit tenant timezone
  and a fixed `now` (`rivet-voice-19-focus.test.ts:76-78`) and asserts a literal UTC instant
  (`:620`). Note that `9bed666` and `436fe49` both *hardened* zone handling this pass (refuse
  rather than default), which narrows the blast radius of the deferred bug rather than masking it.

### 3 · Held commits — the same four, all isolated; one borderline new case

`git log --oneline --grep='HELD:' 5b5538d..a14c2d7` returns exactly the four from prior passes:
`370c0fe8`, `abff9c7`, `4db3e13` (all `[HELD: auth]`, isolated to authorization / attribution /
user provisioning) and `b5595dc` (`[HELD: money-contract]`, the `line_items.unit` column). **No
new held commit was needed and none was added.** No commit in `42adb1c..a14c2d7` touches money
movement, RLS policy, or authorization logic.

**One borderline case, recorded not asserted as a violation:** `ea46e5a` adds
`unit: catalogUnitSchema.optional()` to `lineItemSchema` in `packages/api/src/shared/contracts.ts:122`
— the HTTP money contract — **without** a `[HELD:` label, while its DB-column sibling `b5595dc`
was labeled `[HELD: money-contract]` for the same field. The field is descriptive, no arithmetic
reads it (`quantity × unitPriceCents = totalCents` is untouched and pinned by billing-engine
tests), and `unitPriceCents` / `totalCents` are byte-unchanged — so I do not call this a guardrail
breach. But the two halves of one money-contract change were labeled inconsistently, and a
reviewer scanning for `[HELD:` would see only half of it.

### 4 · Part F — F-1 and F-2 both still PROPOSED

| Entry | Subject | Status | Consequence |
|---|---|---|---|
| F-1 | B9.1 issuance semantics (two-step reading) | **PROPOSED** (`:12`) | **B9.1 cannot exceed 4** |
| F-2 | B1.18 lock-as-tap amendment | **PROPOSED** (`:31`) | **B1.18 cannot exceed 4** |
| F-3 | B5.5 direct audited status act | RECORDED (`:45`) | — |
| F-4 | B7.5 parts land on billing documents | RECORDED (`:59`) | — |
| F-5 | B1.19 wizard remains default | RECORDED (`:68`) | — |
| F-6 | Deferred-set integrity | RECORDED (`:74`) | — |

No ratification marker — sign-off, timestamp, or approver — exists anywhere in the repo for F-1
or F-2. Both caps applied. **Two rows sit at 4 purely for want of a signature.**

Note also what is *missing* from the register: no entry covers the B7.5 spoken-unit scoping
decision (§B7.5 above) or the B1.19 browser-detected-vs-explicitly-confirmed timezone. Both are
deliberate design calls made in code with good reasoning, and neither is recorded where a product
owner would see it.

### 5 · Gates, all re-run by me at this head

| Gate | Result |
|---|---|
| `npx tsc --project tsconfig.build.json --noEmit` | **exit 0** |
| `npx vitest run` (api unit) | **1061 files / 12224 tests passed**, 5 files + 12 tests skipped, 6 expected-fail, 38 todo |
| `npm run test:integration` (full, Docker, RLS role on) | **193 files / 1054 tests passed**, exit 0 |
| `npm run voice-quality` | **67/67**, `launchGate.pass=true` |
| C1 `voice-payload-contract.test.ts` | **37/37** |
| `npm run test:voice-fixtures` | **22/22** |
| web onboarding-conversation suites (at tip) | **2 files / 16 tests passed** |

Everything the run claims is green **is** green. As every pass before this one has had to say: the
problem was never a red test.

---

## Claims and near-misses worth recording

1. **`fac9e4f`'s subject — "capture the tenant timezone conversationally" — was not true of the
   product at the commit that made it.** The server half shipped, the client half did not, and
   three green web assertions pinned the absence. This is the eighth false green and the single
   most valuable finding in this pass. Fixed off-head at `c6fbcdc`.
2. **`resolveTechnician` has no overflow guard.** `resolveJob` escalates past
   `MAX_JOB_CANDIDATES` and `9bed666` gave `resolveEstimate` the same treatment
   (`MAX_ESTIMATE_CANDIDATES + 1`, escalate on confident overflow). `resolveTechnician`
   (`pg-entity-resolver.ts:1126`+) is still a bare `LIMIT 5` with no overflow detection, so six
   technicians named "Mike" yield an arbitrary five-candidate picker that need not contain the
   right one. Low blast radius at 1–3 trucks, but it is an unexplained asymmetry between three
   sibling paths, and `add_crew_member` / `remove_crew_member` will inherit it when they are built.
3. **The AC-4 technician picker test still contains the arrangement `7fbff6e` removed elsewhere.**
   `entity-resolution.test.ts:670-723` drives the transcript *"Assign Carlos to the Ramirez job"*
   with `targetTechnicianName: 'Carlos Vega'` against two technicians seeded with **identical**
   full names, and its comment still says full names were chosen to avoid "a first-name-only fuzzy
   score landing in a particular confidence band." Post-fix that band is 1.000 and the arrangement
   is unnecessary. The test is not *wrong* — it still asserts a real picker — but the more
   realistic and product-relevant ambiguity (two technicians sharing only a **first** name, e.g.
   Carlos Vega and Carlos Ramirez) remains untested anywhere, and every technician case in
   `entity-resolution.test.ts:228-296` still speaks a full name.
4. **`7fbff6e` shipped no test of its own.** Its only coverage is the flipped value in an existing
   fixture. That coverage is genuinely load-bearing (I killed the mutant), so this is a
   process note rather than a proof gap — but Guardrail 5 and CLAUDE.md both ask for a regression
   test in the same commit, and a resolver-level first-name case does not exist.
5. **Everything else reproduced exactly**: D-013, the S1 allowlist, held-commit isolation, the
   cassette-regeneration explanation, the deferred five, the B4.7 hallucinated-id create leg,
   B8.10's migrated-out arrangement, and the previous pass's reading of the `estimates` traversal
   as the missing piece.

---

## Addendum — what `c6fbcdc` (landed mid-audit) changes

`c6fbcdc` adds `clientTimezone` to all three requests the conversational client makes (bootstrap,
its 404 retry, and each turn), derived from `Intl` with **no** `America/New_York` fallback — so an
unreportable zone still gates rather than defaulting. It updates the three body assertions to
expect the field rather than loosening them. I ran the two affected web suites at the tip:
**16/16 green**, and the assertions now derive `BROWSER_TZ` from `Intl` so they pin that the field
is genuinely sent.

**With `c6fbcdc`, B1.19 reaches rung 5 and the number is 11/19** — one short of the 12 ceiling,
with B7.5 the only remaining non-Part-F gap. I am stating both numbers rather than choosing:
**10/19 at the head this audit was asked to measure (`a14c2d7`), 11/19 at the branch tip
(`c6fbcdc`)**. Neither is assumed; both were measured. The residual AC-5 concern
("explicitly confirmed" vs silently browser-detected) survives `c6fbcdc` and is a Part F entry,
not a build.

---

## What each remaining gap would need

Ordered by leverage.

1. **Ratify or reject F-1 and F-2.** Two rows are otherwise built, proven and green. This is the
   single highest-leverage action in the document: it is worth **+2** and costs a signature.
2. **B7.5 — one Part F entry, or one build.** Either record "the catalog is the sole source of a
   line's unit; a spoken unit on an uncatalogued line is out of scope" (amending the requirement's
   "name + quantity + unit" the same way F-1/F-2 amend theirs), **or** allow an uncatalogued line
   to carry the spoken unit under the existing confidence cap. Whichever is chosen, also add a
   `unit` to C1's parts payload rows (`voice-payload-contract.test.ts:270-347`, AC-7) and change
   `spoken-parts-edit-unit-execution.test.ts:250` to speak a document reference instead of a UUID,
   so *(spoken part) × (spoken reference)* is co-proven in one test.
3. **B1.19 — land `c6fbcdc` (done) and record the timezone-confirmation decision in Part F.**
   Either surface the detected zone in the conversation for confirmation, or amend AC-5 to accept
   browser detection. Right now the requirement says "explicitly confirmed" and the build does not
   do that.
4. **Give `resolveTechnician` the overflow guard its two siblings have**, and add the missing
   first-name-collision case (two Carloses, different surnames) plus a resolver-level first-name
   resolution test. Cheap, and it closes the last structural asymmetry among the four resolution
   paths.
5. **Add a test that spans the client/server seam on `POST /api/onboarding/conversation/turn`.**
   The eighth false green existed because no test in the repo asserts that what the client sends
   satisfies what the server requires — server tests supply the field themselves, client tests
   assert a frozen literal. A contract test over the request body shape would have caught it in
   either half.
6. **Give a `not_found` reference a picker.** Carried over unchanged from the previous pass:
   `toResult` returns `not_found` with zero candidates, so a resolution miss is a dead end rather
   than a one-tap outcome. Still the difference between "the north star" and "usually works".
7. **Deferred five, boot-guard C2, live-call UTC** — out of scope, unchanged, and correctly so.

---

## Commands run (all re-runnable; all read-only against the main tree)

```bash
git rev-parse HEAD; git status --short; git log --oneline 42adb1c..HEAD
git show 7fbff6e 9bed666 19090b9 436fe49 ea46e5a c3a65e8 fac9e4f a14c2d7 7e49319 --stat
git show a14c2d7:packages/web/src/hooks/useOnboardingConversation.ts | grep clientTimezone  # EMPTY
git show a14c2d7:packages/web/src/hooks/useOnboardingConversation.test.ts | grep 'body:'    # {} pinned
git diff 5b5538d..a14c2d7 --numstat -- packages/api/src/routes/assistant.ts \
  packages/api/src/ai/voice-turn/create-voice-turn-processor.ts \
  packages/api/src/ai/tasks/proposal-approval-task.ts packages/api/src/proposals/surface.ts   # no rows
git diff 5b5538d..a14c2d7 --numstat -- packages/api/src/workers/voice-action-router.ts       # 102 / 0
git diff 5b5538d..a14c2d7 --name-status -- packages/api/src/ai/voice-quality/corpus/cassettes \
  | awk '{print $1}' | sort | uniq -c                                                        # 66 M, 0 A
git log --oneline --grep='HELD:' 5b5538d..a14c2d7                                            # same four

cd packages/api
npx tsc --project tsconfig.build.json --noEmit          # exit 0
npx vitest run                                          # 1061 files / 12224 tests
npm run test:integration                                # 193 files / 1054 tests, exit 0
npm run voice-quality                                   # 67/67, launchGate.pass=true
npx vitest run test/proposals/voice-payload-contract.test.ts   # 37/37
npm run test:voice-fixtures                             # 22/22
cd ../web && npx vitest run src/hooks/useOnboardingConversation.test.ts \
  src/components/onboarding/v2/steps/ConversationStep.test.tsx   # 16/16

# Mutation tests — DETACHED WORKTREE ONLY, pinned to a14c2d7, removed and verified gone
git worktree add --detach "$WT" HEAD; git -C "$WT" checkout --detach a14c2d7
#  (a) TECH_SCORE_EXPR -> plain similarity(...)
#      => rivet-voice-19-focus.test.ts: 2 failed | 9 passed
#         "payload.toTechnicianId … expected undefined to be '3302…'"
#  (b) resolveEstimate: return not_found for a non-empty needle (traversal severed)
#      => update-estimate-execution.test.ts: 3 failed (3)
#         "annotation.resolved.estimateId … expected undefined"
#  (c) job-edit-task resolvedJobIdFrom -> always undefined
#      => update-job-execution.test.ts: 3 failed | 8 passed
git worktree remove --force "$WT"; git worktree prune; git worktree list   # main tree only ✅
```
