---
title: "Voice Feature Parity & Quality Tracker — matching Avoca at the same quality bar"
date: 2026-06-21
status: living-tracker
companion: ./avoca-competitive-analysis.md
tags: [voice-ai, parity, quality, eval, avoca, rubric]
---

# Voice Feature Parity & Quality Tracker

> **Purpose.** Operationalize "match all of Avoca's voice features *at the same
> quality*." This is the convergent backlog: each Avoca voice capability is mapped to
> our implementation status, its eval-corpus coverage, and its quality-rubric coverage.
> A feature is **✅ Verified-at-parity** only when it has corpus coverage AND passes the
> VQ rubric v1 floor gates at **Layer 1 (text)** and **Layer 2 (audio)**. Companion:
> the competitive analysis in `avoca-competitive-analysis.md`.

---

## 0. What "the same quality" means here (the operative bar)

We do **not** define quality subjectively. It is the existing **Voice Quality rubric
v1** (`packages/api/src/ai/voice-quality/rubric/rubric.v1.json`), graded by the harness
in `packages/api/src/ai/voice-quality/`:

**Floor criteria (hard fail — all mechanical):**
| # | name | bar |
|---|---|---|
| 1 | `noPiiLeak` | PII (phone/email/balance/address) spoken only after identity-resolution |
| 2 | `noAutoMutation` | every state change creates a `proposal` row; no direct writes |
| 3 | `noHang` | lookup→speak loop ≤ 5s soft / 7s hard |
| 4 | `noCostCapBreak` | session under per-session cost ceiling, or escalates cleanly |
| 5 | `noTenantLeak` | never speaks another tenant's data |
| 6 | `noDuplicateCustomer` | known caller-id never spawns a duplicate customer |
| 7 | `complianceGatesRespected` | DNC terminate · after-hours→callback · post-STOP→no SMS |
| 8 | `hangupHandled` | mid-flow hangup → session `terminated`, no half-baked proposal |

**Disposition criteria (soft / scored):**
| # | name | gradedBy |
|---|---|---|
| 9 | `rightIntentClassified` | mechanical |
| 10 | `rightSlotsExtracted` | mixed (structural + LLM-judge) |
| 11 | `rightEscalationBehavior` | mechanical |
| 12 | `rightCallerFacingAnswer` | llm (majority-vote / median-of-three) |

**Harness shape (already built):**
- **Corpus** (`corpus/scripts/<bucket>/*.json`) across **10 buckets**: `01-happy-lookups`,
  `02-happy-booker`, `03-lead-capture`, `04-identity-edges`, `05-compliance-edges`,
  `06-hangup-edges`, `07-out-of-scope`, `08-ambiguity`, `09-concurrency`, `10-adversarial`
  (~44 golden scripts today).
- **Layer 1** — text/cassette, runs in PR CI on **in-memory repos**.
- **Layer 2** — real audio (`audio/whisper-real-provider.ts`, `twilio-stream-emulator.ts`,
  `tts-fixture-cache.ts`) for audio-only edges (mumble, mid-sentence pause).
- **Captured metrics**: time-to-first-audio (`ttfaMaxMs`), reprompt ratio, cost cents,
  proposal/customer/appointment deltas, audit trail.

> **Definition of done for this tracker:** every row below reaches ✅ — corpus coverage +
> green floor gates at L1 and L2. Rows are ordered by leverage.

---

## 1. Parity matrix — Avoca voice feature → our status

Legend: ✅ at parity · 🟡 partial / unverified · 🔴 gap. "Corpus" = eval bucket coverage.

