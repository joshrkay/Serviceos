# Rivet — Acceptance criteria and verification evidence

**Companion to [`docs/PRD-v5-as-built.md`](PRD-v5-as-built.md). Created
2026-09-11.**

## A.0 Why this document exists

PRD v5 scored every capability on a 0–6 ladder. Those scores were **asserted**.
They were an honest engineer's reading of the code, but nothing separated "I
believe this works" from "here is the command that proves it, and here is what
it printed."

That distinction is the product's own stated requirement — R20, *"Prove it,
don't claim it"* — and the repo already says so in its own QA harness:

> `expected` documents the pre-run prediction. **It is NOT the pass criterion**
> — actual pass/fail comes from runtime checks.
> — `packages/api/test/qa/matrix.ts`

A PRD that scores itself from prediction is doing exactly what that comment
forbids. This document replaces the predictions with evidence.

Every row below carries four things:

1. **The acceptance criterion** — one falsifiable sentence. Not "booking
   works," but a statement that a specific command can return true or false.
2. **The evidence class** — what kind of proof actually exists.
3. **The verified rung** — derived from the evidence, not from reading the
   source.
4. **How to confirm it** — the command, so the next person does not have to
   trust this document either.

---

## A.1 The evidence classes

The rung ladder is unchanged. What changed is that a rung is now *earned* by an
evidence class rather than assigned by inspection.

| Class | Meaning | Highest rung it can earn |
|---|---|---|
| **NO EVIDENCE** | No test asserts the claim. | 2 |
| **CODE-ONLY** | The code reads correctly; nothing pins it. A refactor could silently remove it. | 2 |
| **PROVEN-UNIT** | Behaviour proven against in-memory or mocked dependencies. | 3 |
| **STRUCTURAL** | A guard or contract test **with a negative control** — plant a violation, the build fails. | 4 (for structural claims) |
| **REAL-DB-WRITE-ONLY** (written **4−**) | A Docker-gated test proves the row against real Postgres, but the audit leg uses an in-memory repository. | 4− |
| **PROVEN-REAL-DB** | A Docker-gated test proves **the write AND its audit event** against real Postgres. | 4 |

Rung **5** additionally requires **reachability**: a normally-provisioned tenant
can get to the capability with no SQL, no platform-admin action, and no
environment variable. Rung **6** requires live production traffic, which nothing
in this product has yet.

### Three rules this exercise had to learn the hard way

**1. Documentation is never evidence.** A doc-comment claiming a module is wired
is a claim, not a wiring. Two modules in this codebase carry doc-comments that
are *actively false* — `assignment-notifications.ts:252` says *"app.ts registers
one notifier"* and `:259` says *"Called once in app.ts."* `app.ts` never imports
the module. Every production assignment fires a permanent no-op.

**2. Directory location is not evidence.** `packages/api/test/integration/` is
not synonymous with real Postgres. Three files live there and never open a pool:

```bash
for f in packages/api/test/integration/*.test.ts; do
  grep -q "getSharedTestDb\|TEST_DB_URL\|new Pool(\|withTestDb\|testDb" "$f" || echo "NO-DB: $f"
done
# conversation-consent-ordering.test.ts
# mode-switch-no-bleed.test.ts
# voice-create-customer.test.ts
```

`conversation-consent-ordering.test.ts:22` says so in its own header — *"a pure
adapter-behavior check [that] does not touch Postgres"* — and its consent-ledger
assertion is a `vi.fn()`. It was carrying a **rung-5 claim** in the PRD. Any
claim resting on those three files is rung 3.

**3. A mocked dependency caps the claim at the mock.** The entity resolver once
shipped with nonexistent column names because its `Pool` was mocked (CLAUDE.md
records this). The same shape recurs: `estimate-phases.test.ts:11` imports
`InMemoryAuditRepository`, so four §8.7 rows prove their write and not their
audit. `overdue-invoice-worker.test.ts:206` uses
`InMemoryDunningEventRepository`, so the dunning cadence's uniqueness constraint
has never met a real `UNIQUE` index.

---

## A.2 How to run any command in this document

Three lanes. The prefix in each table's **Confirm** column says which.

| Prefix | Lane | Command |
|---|---|---|
| **D:** | Docker / real Postgres (`pgvector/pgvector:pg16` testcontainer, `maxWorkers:1`) | `npm run test:integration --workspace=packages/api -- <path>` |
| **U:** | Unit — **excludes `test/integration/**`**, no Docker | `npm test --workspace=packages/api -- <path>` |
| **W:** | Web (jsdom) | `npm test --workspace=packages/web -- <path>` |
| **E:** | End-to-end | `npx playwright test <path>` |
| **S:** | Structural falsifier — a shell command whose output *is* the verdict | given inline |

Narrow to one case with `-t "<test title>"`. The integration lane requires a
running Docker daemon; without one it does not fail, it *skips* — which is its
own trap, and the reason `S:` falsifiers appear wherever a claim is load-bearing.

---

## A.3 Invariants I1–I18

The invariants are the product's load-bearing claims, so they are audited first.
**Eleven of eighteen hold at PROVEN-REAL-DB or STRUCTURAL. Four carry a
universal quantifier that nothing proves. One has no enforcement at all.**

