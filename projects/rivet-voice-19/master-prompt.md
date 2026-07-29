# Rivet — VOICE 19/19 `/goal` Master Prompt

For **Rivet** — the voice-and-AI-first back office for 1–3-truck owner-operator shops. This run has
one job: **every 🎙️-tagged requirement in PRD v4 Part B reaches rung 5, with proof.** Part E
(2026-07-29) measured voice coverage at **6/19 strict, 8/19 functional**. The target is **19/19**.

**This is a fix run. It writes code.** It is the consumer of the Part E punch list, scoped to the
voice thesis — the single number the product's own PRD calls its completeness against itself.

**North star for every change:** Mike or Jenna speaks a sentence while driving, and the thing
happens — a typed proposal they tap once, or a spoken answer — with nothing silently lost, nothing
booked at the wrong hour, and nothing that "approves" and then saves nothing.

---

## How to run

1. This file lives at `projects/rivet-voice-19/master-prompt.md`.
2. The evidence base is `docs/PRD-v4-part-E-state.md` (§5 voice matrix, §7 punch list) and the
   verbatim traces in `projects/rivet-part-e/reports/` — every break point below carries a
   `file:line` from that run. **Re-verify each citation before changing it; the tree may have moved.**
3. In Claude Code with **Fable 5**, from the repo root:

   ```
   /goal Read projects/rivet-voice-19/master-prompt.md and execute everything below the divider as
   your goal. Follow it exactly, including the never-ask rule, the D-013 hard stop in Guardrail 2,
   and the held-commit rule in Guardrail 3. Do not report back until the definition of done is met.
   Start now. Use fable to orchestrate and adjudicate; fan the tracks out to cheaper models.
   ```

4. **Cost control:** Fable plans, reviews every diff against the guardrails, and adjudicates the
   final re-measurement. Opus/Sonnet subagents implement the tracks in parallel worktrees. The
   volume is mechanical; the expensive mistakes are in Tracks 1–2 review and the contract-test
   design — keep Fable there.

---
<!-- ================= EVERYTHING BELOW THE DIVIDER IS THE GOAL ================= -->

## MISSION

Take voice coverage from 6/19 strict (8/19 functional) to **19/19 at rung 5** — for every
🎙️-tagged Part B requirement: a spoken sentence traverses
`utterance → classifier → INTENT_TO_PROPOSAL_TYPE → Zod payload → entity resolution → approvable
proposal → execution handler → persisted row + audit event` (or, for read-only items, a spoken
answer), **backed by a Docker-gated integration proof (audit event + cross-tenant negative) and a
voice-fixture pin**, so the score survives a re-run of the Part E measurement.

The run ends with a **read-only re-measurement** using the Part E Track B method. That re-run's
number is the deliverable. Self-reported completion does not count.

## GUARDRAILS

1. **Never ask a question.** Every judgment call: make it, log it in `projects/rivet-voice-19/run-log.md`,
   continue. Where this prompt says "Decision:", the recommended default is pre-made — take it
   unless the code contradicts it, and log either way.
2. **D-013 is a hard stop.** `approve_proposal` / `reject_proposal` / `edit_proposal` stay
   hard-refused on recorder and in-app voice channels. Nothing in this run makes approval
   voice-reachable, on any action class, behind any flag. The 19 are about *directing* work by
   voice; approval stays a tap. Any diff that touches `isVoiceApprovalIntent` gating,
   `RV-071/225`, or the `ownerSession` gate is out of scope — revert it.
3. **Repo invariants + held commits.** Integer cents · UTC-stored/tenant-rendered time ·
   tenant_id + RLS FORCE · every mutation audits · gateway-only AI calls · typed Zod proposals,
   human-approved, never auto-executed · catalog-resolved prices. Changes touching **money
   movement, RLS/tenant isolation, or auth** go in clearly-labeled separate commits, held for
   human review, never merged autonomously. Everything else merges on green.
4. **The map must not lie again.** Any classifier-intent or proposal-type change updates
   `docs/reference/voice-action-catalog.md` in the same commit (its contract test enforces this),
   updates the launch fixtures (`npm run test:voice-fixtures`), and keeps both intent-map contract
   tests green.
5. **Every fix ships with its regression test in the same commit.** New/changed DB-touching flows
   need a Docker-gated integration test asserting the row, the audit event, and a cross-tenant
   negative. Mocked-DB coverage does not count as proof — that rule found this mess.
6. **Verification gates before every commit:**
   `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` · `npm test` ·
   `npm run test:integration --workspace=packages/api` · voice-quality rubric stays at or above
   current thresholds. Grep `docs/solutions/` before debugging anything in a documented area.

## THE 19 — current state and required work

Per-item current rung and break points are from the 2026-07-29 Part E run. ✅ = already rung 5:
protect with the new contract test, don't rebuild.

### Group A — already green (6). Protect, and fix the correctness bug underneath them.