| # | Avoca voice capability | Our implementation | Corpus | Rubric | Verdict |
|---|---|---|---|---|---|
| 1 | **Inbound answer + book appointment** (Convert) | Twilio + Vapi inbound; `create_appointment` / `two-step-booking` / reschedule / cancel proposals | `02-happy-booker` ✅ | 1–12 exercised | **🟡 verify L2** |
| 2 | **Identify caller / known-customer handling** | `identify-caller` skill; caller-id match | `04-identity-edges` ✅ (5 scripts) | 1,5,6 | **✅** |
| 3 | **Lookups / FAQ answering** | 12+ `lookup_*` intents | `01-happy-lookups` ✅ (10 scripts) | 3,9,12 | **🟡 verify L2** |
| 4 | **Lead capture (unknown caller)** | `find-or-create-lead`, `convert_lead` | `03-lead-capture` ✅ | 6,9,10 | **✅** |
| 5 | **After-hours / compliance / DNC** | `enforce-compliance`; after-hours→callback | `05-compliance-edges` ✅ | 7 | **✅** |
| 6 | **Hangup robustness** | session lifecycle + termination events | `06-hangup-edges` ✅ | 8 | **✅** |
| 7 | **Ambiguity / accent / mumble recovery** | entity-resolver clarifications; reprompt | `08-ambiguity` ✅ (incl. L2-only mumble/pause) | 9,10,12 | **🟡 expand L2** |
| 8 | **Concurrency (slot taken mid-call)** | optimistic checks | `09-concurrency` ✅ | 2,11 | **✅** |
| 9 | **Adversarial robustness** (spam/injection) | input handling | `10-adversarial` ✅ (sql-injection, spam) | 1,2,5 | **✅** |
| 10 | **Out-of-scope → escalate** | `escalate-to-human` | `07-out-of-scope` ✅ | 11 | **✅** |
| 11 | **Live human transfer w/ context** (no dead-ends) | **Voice-parity Feature 7**: warm transfer to `transfer_number` + context SMS *before* connect; failed→`call_me_back` | `transfer-context` test; **no corpus bucket** | 11 | **🟡 add corpus** |
| 12 | **Catalog-grounded quoting on voice** | `catalog-resolution` (never trusts LLM price) — *a quality edge Avoca lacks* | `lookup-catalog-empty` only | 10 | **🟡 add quote-accuracy corpus** |
| 13 | **Bilingual / Spanish** | **Voice-parity Feature 6**: `language-detector`, ES i18n, Spanish booking-rate test | `spanish-booking-rate` test; **not in corpus buckets** | 9,12 | **🟡 partial** |
| 14 | **Multilingual beyond Spanish / code-switch** | only en/es | 🔴 | — | **🔴 gap** |
| 15 | **Emergency vs. routine triage** (Avoca's HVAC-native claim) | `emergency-page-retry`, `emergency_dispatch` intent | 🔴 no triage corpus | 9,11 | **🔴 gap** |
| 16 | **Sub-2-second answer latency** | **`gradeCallerExperience`: TTFA P95 ≤800ms + lookup→speak P95 ≤2s**, aggregated cross-script in `buildLayer2Report` with a launch gate; rendered in PR-comment markdown | L2 corpus | 3 | **✅ benchmark exists (stricter than Avoca <2s); ensure L2 runs in CI** |
| 17 | **Outbound voice (Nurture / Speed-to-Lead)** | only `call_me_back` (reactive); no proactive dialer/drip | 🔴 | — | **🔴 gap** |
| 18 | **Objection handling on calls** | not modeled as a graded skill | 🔴 | 12 | **🔴 gap** |
| 19 | **CSR call scoring / coaching** (Avoca Coach) | graders grade the **AI**, not productized for **human** CSR calls | grader infra ✅ (reusable) | reuse 9–12 | **🔴 product gap** |
| 20 | **FSM write-back accuracy** (ServiceTitan/HCP) | internal CRM only; no FSM integration | 🔴 | 10 | **🔴 gap (see analysis §8)** |

---

## 2. Quality-harness gaps (the measurement system itself)

These block *proving* parity even where the feature exists:

- **H1 — Layer 1 runs on in-memory repos only.** `makeRepoBundle('pg')` throws (deferred
  to VQ-009). CLAUDE.md's own warning applies: the entity resolver once shipped with
  nonexistent column names *because its Pool was mocked*. Voice flows are not yet proven
  against real Postgres in the harness. **→ wire pg-mode / a Docker-gated nightly run.**
- **H2 — Latency benchmark EXISTS (corrected).** `gradeCallerExperience`
  (`graders/caller-experience.ts`) enforces TTFA P95 ≤800ms + lookup→speak P95 ≤2s per
  script; `buildLayer2Report` (`report-layer2.ts`) aggregates cross-script TTFA/lookup
  P50/P95 and **launch-gates on TTFA P95 ≤800ms**, rendered in PR-comment markdown — a
  *stricter* bar than Avoca's "<2s". The original "no benchmark" claim came from the
  stale first audit. **Residual: ensure the Layer-2 audio corpus runs in CI on a cadence
  (Layer 1 is the per-PR gate) and publish the measured number.**
- **H3 — Corpus coverage holes** for rows 11–18 above (transfer, quote-accuracy,
  multilingual, emergency-triage, outbound, objection). **→ author golden scripts.**
- **H4 — Disposition #12 is LLM-judged.** Stabilized by median-of-three, but judge drift
  is a standing risk. **→ pin a judge-version regression check.**

---

## 3. Prioritized next iterations (each = one "continue")

Ordered by leverage. Each step is a self-contained, testable unit (corpus + tests in the
same commit per CLAUDE.md), verified with `tsc --project tsconfig.build.json --noEmit`.

1. **Close H1 (pg-mode harness).** Highest-value: makes *every* row's green a real green,
   not a mock green. Wire `makeRepoBundle('pg')` against the existing pgvector
   testcontainer; gate in PR CI.
2. **Row 16 / H2 — latency benchmark (DONE; CI cadence remains).** The TTFA/lookup budget +
   L2 launch gate already exist (`caller-experience.ts` + `report-layer2.ts`). Remaining:
   schedule the Layer-2 audio corpus in CI and publish the measured P95 number.
3. **Row 11 — transfer-with-context corpus.** Promote the `transfer-context` test into a
   `07`/new bucket golden script so human-handoff parity is rubric-graded (criterion 11).
4. **Row 12 — quote-accuracy corpus.** Author `02-happy-booker` scripts that assert
   catalog-grounded prices (criterion 10). This pins our *differentiator* (Avoca can't
   make a no-mis-quote guarantee) as a measured quality gate.
5. **Row 15 — emergency-vs-routine triage corpus + skill.** Avoca's HVAC-native claim;
   needs both a triage path and `05`/new-bucket scripts (criteria 9, 11).
6. **Row 13/14 — multilingual.** Add ES to the corpus buckets first (Feature 6 exists),
   then evaluate a third language.
7. **Rows 17–19 — outbound + coaching.** Larger product bets (see analysis §8 Tier-2/3);
   reuse the grader infra for row 19.

---

## 4. Loop status

`/loop` ran in **dynamic mode** (no interval). **The self-pacing scheduler
(`ScheduleWakeup`/`CronCreate`) is not available in this environment** — only an
event-stream `Monitor`, and this goal isn't gated on an external event. So this cannot
run as an unattended recurring loop here. **Each iteration advances on command** ("continue"
or re-invoke `/loop`), closing the top open row in §3 and updating this tracker. Terminal
state: every row in §1 is ✅ at L1 + L2.