| # | Acceptance criterion | Evidence | Confirm |
|---|---|---|---|
| **I1** | A voice-drafted `create_job` produces **zero** `jobs` rows before approval, and exactly one row **plus one `job.created` audit row** after execution. | PROVEN-REAL-DB | **D:** `test/integration/create-job-execution.test.ts` |
| **I1′** | *No AI module may call a repository write.* | **CODE-ONLY** — no lint rule, no import guard. Per-path D-004 pins exist (`test/proposals/resolve-entity.test.ts:436`) but the universal negative is unproven. | **S:** no guard exists to run |
| **I2** | `transitionProposal(p,'approved','system:…')` throws `ForbiddenError` for every starting status, and no code path reaches `approved` without that seam. | PROVEN-UNIT — in-memory objects only. **Zero** integration tests attempt a `system:` approval. | **U:** `test/proposals/lifecycle.test.ts` |
| **I3** | Three wrong spoken codes in one session — *including across a cancelled and restarted dialogue* — lock the session for money/irreversible classes while capture-class still approves. | PROVEN-UNIT (two levels: task + transport) | **U:** `test/ai/tasks/proposal-approval-task.test.ts` `test/telephony/voice-approval-gather.test.ts` |
| **I3′** | *The readback is composed from the payload, never the owner's utterance.* | **CODE-ONLY** — no provenance assertion exists. | — |
| **I4** | Any document with one uncatalogued line carries `requiresReview === true` regardless of tenant settings or confidence, and its `pricing_source` is CHECK-constrained on disk. | PROVEN-UNIT + PROVEN-REAL-DB (persistence) | **U:** `test/ai/resolution/catalog-resolver.test.ts` · **D:** `test/integration/invoice-pricing-source.test.ts` |
| **I5** | Two same-named customers make a chat draft gate on `customerId` with **exactly one** question, and no id is persisted until a follow-up names a candidate. | PROVEN-REAL-DB (chat surface) | **D:** `test/integration/chat-entity-resolution.test.ts` |
| **I5′** | *One shared matcher, so surfaces cannot drift.* | **FALSE AS WRITTEN.** A second, deliberately broader gate exists — `gated-reference-resolution.ts:602` `isDisambiguationAnswer`, used only by `routes/assistant.ts:2531`. Its own comment says it "is allowed to be slightly BROADER than the matcher behind it." Nothing fails if they diverge. | **S:** `grep -n "isDisambiguationAnswer" packages/api/src -r` |
| **I6** | Every entity-id field any proposal contract can place in `missingFields` is a key of `GATED_REFERENCE_SOURCES`. | **NO EVIDENCE** — and the *opposite* is pinned as supported: `gated-reference-resolution.test.ts:115` — *"leaves gates it does not know how to resolve strictly alone."* Individual gates are PROVEN-REAL-DB; the universal is not. | no command exists — the test must be written |
| **I7** | With no discount policy configured, `evaluateDiscountAsk` returns `policyAllowsCents === currentQuotedCents` (zero concession) for every ask, **and no `ProposalType` can express an AI-applied discount**. | PROVEN-UNIT + **STRUCTURAL** (a type-level impossibility proof, not a behaviour sample) | **U:** `test/proposals/guardrails/` · **D:** `test/integration/settings-discount-policy.test.ts` |
| **I8** | Every `TIER_1_EVACUATE` corpus phrase classifies E1 **with no rules loaded**, and the complaint guardrail escalates from every live FSM state. | PROVEN-UNIT | **U:** `test/ai/agents/customer-calling/emergency-tier.test.ts` `…/emergency-tier-transitions.test.ts` `…/complaint-guardrail.test.ts` |
| **I8′** | *No config flag may override it.* | **NO EVIDENCE.** The claim rests on the absence of a parameter (`complaint-guardrail.ts` takes no settings), which nothing pins. Adding one would break the invariant silently. | **S:** `grep -c "settings\|flag\|tenant" packages/api/src/proposals/guardrails/complaint-guardrail.ts` → expect 0 |
| **I9** | Over ≥1000 randomized documents every field of `calculateDocumentTotals` satisfies `Number.isInteger` and `total >= 0`; `createInvoice` persists the server-recomputed total, discarding the client's. | PROVEN-UNIT (seeded-PRNG fuzz, 4000 iterations) + PROVEN-REAL-DB (persistence, hand-picked examples) | **U:** `test/shared/billing-engine.property.test.ts` `test/shared/line-item-normalization.test.ts` |
| **I9′** | *One engine as the only source of totals math.* | **CODE-ONLY** — nothing forbids a module computing its own totals. | — |
| **I10** | A tenant with no timezone produces a draft with no scheduled window, approval **refuses**, and `appointments` holds **zero** rows — never a silent UTC fallback. | PROVEN-REAL-DB | **D:** `test/integration/live-call-booking-timezone.test.ts` |
| **I11** | Every `tenant_id` table has RLS **enabled and forced** except exactly two documented exemptions, and a production config without `RLS_RUNTIME_ROLE=true` fails to boot. | **PROVEN-REAL-DB — the best-evidenced invariant in the product.** | **D:** `test/integration/rls-force-catalog.test.ts` `…/rls-runtime-audit.test.ts` `…/rls-runtime-role.test.ts` · **U:** `test/shared/config.test.ts` |
| **I12 T1** | A forced audit-insert failure during execution rolls back the *whole* unit: no state change, no idempotency marker. | PROVEN-REAL-DB (both polarities) | **D:** `test/integration/executor-audit-atomicity.test.ts` |
| **I12 T2** | A handler whose `auditRepo.create` throws still returns success with its mutation committed. | PROVEN-UNIT, **one handler family only** (~40 others unproven). The §5.0b consequence — operational state created without its domain audit row during an audit outage — has **no real-DB test**. | **U:** `test/proposals/callback-handler.test.ts` |
| **I13** | A transcript containing `[BEGIN …]`/`[END …]` lookalikes yields a prompt whose marker counts are each exactly 1, with the caller block in the lowest-authority slot. | PROVEN-UNIT | **U:** `test/ai/untrusted-content.test.ts` `…/customer-calling/untrusted-content.test.ts` `…/i13-provenance.test.ts` |
| **I13′** | *Every operator-facing model context.* | **CODE-ONLY** — exactly three call sites import the fence. A new prompt that inlines a transcript passes CI. | **S:** `grep -rn "buildUntrustedContentSection" packages/api/src` → 3 sites |
| **I14** | After an SMS `STOP`, an outbound **call** to the same number is blocked even while `customers.consent_status` still reads `granted`; after `START`, SMS is restored and the voice rollup stays revoked. | PROVEN-REAL-DB (row state **and** ledger events) | **D:** `test/integration/consent-cross-channel.test.ts` `…/stop-reply-unify.test.ts` |
| **I15** | The guard script exits 0 on the clean tree and **non-zero when an offending file is planted**. | **STRUCTURAL with a genuine negative control.** Scope caveat: the guard is OpenAI-specific; an `@anthropic-ai/sdk` import would pass it. | **U:** `test/ai/gateway-ci-guard.test.ts` · **S:** `npm run check:ai-gateway-guard --workspace=packages/api` |
| **I16** | `COVERAGE_TABLE` declares a cell for all 11 × 4 pairs with no unknown keys, **and** every handler in the shared drafting registry is reachable or in a declared exception set on both voice/memo and chat. | STRUCTURAL. Caveat: the coverage table is inert at runtime (`coverage-table.ts:19` — *"nothing in production reads it"*) and its axis is 11 intent families, not 48 capabilities. **`drafting-surface-parity.test.ts` is the test that actually spans the registry — cite that one.** | **U:** `test/ai/voice-turn/coverage-table.structural.test.ts` `test/proposals/drafting-surface-parity.test.ts` |
| **I17** | A fresh tenant reads `enabled=false` / `threshold=0.95`; a raw SQL update to 0.80 is rejected by a DB CHECK; and the lane returns ineligible for each of 19 single-gate mutations, with the platform kill switch outranking tenant opt-in. | PROVEN-REAL-DB + PROVEN-UNIT (19-case gate table) | **D:** `test/integration/settings-autonomous-booking.test.ts` `…/digest-reflection.test.ts` · **U:** `test/proposals/autonomous-lane.test.ts` `test/proposals/one-tap-undo.test.ts` |
| **I18** | *No feature ships that adds admin work.* | **NO ENFORCEMENT AND NO TEST.** This is a product-process rule, not a code invariant, and it does not belong in the same table as I1–I17 unmarked. See A.6 for three ways to make it falsifiable. | — |

### The four invariants whose universal quantifier is unproven

I1′, I5′, I8′, I9′ and I13′ share one shape: the *instance* is proven and the
*universal* is not. "The AI never writes" is proven for the paths someone
thought to test; nothing stops a new path. That is the difference between a
tested behaviour and an enforced invariant, and §5 should say which each one is.

**I6 is the weakest**, because a test pins the opposite behaviour as supported —
an unresolvable gate is a legal state. The invariant text says such a gate "is a
capability that can never be approved" (#909). Both cannot be true.

---

## A.4 Lifecycle capabilities — §8.2 Capture

**12 rows audited. 5 overclaims, 2 underclaims, 5 correct.**

| Capability | Was → **Now** | Acceptance criterion | Confirm |
|---|---|---|---|
| Answer 24/7, tenant resolved from the dialed number | 5 → **5** | The dialed-number→tenant lookup resolves against the real `phoneE164` column. | **D:** `voice-inbound-appointment.test.ts -t "routes a dialed number to its tenant"` |
| Recording disclosure spliced before capture | 5 → **3** 🚨 | The disclosure `<Say>` precedes `<Start><Record>`, Media Streams does not consume audio until it has played, **and the implicit-consent ledger row is written**. The third clause is unproven: the only test mocks `commitRecordingConsent` with `vi.fn()`. | **S:** `grep -c "getSharedTestDb\|new Pool(" packages/api/test/integration/conversation-consent-ordering.test.ts` → **0** |
| Caller identification from caller-ID; unknown → lead | 4 → **4** | A stored E.164 customer matches; a non-NANP caller sharing the last 10 digits does **not**. | **D:** `identify-caller.test.ts`. Caveat: the *voice* unknown→lead leg has no real-DB test — only the SMS caller of the same function. |
| Intent + urgency classification, surface-conditional | 5 → **3** 🚨 | A classification outside the surface's accept rule becomes `unknown` and is audited. Proven on fixtures; **no Docker-gated test references `intent_off_surface` or the surface profile**. | **S:** `grep -rln "intent_off_surface\|surfaceProfile" packages/api/test/integration/` → **empty** |
| Deterministic emergency detection (E1/E2/E3), pre-LLM, bilingual | 5 → **3** 🚨 | Every corpus phrase classifies to its tier with no rules loaded, **and the classification plus its audit event survive a real-Postgres round trip**. Unit tests only; the nearest integration test (`emergency-dispatch-hold.test.ts:81`) uses `InMemoryAuditRepository`. | **S:** `grep -rln "classifyCallerSafety\|detectEmergency" packages/api/test/integration/` → **empty** |
| Vulnerability grading → patch the owner's cell | 3 → **3** | Same structural problem as dropped-call recovery: `voice_vulnerability_triage` has no production write path either. | **U:** `test/ai/agents/customer-calling/vulnerability-triage-hook.test.ts` |
| Dropped-call SMS recovery at 60 s | 4 → **4 (unlit-able)** | With the flag on, a due row sends exactly one SMS, stamps `sent_at` + sid, and emits the audit event — **proven at real Postgres, including the flag-off→override-on transition**. The criterion that fails is a different one: *a production write path for the flag exists.* | **D:** `dropped-call-worker.test.ts` · **S:** `grep -rn "setTenantFlag" packages/api/src packages/web/src` → **definition only** |
| Customer photo → draft estimate (MMS) | 3 → **4** ✅ | An unknown-customer MMS persists a `draft_estimate` proposal with `tenant_id` **and** an audit row; an ambiguous sender yields a clarification, never a draft. | **D:** `mms-to-quote.int.test.ts` |
| Public web booking, no login, real availability | 5 → **3** 🚨 | A tokenless booking POST writes a real held appointment. The route is mounted and `/book` exists, so reachability is real — but the only test is in-memory supertest. | **S:** `grep -rln "public-booking\|PUBLIC_BOOKING" packages/api/test/integration/` → **empty** |
| Unclaimed inbound SMS → threaded conversation | 4 → **4** | Concurrent captures from one unmatched number collapse to a single open thread (migration 200 index), and threads never bleed across tenants. | **D:** `inbound-sms-capture.test.ts` |
| Never quotes a firm price, never negotiates | 5 → **3** 🚨 | A price-pressure turn speaks the holding line, mints exactly one owner callback, stays in state, and is idempotent when already flagged. Unit only. | **S:** `grep -rln "NEGOTIATION_HOLDING_LINE" packages/api/test/integration/` → **empty** |
| B2B / property-manager recognition | 2 → **3** ✅ | The PRD's "not consumed at all" was wrong twice: `twilio-adapter.ts:947` assembles it onto the session and `ai/supervisor/checks.ts:117` reads `accountType`. The narrower claim — **no routing difference** — still holds. | **S:** `grep -rn "b2bAccountContext" packages/api/src` → 2 writes, 0 reads |

