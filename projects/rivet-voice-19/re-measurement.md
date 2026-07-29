# Rivet Voice 19 — Read-only re-measurement (SECOND PASS)

Measured by a fresh, read-only agent per `projects/rivet-voice-19/re-measurement-brief.md`.
No source file was changed to produce this document. This is the second re-measurement of
the same 19 requirements; the first pass (measured at commit `7d8fbd4`, scored **9/19**) is at
`projects/rivet-voice-19/re-measurement.md`'s prior revision and was read in full before this
pass began, along with the brief and `docs/PRD-v4-part-E-state.md` §5.

**Head measured: `5f71f79`.** This is one commit further than the four work items the master
prompt described — see "A finding the master prompt did not anticipate" below. The working
tree also carried **uncommitted, in-progress changes** at measurement time (an RBAC hardening
pass touching `proposals/actions.ts`, `brand-voice-handler.ts`, `handlers.ts`,
`onboarding-handlers.ts`, `test/proposals/actions.test.ts` — apparently a concurrent session
still editing the repo). Per the read-only mandate, **scoring below is anchored to committed
HEAD `5f71f79` only**; the uncommitted diff was not evaluated or scored either way. It is
disclosed for transparency, not as a caveat on the numbers: the full API unit suite (run while
that diff was present on disk) still matched the stated baseline exactly (1056 files / 12053
tests, all green), so nothing below rests on a broken tree.

## Headline

**11 / 19 at rung 5.**

Arithmetic, shown rather than asserted:

| Bucket | Count | Rows |
|---|---|---|
| Already at rung 5 before this pass, untouched | 9 | B7.1, B7.7, B7.4, B5.3, B8.10, B6.3, B5.5, B7.6, B8.1 |
| This pass's re-verification of the two rows the first pass found short | +2 | B4.7 (4→**5**), B1.19 (3→**4**, not 5 — see below) |
| Net change from the first pass's 9 | +2 | 11 total |
| Capped below 5 — Part F unratified (F-1, F-2) | 2 | B1.18 (4, unchanged), B9.1 (4, unchanged) |
| Capped below 5 — team-member sub-flow requires non-voice input | 1 | B1.19 (3→**4**) |
| Confirmed still incomplete | 1 | B7.5 (2, unchanged — see finding below) |
| Deferred five — confirmed unchanged | 5 | B7.8, B7.9, B7.10, B9.4, B9.12 (all 3, matching Part E and the first pass) |

11 = 9 (carried forward from the first pass, re-spot-checked, all still green) + 2 (B4.7 and
B1.19 both moved up this pass). This is **below** the brief's original 12–14 range for the same
reason the first pass found (B1.18/B9.1 unratified caps the ceiling at 17, and B7.5's
functional gap caps it further) and **one below** what a naive reading of "the four listed work
items all landed cleanly" would suggest, because independent verification found a real
per-leg gap in B4.7's create leg that the commit fixing the *other* gap didn't address, and
because B1.19's team-member leg — even now genuinely completable, which is new and real — still
requires a human to type an email that voice can never produce. I did not adjust toward 12–14;
this is what I measured.

**Part F ratification status — unchanged.** `docs/PRD-v4-part-F-decisions.md` entries F-1
(B9.1) and F-2 (B1.18) are still marked **PROPOSED**. No ratification marker (sign-off,
timestamp, approval) exists anywhere in the repo for either. Both rows stay capped at 4 per the
master prompt's explicit, non-negotiable instruction.

## A finding the master prompt did not anticipate: B1.19's premise had already changed

The master prompt described B1.19 as: gated at draft time with `missingFields: ['email']`,
"the real approveProposal refuses them and execution is never reached," and asked me to judge
whether a gated-but-never-completable capture reaches 5. I verified that gate first
(`packages/api/src/ai/orchestration/onboarding-conversation.ts:471`, `test/integration/
onboarding-conversation-parity.test.ts:433-435` — ran, confirms `approveProposal` really
throws `/unfilled required fields/` for a team-member proposal with no email). But `git log`
showed one more commit past what I was briefed on: `5f71f79 fix(B1.19): make the team-member
gate completable — invitations already had a home`.

