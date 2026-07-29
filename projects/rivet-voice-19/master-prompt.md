# Rivet — VOICE Phase 1 (8 of 19) `/goal` Master Prompt

For **Rivet** — the voice-and-AI-first back office for 1–3-truck owner-operator shops. Part E
(2026-07-29, incl. post-review corrections — run log #16-17) measured voice coverage at **3/19
strict** (after post-review correction rounds, run log #16-18). This run ships the **eight focus
requirements** below to rung 5, taking coverage to **14/19**. Five items are explicitly deferred
(appendix) — do not touch them except where a cross-cutting gate requires it.

**Focus set:** B7.4 · B5.3 · B8.10 · B6.3 · B5.5 · B1.18 · B1.19 · B7.5

**North star:** Mike or Jenna speaks the sentence while driving and the thing happens — a typed
proposal they tap once, or a status act that's audited — with nothing silently lost and nothing
that "approves" and then saves nothing.

---

## How to run

1. This file lives at `projects/rivet-voice-19/master-prompt.md`.
2. Evidence base: `docs/PRD-v4-part-E-state.md` (§5) + `projects/rivet-part-e/reports/`. Every
   break point below carries a `file:line` from that run — **re-verify each before changing it.**
3. In Claude Code with **Fable 5**, from the repo root:

   ```
   /goal Read projects/rivet-voice-19/master-prompt.md and execute everything below the divider as
   your goal. Follow it exactly, including the never-ask rule, the D-013 hard stop in Guardrail 2,
   and the held-commit rule in Guardrail 3. Do not report back until the definition of done is met.
   Start now. Use fable to orchestrate and adjudicate; fan the work out to cheaper models.
   ```

4. **Cost control:** Fable plans, reviews diffs against guardrails, and adjudicates the final
   re-measurement. Subagents implement items in parallel worktrees. Fable stays on the B7.5
   contract change, the B1.19 surface design, and the C1 test design — that's where the expensive
   mistakes live.

---
<!-- ================= EVERYTHING BELOW THE DIVIDER IS THE GOAL ================= -->

## MISSION

Ship the eight focus requirements to **rung 5, with proof**: for each, a spoken fixture traverses
`utterance → classifier → INTENT_TO_PROPOSAL_TYPE → Zod payload → entity resolution → approvable
proposal → execution → persisted row + audit event` (or the audited status-act / conversation
equivalent), pinned by a Docker-gated integration test (audit + cross-tenant negative) and a
voice-quality fixture. The run ends with a **read-only re-measurement of all 19** using the Part E
Track B method; the deliverable is that re-run scoring **14/19**: the three previously-green items (B7.1, B7.7,
B9.1) still green, B4.7/B7.6/B8.1 restored to rung 5 by items 9-10's proof-only tests, the eight
focus items newly green, and the five deferred items unchanged.

## GUARDRAILS

1. **Never ask a question.** Every judgment call: make it, log it in
   `projects/rivet-voice-19/run-log.md`, continue. Where an item says "Decision:", the default is
   pre-made — take it unless the code contradicts it, and log either way.
2. **D-013 is a hard stop.** `approve_proposal`/`reject_proposal`/`edit_proposal` stay hard-refused
   on recorder and in-app voice. Nothing here makes approval voice-reachable — including B1.18's
   *lock* (tap-only, pinned by a negative test). Any diff touching `isVoiceApprovalIntent` gating,
   RV-071/225, or the `ownerSession` gate is out of scope — revert it.
3. **Repo invariants + held commits.** Integer cents · UTC-stored/tenant-rendered time · tenant_id
   + RLS FORCE · every mutation audits · gateway-only AI calls · typed Zod proposals,
   human-approved · catalog-resolved prices. **Money/RLS/auth-touching commits are isolated,
   labeled, and held for human review.** Everything else merges on green.
4. **The map must not lie.** Any intent/proposal-type change updates
   `docs/reference/voice-action-catalog.md` and the launch fixtures in the same commit; both
   intent-map contract tests stay green.
5. **Every fix ships its regression test in the same commit.** DB-touching flows need Docker-gated
   integration tests (row + audit event + cross-tenant negative). Mocked-DB coverage is not proof.
6. **Gates before every commit:** `cd packages/api && npx tsc --project tsconfig.build.json
   --noEmit` · `npm test` · `npm run test:integration --workspace=packages/api` · voice-quality
   rubric ≥ current thresholds · grep `docs/solutions/` before debugging documented areas.

## CROSS-CUTTING GATE — C1, build first

**Payload-contract drift test** (`packages/api/test/proposals/voice-payload-contract.test.ts`,
table-driven): for every intent in `INTENT_TO_PROPOSAL_TYPE`, run the **real** drafting task
handler with resolver-style `existingEntities`, and assert the produced payload either satisfies
the **real** execution handler's requirements or carries honest, non-empty `missingFields`. This is
the missing test class that let voice actions break beneath green contract tests (Part E §5). It
must fail on today's `add_note` shape before the B7.4 fix, and pass after — that failing-then-green
transition is itself an acceptance criterion. It becomes a permanent CI gate covering **all**
mapped intents (deferred items included — for those it pins current honest-gating behavior, it does
not fix them).

---

## THE FOCUS EIGHT — break points and verifiable acceptance criteria

Ordering is priority order. AC are numbered per item; each is independently checkable by a
reviewer running the named command or reading the named artifact. "Fixture" = a rubric-suite
script under the voice-quality eval plus, where noted, a classifier launch fixture
(`npm run test:voice-fixtures`).

### 1 · B7.4 — Job notes dictated ("Note on the Patel job — wants morning visits")

**Today:** approves, then fails at execution. Task sets only `targetReference`
(`voice-extended-tasks.ts:460-484`), `missingFields` stays empty, handler requires a UUID
(`voice-extended-handlers.ts:94-99`). Silent data loss.

**AC:**
1. **Unit (task):** with `existingEntities.jobId=J`, the task payload has `targetKind:'job'`,
   `targetId:J`, `body` = the note text verbatim, `missingFields:[]`. (Pattern:
   `complaint-task.ts:94-97`.)
2. **Unit (honest gate):** with no resolvable target, payload carries
   `missingFields:['targetId']` and `approveProposal` throws
   (`proposals/actions.ts:214-219` path exercised in the test).
3. **Unit (ambiguity):** resolver-ambiguous target ("two Patel jobs") yields a
   `voice_clarification` proposal with the candidate list — never an `add_note` with empty
   `missingFields`.
4. **Integration** (`test/integration/add-note-voice-execution.test.ts`, real Postgres): the
   **task-produced** payload (not hand-built) → approve → execute → note row persisted on the
   job; exactly one note-created audit event with actor attribution; **cross-tenant negative**
   (tenant B cannot read the note).
5. **C1:** `add_note` row in the payload-contract test — red before this fix, green after.
6. **Fixture:** rubric script asserting `add_note` proposal with a resolved `targetId`; classifier
   fixture unchanged (intent already exists).
7. **Regression pin:** a test that constructs the pre-fix payload shape (`targetReference` only,
   empty `missingFields`) and asserts it is now rejected at draft time.

### 2 · B5.3 — Assign work by speaking ("Assign Carlos to the Johnson job")

**Today:** blocked. `missingFields=['appointmentId']` unconditional (`voice-extended-tasks.ts:378`)
ignoring the router-threaded id (`voice-action-router.ts:1498-1500`); a job-name-only reference
falls to soonest-appointment-tenant-wide (`pg-entity-resolver.ts:397-437`); "assign NAME to JOB"
phrasing risks classifying as `add_crew_member`.

**AC:**
1. **Classifier fixtures (added to launch fixtures, `npm run test:voice-fixtures` green):**
   "Assign Carlos to the Johnson job" → `reassign_appointment`; "Put Carlos on the Garcia job
   instead of me" → `reassign_appointment`; "Add Carlos to the Garcia appointment" →
   `add_crew_member`. All three pinned; the ambiguous minimal pair is now decided by test, not luck.
2. **Unit (task):** with `existingEntities.appointmentId=A` and resolved technician `T`, payload
   has `appointmentId:A`, `toTechnicianId:T`, `missingFields:[]`.
3. **Unit (resolution by name):** "the Johnson job" resolves job→appointment: unique upcoming
   appointment for that job → its id lands on the payload; multiple → `voice_clarification` with
   ≤5 candidates carrying date + assigned tech; **zero name-match must NOT return an arbitrary
   soonest appointment** — pinned by a `pg-entity-resolver` unit test where a non-matching name
   reference yields not_found/ambiguous, never a fallback id.
4. **Unit (technician ambiguity):** "two Carloses" → `voice_clarification` picker (existing
   behavior, now pinned on this path).
5. **Integration** (`test/integration/reassign-appointment-voice.test.ts`, real Postgres):
   task-produced payload → approve → execute → appointment's technician changed; staleness +
   feasibility checks still invoked (assert the feasibility gate ran); reassignment audit event;
   **cross-tenant negative**.
6. **C1:** `reassign_appointment` row green with resolver-provided ids.
7. **Fixture:** rubric script: the sentence ends in an approvable proposal (non-empty ids, empty
   `missingFields`).

### 3 · B8.10 — Estimate nudge by voice ("Nudge the Khan estimate")

**Today:** blocked by design comment — `missing=['estimateId']` unconditional
(`voice-extended-tasks.ts:667`).

**AC:**
1. **Unit (task):** unique open-estimate match for "Khan" → `payload.estimateId` set,
   `missingFields:[]`. Reference resolution follows the proven `resolveEstimateIdGate` pattern
   (`estimate-edit-task.ts:265,350-356`).
2. **Unit (ambiguity):** two nudgeable Khan estimates → `voice_clarification` with candidates
   (estimate number + amount + age).
3. **Unit (state filter):** only nudgeable states (sent/viewed — not draft, accepted, declined, or
   expired) participate in matching. A unique match in a non-nudgeable state → honest gate with a
   reason surfaced on the draft. Decision: gate (not clarification) — log it.
4. **Unit (no match):** `missingFields:['estimateId']` — today's behavior becomes the fallback,
   not the default.
5. **Integration** (`test/integration/estimate-nudge.test.ts` extended, real Postgres):
   voice-produced payload → approve → execute → nudge dispatch row + audit event; **48h cooldown
   holds under voice**: a second voice-approved nudge inside the window sends nothing and records
   the suppressed outcome; **cross-tenant negative**.
6. **C1** row green. **Fixture:** sentence → approvable `send_estimate_nudge` proposal.

### 4 · B6.3 — Time entries by voice ("Clock 2 hours on the Patel job")

**Today:** the chain works (probe-verified approvable + executes) — it lacks rung-4 proof.

**AC:**
1. **Integration** (`test/integration/log-time-entry-execution.test.ts`, real Postgres): the
   task-produced payload for the fixture sentence → approve → execute → `time_entries` row with
   `durationMinutes:120` and the resolved `jobId`; time-entry audit event with actor; **cross-tenant
   negative** (tenant B query returns empty).
2. **P&L linkage:** the same test (or `job-profit` suite extension) asserts the entry is counted by
   the job-profit query for that job.
3. **C1** row green (should pass without code change — if it does not, what it finds is in scope).
4. **Fixture:** rubric script pinning the full sentence → approvable `log_time_entry` proposal.

### 5 · B5.5 — "On my way" by voice and SMS keyword

**Today:** app button only (`dispatch/routes.ts:262-310`). No intent; no `en_route` JobStatus; no
SMS keyword (`tech-status-event.ts:70` = out/sick/unavailable).

**Decision (log it):** voice/SMS legs invoke the **same audited direct status act** as the app
button (en-route coordinator → `appointment.en_route_triggered` audit → branded ETA SMS), not a
proposal. Governance rationale, stated fully because a reviewer challenged it: A5.2's invariant
governs **AI-proposed actions**; a technician saying "on my way" is the human acting directly —
the exact precedent PRD B10.10 already blesses ("the owner IS the human", direct + audited +
DNC-gated), and the shipped app button already executes this same act directly. What voice adds is
classification risk, so: a low-confidence `en_route` classification MUST gate to clarification
rather than fire (add a confidence-floor test), the intent is registered in the documented
non-proposal set exactly as `lookup_*` is (so B7.11's drift test recognizes it as intentional, not
a gap), and the decision is recorded in the run log and Part F. If the reviewer of this run's held
commits rejects the rationale, the fallback is an auto-approvable capture-class proposal — but
that is a human call at review time, not a reason to stall the run. No new `JobStatus` value is
introduced.

**AC:**
1. **Classifier:** new `en_route` intent in `SUPPORTED_INTENTS` with launch fixtures: "On my way to
   the Garcia job", "Heading to my next one now", and a negative pin — "I'm running 20 minutes
   late" stays `notify_delay`. Catalog doc updated in the same commit; both contract tests green
   (the intent is deliberately NOT in `INTENT_TO_PROPOSAL_TYPE`; add it to the documented
   non-proposal set the same way `lookup_*` is, so the drift test recognizes it as intentional).
2. **Speaker scoping:** the voice path resolves the appointment **within the speaker's own
   assignments only** — a technician's "on my way" can never target another tech's appointment.
   Unit test proves the query is filtered by the acting user.
3. **Resolution:** named job → that appointment; bare "on my way" → the tech's next upcoming
   appointment today; two candidates → clarification; zero → an explicit spoken/visible "no
   upcoming appointment" outcome — asserted, never silent.
4. **Integration** (`test/integration/en-route-voice.test.ts`, real Postgres): voice-triggered
   en-route → `appointment.en_route_triggered` audit with tech actor + customer ETA SMS dispatch
   row (existing branded template); idempotence (second utterance within the window doesn't
   double-text the customer); **cross-tenant negative**.
5. **SMS keyword:** inbound `OMW` / "on my way" from a registered tech phone joins
   out/sick/unavailable in the tech-status keyword handler; handler-suite tests cover match,
   non-tech sender (ignored), and DNC/consent invariants untouched.
6. **Fixture:** rubric script for the spoken leg ending in the audited status act.

### 6 · B1.18 — Brand voice captured by voice, then locked

**Today:** web form only (`BrandVoiceSheet.tsx`); versioned + cooldown + `brand_voice_locked`
(`schema.ts:5948`); no intent exists.

**Scope decision (log it):** capture is speakable; **lock stays tap-only** (control act, same
theory as D-013). Smallest honest scope: one new intent + proposal type; no multi-turn interview.

**AC:**
1. **Contract:** new `update_brand_voice` intent → new proposal type with a Zod payload matching
   the six BrandVoiceSheet fields; mapped in `INTENT_TO_PROPOSAL_TYPE`; execution handler
   registered with `isFullyWired()`; catalog doc + launch fixtures updated; both contract tests
   green. Action class: `capture`-adjacent but **never auto-approves** — assert
   `decideInitialStatus` can not auto-approve this type at any trust tier (unit test).
2. **Unit (task):** fixture "Set my brand voice: friendly, plain-spoken, no slang, always sign off
   'Thanks — Bob's HVAC'" → draft proposal populating tone/sign-off fields; unmapped instructions
   land in the free-text field, nothing dropped; low-confidence extraction surfaces confidence
   markers, never guesses silently.
3. **Execution:** approve → writes through the **same** versioned path as the sheet: new
   `brand_voice_versions` row, version incremented, cooldown enforced; cooldown violation surfaces
   as an honest failed-execution reason on the proposal (not a silent skip). Integration test
   (real Postgres): version row + audit event + **cross-tenant negative**.
4. **Lock negative:** a spoken "lock my brand voice" does **not** set `brand_voice_locked` — pinned
   by a test (either the classifier maps it to the capture intent whose payload cannot express
   lock, or it clarifies; both acceptable, logged).
5. **UI:** `BrandVoiceSheet` shows the voice-created version identically to a form-created one
   (existing component test extended).
6. **C1** row green. **Fixture:** rubric script → approvable brand-voice proposal.

### 7 · B7.5 — Parts and materials by speaking, structured name + quantity + unit

**Today:** rung 0. No parts intent; no qty/unit entity fields; **no `unit` field on any line item**
(`contracts.ts:306-329`, `billing-engine.ts:19-45`); catalog `unit` dropped at
`catalog-resolver.ts:558`.

**Scope decision (log it):** spoken parts land on **billing documents** (the job's active
estimate/invoice) via the proven line-item edit path — that is what "add it to the estimate" means
— not a new job-materials table (Part F candidate).

**AC:**
1. **Contract change (build-blocking, do first):** optional `unit: CatalogUnit` added to
   `lineItemSchema`, `EstimateEditLineItemInput` (`estimate-editor.ts:30-44`), and the shared
   billing-engine `LineItem`; `npx tsc --project tsconfig.build.json --noEmit` green; money math
   untouched (unit is descriptive, price stays integer cents — pinned by billing-engine unit
   tests).
2. **Resolver threading:** a catalog match now carries the catalog item's unit onto the resolved
   line (unit test: catalog item with unit `ea` → resolved line `unit:'ea'`); uncatalogued lines
   may carry a spoken unit; the uncatalogued **confidence cap still applies** (existing invariant
   re-pinned).
3. **Classifier:** entity extraction gains structured part mentions `{name, quantity, unit?}`;
   launch fixtures: "Add three 45-microfarad capacitors to the Smith estimate" → `update_estimate`
   / `add_line_item` with qty 3, unit each; "Add two hours of labor to the Garcia invoice" →
   `update_invoice` with qty 2, unit hour.
4. **Targeting:** named document → that document; "the job"/unnamed with exactly one open
   estimate/invoice on the resolved job → that document; multiple candidates → clarification;
   none → honest gate (`missingFields`), with the draft preserving the structured parts so nothing
   spoken is lost. Decision: no auto-created estimate in this run — log it.
5. **Integration** (`test/integration/spoken-parts-line-item.test.ts`, real Postgres):
   voice-produced edit → approve → execute → line persisted with description, quantity, **unit**,
   integer-cents price, catalogItemId when grounded; document totals correct; audit event;
   **cross-tenant negative**.
6. **UI:** unit renders on the estimate review line items and the customer approval page; jsdom
   class-contract + 320px viewport checks per repo rules (no horizontal overflow).
7. **C1** rows green for `update_estimate`/`update_invoice` with parts payloads. **Fixture:**
   rubric script for AC-3's first sentence ending in an approvable proposal carrying qty+unit.

### 8 · B1.19 — Conversational onboarding, wired to a real surface

**Today:** the engine is real and orphaned — multi-turn FSM with persisted sessions
(`ai/orchestration/onboarding-conversation.ts`, route `app.ts:5488`), **zero clients**; text-only;
missing the PRD's `tools` capture state. Shipped UX is the form wizard.

**AC:**
1. **Surface:** the v2 onboarding flow (`OnboardingShell`) gains a "talk it through" step: mic
   capture reusing the existing recording→transcription machinery for STT, transcript POSTed to
   `POST /api/onboarding/conversation/turn`, agent reply rendered, loop continues. The form wizard
   remains the default fallback and edit surface (B1.20 guard tests stay green).
2. **Session persistence, user-visible:** mid-conversation page refresh resumes the same
   `onboarding_session` with history intact — Playwright test.
3. **`tools` state added** to the engine + transitions tests updated; the state machine still
   passes its existing suite.
4. **Clarification loop, demonstrated:** a scripted turn test (mocked gateway) where an answer
   opens a follow-up ("me and my cousin Carlos" → the agent asks Carlos' role) — asserting
   `clarificationCountByState` increments and the question is asked, not skipped.
5. **Parity of outcome:** a completed scripted conversation produces the same tenant configuration
   the wizard produces for identical facts — business profile, hours + **explicitly confirmed**
   timezone (never guessed — regression pin stays green), pricing seed, team, vertical pack —
   asserted against real Postgres via the existing integration test extended with the
   conversation-driven path, including audit events and the **cross-tenant negative** already in
   `onboarding-conversation.test.ts:128`.
6. **Extraction writes are proposal/approval-shaped** exactly as the engine already defines —
   nothing in the new surface bypasses approval semantics for config writes that require them.
7. **Mobile-safe:** the step meets ≥44px targets and no horizontal overflow at 320px — jsdom
   class-contract test + Playwright viewport test (repo-mandated pattern,
   `e2e/estimate-approval-mobile.spec.ts` as reference).
8. **E2E:** one Playwright script drives a **10–15 exchange** spoken-style conversation (mocked
   gateway, text-injected transcripts) from fresh signup to "CRM unlocked" — matching the source
   requirement's stated depth, covering all six capture states (profile, category, pricing, team,
   schedule, tools) with at least one clarification exchange — asserting the exchange count lands
   in [10,15] and the B1.20 soft-gate opens.

---

### 9 · B4.7 restoration — reschedule/cancel real-DB proofs (proof-only, no behavior change)

**Today:** B4.7 (book/move/cancel by speaking) was corrected to rung 3 in the Part E post-review
round (run log #17): the create leg is integration-proven (`voice-inbound-appointment.test.ts`),
but no integration test exercises `RescheduleAppointmentExecutionHandler` or
`CancelAppointmentExecutionHandler` with the rung-4 assertions. The spoken chains work; the proof
is missing. This item is test-only — if writing the tests reveals a real defect, fixing it is in
scope, and the run log must call it out as a found-by-proof defect.

**AC:**
1. **Integration (reschedule)** (`test/integration/reschedule-appointment-voice.test.ts`, real
   Postgres): task-produced payload for "Move the Garcia job to Thursday at 10" → approve →
   execute → appointment's scheduled window updated; reschedule audit event with actor;
   **cross-tenant negative**.
2. **Integration (cancel)** (`test/integration/cancel-appointment-voice.test.ts`, real Postgres):
   task-produced payload for "Cancel Tuesday's Garcia appointment" → approve → execute →
   appointment status `canceled`; cancellation audit event; **cross-tenant negative**; and the
   irreversible action class is asserted (never auto-approvable at any trust tier).
3. **C1** rows for `reschedule_appointment`/`cancel_appointment` green with resolver-provided ids.
4. Both fixtures added to the rubric suite (spoken sentence → approvable proposal).

### 10 · B7.6 + B8.1 restoration — estimate execution real-DB proofs (proof-only)

**Today:** both were corrected to rung 3 in Part E review round three (run log #18): the spoken
chains work, but **no integration test exercises `UpdateEstimateExecutionHandler` at all** (the
only `update_estimate` integration coverage calls `applyEstimateEdits` directly), and the
`draft_estimate` execution citation was a comment-grep false positive — no test asserts the
estimate audit event + cross-tenant negative through `DraftEstimateExecutionHandler`. Test-only;
any defect found by writing them is in scope and must be flagged as found-by-proof.

**AC:**
1. **Integration (B8.1)** (`test/integration/draft-estimate-execution.test.ts`, real Postgres):
   task-produced `draft_estimate` payload → approve → execute via the registered
   `DraftEstimateExecutionHandler` → estimate row with catalog-grounded integer-cents lines;
   exactly one estimate-created audit event; **cross-tenant negative**.
2. **Integration (B7.6)** (`test/integration/update-estimate-execution.test.ts`, real Postgres):
   task-produced `update_estimate` add-line-item payload → approve → execute via
   `UpdateEstimateExecutionHandler` → line persisted, totals recomputed correctly; estimate-updated
   audit event; **cross-tenant negative**.
3. **C1** rows for both intents green with resolver-provided ids; both already have rubric
   fixtures — extend only if the new tests reveal a fixture gap.

## DEFERRED — do not build in this run

B7.8 (expense job-link) · B7.10 (crew add/remove) · B9.12 (reminder/late fee by voice) · B9.4
(batch-invoice proof + guard) · B7.9 (lookup_leads/lookup_catalog + inventory scope decision) ·
the boot-guard default-fail (C2) · the live-call UTC datetime fix (tracked as Part E punch-list #1
— **flag loudly in the final report if any focus item's fixtures touch spoken datetimes**, but its
fix belongs to the deferred set unless a focus AC cannot pass without it). C1 still *covers* the
deferred intents by pinning their current honest-gating behavior — pins, not fixes.

## DEFINITION OF DONE (self-grade before reporting)

- [ ] Read-only re-measurement of all 19 (Part E Track B method, fresh agent): **14/19 at rung 5** —
      the focus eight newly green, the prior three still green, B4.7/B7.6/B8.1 restored via items 9-10's proofs, the deferred five unchanged
- [ ] Every numbered AC above is demonstrably satisfied — each cites the test/file/command a
      reviewer can re-run
- [ ] C1 payload-contract test exists, covers **all** mapped intents, gates CI, and its
      red-then-green transition on `add_note` is in the run log
- [ ] All new integration tests assert row + audit event + cross-tenant negative and ran green in
      `npm run test:integration`
- [ ] D-013 untouched — approval/edit refusal contract test green; B1.18 lock-by-voice negative
      test green
- [ ] `voice-action-catalog.md`, launch fixtures, and both intent-map contract tests green; voice-
      quality rubric ≥ current thresholds with the eight new fixtures included
- [ ] Scoping decisions (B5.5 direct-act, B1.18 lock-stays-tap, B7.5 billing-document landing +
      no-auto-estimate, B1.19 wizard-remains-default) recorded in the run log **and** as Part F
      entries
- [ ] Money/RLS/auth-touching commits isolated and held; all other commits merged on green;
      full gates green at every commit

<!-- ================= END OF GOAL ================= -->