## §8.3 Book

**12 rows audited. 4 overclaims, 1 underclaim, 7 correct.**

| Capability | Was → **Now** | Acceptance criterion | Confirm |
|---|---|---|---|
| Call → booking **proposal**, never a booking | 5 → **5** | Free text → real entity resolver → real drafting task → approve → production execution registry, with the spoken reason persisted only after execution. | **D:** `voice-inbound-appointment.test.ts` |
| Availability: grid, per-day hours, DST, travel buffer, tech hours, time-off | 4 → **4 / 3** | Real-DB proof covers business hours, the buffered booked window, and tenant isolation. **DST, per-day hours, technician hours and time-off are unit-only.** The row is over-broad as written. | **D:** `dispatch-availability.test.ts` · **S:** `grep -in "dst\|workingHours\|unavailable" packages/api/test/integration/dispatch-availability.test.ts` → **empty** |
| Config provenance on availability | 4 → **3** 🚨 | A cold tenant's availability response labels hours, buffer and timezone as defaults. In-memory supertest only — and the **web app never calls this endpoint**; only mobile does. | **S:** `grep -rn "dispatch/availability" packages/web/src` → **empty** |
| Write-side twin: a POST can only book what GET would offer | 4 → **3** 🚨 | `isWithinBusinessHours` rejects a POST for a slot generation would not offer. Unit only. | **S:** `grep -rln "isWithinBusinessHours" packages/api/test/integration/` → **empty** |
| Held slots (24 h), reaped on a sweep | 4 → **4** | The reaper cancels the expired hold, clears the flag, emits audit, spares live holds, and a second sweep is a no-op; an expired hold stops blocking the slot. | **D:** `hold-reaper.test.ts` `slot-conflict-checker.test.ts` |
| Double-booking excluded at the **database** level | 4 → **4** | Two concurrent `assignTechnician` calls for the same technician and slot: exactly one succeeds; a raw INSERT on the overlapping slot is refused by the `no_double_booking` EXCLUDE constraint until the conflict is cancelled. **This is the strongest capability row in the product.** | **D:** `technician-double-booking-race.test.ts` |
| Owner approves; ambiguity clarifies | 5 → **5** | Duplicate display names yield an ambiguity carrying both candidates; approve → execute emits exactly one audit event. | **D:** `entity-resolution.test.ts` `cancel-appointment-voice.test.ts` |
| Confirmation to the customer on approval | 4 → **3** 🚨 | Approving a `create_appointment` writes an `appointment_confirmation` dispatch row. **No test proves it**, the default is `NoopSchedulingConfirmationNotifier`, and the class whose doc-comment claims to be the live path (`appointment-confirmation-notifier.ts:36`) is never instantiated in `src/`. | **S:** `grep -rn "new AppointmentConfirmationNotifier" packages/api/src` → **empty** |
| Day-before reminder | 3 → **3 / 4** | The **owner push** is PROVEN-REAL-DB with durable dispatch-key idempotency. The **customer** reminder is not. Conservative score was right. | **D:** `appointment-reminder-owner-push.integration.test.ts` |
| Book / move / cancel by speaking | 4 → **5** ✅ | All three intents are mapped with wired handlers and each has a real-DB approve→execute test emitting exactly one audit event. | **D:** `voice-inbound-appointment.test.ts` `reschedule-appointment-voice.test.ts` `cancel-appointment-voice.test.ts` |
| Schedule proposals expire after 48 h | 3 → **3** | Unit only. Note a live conflict: `proposal-expiry-worker.ts:29` says 48 h while `ai/guardrails/expiration.ts:10-16` defaults to 24 h with `create_appointment` at 4 h. **Two TTL regimes coexist.** | **U:** `test/workers/proposal-expiry-worker.test.ts` |
| Drive-time feasibility | 3 → **3** | `checkFeasibility` has five callers, all on the dispatch/reschedule side. **The three booking-creation paths call `createAppointment` with no feasibility check at all.** | **S:** `grep -n "checkFeasibility" packages/api/src/proposals/execution/handlers.ts packages/api/src/routes/public-booking.ts packages/api/src/routes/appointments.ts` → **empty** |

## §8.4 Dispatch

**10 rows audited. 3 overclaims, 7 correct.**

| Capability | Was → **Now** | Acceptance criterion | Confirm |
|---|---|---|---|
| Dispatch board, day view, drag-and-drop | 5 → **5** | Board data queries by date and refuses cross-tenant access. (Read-only; the audit clause is inapplicable.) | **D:** `dispatch.test.ts` |
| Drag produces a **proposal**, never a direct mutation | 5 → **3** 🚨 | A drag creates a proposal and never mutates the appointment. `createSchedulingProposal` has **zero** integration coverage; the UI is genuinely reachable, the proof is not. | **S:** `grep -rln "createSchedulingProposal" packages/api/test/integration/` → **empty** |
| Live multi-user collaboration: revision tokens, presence leases | 4 → **3** 🚨 | Presence is in-memory or Redis-backed, so it is **structurally incapable** of a real-Postgres proof. Score it as unit-proven and stop calling it 4. | **S:** `grep -rln "board-revision\|presence-store" packages/api/test/integration/` → **empty** |
| Technician day view with a same-tenant ownership guard | 4 → **4** | A 23:00-local appointment lands on the tenant date (the naive-UTC window would have dropped it), and a technician of tenant B is not submittable by tenant A. | **D:** `dispatch-technician-day-window.test.ts` `technician-location-authz.test.ts` |
| "On my way" — app, voice, SMS keyword, one audited act | 4 → **4 / 3** | Voice, phone and chat legs emit the audit event (TECH actor) plus a customer ETA dispatch row at real Postgres. **The SMS-keyword leg is unit-only** — the row claims four legs and proves three. | **D:** `en-route-voice.test.ts` · **S:** `grep -rln "en-route-keyword" packages/api/test/integration/` → **empty** |
| Running late, 10/20/30 chip picker | 4 → **3** 🚨 | The chip POSTs to `/running-late` and writes a delay notice. In-memory supertest + a jsdom test that the chip hits the right endpoint; no real-DB write proof. | **S:** `grep -rln "running-late" packages/api/test/integration/` → only a schema-pin file |
| Geofence/dwell lateness engine | 3 → **3** | Correct — and worth flagging that `dispatch/lateness.ts`'s only importer uses it as a **type-only import**; the server-side evaluator has no runtime caller. | **S:** `grep -rn "dispatch/lateness" packages/api/src` |
| Tech texts OUT → one reschedule proposal per appointment | 4 → **4** | A verified tech OUT writes an unavailable block, a reschedule proposal and an audit row; a second OUT the same tenant-local day is a no-op; an OUT from an unregistered number is not actioned. | **D:** `tech-status-sms.test.ts` |
| Skill-based assignment | 0 → **0** | The whole file is nine lines returning `[]`. Worth noting it is **wired** into `checkFeasibility`, so the empty skill list reads as an always-feasible verdict rather than a visible gap. | **S:** `cat packages/api/src/scheduling/skill-matcher.ts` |
| Route optimization / multi-stop sequencing | 0 → **0** | Absent. No module, no test. | **S:** `grep -rni "optimizeRoute\|multi-stop" packages/api/src` → **empty** |

