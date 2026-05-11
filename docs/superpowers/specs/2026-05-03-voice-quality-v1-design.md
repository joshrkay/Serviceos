# Voice Quality v1 — Design

**Date:** 2026-05-03
**Branch:** `claude/serviceos-crm-strategy-3Y1Pp`
**Status:** Draft for review

---

## 1. Goal & non-goals

**Goal:** A measurable rubric — *Voice Quality v1* — that produces a single number every CI run answering: "Is the voice agent ready to put in front of the first paying customer's real callers?" The rubric is the **go/no-go gate** for the pilot launch.

**Non-goals:**
- Not a regression suite for every voice intent (the other ~10 intents are out of scope for v1)
- Not the sales-comparison metric vs Avoca (that's a downstream output)
- Not the engineer debug instrument (separate concern)
- Not multi-tenant; one fictional pilot tenant profile drives the corpus
- Not bilingual yet — English first; Spanish corpus is v1.5
- Not outcome-driven (no "did the booked appointment actually happen") — requires post-launch traffic

**Meta-success criterion (the rubric grading itself):**
- Layer 1 runs in CI in under 5 minutes
- Produces a single % number with per-bucket breakdown
- An engineer can look at one failed call and understand why in under 2 minutes

**MVP scope** — Booker + Lead Capture:
- **6 lookups:** `lookup_account_summary`, `lookup_customer`, `lookup_jobs`, `lookup_appointments`, `lookup_invoices`, `lookup_estimates`
- **3 booker mutations:** `create_appointment`, `reschedule_appointment`, `cancel_appointment`
- **2 lead-capture mutations:** `create_customer` (P17-001 — currently broken), `find_or_create_lead`

---

## 2. Whose success counts

**Tenant-first, caller-second, system-as-floor.**

ServiceOS is sold to tenants. Tenant satisfaction is the contract. Caller satisfaction is a constraint that protects tenant satisfaction. System integrity (no crashes, no isolation leaks) is a hard floor that everything else assumes.

A call "succeeds" when:
1. The tenant got value (correct proposal generated, audit trail clean, no liability surface created)
2. The caller got served or correctly escalated
3. The system stayed within its safety constraints

---

## 3. The per-call rubric: "agent did the right thing"

Twelve criteria. A call passes if **all** hold; one strike fails the call.

### 3.1 Hard floor (any failure = call fails, no further grading)

1. **No PII leak.** Phone numbers, emails, balances, addresses spoken only after caller is identity-resolved.
2. **No auto-mutation.** Every state-changing action created a `proposal` row; nothing wrote to `customers` / `appointments` / `leads` directly.
3. **No hang.** Lookup → speak loop ≤ 5s soft / 7s hard.
4. **No cost-cap break.** Session stayed under per-session ceiling, OR escalated cleanly.
5. **No tenant-isolation leak.** Voice agent never spoke data from a different tenant than the call's resolved tenant.
6. **No duplicate customer.** When caller-id matches an existing customer, agent must NOT create a new customer record. (Closes a doc-flagged gap; mechanical: `customers` row count delta ≤ 1, normalized phone uniqueness preserved.)
7. **Compliance gates respected.** DNC list check + business-hours check + SMS consent check. After-hours → callback proposal, not booking. Caller on DNC → terminate politely. Caller previously sent STOP → no outbound SMS in proposal.
8. **Caller-hangup handled cleanly.** Mid-flow hangup: session marked `terminated`, no half-baked `pending` proposal, audit trail clean.

### 3.2 Disposition correctness (graded per call)

9. **Right intent classified.** The intent the agent acted on matches what the caller asked for.
10. **Right slots extracted.** Mutation proposal payload has correct values: customer matched, date/time parsed in tenant TZ, etc. Hard fields (IDs, enums): structural assertions. Soft fields (notes): LLM-judged.
11. **Right escalation behavior.** Should-have-escalated cases actually did; should-not-have-escalated cases didn't.
12. **Right caller-facing answer.** For lookups: the spoken answer matches ground truth. For mutations: the confirmation TTS accurately summarizes the proposal.

**Per-call result:** `pass` (all 12 hold) | `fail-floor` (1-8 broke) | `fail-disposition` (9-12 broke).

**Not graded in v1:** subjective conversational quality, voice synthesis naturalness, reprompt elegance, multi-turn coherence beyond MVP intent paths.

---

## 4. The two-layer architecture

A single suite cannot honestly answer all three of the questions below. v1 splits them into two layers; v1.5+ adds a third.

| Question | Layer | Frequency |
|---|---|---|
| "Did this code change break the agent?" | **Layer 1 — Code correctness** | Every PR |
| "Does the LLM model change break the agent?" + "Does the caller experience hold up?" | **Layer 2 — Caller experience** | Pre-deploy + nightly + weekly trend |
| "Are real callers getting good service?" | **Layer 3 — Live traffic** (deferred to post-launch) | Continuous sampling |

The rubric (Section 3) is shared across layers. The corpus and harness differ.

| | **Layer 1** | **Layer 2** |
|---|---|---|
| Harness | Text-mode + cassettes + InMemory | Real audio + Whisper + Claude live + TTS + Pg |
| Corpus | 40 scripts | 10-15 scripts (subset of Layer 1's, full audio) |
| Wall-clock | <5 min | 15-25 min |
| Cost per run | ~$0.50 (cassette) / ~$5 (refresh) | $5-10 |
| What it grades | Floor 1-8 + disposition 9-11 + soft slots in 10 | Everything Layer 1 grades + caller-experience metrics |
| Determinism | Deterministic via cassettes | Non-deterministic (real LLM); 2-of-3 voting |
| Frequency | Every PR | Pre-deploy + weekly |
| Honest framing | **Necessary, insufficient.** Regression catcher. | **The launch gate.** |

**Layer 2 adds caller-experience criteria** (graded only at Layer 2):
- TTFA (time to first audio): <800ms P95
- Lookup → speak P95: <2s
- Reprompt rate: <10% of turns
- Misunderstanding recovery: <2 turns
- Total happy-path booking duration: <90s
- Caller-perceived completion: >90% of scripts (LLM-judged from full transcript)

---

## 5. Layer 1 design — code-correctness suite

### 5.1 Performance budget (non-negotiable)

| Constraint | Budget | Why |
|---|---|---|
| Full suite wall-clock | ≤ 5 min (300s) | Devs won't run it locally if slower |
| Per-script wall-clock | ≤ 6s avg | Forces honest performance |
| Per-turn agent latency | ≤ 1.5s P50, ≤ 5s P95 | Caller-perceived cap (also in floor #3) |
| LLM-judge total | ≤ 30s for the suite | Forces parallelization + caching |
| Cost per full run | ≤ $1.00 (replay) / ≤ $5 (cassette refresh) | Sustainable at PR volume |
| Memory per worker | ≤ 512MB | Allows 4 parallel workers on 2-vCPU runner |

### 5.2 Corpus structure (40 scripts, 10 buckets)

| # | Bucket | Scripts | Purpose |
|---|---|---|---|
| 1 | Happy-path lookups | 6 | One per lookup intent |
| 2 | Happy-path booker | 4 | create/reschedule/cancel + two-step booking |
| 3 | Happy-path lead capture | 3 | `find_or_create_lead` + `create_customer` (half-broken until P17-001) |
| 4 | Identity-resolution edges | 5 | Floor #6 territory: caller-id matches one, multiple, blocked, mismatched, lead-not-customer |
| 5 | Compliance edges | 4 | Floor #7: after-hours, DNC, STOP-sent, geo-out-of-coverage |
| 6 | Hangup edges | 3 | Floor #8: hangup mid-confirmation, before-intent, post-proposal |
| 7 | Out-of-scope escalation | 4 | Caller wants payment / update / note / vague complaint |
| 8 | Ambiguity / reprompt | 4 | Mumble, two intents in one sentence, partial info, accent |
| 9 | Concurrency / state edges | 3 | Stale lookup, slot just-taken, customer just-archived |
| 10 | Adversarial / abuse | 4 | SQL-injection text, spam, cross-customer extraction, cost-cap drain |

**Buckets 9 and 10 are intentionally where v1 will fail at first** — they ARE the gap-finder.

**Layout:**
```
packages/api/src/ai/voice-quality/
├── corpus/
│   ├── manifest.json                    # Auto-generated; SHA-pinned per script
│   ├── scripts/
│   │   ├── 01-happy-lookups/*.json      # 6 files
│   │   ├── 02-happy-booker/*.json       # 4 files
│   │   └── ...                          # 10 buckets
│   ├── golden/<script-id>.json          # Expected proposal payloads
│   └── cassettes/<script-id>.json       # Recorded LLM exchanges
├── runner.ts                            # Loads script → seeds tenant → drives agent → collects observations
├── observations.ts                      # Per-call observation record
├── text-mode-driver.ts                  # Bypasses Twilio I/O, drives orchestration
├── event-bus.ts                         # AgentEventEmitter (proposal_created, lookup_executed, ...)
├── cassette.ts                          # VCR record/replay
├── graders/
│   ├── floor.ts                         # 8 hard-floor checks
│   ├── disposition-structured.ts        # Criteria 9-11 + hard slots in 10
│   └── disposition-llm.ts               # Criterion 12 + soft slots in 10
├── report.ts                            # Per-bucket roll-up + JSON for CI
├── schema.ts                            # Zod: VoiceQualityScriptSchema + RubricVersionSchema
└── voice-quality.test.ts                # Single vitest entry point
```

### 5.3 Architectural decisions (eight)

**5.3.1 — Repo strategy: InMemory PR / Pg nightly.** PR-CI uses `InMemoryCustomerRepository` + sibling InMemory repos. Nightly Layer 1 run uses Pg via testcontainers. Both share the same corpus.
- **Why:** InMemory is microseconds; gets us to the 5-min budget. Pg catches RLS, generated columns, JSONB query plans.
- **Mitigation for divergence:** every repo has a contract test (`*-contract.test.ts`) running against both implementations.

**5.3.2 — Agent invocation: text-mode through orchestration, not direct skill calls.** Harness drives the same classifier → intent router → skill dispatch as Twilio, bypassing only Twilio I/O.
- **Why:** classifier and orchestration bugs are the failure modes the rubric must catch. Bypassing them tests the wrong code.
- **Cost:** ~50ms overhead per turn (acceptable inside 1.5s P50).

**5.3.3 — LLM determinism: VCR cassettes, named honestly as mocking.** First run records real LLM calls; subsequent runs replay. Cassettes committed to git in `corpus/cassettes/`.
- **Honest framing:** cassettes ARE mocked LLM, just frozen-real. They catch code regressions; they cannot catch model regressions.
- **Mitigation for cassette drift:** quarterly refresh PR + Layer 2 nightly real-LLM run.
- **When agent code changes:** dev re-records affected cassettes locally, commits in same PR; reviewers diff.

**5.3.4 — Observation capture: dedicated event bus, not log scraping.** Voice agent emits events on `AgentEventEmitter` (`proposal_created`, `lookup_executed`, `intent_classified`, `escalation_triggered`, `cost_incurred`, `session_terminated`). Production has a no-op consumer (or audit-log consumer); tests subscribe and capture.
- **Why:** log scraping is fragile; DB sniffing misses in-flight state; decorator wrapping is invasive.
- **Cost:** one new module + ~5-line `emit` per existing mutation site.

**5.3.5 — Parallelism: 4 workers, tenant-per-worker.** vitest workers run in parallel; each owns `test_tenant_<n>`; scripts distributed via worker-id modulo.
- **Why:** 40 scripts × 6s sequential = 240s; with 4 workers = 60s.
- **Cost:** cassette write lock via `flock` on `cassettes/.lock`. Reads lock-free.

**5.3.6 — Snapshot pattern for proposals.** Expected proposal payloads live in `corpus/golden/<script-id>.json`. Grader does deep-diff between observed and golden. Slot legitimately changes → dev updates golden in same PR.
- **Why:** asserting on big nested payloads inline is unreadable; golden files diff cleanly in review.

**5.3.7 — Schema & versioning.** Scripts validated by Zod at load. Rubric definition versioned (`rubric.v1.json`); runs query results by rubric version. Corpus manifest auto-generated, SHA-pinned per script.
- **Why:** without this, the rubric silently mutates and "no regression vs previous main" becomes meaningless.

**5.3.8 — Performance instrumentation native to the harness.** Every event carries a monotonic timestamp; per-turn latency derived from event deltas. Reported as P50/P95 alongside the % number even though latency isn't gated at Layer 1 (gated at Layer 2).
- **Why:** lets Layer 1 detect latency regressions early as a soft signal even though the hard gate lives in Layer 2.

### 5.4 Grading mechanism

- **Floor checks:** pure functions on observations + script metadata. Deterministic, fast.
- **Disposition 9, 11:** structured assertions on classifier output + escalation flag.
- **Disposition 10 (slots):** golden-file deep-diff on hard fields; LLM-judge on soft fields.
- **Disposition 12 (caller-facing answer):** LLM-as-judge (Claude Haiku). Inputs: caller transcript, agent output, expected behavior in plain English. Output: `{ pass: bool, reason: string }`. Batched, parallelized, cached by hash of inputs.
- **Judge validation pass:** quarterly, 20 random verdicts re-graded by humans. <90% agreement → recalibrate prompt or fall back to structured-only for disagreeing cases.

### 5.5 Failure output

When a call fails, the report shows: bucket → script id → failed criteria → for each, expected vs observed → link to full transcript + observation log. Engineer opens, understands in <2 min.

---

## 6. Layer 2 design — caller-experience suite (sketch; full design in separate plan)

> See: [`docs/superpowers/runbooks/voice-quality-layer2.md`](../runbooks/voice-quality-layer2.md) for the operational runbook.

**Out of scope for the Layer 1 plan.** Captured here so the Layer 1 architecture doesn't paint Layer 2 into a corner.

**Core characteristics (to be detailed in a separate spec):**
- Real audio path: Whisper STT, Claude live LLM, Polly/ElevenLabs TTS, real Pg
- Smaller corpus (10-15 scripts) — subset of Layer 1's, run end-to-end with audio
- Non-deterministic; 2-of-3 voting per script
- Adds caller-experience criteria (TTFA, lookup→speak latency, reprompt rate, recovery turns, total duration, perceived completion)
- 15-25 min wall-clock, $5-10/run, runs pre-deploy + weekly trend
- Telephony emulation TBD: candidates include Twilio test rig, sipsorcery, Pion-based local SIP

**Layer 1 commitments that protect Layer 2:**
- Event bus (5.3.4) is reused by Layer 2 — Layer 2 just attaches more subscribers
- Corpus schema (5.3.7) extends to include `layer2_eligible: bool` + `expected_caller_metrics`
- Rubric versioning (5.3.7) carries forward; Layer 2 uses same rubric + adds caller-experience criteria
- The text-mode driver and audio driver share an interface (`AgentDriver`) so the orchestration layer doesn't fork

---

## 7. Operational integration (Layer 1 ship gate)

> See: [`docs/superpowers/runbooks/voice-quality-launch-gate.md`](../runbooks/voice-quality-launch-gate.md) for the operational gate procedure (threshold table, override procedure, decision flow, judge-validation cadence).

### 7.1 Where it runs

- **Pre-merge in CI** — every PR touching `packages/api/src/ai/`, `packages/api/src/customers/`, `packages/api/src/leads/`, `packages/api/src/jobs/`, `packages/api/src/appointments/`, or the corpus
- **Nightly on main** — full Layer 1 + the Pg variant; trend tracked
- **Manual:** `npm run voice-quality` locally

### 7.2 Threshold for the launch gate

| Bucket | Required pass rate |
|---|---|
| Hard floor (criteria 1-8, every script) | **100%** — one floor failure = launch blocked |
| Buckets 1, 2, 3 (happy paths) | **100%** |
| Buckets 4, 5, 6, 7 (edges + escalation) | **≥ 90%** |
| Buckets 8, 9, 10 (ambiguity + concurrency + adversarial) | **≥ 70%** |
| **Overall** | **≥ 90%** weighted across all 40 scripts |

Launch gate = all four sub-thresholds met simultaneously, AND no regression vs previous main.

### 7.3 Failure handling

- **Floor failure on a PR:** CI red, PR blocked. Override only via tracked issue + doc-owner approval.
- **Disposition miss below threshold on a PR:** CI red; engineer can override with rationale in PR description.
- **Nightly regression:** Slack alert + auto-opened GitHub issue. Doesn't block deploys (gate is launch-time). Owner assigned within 24h.
- **Buckets 9/10 below 70%:** triggers "voice quality debt" review at next weekly.

### 7.4 Pilot launch decision flow

1. Voice quality report green at all four sub-thresholds for 7 consecutive nightly runs on main.
2. Layer 2 shows ≥85% pass, TTFA P95 median ≤ 800ms, perceived-completion ≥ 90%, no flakes on happy-path scripts, total cost <$10/run for 1 consecutive week (4 consecutive weekly runs). See the [Layer 2 launch gate section](../runbooks/voice-quality-launch-gate.md#layer-2-launch-gate) of the launch-gate runbook for the full procedure.
3. Manual sign-off by engineering lead + product on the report.
4. Pilot tenant onboarded; live traffic routed with human CSR shadow (escalation-first mode) for 1 week.
5. Pilot tenant + ServiceOS together review live traffic vs rubric (sample N=20 real calls, human-graded). Real-world pass rate ≥85% → expand to full handling.

---

## 8. Deferred / explicitly out of scope

- **v1.5: Recorded-call audit pass.** Replay real recordings from S3 (P8-014) through full pipeline; human-graded sample. Catches real-caller weirdness Layer 1+2 synthetic corpus misses.
- **v2: Live shadow at partner tenant.** Agent runs alongside human CSR; compare proposals to human actions. Requires partner tenant infrastructure.
- **Multi-language corpus.** Spanish corpus follows once Layer 1 + Layer 2 are stable in English.
- **Outcome-driven grading.** Did the booked appointment actually happen? Did the lead convert? Lagging signals; require post-launch traffic.

---

## 9. Open questions / decisions log

| # | Decision | Resolved | Notes |
|---|---|---|---|
| Q1 | Foundation of the rubric | ✅ Go/no-go gate (B) | Other lenses (A regression, C sales, D debug) layered later |
| Q2 | Whose success | ✅ Tenant-first, caller-second, system-floor (E) | |
| Q3 | MVP scope | ✅ Booker + Lead Capture (B+C) | 6 lookups + 5 mutations |
| Q4 | Grading shape | ✅ Threshold on disposition correctness (B) | Floor folded in as multi-criteria |
| Q5 | Corpus + grader | ✅ Synthetic scripts + LLM-judge (A+D) | Real calls deferred to v1.5 |
| Q6 | Floor enhancements | ✅ E1 + E2 + E3 added | E4 latency / E5 parity / E6 cost deferred |
| Q7 | Cassette honesty | ✅ Named as mocking; mitigation via quarterly refresh + Layer 2 real-LLM | |
| Q8 | Two-layer split | ✅ Layer 1 code-correctness, Layer 2 caller-experience | Layer 3 live traffic deferred |

**Still open (will resolve during planning):**
- Concrete Pg test infrastructure (testcontainers vs custom Docker compose)
- Cassette format (JSON vs binary); sensitivity to LLM API schema changes
- Judge model selection (Haiku-4.5 vs Sonnet-4.6 with caching)
- Exact tenant-per-worker schema isolation strategy

---

## 10. References

- `docs/quality/crm-deep-state-and-edges.md` — the source CRM state analysis
- `docs/voice-production-readiness.md` — three implementation paths discussed
- `docs/PRD.md` — phase-based execution PRD
- `docs/stories/phase-17-gap-stories.md` — Phase 17 voice/UI parity stories (P17-001..010)
- `packages/api/src/ai/skills/` — current voice skills (16 .ts files)
- See: `docs/superpowers/runbooks/voice-quality-cassette-refresh.md` for the refresh procedure
