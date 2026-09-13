# Rivet — PART E: State Verification `/goal` Master Prompt

For **Rivet** — the voice-and-AI-first back office for 1–3-truck owner-operator HVAC, plumbing, and
electrical shops. This run produces **Part E of PRD v4: the state table** — a per-requirement,
evidence-backed answer to *"did we actually build what we said we'd build, and is it live?"*

**This is a measurement run. It is READ-ONLY. It fixes nothing.**

That constraint is the whole point and is not negotiable. An audit that repairs as it measures
describes a state that never existed, and the resulting table cannot be trusted or re-run for
comparison. Findings become a punch list for a *separate* fix run. The existing
`serviceos-coding-audit-master-prompt.md` is that run — do not do its job here.

**North star for every verdict:** does the persona (Mike Rivera / Jenna Walsh / the owner going
independent) actually get this capability — including **by voice, where Part B tags it 🎙️** — in the
environment they actually use? Anything short of that is not done, however green the test suite is.

---

## How to run

1. Save everything below the divider as `projects/rivet-part-e/master-prompt.md`.
2. Place `PRD-v4-DRAFT-spine-lifecycle.md` at `projects/rivet-part-e/PRD-v4.md`. **It is the input.**
   Every requirement ID it defines (B1.1 … B10.10) becomes a row in the output.
3. In Claude Code with **Fable 5**, from the Rivet repo root:

   ```
   /goal Read projects/rivet-part-e/master-prompt.md and execute everything below the divider as your
   goal. That file is your full instruction set. Follow it exactly, including the READ-ONLY rule in
   Guardrail 1, the evidence rule in Guardrail 3, and the never-ask rule. Track C needs credentials —
   if they are absent, record UNKNOWN and continue; do not stall. Do not report back until the
   definition of done is met. Start now.
   ```

4. **Cost control:** Fable orchestrates and adjudicates; Opus 4.8 / Sonnet 5 subagents fan out across
   lifecycle sections in parallel. This run is read-heavy and judgment-light per unit — route the
   volume to the cheaper models and keep Fable on the ladder adjudication, where the expensive
   mistakes live.

---
<!-- ================= EVERYTHING BELOW THE DIVIDER IS THE GOAL ================= -->

## MISSION

Produce `docs/PRD-v4-part-E-state.md`: a table with one row per Part B requirement, each assigned a
rung on the done ladder, each backed by evidence a skeptic could re-check, plus the rollups and the
delta list that tell the reader where documentation and reality disagree.

The document this replaces marked 48 things built when 44 delivered. The three loudest overclaims all
had **foundations present and the flow never completed**. Your job is to make that class of error
impossible to repeat by refusing to score anything from documentation.

## GUARDRAILS

1. **READ-ONLY. Fix nothing.** No production code changes, no refactors, no "while I was in there."
   You may create files **only** under `projects/rivet-part-e/` and the single output document. You
   may *run* tests, type checks, and read-only scripts — running the suite is measurement. You may
   **not** write to any tenant database, deploy anything, or execute writes against staging or
   production. If you find a critical defect, record it in the punch list and keep moving.

2. **Never ask a question.** Nobody is watching. Every judgment call: make it, log the call and the
   reasoning in the run log, continue. Blocked is not an option — if a tool fails, find another path.
   If a track stalls, ship the strong 80% and note what is missing.

3. **Evidence or it didn't happen.** Every rung verdict cites one of: a `file:line` reference, a test
   name that you ran and observed pass, a command and its output, or a live probe result.
   **Documentation is never evidence.** `docs/PRD-v3.md`, plan files, and code comments are *claims to
   be tested*, not sources of truth. Where code and docs disagree, the code wins and the disagreement
   goes in the delta list.

4. **`UNKNOWN` is a legal verdict. Blank is not.** Every cell gets filled. If Track C credentials are
   missing, that dependency is `UNKNOWN — no credential`, not omitted and not guessed.

5. **Re-verify the seeds.** §"Known-suspect watchlist" below is prior knowledge to save you discovery
   time, not findings to copy. Every seeded item gets independently re-checked and may have changed in
   either direction. A seed you confirm still needs its own evidence citation.

6. **No tenant data leaves the run.** Aggregates and schema only. No customer names, phone numbers,
   addresses, or invoice contents in the output document.

## THE LADDER

Score every requirement at exactly one rung. Report the **highest rung fully satisfied** — a
requirement that is Wired but untested is rung 3, not "3.5" and not 4.