> **Extra row the PRD does not carry.** `setTechnicianAssignmentNotifier` has
> **zero callers in `packages/api/src`**. The accessor is
> `await instance?.notifyChange(change)`, so every production assignment fires a
> silent no-op that never throws and never logs — while the module's own
> doc-comment says *"app.ts registers one notifier."* **Rung 2.**

---

## §8.1 Setup, §8.5 Execute, §8.6 Narrate — executed, not inspected

No evidence sweep covered these three sections, so rather than carry their
asserted rungs forward unmarked, **the relevant Docker-gated suite was run
here**:

```
npm run test:integration --workspace=packages/api -- \
  test/integration/onboarding-{status,identity,pack,conversation,ai-check}.test.ts \
  test/integration/brand-voice.integration.test.ts \
  test/integration/{log-time-entry-execution,log-expense-job-link,add-note-voice-execution}.test.ts \
  test/integration/{material-items,voice-lookup-answer,voice-idempotency}.test.ts

Test Files  12 passed (12)
     Tests  70 passed (70)
  Duration  20.12s          # 2026-09-11, pgvector/pgvector:pg16 testcontainer
```

### §8.1 Setup

| Capability | Was → **Now** | Acceptance criterion | Confirm |
|---|---|---|---|
| Tenant bootstrap on signup (webhook, idempotent) | 4 → **4** | Signature verified with the replay window enforced *before* verification. | **D:** `clerk-owner-membership.test.ts` `users-tenant-clerk-unique.test.ts` |
| Identity, hours, timezone, service area, rate | 5 → **5** | A valid payload upserts and marks the step done; a re-PUT is idempotent; an omitted `serviceAreaRadius` keeps the stored value while `null` clears it; **`tenant.identity_set` audit event emitted**. ✅ executed, 5 passed | **D:** `onboarding-identity.test.ts` |
| Vertical pack selection + price-book seeding | 4 → **4−** | Activation is idempotent and serialized by an advisory lock. Real-DB write proven; **no audit assertion**. | **D:** `onboarding-pack.test.ts` `onboarding-pack-seed-concurrency.test.ts` |
| Onboarding status derived from facts, never wizard state | — → **4** | A fresh tenant with no settings row returns `identity`; `isComplete` only when all seven steps are satisfied by facts. ✅ executed | **D:** `onboarding-status.test.ts` |
| Phone number provisioning | 3 → **3** | Production path throws without real credentials; CI uses a magic test number. No real-provider proof is possible in CI — this rung is capped by the dependency, not by neglect. | **U:** provisioning unit tests |
| Subscription + 14-day trial | 4 → **4** | A plan that fails live Stripe validation is omitted, never shown wrong. | **D:** subscription/billing integration tests |
| AI verification + test call | 3 → **4** ✅ | Passing verification marks the step done with DB status `passed`; failing yields an `ai_verification_failed` blocker; retry resets to pending and enqueues the job. ✅ executed, 3 passed | **D:** `onboarding-ai-check.test.ts` |
| Conversational onboarding (bounded at 15 turns) | 4 → **4−** | Sessions round-trip transcript turns, extractions and clarification counts through JSONB; **migration 195 pins ENABLE + FORCE RLS and the isolation policy**, and cross-tenant reads are refused under the unprivileged role. ✅ executed, 6 passed. No audit assertion. | **D:** `onboarding-conversation.test.ts` `onboarding-conversation-parity.test.ts` |
| Brand voice capture | 3 → **4 (web dark, voice lit)** ✅ | Onboarding captures all six fields, writes v1 history and round-trips to a tone; an explicit edit is **audit-logged** and cool-down enforced (423) then succeeds; two overlapping edits serialize on `FOR UPDATE` with no lost update; rollback re-persists as a new bump and never mutates history. ✅ executed, 5 passed. The **web configurator is behind a default-off flag**; the spoken path is not. | **D:** `brand-voice.integration.test.ts` `update-brand-voice-voice-execution.test.ts` |
| Team invites | 4 → **4** | The local invitation row is written **first**, so a Clerk outage cannot lose tenant intent; the last owner cannot be demoted. | **D:** `clerk-owner-membership.test.ts` |

> **Known carve-out, unchanged:** `/accept-invitation` has no route. Every invite
> email 404s. This is tracked separately and is not a scoring question.

### §8.5 Execute — the field

| Capability | Was → **Now** | Acceptance criterion | Confirm |
|---|---|---|---|
| One-handed, gloved, daylight-legible field screens | 3 → **3** | ≥44px tap targets and no horizontal overflow at 320px, pinned by a jsdom class-contract test plus a Playwright viewport test. That pattern exists for estimate approval and review response; **field screens are not pinned the same way**. | **E:** `e2e/estimate-approval-mobile.spec.ts` (the pattern to copy) |
| Job photos with categories and before/after pairing | 4 → **4** | Category and pairing survive the round trip. | **D:** job-photo integration tests |
| Time entries by voice | 3 → **4** ✅ | A spoken duration persists a `time_entries` row with the resolved `jobId`, emits **exactly one** audit event with actor attribution, is invisible to another tenant, and **is counted by the job-profit query**. ✅ executed, 4 passed | **D:** `log-time-entry-execution.test.ts` |
| Offline capture: crash-safe journal, poison-parking, flush on the reconnect edge | 5 → **4** | Client journal, relocation and flush are PROVEN-UNIT in the mobile package (real Postgres is inapplicable to a device queue). The **server leg is PROVEN-REAL-DB**: the same key twice yields one row and exactly one effective job; a create-then-crash replay re-enqueues; keys are tenant-isolated. ✅ executed, 4 passed. Rung 5 needs a device-level or e2e proof of the reconnect edge, which does not exist. | **D:** `voice-idempotency.test.ts` · **U:** `packages/mobile/src/offline/{queue,flush,audioRelocation}.test.ts` |
| Tap-to-pay card-present on mobile | 3 → **3** | Requires an active Connect account, else a clean 409. Terminal has **no** Docker-gated test — unit and route tests only. | **U:** `test/payments/stripe-terminal.test.ts` |

### §8.6 Narrate — the owner's spoken command line

| Capability | Was → **Now** | Acceptance criterion | Confirm |
|---|---|---|---|
| Push-to-talk from any screen | 5 → **5** | Reachable on every authenticated screen; session + SSE event stream. | **W:** `src/components/voice/useVoiceRecorder.test.ts` |
| Speech → typed proposal pipeline | 5 → **5** | The golden path drafts a typed proposal from a spoken sentence with vertical context. | **U:** `test/voice/operator-voice-golden-path.test.ts` · **D:** `voice-inbound-appointment.test.ts` |
| Free-text references resolve to ids across nine entity kinds | 4 → **4** | Duplicate names resolve to an ambiguity carrying both candidates, against real rows. | **D:** `entity-resolution.test.ts` `chat-entity-resolution.test.ts` |
| Job status by voice | 5 → **5** | — | **D:** `update-job-execution.test.ts` |
| Spoken line item onto an existing estimate | 3 → **4** ✅ | *"Add two hours of labor to the Garcia estimate"* persists the line (qty 2, unit hour) and recomputes totals in integer cents on the real row. | **D:** `update-estimate-execution.test.ts` |
| Dictated notes, expenses, mileage, materials, time | 3 → **4** ✅ | A dictated note persists on the job and emits **exactly one** note-created audit event, tenant-scoped. *"$40 in parts for the Henderson job"* links the job through the resolver, carries `job_id`, and **job P&L counts it**; two Henderson jobs yield a clarification, never a guess; no job mention logs **unlinked** and P&L does not count it. ✅ executed, 7 passed | **D:** `add-note-voice-execution.test.ts` `log-expense-job-link.test.ts` |
| Read-only lookups by voice | 4 → **4** | The in-app memo holds a two-phase contract (`completed` + `answerStatus=pending`, then answered), is **write-once** against a redelivered stamp, keeps `failed` writable for a retry, tenant-isolates both legs, and rejects an out-of-enum status at the DB CHECK. ✅ executed, 6 passed | **D:** `voice-lookup-answer.test.ts` |
| Spoken address as a first-class resolvable entity | 0 → **0** | No `place` entity kind exists. | **S:** `grep -rn "'place'" packages/api/src/ai/resolution` → **empty** |
| Parts capture with quantity **and unit** | 3 → **3** | Units round-trip; `listPending` scopes by `jobId`, orders by `needed_by` ascending, excludes NULL bounds under three-valued logic, and breaks ties on insertion order. ✅ executed, 8 passed. **Correction to the PRD:** the note *"there is no job-level parts domain"* is wrong — `material_items` (migration 272) carries `job_id`, has an execution handler, a lookup skill and a classifier intent. | **D:** `material-items.test.ts` |