That commit found that the premise behind the earlier gate — "no invitation endpoint exists
yet" — was **false**. `pending_invitations` and `PgPendingInvitationRepository`
(`packages/api/src/users/pending-invitation.ts`) have existed since migration 082, predating
this entire voice run by a wide margin (`git log --follow` on that file: last touched by an
unrelated commit, `4bc8f59`, "ISSUE-005 — redact public portal API errors"). `5f71f79` wires
`OnboardingTeamMemberExecutionHandler` to the real repo (`app.ts:2117-2121`,
`handlers.ts:1425`) so that once an operator supplies the missing email on the review card, the
**same voice-drafted proposal** (name + role captured by voice; only email added) executes and
creates a real `pending_invitations` row, with a `user.invitation_created` audit event
(`onboarding-handlers.ts` — read directly).

I ran the updated test (`onboarding-conversation-parity.test.ts`, 11/11 pass) and independently
confirmed both halves: (1) the gate genuinely refuses approval while the email is missing
(`missingFieldsFor(p)` contains `'email'`; `approveProposal` throws), and (2) filling the email
and re-executing through the production registry (`createExecutionHandlerRegistry`, not a
hand-rolled handler) inserts exactly one `pending_invitations` row with the supplied email —
`invited.rows` length 1, `invited.rows[0].email === 'carlos@example.com'`.

**One gap this measurement found in that same test that the run didn't flag:** the "genuinely
completable" assertion checks the `pending_invitations` row but never queries
`audit_events` for `user.invitation_created` — I grepped the whole repo
(`grep -rln invitation_created test/ src/`) and found the event type emitted only in
`onboarding-handlers.ts`, asserted nowhere. So the team-member completion path has row proof
but not audit proof — the rung-4 triple is two-thirds present for that specific leg. Also
worth noting: the *other* test in the same file, "audit events: ... the failed team proposals
audit their failure," is now vacuous prose left over from the prior gate — since gated
proposals never enter `conversationExecutions`, the loop that's supposed to check
`proposal.execution_failed` audit rows for team members iterates zero times. It still passes,
but not because it proves anything about team members anymore; it's dead-code-shaped, not a
scoring issue.

**My judgment on the rung, given this:** B1.19 moves to **4**, not 5. Four of five onboarding
proposal types (identity, pack, schedule, template) are fully voice-reachable with complete
rung-4 proof (row + audit + cross-tenant negative) — genuinely rung 5 material on their own.
The team-member leg is now real and honestly gated, not a dead end, and is a categorically
different — better — shape than B7.4's "approves, then fails" defect (this one never reaches
`approved` until a human supplies missing data, then it actually works). But it can never be
completed by a spoken sentence alone: email is not something the voice channel could have
captured or could ever produce from "me and my cousin Carlos" — this isn't disambiguating
something already said (the way a one-tap picker resolves an ambiguous appointment reference),
it's introducing wholly new information voice structurally cannot supply. Since the row's own
test file explicitly scopes team-member capture as part of what "conversational onboarding"
covers, the conjunctive row cannot be called "reachable by a spoken sentence" (rung 5) while one
of its five capture types always requires a keyboard. Rung 4 — proven, not fully reachable — is
the right call.

## B4.7 — the cross-tenant fix landed clean, but a different per-leg gap surfaces on independent review

The first pass capped B4.7 at 4 because the create leg's own test asserted the appointment row
and audit event but never a cross-tenant negative. `efe05f3` closed exactly that gap: I read the
diff and ran the test — `voice-inbound-appointment.test.ts`, 2/2 pass, and the added lines
(`booked!.id` looked up under `other.tenantId`, expects `null`) are a real scoped-read negative,
the same form the sibling reschedule/cancel tests use. Taken alone, that would satisfy rung 5.