| Rung | Name | Test to apply |
|---|---|---|
| 0 | **Absent** | No code implements this |
| 1 | **Specced** | A story, plan, or contract exists; no implementation |
| 2 | **Present** | Implementation exists — module, handler, schema column, route |
| 3 | **Wired** | Reachable from a production entry point. Registered in `app.ts` / a router / a worker registry / an intent map — **not merely exported.** Dependencies actually injected. |
| 4 | **Proven** | Covered by a test against a **real database** (Docker-gated integration), with the audit event asserted and a cross-tenant negative asserted. Mocked-DB coverage does **not** reach rung 4. |
| 5 | **Reachable** | The persona can get to it through a real surface — and **if Part B tags it 🎙️, a spoken sentence reaches it**, end to end through classifier → intent map → handler |
| 6 | **Live** | Configured and working in the deployed environment (Track C) |

Two rules that decide most contested cases:

- **A handler with no classifier intent is rung 2, not 3.** The transcript is silently skipped. This
  is the product's most dangerous failure mode; score it harshly.
- **An execution handler whose dependencies are absent is rung 2, not 3**, even if it returns
  successfully — it passes back a synthetic ID and saves nothing.

## TRACKS

Run A and B in parallel. C depends on credentials and runs independently.

### Track A — Code truth, per requirement (rungs 0–5)

Walk **every** requirement ID in Part B of `PRD-v4.md`, section by section (B1 Setup, B2 Situational
Context, B3 Capture, B4 Book, B5 Dispatch, B6 Execute, B7 Narrate, B8 Quote, B9 Bill, B10 Close).
Fan out one subagent per lifecycle section.

For each requirement: locate the implementation, establish the highest rung satisfied, cite evidence,
and where the rung is below 5, write one sentence naming the specific missing link — not "incomplete"
but *"handler exists at `x.ts:120`, no entry in `INTENT_TO_PROPOSAL_TYPE`."*

### Track B — Voice reachability matrix

Part B tags requirements 🎙️ / 📱 / ⚙️. For every 🎙️ requirement, trace the full path:

```
utterance → classifier intent → INTENT_TO_PROPOSAL_TYPE → proposal type (Zod) → entity resolution →
execution handler → persisted row + audit event
```

Report the break point for anything that doesn't complete. Produce a **voice coverage percentage**:
of requirements Part B tags 🎙️, how many reach rung 5. Per §A5.1 this is the single most important
number in the document — voice is the primary interface, so this number *is* the product's
completeness against its own thesis.

Also enumerate the inverse: **execution handlers that exist with no voice on-ramp**, and **classifier
intents with no handler**. Both are silent-failure surfaces.

### Track C — Runtime truth (rung 6)

Needs Railway API/dashboard access and staging credentials. **If absent, mark the whole track
`UNKNOWN — no credential` and say so prominently in the summary rather than implying rung 6 was
assessed.**

**Per Railway service — `web`, `worker`, `voice` separately.** They share one entrypoint
differentiated by `PROCESS_ROLE`; a variable set on one is not set on the others, and the worker runs
every sweep and the SLO monitor. `railway*.toml` is **not** a declaration site — it holds only
`[build]`/`[deploy]` keys.

1. **Declared vs. set.** Run `check:env-declared` for declaration. Separately enumerate what is
   actually set per service. Report the difference. These are two different failures.
2. **Config path.** Flag any production code reading raw `process.env` instead of the Zod-validated
   config object — the validated path coerces empty-string secrets to `undefined` and a raw empty
   string is truthy.
3. **Danger flags.** Prove false in production: anything shaped "allow missing," "simulated," "dev
   token," or "cassette fallback." Name each one found and its current value.
4. **Third-party liveness** — per environment, each is `live` / `not-configured` / `broken` /
   `unknown`. A key being present is not liveness.

   | Dependency | Proof required |
   |---|---|
   | Twilio voice | Provisioned number's webhook points at *this* environment; a real inbound call produces a proposal |
   | Twilio SMS | Messaging service resolves; outbound delivered and logged; STOP/DNC enforcement live |
   | Voice stack | A synthetic turn completes STT → gateway → TTS |
   | LLM gateway | Reachable, failover configured, **and `ai_runs` rows are being written** |
   | Stripe platform | Live vs. test keys unambiguous; webhook signature verification active; webhook handler genuinely instrumented |
   | Stripe Connect | A tenant can complete onboarding; payouts route to *their* bank |
   | Clerk | Auth enforced; dev-mode token paths provably disabled |
   | Sentry | A deliberate test event **per service** arrives with correct environment and release tags |
   | Others | QuickBooks, SendGrid, PostHog, storage, push/EAS — verified or explicitly not-configured |

## KNOWN-SUSPECT WATCHLIST

Prior knowledge, to be **re-verified, not copied**. Each may have moved in either direction.

**Previously downgraded** — MMS-to-quote · ACH payments · B2B account recognition. For B2B
specifically: `account_type` was `residential|b2b` only, its sole consumer
(`property-type-detector.ts`) was unreachable because `extractVulnerabilitySignals()` is never called
in the live flow, and no inbound path set the field.