---

## §8.7 Quote

**12 rows audited. 7 overclaims, 2 underclaims.**

| Capability | Was → **Now** | Acceptance criterion | Confirm |
|---|---|---|---|
| Estimate from a spoken description or a photo | 3 → **5** ✅ | Both paths persist a real estimate/proposal row **plus** their audit event. | **D:** `draft-estimate-execution.test.ts` `mms-to-quote.int.test.ts` |
| Catalog-resolved pricing; uncatalogued caps confidence and forces review | 5 → **4 / 3** 🚨 | Catalog grounding stamps the tenant price into JSONB, clears `missingFields` and moves to `ready_for_review` — proven. **The second clause is not:** no real-DB test asserts that an uncatalogued line persists with confidence capped below the auto-approve floor. That is the half protecting you from quoting a number you cannot defend. | **D:** `draft-estimate-execution.test.ts` `resolve-line.test.ts` · missing: `-t "uncatalogued"` matches **zero** tests |
| Confidence markers surfaced on the line that earned them | 5 → **5** | Every valid `pricingSource` round-trips through the repo mapper, an invalid one is refused by the DB CHECK on a raw UPDATE, and a badge renders per line. | **D:** `estimates.test.ts -t "pricing_source"` · **W:** `AIProposalCard.test.tsx` |
| Good / better / best tiers with add-ons | 5 → **4−** 🚨 | Tier rows persist and an acceptance recomputes the total from the selection. Audit leg uses `InMemoryAuditRepository`. | **D:** `estimates.test.ts` `estimate-phases.test.ts` |
| **Headline total is the default selection, not the sum of all options** | 5 → **4−** 🚨 | `total_cents` on disk equals the default-selected tier, strictly less than the sum of all tiers. Shares its single assertion with the row above. | **D:** `estimates.test.ts -t "headlines at the default selection"` |
| Customer approval by token link, with signature | 4 → **4− / 2** 🚨 | Token approval is proven at real Postgres. **The signature is not**: the only integration reference *sets* `acceptedSignatureData` as fixture data; nothing asserts it round-trips through the public approve flow. | **D:** `estimate-phases.test.ts` · missing: `-t "signature"` → **zero** tests |
| Stale-revision guard | 4 → **3** 🚨 | Revise 1→2, then approve with `expectedVersion: 1` → rejected and `status` still `sent`; with `2` → accepted. **A guard deciding which price a customer is legally bound to has never touched a real database.** | **S:** `grep -rn "expectedVersion" packages/api/test/integration/` → **empty** |
| **One accepted estimate per job** | 4 → **4− / 3** | The race **is** genuinely tested: two concurrent `approve()` calls against the real partial unique index yield exactly one accepted row. **But "race-mapped to a clean conflict" is not** — the test counts fulfilled results and never inspects the rejected one, so nothing proves a `ConflictError`/409 rather than a raw `23505` → 500. | **D:** `estimate-phases.test.ts -t "two concurrent approvals"` |
| Deposits — percentage or fixed, before- or after-approval | 4 → **4− / 3** 🚨 | `after_approval` writes the deposit onto the job and the view is payable — proven. **`before_approval` blocking an unpaid approve, and the fixed-amount rule, are in-memory only.** | **D:** `estimate-phases.test.ts` · missing: `-t "before_approval"` → **zero** tests |
| Auto follow-up on unviewed estimates | 3 → **5** ✅ | Concurrent nudges for one estimate produce exactly one send with the cadence advancing once, plus `estimate.reminder_sent` and `proposal.executed` audit rows — nine real-DB tests including crash recovery and the 48 h cooldown. | **D:** `estimate-nudge.test.ts` |
| Supervisor review of quotes | 3 → **3** | Annotations persist with a real `ai_run_id` FK and are RLS-isolated. **But see A.7 — the gate reaches 2 of 93 proposal-creation sites and cannot hold a pricing anomaly in any mode.** | **D:** `supervisor-reviews.test.ts` |
| Negotiation pushback → owner proposal; the AI never concedes | 5 → **3** 🚨 | A discount-request turn persists a capture-class callback in `ready_for_review` with zero customer-facing dispatch. All coverage is in-memory; the one integration file touching negotiation tests the **context read**, not the guardrail. | **S:** `grep -rln "NEGOTIATION_HOLDING_LINE" packages/api/test/integration/` → **empty** |

> **One cheap structural fix.** Four rows above sit at **4−** purely because
> `estimate-phases.test.ts:11` imports `InMemoryAuditRepository`.
> `correction-loop.test.ts:29` shows the fix — import `PgAuditRepository` and
> assert `findByEntity`. That single swap moves four rows to a clean 4.

## §8.8 Bill — the money surface

**13 rows audited. 5 overclaims, 2 underclaims.**