| # | Req | State | Work |
|---|---|---|---|
| 1 | **B4.7** book/move/cancel by voice | ✅ 5 | **Fix the UTC bug**: `parseNaturalDatetime` (`ai/agents/customer-calling/entity-resolution.ts:204-241`) builds `Date.UTC` with no tenant timezone — route it through the tenant-local resolution `resolve-datetime.ts` already proven on the recorded-voice path. Add real-DB proofs for reschedule + cancel (create already has one). Widen appointment resolution: a job/customer-name reference must not fall through to soonest-appointment-tenant-wide (`pg-entity-resolver.ts:397-437`). |
| 2 | **B7.1** push-to-talk any screen | ✅ 5 | No build. Pin in the contract test. |
| 3 | **B7.6** spoken line-item to estimate | ✅ 5 | No build. Its `resolveEstimateIdGate` pattern (`estimate-edit-task.ts:265,350-356`) is the **reference implementation** Group B copies. |
| 4 | **B7.7** job status by voice | ✅ 5 | Optional hardening: gate-lift reads `existingEntities.jobId` directly instead of via LLM echo (`job-edit-task.ts:347-348`). |
| 5 | **B8.1** estimate from speech/photo | ✅ 5 | No build. Pin. |
| 6 | **B9.1** invoice from a spoken sentence | ✅ 5 | No build. Pin. |

### Group B — wired but voice-blocked or voice-lossy (8). The core of the run: make the drafting task consume what the resolver already found.