**Voice on-ramp gaps** — crew add/remove · batch invoice · late fee · payment reminder · estimate
nudge (handlers exist, classifier intents reportedly absent) · `assign_technician` (needs a new
proposal type; entity resolver had no `technician` kind) · `add_equipment` (no type or handler).

**Address resolution** — the July audit recorded *"spoken addresses vanished without an error."* The
entity resolver supported `customer | job | appointment | invoice | estimate | pending_proposal` and
**no place/address kind**, while geocoding, service-location lat/lng, and a travel-time provider were
all wired. Score all of B2 against this.

**Setup and money rail** — `billing/stripe-connect.ts` exists; Connect **onboarding UX** was
explicitly scoped out of the quote-to-cash campaign. Establish whether an owner can self-serve a bank
connection today (B1.7–B1.11).

**Specced-not-built** — correction loop · QuickBooks sync (UI stub, backend missing) · offline voice
capture · custom job forms · **electrical vertical pack** (specced in PRD-v3 §9, believed unbuilt —
this now gates a launch vertical) · native mobile.

**Observability** — Sentry `instrument` claimed on four critical paths, believed wired on three
(Stripe webhook missing, and its P1 alert rule has therefore never been able to fire) · 61 of 115
env vars read by code declared in no environment · `ALLOW_MISSING_CRITICAL_CONSTRAINTS` may itself be
a finding · one table reportedly without `FORCE RLS`.

**Scope questions to resolve by observation, not opinion:**

- **`VAPI_*` alongside Twilio Media Streams.** Two voice stacks. Determine which one production
  inbound traffic actually traverses. This likely resolves open decision **D-014, canonical inbound
  call path**, which has been open for months.
- **`WISETACK_*`.** Consumer financing, which PRD-v3 lists as an explicit non-goal. Report whether it
  is wired and reachable or dead config.

**Three shipping gaps from the last competitive audit** — conversational onboarding loop · delayed
post-job thank-you SMS · painting vertical pack.

## OUTPUT

`docs/PRD-v4-part-E-state.md`, containing:

1. **Summary** — total requirements, rung distribution, and prominently: **voice coverage %**, and
   whether Track C ran or was `UNKNOWN`.
2. **The state table** — one row per requirement:

   | Req | Requirement | Tag | Rung | Evidence | Missing link |
   |---|---|---|---|---|---|
   | B7.5 | Parts added by speaking | 🎙️ | 3 | `handlers.ts:412`; no entry in `INTENT_TO_PROPOSAL_TYPE` | No classifier intent — utterance silently skipped |

3. **Rollups** — rung distribution per lifecycle section. Which section is weakest, stated plainly.
4. **Delta list** — every place a shipped document claims a status the code doesn't support, and
   every place **reality is ahead of the documentation** (that direction matters too and was skipped
   last time).
5. **Track C table** — per service × per dependency, no blanks.
6. **Punch list** — findings ordered by *persona impact*, not by ease of fix. A silent voice failure
   on a daily path outranks a missing admin screen.
7. **Run log** — every judgment call you made, the call, and why.

## DEFINITION OF DONE (self-grade before reporting)

- [ ] Every Part B requirement ID has a row. No blanks, no omissions.
- [ ] Every rung verdict cites `file:line`, a test you ran, a command output, or a probe result
- [ ] No verdict anywhere rests on documentation
- [ ] Every seeded watchlist item independently re-verified with its own citation
- [ ] Voice coverage % computed and stated in the summary
- [ ] Handlers-without-intents and intents-without-handlers both enumerated
- [ ] Track C either ran per service, or is clearly marked `UNKNOWN` — never implied
- [ ] Delta list runs **both** directions
- [ ] D-014 (VAPI vs. Media Streams) answered from observed traffic, or explicitly marked
      undeterminable and why
- [ ] **The repository is unchanged** — `git status` clean outside `projects/rivet-part-e/` and the
      output document. Confirm this explicitly; it is the guardrail most likely to erode over a long
      run.
- [ ] Nothing in the output is a placeholder pretending to be a finding

<!-- ================= END OF GOAL ================= -->

---

## Decisions you own

- **Track C credentials.** Without Railway API access and staging keys, rung 6 is unmeasurable and the
  run returns rungs 0–5 only. That's still the majority of the value — but it will not catch the
  Sentry-class failure, where every rung of code truth is green and the thing is dark in production.
- **Whether the fix run follows immediately.** This run deliberately touches nothing. The punch list
  it produces is the input to `serviceos-coding-audit-master-prompt.md`. Keeping them separate is what
  makes the state table re-runnable as a progress measure.
- **Whether `UNKNOWN` rows block Part D.** The parity comparison is only as good as the state table
  underneath it. A large `UNKNOWN` block on the voice path in particular would make a Jobber
  comparison misleading.