| Capability | Was → **Now** | Acceptance criterion | Confirm |
|---|---|---|---|
| Invoice from a spoken sentence (draft, then issue) | 4 → **5** ✅ | Spoken draft → approve → execute writes a real invoice row with integer-cent totals and exactly one `invoice.created` audit event. | **D:** `draft-invoice-execution.test.ts` `issue-invoice-conversation-resolution.test.ts` |
| Estimate → invoice, billing exactly the accepted selection | 3 → **3** | Conversion proves **linkage and idempotency** at real Postgres; **selection fidelity — the actual claim — is in-memory only.** | **D:** `estimate-phases.test.ts -t "convert"` · **U:** `test/invoices/convert-estimate.test.ts` |
| Auto-invoice on completion (opt-in, still a proposal) | 3 → **4** ✅ | A completed transition stamps `completed_at` **and** runs completion effects, auto-drafting an invoice proposal. | **D:** `update-job-execution.test.ts` |
| Payment links, hosted checkout, embedded elements | 4 → **4 / 3** | CAS-guarded link persist and clear, and a signed `checkout.session.completed` flipping an open invoice to paid, are proven at real Postgres. **Embedded elements are jsdom-only.** | **D:** `payment-credit-guards.test.ts` `invoice-webhook-paid.test.ts` |
| Card-present, ACH lifecycle, saved cards off-session | 4 → **4 / 3 / 2–3** 🚨 | ACH is strong: `processing → succeeded` persists one completed payment + paid invoice + audit chain, `processing → payment_failed` reverses the in-flight credit and reopens, and a duplicate delivery does not double-credit. **Card-present has no Docker-gated test. Off-session charging has none at all** — storage round-trips, nothing proves a charge lands money. This row is a composite averaging one strong leg with two weak ones. | **D:** `ach-webhook.test.ts` `customer-payment-methods.test.ts` · missing: `-t "off-session"` → **zero** tests |
| Partial payments and deposit credits via guarded atomic updates | 4 → **4** | Two concurrent full-balance credits leave `amount_paid_cents === total_cents` exactly once; a $100 cash entry racing a $150 ACH webhook both credit with no lost update; the SQL balance cap rejects a credit that no longer fits. **Five Docker-gated files, nine lost-update/overpay/clamp tests — the best-evidenced row in the money surface.** | **D:** `payment-credit-guards.test.ts` `payment-concurrent-credit.test.ts` `deposit-credit-atomic.test.ts` `deposit-concurrent-credit.test.ts` `payment-reversal-concurrent.test.ts` |
| Void and cancel — deactivating links, cancelling in-flight intents | 4 → **3** 🚨 | Voiding leaves `stripe_payment_link_id`/`_url` NULL on the persisted row and records a `payment_link.deactivated` audit event. **The *consequences* of void are proven at real Postgres (a voided invoice takes no credit; `reconcileBalanceAtomic` never resurrects a void); the deactivation itself is proven only against `MockPaymentLinkProvider` and `InMemoryInvoiceRepository`.** The scenario this row exists to prevent — a customer paying a link for an invoice you already voided — is mocked. | **D:** `payment-credit-guards.test.ts -t "deactivat"` → **zero** tests |
| Refunds as accumulating adjustments, idempotent per provider refund id | 4 → **4** | Two concurrent deliveries of one `stripe_refund_id` increment `amount_refunded_cents` exactly once and leave one claim row; an earlier refund retried after a later one is deduped; a rejected over-refund strands no claim; claims are RLS-invisible cross-tenant; a pre-ledger refund gains a claim on re-run. | **D:** `payment-refunds.test.ts` `record-payment-refund-proposal-flow.test.ts` |
| Dunning: three reminders at 3/7/14 days, idempotent per step key | 5 → **3** 🚨🚨 | Sweeping a 15-day-overdue invoice twice inserts exactly three `invoice_dunning_events` rows with `step_key IN ('3:sms','7:sms','14:sms')`, and a duplicate INSERT of `'7:sms'` raises 23505. **Every cadence test uses `InMemoryDunningEventRepository`. The only real-DB dunning-ledger test keys on `manual:<proposalId>`.** Nothing proves the cadence step key has ever met the real `UNIQUE` constraint. A duplicate sweep double-texting a customer about money is exactly the failure this row claims is closed. **The largest single overclaim in the money surface.** | **S:** `grep -rn "3:sms\|7:sms\|14:sms" packages/api/test/integration/` → **empty** |
| Late fees, capped, idempotent | 3 → **5 / 3** ✅ | Re-executing the same `apply_late_fee` proposal appends no second fee line on a real DB reload, and the voice path appends the fee to the real invoice row plus audit, idempotently. **The cap is unit-only.** | **D:** `late-fee-idempotency.test.ts` `voice-collections-execution.test.ts` |
| Progress/milestone billing with a remainder milestone | 3 → **3** | A 3-milestone schedule splits a non-divisible total with the remainder absorbing every stray cent (Σ milestones === total). Unit only. | **S:** `grep -rln "milestone\|invoice_schedules" packages/api/test/integration/` → **empty** |
| Memberships: auto-renew, member pricing, priority booking, dues | 3 → **3** | Every integration test here proves a **column**, not a **behaviour** — no renewal sweep, no member price applied to a document, no priority in dispatch, no dues charge. Generous at 3; three of four clauses are closer to 2. | **D:** `agreements.test.ts` (storage only) |
| Integer cents end to end | 5 → **4** 🚨 | Over ≥1000 randomized documents every money field is an integer and totals never go negative; `applyBps` is monotonic with 0%→0 and 100%→identity. **Correction to the PRD's supporting claim:** this is **not** a property-based test. Its own header (lines 10-11) reads *"Dependency-free (no fast-check): a seeded PRNG (mulberry32)"* — a 4000-iteration fuzz loop over four pure functions, living in `test/shared/`, **explicitly excluded from Docker**. Real-DB integer-cents proof exists only as hand-picked examples (*"450 dollars" persists as 45000, not 450*). And `money-reconciliation.test.ts:307` **expects rounding mismatches in real data** and downgrades them to informational — "end to end" is not clean. | **U:** `billing-engine.property.test.ts` · **D:** `draft-invoice-execution.test.ts` |

## §8.9 Close

**11 rows audited. 2 overclaims, 3 underclaims.**

| Capability | Was → **Now** | Acceptance criterion | Confirm |
|---|---|---|---|
| Thank-you SMS +2 h after completion, stamped | 4 → **4** | Two concurrent sweeps over one eligible job send exactly once and write one `notification.thank_you_sms.sent` audit row; a "sent" claim with a NULL stamp is reconciled rather than resent. | **D:** `thank-you-sms-worker.test.ts` |
| Review request +24 h, default on | 4 → **4−** | `send_review_request` defaults TRUE at the column level (migration 214) and a double sweep enqueues one `feedback_send`. No audit assertion. | **D:** `review-request-sweep.test.ts` |
| Review gating: 4★+ public, below kept private | 5 → **3** 🚨🚨 | `POST /public/feedback/:token` with `rating: 3` persists the response and returns **no** review links; with `5` it returns the configured link. Proven only by a mocked-repo route test. **This is the row that decides whether a 2★ experience becomes a public Google review, and it has no real-DB proof.** | **S:** `grep -rln "reviewLinks\|rating >= 4" packages/api/test/integration/` → **empty** |
| Google review monitoring, classified, drafted responses | 3 → **4 / 3** ✅ | Monitoring is strong: a sweep persists new reviews and advances the per-tenant cursor, a re-sweep persists nothing new, a 429 stamps `backoff_until` and the 429 counter, and reviews are RLS-invisible cross-tenant. **Classification and drafting are unit-only.** | **D:** `google-reviews-worker.test.ts` |
| **Service credits by tier, capped per customer per 12 months** | 3 → **3** | With $80 issued in the trailing 12 months and a $50 tier proposed, `sumIssuedInLast12Months` returns 8000 and the proposal is **omitted, not zeroed**. The existing test calls itself a *"smoke test — exercises the query string + row mapping by stubbing `pool.connect()`"* — a mocked pool, textbook rung 3. | **S:** `grep -rln "service_credits" packages/api/test/integration/` → **empty** |
| End-of-day digest, tenant-local, with "what I wasn't sure about" and "what I learned" | 3 → **4 (unlit-able)** | The write is proven: a due tenant gets a `daily_digests` row with the dispatch claimed, a second sweep neither duplicates nor re-sends, and **both named sections compose from the real DB**. The criterion that fails is reachability: *a tenant owner can enable the digest without a database write.* | **D:** `daily-digest-worker.test.ts` `digest-reflection.test.ts` · **S:** `grep -rn "digestEnabled" packages/api/src/routes packages/web/src` → **empty** |
| Weekly owner summary including a repeat-correction rate | 3 → **4** ✅ | The snapshot joins the real correction repository and reports total/repeats/rate, omitting the field at zero; the send ledger is idempotent on re-sweep and a failing send leaves **no** ledger row so the week retries. | **D:** `weekly-feedback-builder.test.ts` `hfcr-weekly-send-worker.test.ts` |
| Correction loop: lessons forward, digest-reported, reversible | 5 → **5** | One real-Postgres test proves all three clauses: a labor-rate lesson changes the next same-day draft, appears in `findAppliedForDay`, and `undoCorrectionLesson` restores the prior price — with `PgAuditRepository` asserting both `correction_lesson.applied` and `.reverted` on disk, and FORCE RLS isolating lessons across tenants. **The best-evidenced row in the three lifecycle sections.** | **D:** `correction-loop.test.ts` |
| Repeated corrections mint an owner-reviewed fix proposal | 4 → **4** | The third same-target correction mints a meta-proposal that, once approved, updates the real catalog through the **production registry and executor**. | **D:** `correction-repetition-meta-proposal.test.ts` `corrections.test.ts` |
| QuickBooks one-way sync | 3 → **4** ✅ | A second sweep over already-synced paid invoices issues zero QuickBooks calls and writes zero new `sync_log` rows; pagination syncs every paid invoice, not just one page; `sync_log` is RLS-isolated. Rung 5 is blocked on a live OAuth connection, not on code. | **D:** `accounting-sync.test.ts` |
| Unified comms inbox with AI-suggested replies | 5 → **4 / 3** 🚨 | The inbox and its guarded send are proven at real Postgres — including that a reply to a DNC number writes **no** dispatch row, which is the "never auto-sent" half. **The AI-suggestion leg has no integration test at all.** | **D:** `conversation-inbox.test.ts` `conversation-reply-send.test.ts` · **S:** `grep -rn "suggest-reply" packages/api/test/integration/` → **empty** |

---

## A.5 The fourteen founding commitments