Independently re-deriving the row from scratch (not just checking the one gap flagged), I found
a **second, different per-leg gap in the same conjunctive requirement**: the create/book leg's
real-Postgres proof (`voice-inbound-appointment.test.ts`) constructs its `CreateProposalInput`
as a **hand-built payload literal** (`payload: { jobId, scheduledStart, ... summary: REASON }`)
— it does not exercise `CreateAppointmentTaskHandler` (the actual drafting task that turns a
transcript into this shape). The reschedule and cancel legs don't have this problem:
`rivet-voice-19-focus.test.ts`'s own sanity check (`expect(corpus.cases).toHaveLength(6)`,
line 449-463) confirms its 6-case corpus covers `reschedule_appointment` and
`cancel_appointment` — proving drafting + `PgEntityResolver` resolution against real Postgres
for those two — but not `create_appointment`/`create_booking` at all. I grepped for any other
real-Postgres test that drives the create/book drafting task and found none;
`create-appointment-task.test.ts` and its siblings are mocked-DB unit tests, which the brief's
own rule excludes from rung-4 proof ("Mocked-DB coverage is not proof... A test that hand-builds
the payload does not prove the chain").

So: book/create has full row+audit+cross-tenant proof for **execution**, but its
**drafting/resolution leg is unproven by real Postgres** — the exact standard the brief applies
strictly. Under the brief's own conjunctive-requirement precedent (which is what capped this row
at 4 in the first place), one of three verbs lacking full end-to-end proof caps the row.

**I score B4.7 at 4 (unchanged from the first pass), for a different reason than the one the
first pass found and this run's own commit fixed.** The cross-tenant gap is genuinely closed;
a new gap in the same leg keeps the row from 5.

## B7.5 — a finding that overturns the run's own framing