| # | Req | State | Break point (verified) | Work |
|---|---|---|---|---|
| 7 | **B7.4** notes dictated | 3 — **approves then fails** | Task never sets `targetId` from resolved entities (`voice-extended-tasks.ts:460-484`); handler requires UUID (`voice-extended-handlers.ts:94-99`); `missingFields` stays empty | Set `targetId` from `existingEntities` (copy `complaint-task.ts:94-97`); if unresolved, gate honestly via `missingFields`. Integration proof. **Do this first — it is silent data loss on the highest-frequency narrate action.** |
| 8 | **B7.8** expense by voice | 3 — executes, drops job link | `log_expense` absent from `JOB_REF_INTENTS` (`entity-resolution.ts:85-93`); task never sets `jobId` (`voice-extended-tasks.ts:1070`); handler reads it (`log-expense-handler.ts:40`) | Add to `JOB_REF_INTENTS`, thread `jobId`, assert the expense lands on the job and `lookup_job_profit` counts it. |
| 9 | **B5.3** assign work by speaking | 3 — blocked | `missingFields=['appointmentId']` unconditional (`voice-extended-tasks.ts:378`), ignoring the router-threaded id (`voice-action-router.ts:1498-1500`) | Consume the resolved id; gate only when genuinely unresolved. Add classifier fixtures pinning "assign NAME to JOB" vs `add_crew_member` phrasings. Appointment-by-job/customer-name resolution (shared with #1). |
| 10 | **B7.10** crew add/remove | 3 — blocked | `missing=['appointmentId']` unconditional (`voice-extended-tasks.ts:423,444`); intents not in `APPOINTMENT_REF_INTENTS` (`entity-resolution.ts:97-102`) | Add both intents to `APPOINTMENT_REF_INTENTS`; consume the resolved id; `isFullyWired()` on both handlers (see cross-cutting #C2). |
| 11 | **B8.10** estimate nudge | 3 — blocked by design comment | `missing=['estimateId']` unconditional (`voice-extended-tasks.ts:667`) | Resolve `estimateReference` with the #3 reference pattern; ambiguous → clarification card, unique → approvable. |
| 12 | **B9.12** payment reminder + late fee | 3 — blocked | `missing=['invoiceId']` / `+feeCents` unconditional (`voice-extended-tasks.ts:711,817`) | Resolve the invoice reference (resolver has an `invoice` kind); parse the spoken fee amount into integer `feeCents` (reuse `parseAmountMention`). Money-class: proposal stays tap-approved — that is D-013-consistent and correct. |
| 13 | **B6.3** time entry by voice | 3 — proof gap only | Chain works (probe-verified); no integration test exercises `LogTimeEntryExecutionHandler` | Docker-gated proof: row + audit + cross-tenant. |
| 14 | **B9.4** batch invoice by voice | 3 — proof + guard gap | Approvable and works; no integration test; handler has synthetic-passthrough with no `isFullyWired` (`batch-invoice-handler.ts:48-50`) | `isFullyWired()` + integration proof of the fan-out (N jobs → N draft_invoice proposals, idempotent re-execution). |

### Group C — no voice leg exists yet (5). New on-ramps; smallest honest scope each.

| # | Req | State | Work |
|---|---|---|---|
| 15 | **B7.9** read-only lookups | 3 — two silent skips + one missing domain | Implement `lookup_leads` and `lookup_catalog` skill cases (`voice-lookup-answer.ts:675` currently defaults to unsupported → silently skipped). **Truck inventory: Decision** — no inventory domain exists anywhere; do NOT build one inside this run. Record a Part F decision entry amending B7.9's list to the four domains that exist + leads + catalog, and mark the inventory lookup as a new Part B requirement for a future run. B7.9 then scores against the amended list. Log this prominently; it is the one place 19/19 is achieved by scoping, and hiding that would repeat the overclaim failure Part E exists to prevent. |
| 16 | **B5.5** "on my way" by voice (and SMS) | 3 — app leg only | Add an `en_route` intent → routes to the same audited flow as `POST /api/dispatch/appointments/:id/en-route` (`dispatch/routes.ts:262-310`). Decision: match the existing app leg's direct-and-audited pattern (it is a tech status act, not an owner mutation — the app route already executes directly); log the A5.2 tension. Add SMS keyword `OMW`/`on my way` beside out/sick/unavailable (`tech-status-event.ts:70`). Appointment inference: tech's next scheduled appointment today; ambiguity → clarification. |
| 17 | **B1.18** brand voice captured by voice | 3 — no on-ramp | Smallest honest scope: a `capture_brand_voice` intent whose task turns the spoken description into a **draft brand-voice update proposal** rendered in the existing `BrandVoiceSheet` review surface (versioning + cooldown + lock stay exactly as built; lock remains a tap). Do not build a multi-turn interview here. |
| 18 | **B7.5** parts by speaking (name+qty+**unit**) | 0 | The real build in this run: (a) add `unit` to `lineItemSchema` (`contracts.ts:306-329`) and `EstimateEditLineItemInput`, thread `CatalogUnit` through `catalog-resolver.ts` (it is dropped at :558 today); (b) extend classifier entities with structured part mentions (name/qty/unit); (c) route spoken parts onto the existing estimate/invoice line-item edit path (B7.6/`update_invoice`) so a part spoken against a job's active estimate/invoice lands as a structured line. Decision: parts land on billing documents, not a new job-materials table — that is what the persona's sentence ("add it to the estimate") means and it reuses proven machinery. Log it; a standalone materials ledger is a Part F candidate, not this run. |
| 19 | **B1.19** conversational onboarding | 3 — engine has zero clients | Wire the **existing** engine (`ai/orchestration/onboarding-conversation.ts`, route `app.ts:5488` — session-persisted, clarification loop already real) to a client surface: an onboarding step in `packages/web` that reuses the VoiceBar capture → transcription machinery for STT and posts turns to `POST /api/onboarding/conversation/turn`, with the form wizard remaining the fallback/edit surface per B1.20. Add the missing `tools` capture state. This is the largest UI item — schedule it early, don't let it slip to the end. |

### Cross-cutting gates (the reason the map lied)

- **C1 — payload-contract drift test (mandatory, table-driven).** For every intent in
  `INTENT_TO_PROPOSAL_TYPE`: run the real task handler with resolver-style `existingEntities`,
  assert the produced payload either passes the real execution handler's requirements or carries
  honest `missingFields`. This is the test class whose absence let seven actions break beneath
  green contract tests. It becomes a permanent CI gate.
- **C2 — close the boot-guard hole.** `assertVoiceHandlersWired` must fail loudly for any
  voice-reachable handler lacking `isFullyWired()` (`wiring-assertions.ts:53` currently treats
  absence as wired), or all remaining handlers implement it — including `batch_invoice`, both crew
  handlers, and `reassign_appointment`, which still carry the synthetic-uuid passthrough.
- **C3 — voice-quality fixtures.** Each of the 19 gets at least one rubric-suite script asserting
  the end state (proposal type + resolved ids, or spoken answer), so the launch gate measures the
  thesis, not just the happy-path booker.

## DEFINITION OF DONE (self-grade before reporting)

- [ ] Re-run of the Part E Track B measurement (read-only, same method, fresh agent) scores
      **19/19 at rung 5** — every 🎙️ requirement: spoken fixture → approvable proposal/answer →
      execution proof, citing file:line and observed test runs
- [ ] Every Group B/C item has a Docker-gated integration test (row + audit + cross-tenant) that ran green
- [ ] C1 payload-contract test exists, covers all mapped intents, and is a CI gate
- [ ] C2: zero voice-reachable handlers invisible to the boot guard
- [ ] The UTC datetime fix has a regression test proving tenant-local wall-clock on the live-call path
- [ ] D-013 untouched: approval/edit intents still hard-refused off owner telephony (contract test still green)
- [ ] `voice-action-catalog.md`, launch fixtures, and both intent-map contract tests green
- [ ] All scoping decisions (B7.9 inventory amendment, B5.5 direct-act pattern, B7.5 billing-document
      landing, B1.18 minimal capture) recorded in `projects/rivet-voice-19/run-log.md` **and** as
      Part F decision entries — 19/19 must be auditable as honest, not definitional sleight of hand
- [ ] Full gates green: build tsc, unit, integration, voice-quality ≥ current thresholds
- [ ] Money/RLS/auth-touching commits isolated and held for human review; everything else merged on green

<!-- ================= END OF GOAL ================= -->