From `docs/strategy/day-in-the-life.md:190-243` — *"What this forces on the
product."* These are the oldest statements of intent in the repository, and the
question they answer is not "is it built" but **"is it still true."**

**6 kept and proven · 3 kept but dark · 2 partial · 2 kept but unproven · 1 not kept.**

| # | Commitment | Verdict | Acceptance criterion | Confirm |
|---|---|---|---|---|
| 1 | Voice directs, SMS approves (D-030) | **KEPT-AND-PROVEN** | A spoken instruction produces a persisted proposal, that proposal renders an owner SMS with a one-tap link, and a `Y` reply approves through the same `approveProposal` path as a dashboard click — **with no web session involved**. Proven in three abutting segments; no single test spans the whole arc. | **U:** `operator-voice-golden-path.test.ts` `voice-action-router-unsupervised-sms.test.ts` `proposals/sms/reply-handler.test.ts` |
| 2 | End-of-day digest is the dashboard | **KEPT-BUT-DARK** | A tenant created through normal onboarding — no SQL, no raw API call — receives a digest at its configured local time, and an owner can toggle it from a shipped UI. `digest_enabled` defaults **false**; the field is in the update contract but **no web or mobile code writes it**. The "Weekly digest" toggle in `TemplatesPage.tsx:913` is unwired local state for a different feature. | **S:** `grep -rn "digestEnabled\|digest_enabled" packages/web/src packages/mobile/src` → **empty** |
| 3 | One-tap approvals with dictation edits | **PARTIAL** | After replying `EDIT`, an owner can deliver the change **by voice** and the delta applies to the same proposal. One-tap and the 10-minute text edit session are proven; dictation is proven only on the in-app surfaces. **The SMS edit session accepts text only** — no path carries dictated audio into an open session. | **U:** `reply-handler.test.ts` `voice/estimate-edit-flow.test.ts` · **W:** `useVoiceCommands.test.ts` |
| 4 | Confidence surfaced, not hidden | **KEPT-AND-PROVEN** | A low/medium marker renders a visible `(?)`/`Check:` line in the owner SMS, is **denied a one-tap link** at low confidence, and appears in the digest's "what I wasn't sure about." High confidence is byte-identical to absent metadata. (The digest half inherits #2's darkness.) | **U:** `proposals/sms/render.test.ts` `ai/guardrails-confidence.test.ts` `digest/digest-service.test.ts` |
| 5 | **A second classifier reviews every booking and quote** | **NOT-KEPT** | See A.7. The gate has **two call sites**, both in one file; one is conditional on `ready_for_review`, so **low-confidence quotes are excluded**; the default mode is `shadow`, where `hold` is always false; and `pricing_anomaly` is **not** in `CUSTOMER_HARM_CHECKS`, so a pricing anomaly on a quote **can never hold in any mode**. | **S:** `grep -rn "getSupervisorReviewGate()" packages/api/src` → **2 call sites** |
| 6 | Emergency intent overrides automation | **KEPT-AND-PROVEN** | An E1/E2 utterance with a vulnerability signal, on a tenant configured with nothing but an owner phone, dials the owner's cell within the same turn; if unanswered for 60 s it produces a high-priority booking plus an owner SMS, never a normal booking. The tier classifier works with **no rules loaded**. Open item: `E1_SCRIPT_REVIEW_REQUIRED` is still `true`. | **U:** `emergency-tier.test.ts` `triage-decision.test.ts` `voice/triage/` `emergency-immediate-dial.test.ts` `gather-vulnerability-triage.test.ts` |
| 7 | Never discounts or promises scope changes | **KEPT-AND-PROVEN** | On an unconfigured tenant every price-pressure utterance produces a capture-class, low-confidence owner callback carrying a recommendation — never a committed price — **and no registered proposal type can express an AI-applied discount.** That second clause is a type-level impossibility proof, not a behaviour sample. **The strongest of the fourteen.** | **U:** `negotiation-invariant.test.ts` `discount-evaluator.test.ts` `settings/discount-policy.test.ts` |
| 8 | Dropped calls trigger SMS recovery | **KEPT-BUT-DARK** | A normally-provisioned tenant receives a recovery SMS 60 s after a dropped inbound call. The pipeline is proven at real Postgres **including the flag-on transition** — but `setTenantFlag` has **zero production callers**, no route writes `tenant_feature_flags`, and no web UI references the admin endpoint. Rows are scheduled, then expire unsent. | **S:** `grep -rn "setTenantFlag" packages/api/src packages/web/src` → **definition only** |
| 9 | B2B account recognition is first-class | **KEPT-BUT-DARK** | Two identical calls — one from a `property_manager`, one residential — produce **observably different** outcomes. The context is assembled onto the session and read by one supervisor check; **`buildAccountContextPromptSection` has zero production callers** and nothing routes on `ctx.priority`. Recognition is implemented and tested; *routed differently* is not implemented. | **S:** `grep -rn "buildAccountContextPromptSection" packages/api/src` → **definition only** |
| 10 | Vertical packs genuinely differ | **KEPT-BUT-UNPROVEN** | For every pair of shipped packs, the `sttKeywords`, terminology key sets, `repairTemplates` and SKU sets are pairwise non-identical. **They genuinely differ** — 12 vs 12 fully disjoint STT keywords, disjoint terminology, plumbing-only `minor_issue` objection, different rates *and* different SKUs. **But only pricing has a cross-pack test.** A refactor collapsing `sttKeywords` to a shared list would keep the suite green. | **U:** `test/verticals/` `test/packs/seed-pack-defaults.test.ts` |
| 11 | Google review monitoring with draft-response approval | **KEPT-AND-PROVEN** | A new review on a connected tenant produces a draft `review_response_proposal` with PII redacted **on input and output**, approvable from the inbox, never duplicated on re-sweep. Reachable — no feature flag; the OAuth connect flow has a shipped settings UI. | **U:** `workers/google-reviews.test.ts` `test/reputation/` · **W:** `InboxPage.reviewResponse.test.tsx` · **E:** `e2e/review-response-approval-mobile.spec.ts` |
| 12 | Brand voice configurable, then locked | **PARTIAL** | *(a)* A default tenant can configure brand voice from a shipped web UI without platform-admin action — **false**, `brand_voice_configurator` is seeded `enabled: false`. The **spoken** path is unflagged and works. *(b)* `BRAND_VOICE_INTENTS` covers every customer-facing generated-text surface — **false**, it is exactly five, and **the live voice agent's spoken utterances do not read brand voice at all**. The commitment names calls, texts, invoices, follow-ups and review responses; two of five are covered. The **lock itself is real and well proven**: first write sets `brand_voice_locked`, then every edit is cool-down gated under `FOR UPDATE`, and a spoken *"lock my brand voice"* can never set it. | **S:** `grep -rn "brandVoice" packages/api/src/telephony/twilio-adapter.ts` → **empty** |
| 13 | Every AI mistake is a learning event | **KEPT-AND-PROVEN** | An owner edit, once executed, writes a `correction_lessons` row, **changes the corresponding config so the next same-day draft reflects it**, emits `correction_lesson.applied`, and is fully reversible — restoring the prior value exactly and emitting `.reverted` **exactly once**, idempotently. Proven in-memory *and* against real Postgres with RLS. | **U:** `test/learning/` · **D:** `correction-loop.test.ts` `correction-lesson-on-execution.test.ts` |
| 14 | No feature ships that adds admin work | **KEPT-BUT-UNPROVEN** | Unfalsifiable as stated — see A.6. | — |

> **Correction to D-030.** D-030 named four dark commitments (digest,
> brand-voice configurator, dropped-call recovery, B2B). All four are confirmed.
> But **#5 is a fifth and more serious finding**, and D-030's remediation
> framing — *"a launch checklist, not an architecture change"* — does not hold
> for it.

---

## A.6 Making I18 / commitment #14 falsifiable

*"No feature ships that adds admin work to the owner's day"* is the product's
founding promise and the only invariant with **no enforcement of any kind**. It
does not belong in the I1–I17 table unmarked.

Three mechanisms could operationalize it, in ascending cost. All three already
have working precedent in this repo.

**(a) A pinned inventory of owner-required daily actions.** The repo does this
exact thing twice: `voice-action-catalog.contract.test.ts:75` pins
`docs/reference/voice-action-catalog.md` to `INTENT_TO_PROPOSAL_TYPE` — its own
comment explains why: *"`docs/remaining-features.md` rotted because it was prose
with no test behind it."* And `route-manifest.test.ts` snapshots every mount with
its exposure class.