The master prompt described B7.5 as: "unit now exists on the shared lineItemSchema... on the
catalog resolver now carries a matched item's unit onto the grounded line... STILL MISSING: no
classifier structured part-mention extraction... Score accordingly." I verified the plumbing
claims directly and they are all true — `unit` exists and round-trips cleanly through:
`packages/shared/src/contracts/money.ts:48` (`lineItemSchema`), `packages/api/src/shared/
billing-engine.ts:31` (`LineItem`), `packages/api/src/proposals/contracts.ts:321`
(the proposal line-item contract), `packages/api/src/estimates/estimate-editor.ts:35,87-91`
(`EstimateEditLineItemInput`, applied post-`buildLineItem` so it can't touch money math), both
INSERT paths (`pg-estimate.ts:396`, `pg-invoice.ts:531`), the row mapper
(`document-row-mappers.ts:16`), and `catalog-resolver.ts:568` (`groundLineItemPricing` carries a
matched catalog item's unit onto a grounded draft line). I ran every cited test:
`money.test.ts` (17/17), `spoken-parts-line-item.test.ts` (3/3, real-Postgres round-trip + raw
column read + money-unchanged assertion), `estimate-grounding-idempotent.test.ts` (4/4, the two
new B7.5 cases). All pass, and none of this plumbing broke the previously-passing estimate/
invoice execution suites (re-ran 10 files / 46 tests touching the same shared modules, all
green).

But two of those tests **hand-build their payload literals** — `spoken-parts-line-item.test.ts`
constructs `{ description, quantity, unit: 'each', unitPrice, category }` directly as an
`EstimateEditAction`, not via the real drafting task. Per the brief's rule that disqualifies the
drafting leg in exactly this situation, I traced the *actual* production path a spoken "add
three capacitors to the Smith estimate" would take, and found it never produces a `unit`
anywhere, for a genuinely structural reason the run's framing did not surface:

1. **The LLM extraction prompt for the real edit task never asks for a unit.**
   `estimate-edit-task.ts`'s `ESTIMATE_EDIT_SYSTEM_PROMPT` (lines 41-79) requests only
   `description`, `quantity`, `unitPrice`, `category` — no unit-of-measure field exists in the
   schema the model is asked to fill, for either estimates or (checked `estimate-task.ts`
   similarly) fresh drafts.
2. **The real edit-path grounding function doesn't attach one either.** `estimate-edit-task.ts`
   calls `groundEditActionPricing` (`ai/resolution/edit-action-grounding.ts`) — a *different*
   module from `groundLineItemPricing`. I grepped it for `unit` and found zero references to a
   unit-of-measure field (only `unitPrice`/`unitPriceCents` money fields). So even a catalogued
   match, on the actual "add a line to an existing estimate" voice path (the flow F-4 in Part F
   describes as how B7.5 is meant to land), never carries a unit forward.
3. **The one place a catalog match *does* attach unit (`groundLineItemPricing`, used by the
   fresh-draft path `estimate-task.ts`/`invoice-task.ts`, i.e. B8.1/B9.1) gets it stripped
   again before persistence.** `DraftEstimateExecutionHandler.execute` and its invoice
   equivalent both call `normalizeDraftLineItems` (`handlers.ts:765-833`) to convert the
   approved payload into `LineItem[]`. That function explicitly whitelists which fields survive
   (`id, description, quantity, unitPriceCents, totalCents, sortOrder, taxable, category,
   pricingSource, groupKey, groupLabel, isOptional, isDefaultSelected, imageFileId` —
   read line by line) and `unit` is not among them. I confirmed `draft-estimate-execution.test.ts`
   never selects the `unit` column in its row-read assertions (only `description, quantity,
   unit_price_cents, total_cents, pricing_source`), so this gap is untested and unnoticed by
   the run's own suite.

**Net: in the entire live system, there is currently no path — voice, catalog match, or
otherwise — by which a spoken sentence's unit-of-measure survives to a persisted row.** The
storage layer is real and correctly built (money-safety proven, round-trip proven), but it is
reachable only from a hand-built test literal, never from the drafting → execution pipeline that
actually runs in production. This is a stronger, more specific finding than the master prompt's
own "Score accordingly" framing suggested (which implied at least the catalogued-match path was
live) — that path is dead too, one layer further down (`normalizeDraftLineItems`). I score B7.5
at **2** (Present, unreachable), unchanged from the first pass: more plumbing exists, and it is
provably correct in isolation, but reachability from an actual spoken sentence is still zero.

## 19-row table

Prior rung = `docs/PRD-v4-part-E-state.md` §5. First-pass rung = the prior revision of this
document (measured at `7d8fbd4`). New rung = this measurement, `5f71f79`.

| Requirement | Part E | 1st pass | New | Evidence I personally ran/verified | What's missing below 5 |
|---|---|---|---|---|---|
| **B1.18** Brand voice captured, then locked | 3 | 4 | **4** (unchanged) | Re-ran `test/integration/update-brand-voice-voice-execution.test.ts` — 4/4 pass. `docs/PRD-v4-part-F-decisions.md:31-43` (F-2) still **PROPOSED**, no ratification marker anywhere in the repo (grepped `docs/decisions.md` and Part F itself). | RED per brief rule: F-2 unratified. |
| **B1.19** Conversational onboarding, 10–15 exchanges, clarification loop | 3 | 3 | **4** | `onboarding-conversation-parity.test.ts` — ran, 11/11 pass (was passing at 3 originally too, count unchanged — the new assertions extended the SAME test, not a new one). Verified `5f71f79` genuinely wires a real `pending_invitations` row + `user.invitation_created` audit event once an operator supplies the email the voice-drafted proposal is gated on; confirmed `pending-invitation.ts` predates this entire run (`git log --follow`, last touch `4bc8f59`, unrelated). 4 of 5 onboarding proposal types (identity/pack/schedule/template) have full rung-5-worthy proof (row+audit+cross-tenant, all re-run). | Team-member completion always requires a human-typed email — structurally never producible by voice, unlike disambiguation-by-tap. Also: the completion path's `pending_invitations` row is proven but its audit event (`user.invitation_created`) is asserted by no test anywhere (grepped). Row capped at 4, not 5. |
| **B4.7** Book / move / cancel by speaking | 3 | 4 | **4** (unchanged, different reason) | `efe05f3`'s cross-tenant fix verified: ran `voice-inbound-appointment.test.ts` (2/2), the added negative (`appointmentRepo.findById(other.tenantId, booked!.id)` → null) is real. Reschedule/cancel re-ran (7/7), still fully proven incl. drafting via `rivet-voice-19-focus.test.ts` (8/8). | **New finding, not flagged by the run**: the create/book leg's real-Postgres proof hand-builds its `CreateProposalInput` payload literal rather than driving `CreateAppointmentTaskHandler`; `rivet-voice-19-focus.test.ts`'s own corpus (verified: `toHaveLength(6)`, ops = add_note/reassign/log_time/reschedule/cancel) never covers create/book. Drafting-leg proof for book/create rests on mocked-DB unit tests only, which the brief excludes. One of three verbs unproven end-to-end → row capped at 4. |
| **B5.3** Assign work (reassign) by speaking | 3 | 5 | **5** | Re-ran `reassign-appointment-voice.test.ts` (5/5) and `rivet-voice-19-focus.test.ts` (8/8, incl. the named-no-match negative). No files touched this pass. | — |
| **B5.5** "On my way" by app/SMS/voice | 3 | 5 | **5** | Re-ran `en-route-voice.test.ts` (3/3). No files touched this pass. | — |
| **B6.3** Time entries by voice | 3 | 5 | **5** | Re-ran `log-time-entry-execution.test.ts` (4/4). No files touched this pass. | — |
| **B7.1** Push-to-talk from any screen | 5 | 5 | **5** (unchanged) | `git diff 1074ecd..5f71f79 --name-only` — no touch to `Shell.tsx`/`VoiceBar`. | — |
| **B7.4** Job notes dictated | 3 | 5 | **5** | Re-ran `add-note-voice-execution.test.ts` (3/3). No files touched this pass. | — |
| **B7.5** Parts by speaking (name + qty + unit) | 0 | 2 | **2** (unchanged) | See finding above: schema/contracts/persistence genuinely round-trip (ran `money.test.ts` 17/17, `spoken-parts-line-item.test.ts` 3/3, `estimate-grounding-idempotent.test.ts` 4/4), but traced the real production chain and found unit never reaches a payload from an actual utterance — the edit-task LLM prompt never asks for it, the edit-path grounding function never attaches it, and even the one place a catalog match does attach it (draft-path `groundLineItemPricing`) gets it stripped by `normalizeDraftLineItems` before persistence. | No classifier extraction, no live catalog-carry to persistence (even for catalogued items), no UI, no C1 rows (grepped — zero matches for `SpokenPart`/`spoken-parts` anywhere in `src/`, zero `part`-related lines in `voice-payload-contract.test.ts`). |
| **B7.6** Spoken line-item to existing estimate | 3 | 5 | **5** | Re-ran `update-estimate-execution.test.ts` (3/3). Confirmed the B7.5 changes to `estimate-editor.ts`/`pg-estimate.ts` didn't regress this. | — |
| **B7.7** Job status by voice | 5 | 5 | **5** (unchanged) | `git diff 1074ecd..5f71f79 --name-only` — no touch. | — |
| **B7.8** Expense by voice *(deferred)* | 3 | 3 | **3** (unchanged) | `git diff 1074ecd..5f71f79 --name-only` — no touch to `LogExpenseTaskHandler`'s path. | Deferred; unchanged. |
| **B7.9** Read-only lookups by voice *(deferred)* | 3 | 3 | **3** (unchanged) | No touch. | Deferred; unchanged. |
| **B7.10** Crew add/remove by voice *(deferred)* | 3 | 3 | **3** (unchanged) | No touch. | Deferred; unchanged. |
| **B8.1** Estimate from spoken description or photo | 3 | 5 | **5** | Re-ran `draft-estimate-execution.test.ts` (3/3). Confirmed the B7.5 `normalizeDraftLineItems` review didn't change any existing assertion (it already never selected `unit`). | — |
| **B8.10** Nudge by voice | 3 | 5 | **5** | Re-ran `estimate-nudge.test.ts` (11/11). No files touched this pass. | — |
| **B9.1** Invoice from a spoken sentence | 3 | 4 | **4** (unchanged) | Re-ran `draft-invoice-execution.test.ts` (7/7) and `issue-invoice-conversation-resolution.test.ts` (3/3). F-1 still **PROPOSED**, no ratification. | RED per brief rule: F-1 unratified. |
| **B9.4** Batch invoice by voice *(deferred)* | 3 | 3 | **3** (unchanged) | No touch. | Deferred; unchanged. |
| **B9.12** Reminder + late fee by voice *(deferred)* | 3 | 3 | **3** (unchanged) | No touch. | Deferred; unchanged. |

## Rows that changed since the first pass, and why

- **B4.7 (4 → 4, same number, different basis).** The cross-tenant gap the first pass found is
  genuinely closed (`efe05f3`, verified). It stays at 4 because this pass's own independent
  re-derivation found a different gap in the same leg: the create/book verb's drafting proof is
  unproven by real Postgres (hand-built payload). Net: still not 5, for a reason the run's own
  commit did not — and could not, since it targeted a different gap — address.
- **B1.19 (3 → 4).** The team-member sub-flow is no longer a dead end. `5f71f79` corrected a
  false premise from an earlier commit ("no invitation endpoint exists") and wired the handler to
  a real, pre-existing repo. This is a genuine improvement, verified by running the updated test
  and independently tracing the invitation repository's history. It stops short of 5 because
  completion always requires a human-typed field voice cannot supply, and because that specific
  completion path's audit event is unasserted by any test.
- **All other rows: unchanged from the first pass.** Re-ran every cited integration test for
  each row that wasn't part of this round's work (B5.3, B5.5, B6.3, B7.4, B7.6, B8.1, B8.10) and
  confirmed all still pass, with no regression from the B7.5 plumbing touching shared modules
  (`billing-engine.ts`, `estimate-editor.ts`, `pg-estimate.ts`, `pg-invoice.ts`,
  `document-row-mappers.ts`).

## Deferred five, D-013, and S1 allowlist — integrity re-checked at the new head

```
git diff 1074ecd..5f71f79 --name-only | grep -iE "AddCrewMember|RemoveCrewMember|LogExpense|ApplyLateFee|SendPaymentReminder|BatchInvoice"
```
returns nothing — no deferred-handler path touched between the first pass and this one. All
five stay at rung 3, matching Part E and the first pass exactly.

```
git diff 1074ecd..5f71f79 -- packages/api/src/routes/assistant.ts \
  packages/api/src/ai/voice-turn/create-voice-turn-processor.ts \
  packages/api/src/ai/tasks/proposal-approval-task.ts
```
empty — D-013's three byte-untouched files remain untouched.

```
git diff 1074ecd..5f71f79 -- packages/api/src/proposals/surface.ts
```
empty — no widening of the `S1_ALLOWED_PROPOSAL_TYPES` allowlist since the first pass.

## Claims that did not survive verification

1. **The master prompt's own framing of B1.19** ("gated at draft time... never
   completable... judge whether that reaches 5") described a state that had already been
   superseded by commit `5f71f79` at the time I measured. This isn't a run claim that failed —
   it's the master prompt citing an intermediate state one commit behind HEAD. I measured the
   actual head and scored accordingly (4, not the binary "3 or unchanged-3" the prompt implied).
2. **The master prompt's framing of B7.5** ("the catalog resolver now carries a matched item's
   unit onto the grounded line... Score accordingly") is true only of one grounding function
   (`groundLineItemPricing`, used by the fresh-draft path) and even that gets the unit stripped
   before persistence by `normalizeDraftLineItems`. The actual live edit-path grounding function
   (`groundEditActionPricing`) never attaches a unit at all. In practice, zero live paths carry a
   spoken/catalog-matched unit to a persisted row. I did not take the "Score accordingly"
   framing as license to score higher than 2; if anything this finding argues for staying
   exactly where the first pass had it.
3. **B4.7's "restored" framing.** `efe05f3`'s commit message is explicit that it doesn't itself
   re-score the row ("It does NOT itself re-score the row... any move to 5 needs
   re-verification") — that message survives verification intact. But nothing in the run
   claimed the create leg's drafting proof was hand-built; that gap was found independently by
   this pass, not asserted-and-checked.

Nothing else failed to hold up. Every audit-event assertion, cross-tenant negative, and test
count I spot-checked for the unchanged nine rows (B7.1, B7.7, B7.4, B5.3, B8.10, B6.3, B5.5,
B7.6, B8.1) reproduced exactly.

## Commands run (all re-runnable)

```bash
# Environment / diff checks
git log --oneline -20
git status --short
git rev-parse HEAD
git diff 1074ecd..5f71f79 --stat
git diff 1074ecd..5f71f79 --name-only -- packages/api/src packages/web/src
git diff 1074ecd..5f71f79 -- packages/api/src/routes/assistant.ts \
  packages/api/src/ai/voice-turn/create-voice-turn-processor.ts \
  packages/api/src/ai/tasks/proposal-approval-task.ts
git diff 1074ecd..5f71f79 -- packages/api/src/proposals/surface.ts
git diff 1074ecd..5f71f79 --name-only | grep -iE "AddCrewMember|RemoveCrewMember|LogExpense|ApplyLateFee|SendPaymentReminder|BatchInvoice"
git show --stat efe05f3 4c07cf4 52edb15 0d85691 3c50d1c 5f71f79
git log --follow -- packages/api/src/users/pending-invitation.ts

# Build verification
cd packages/api && npx tsc --project tsconfig.build.json --noEmit

# Docker-gated integration tests (RLS_RUNTIME_ROLE=true, vitest.integration.config.ts)
cd packages/api
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  test/integration/onboarding-conversation-parity.test.ts \
  test/integration/voice-inbound-appointment.test.ts \
  test/integration/entity-resolution.test.ts \
  test/integration/spoken-parts-line-item.test.ts

RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  test/integration/reschedule-appointment-voice.test.ts \
  test/integration/cancel-appointment-voice.test.ts

RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  test/integration/update-estimate-execution.test.ts \
  test/integration/draft-estimate-execution.test.ts \
  test/integration/draft-invoice-execution.test.ts \
  test/integration/issue-invoice-conversation-resolution.test.ts \
  test/integration/estimate-nudge.test.ts \
  test/integration/en-route-voice.test.ts \
  test/integration/update-brand-voice-voice-execution.test.ts \
  test/integration/log-time-entry-execution.test.ts \
  test/integration/reassign-appointment-voice.test.ts \
  test/integration/add-note-voice-execution.test.ts

# Unit tests
npx vitest run test/ai/tasks/estimate-grounding-idempotent.test.ts
npx vitest run   # full api unit suite — 1056 files / 12053 tests, all green

# Shared package
cd packages/shared && npx vitest run   # 16 files / 169 tests, all green
npx vitest run src/contracts/money.test.ts

# Web
cd packages/web
npx vitest run src/hooks/useOnboardingConversation.test.ts src/components/auth/ProtectedRoute.test.tsx

# B7.5 production-path tracing (the finding above)
grep -n "unit" packages/api/src/ai/resolution/catalog-resolver.ts
grep -n "unit" packages/api/src/ai/resolution/edit-action-grounding.ts   # zero unit-of-measure refs
grep -n "unit" packages/api/src/ai/tasks/estimate-edit-task.ts           # prompt never asks for it
grep -n "unit" packages/api/src/proposals/execution/handlers.ts          # normalizeDraftLineItems whitelist
grep -rln "SpokenPart\|spoken-parts" packages/api/src                    # no matches
grep -n "unit" test/integration/draft-estimate-execution.test.ts        # never selects unit column

# B1.19 production-path tracing
grep -n "missingFields\|unfilled required fields" packages/api/src/proposals/actions.ts
git log --follow --oneline -- packages/api/src/users/pending-invitation.ts
grep -rln invitation_created packages/api/test packages/api/src         # asserted nowhere

# Deferred five / D-013 / S1 allowlist re-check (see "Deferred five" section above)
```