Apply the same shape: a machine-readable `docs/reference/owner-daily-actions.md`
listing every action an owner **must** perform in a web or mobile session on a
normal day, each tagged `sms_reachable: true|false`. A contract test derives the
same set from code — every `role: owner` route not also reachable via an SMS
keyword handler, a one-tap token action, or a voice intent — and fails on
divergence. Adding an owner-only, non-SMS-reachable daily surface then **breaks
the build** and forces either an on-ramp or a reviewed exemption.

**(b) A budget assertion on the count.** `expect(ownerRequiredDailyWebActions).toHaveLength(N)`.
Cheap, mechanical, and a PR incrementing `N` is self-documenting in review.

**(c) An e2e "SMS-only day."** Drive a full simulated day — inbound call, quote,
approval, payment, review response — entirely through the SMS/webhook surface
with **zero authenticated web requests**. Any feature adding a mandatory web step
fails it. Most faithful to the intent; most expensive to maintain.

**Acceptance criterion, once (a) exists:** *the set of owner-role actions
required on a normal operating day and NOT reachable via SMS, one-tap or voice
is empty — or is exactly the reviewed exemption set.*

---

## A.7 The finding that changes a decision, not just a number

Everything above is bookkeeping except this.

**Commitment #5 — *"a second classifier reviews every booking and quote"* — is
not dark. It is structurally incomplete, and three independent limits stack.**

```
grep -rn "getSupervisorReviewGate()" packages/api/src
  → ai/supervisor/review-gate.ts:53      (the definition)
  → workers/voice-action-router.ts:2098  (chain head, unconditional)
  → workers/voice-action-router.ts:2490  (single action, IF status === 'ready_for_review')
```

**1. Two call sites, both in one file.** There are **93 `createProposal(` call
sites across 44 files**. Quotes minted by MMS photo intake
(`customer-mms-intake.ts:317`), by chat (`routes/assistant.ts` — zero references
to the gate), by REST (`routes/estimates.ts:41`), by redraft, and by
autonomous-close are **never reviewed**.

**2. The conditional site excludes the proposals that most need review.** A
low-confidence quote lands in `draft`, not `ready_for_review` — so it is skipped
precisely because the drafting agent was unsure.

**3. Neither mode can hold a pricing anomaly.**

```
types.ts:43   DEFAULT_SUPERVISOR_REVIEW_MODE = 'shadow'
types.ts:25   CUSTOMER_HARM_CHECKS = ['missed_urgency', 'account_routing']
reviewer.ts:237  const hold = mode === 'enforce' && harmCritical;
```

In `shadow` nothing holds, ever. And because `pricing_anomaly` is not a
customer-harm check, **a pricing anomaly on a quote cannot hold even in
`enforce`** — the exact clause the commitment names.

**Do not confuse the two supervisors.** `proposals/supervisor/hook.ts` *does* run
on every `createProposal` and is default-ON via an opt-out flag — but it is an
autonomy-budget policy engine. It does not check urgency or pricing. Only
`ai/supervisor/review-gate.ts` is the "second classifier," and that is the one
with two callers.

**Acceptance criterion:** *for every `draft_estimate` / `create_appointment` /
`create_booking` reaching an owner-facing dispatch — regardless of origin channel
and regardless of status — exactly one `supervisor_reviews` row exists before the
owner is notified.* Today: **false, by roughly 91 of 93 origins.**

The missing proof is one test —
`test/ai/supervisor/review-coverage.test.ts`, *"every owner-dispatch chokepoint
consults the supervisor review gate"* — asserting one row per notified
booking/quote across all six origins. It would fail today, which is the point.

---

## A.8 Scorecard

| Section | Rows | Overclaimed | Underclaimed | Confirmed |
|---|---|---|---|---|
| Invariants I1–I18 | 18 (+5 sub-clauses) | 5 sub-clauses unproven, 1 invariant unenforced | — | 11 at PROVEN-REAL-DB or STRUCTURAL |
| §8.1 Setup | 10 | 1 (pack → 4−) | 2 | 7 |
| §8.2 Capture | 12 | 5 | 2 | 5 |
| §8.3 Book | 12 | 4 | 1 | 7 |
| §8.4 Dispatch | 10 | 3 | — | 7 |
| §8.5 Execute | 5 | 1 | 1 | 3 |
| §8.6 Narrate | 9 | — | 3 | 6 |
| §8.7 Quote | 12 | 7 | 2 | 3 |
| §8.8 Bill | 13 | 5 | 2 | 6 |
| §8.9 Close | 11 | 2 | 3 | 6 |
| Founding commitments | 14 | 1 not kept, 3 dark, 2 partial, 2 unproven | — | 6 |

**Net: the PRD overclaimed 28 rows and underclaimed 16.** The overclaims
concentrate in exactly one place — **§8.7 Quote, where 7 of 12 rows were
overstated** — and that is the surface where a wrong number becomes a price a
customer is bound to.

**The corrected picture is not worse, it is differently shaped.** Several things
the PRD undersold are genuinely excellent: MMS-to-quote, estimate nudges, voice
invoicing, the correction loop, QuickBooks sync, and voice book/move/cancel are
all stronger than claimed. What the PRD oversold is concentrated in quoting,
collections cadence, and review gating.

### The five strongest things in the product

Ranked by evidence, not by ambition:

1. **RLS isolation (I11)** — every `tenant_id` table proven enabled-and-forced
   at runtime, exemptions pinned to exactly two, boot refusal proven.
2. **Double-booking exclusion (§8.3)** — a real concurrent race against a real
   `EXCLUDE` constraint.
3. **Payment concurrency (§8.8)** — five Docker-gated files, nine
   lost-update/overpay/clamp tests.
4. **The correction loop (§8.9)** — apply, cascade, report and undo, all proven
   on real Postgres with audit rows on both ends.
5. **The negotiation guardrail (I7/#7)** — a type-level impossibility proof.

**The PRD called emergency detection "the strongest thing in the product." That
is the inverse of true** — it is unit-tested only, with no Docker-gated proof and
a self-declared placeholder script. It is the single largest overclaim in the
document.

### The eight tests that would close the most ground

In the order they should be written:

1. `test/ai/supervisor/review-coverage.test.ts` — the A.7 finding. Highest value;
   it is the only one that changes an architecture decision rather than a score.
2. Dunning cadence at real Postgres — `'3:sms' | '7:sms' | '14:sms'` against the
   real `UNIQUE` index. Closes the largest money overclaim.
3. Review gating at real Postgres — a 3★ returns no links, a 5★ does.
4. Swap `InMemoryAuditRepository` → `PgAuditRepository` in
   `estimate-phases.test.ts`. **One import; moves four rows from 4− to 4.**
5. Stale-revision guard at real Postgres — `expectedVersion` 1 vs 2.
6. Emergency classification at real Postgres, with its audit event.
7. Void → link deactivation + intent cancellation at real Postgres.
8. Uncatalogued line → confidence capped below the auto-approve floor, on disk.

### The four things that are built and cannot be turned on

Not "dark by default" — **unlit-able**. No product surface can enable them.

| Capability | Blocker |
|---|---|
| Dropped-call SMS recovery | `setTenantFlag` has zero production callers |
| Voice vulnerability triage | same flag mechanism |
| End-of-day digest | `digest_enabled` has no route and no UI writer |
| Technician assignment notification | `setTechnicianAssignmentNotifier` has zero callers; every assignment fires a silent no-op |

Each needs a write path, not a feature. Together they are a day of work and they
light four of the product's most-cited capabilities.

---

## A.9 How to keep this document from rotting

This register has the same failure mode as every document it replaces: it is
prose, and prose drifts. Two defences:

1. **Every row carries its command.** A claim you cannot run is a claim you
   should not trust — including the claims above.
2. **The `S:` falsifiers are the load-bearing ones.** They are single shell
   commands whose *output is the verdict*. When one of them starts returning
   something different, the row is stale. They are cheap enough to run as a
   batch; the natural next step is a script that runs all of them and diffs
   against the expectations recorded here — the same trick
   `voice-action-catalog.contract.test.ts` plays on the capability catalog.

Until that script exists, this document is a snapshot with a decay rate, not a
standing truth. It was accurate on 2026-09-11.
