# ServiceOS — Feature & Workflow Audit (2026-06-15)

Complete audit of the **working** features/workflows in the canonical product
(`/packages`, the Railway deploy target), with every workflow mapped back to the
**12 Jobs-To-Be-Done** from prior sessions. Experiments under `/experiments`,
`/rewrite`, `/service-os-app`, `/service-os-agent`, `/infra` are out of scope.

## Method & confidence

This audit verifies **actual wiring**, not doc claims — `CLAUDE.md` warns this
repo has shipped "built-but-never-wired" modules and mocked-DB tests that hid
broken queries. Six parallel investigations traced each subsystem from the
composition root (`packages/api/src/app.ts`, ~4,475 lines) to a real
request/scheduled path and confirmed tests. Status legend:

- ✅ **WORKING** — wired into a real path + tested (incl. integration where DB-touching)
- 🟡 **PARTIAL** — wired but with a material gap, or fully built yet off-by-default
- 🔩 **BUILT-NOT-WIRED** — code + tests exist, but nothing calls it in `app.ts`
- 🧪 **STUB** — placeholder only
- ❌ **MISSING** — not built

**The master gate:** the entire AI pipeline is a no-op mock returning
`{"intentType":"unknown"}` unless `AI_PROVIDER_API_KEY` is set (`app.ts:1034-1036`).
All integrations are real but **off-by-default** by credential presence. So "working"
below means "wired and correct when keys are present" — production behavior is
env-key-gated by design.

---

## JTBD scorecard (current state vs. the 2026-06-11 coverage map)

| # | JTBD | Prior claim | Audited verdict | Δ |
|---|------|-------------|-----------------|---|
| 1 | Intake & Booking | Strong | ✅ **Strong** (56 intents, 12-state FSM, both channels, dropped-call recovery) | = |
| 2 | Estimating | Strong + catalog-grounded | ✅ **Strong backend**, 🟡 confidence/ambiguity not surfaced in UI | ~ |
| 3 | Scheduling | Strong | ✅ **Strong**; gaps: no hold reaper, no ETA mutation | = |
| 4 | Job Execution | Partial | 🟡 **Partial** (photos ✅; checklists ❌; notes→invoice ❌) | = |
| 5 | Invoicing & Payments | Strong + catalog-grounded | ✅ **Strong** (end-to-end, integration-tested) | = |
| 6 | Customer Mgmt | Good | ✅ **Good/Strong** (B2B routing genuinely wired into voice) | ↑ |
| 7 | Admin Reduction | Weakest high-value | ✅ **Now working** (P2-034 SMS one-tap shipped, digest live) | ↑↑ |
| 8 | Accounting | Partial (CSV) | 🟡 **Partial** — but QuickBooks is *fully built*, off-by-default | ↑ |
| 9 | Marketing & Reviews | Good | ✅ **Good** (Google review monitoring + 3-part drafts wired) | = |
| 10 | Reporting | Good | ✅ **Good** (reports router + 16 voice lookups + digest) | = |
| 11 | Emergencies | Good | 🟡 **Partial** — fast-path ✅, but vulnerability/weather triage largely aspirational | ↓ |
| 12 | Field Tech | Improved | 🟡 **Partial** — mobile ✅, "I'm out" 🔩 not wired, on-device voice ❌ | ~ |

**Headline:** The money spine (proposals → estimates → invoices → Stripe →
billing engine → catalog grounding) and the admin-reduction surface (SMS one-tap
approval + digest) are genuinely production-grade and integration-tested. The
softest areas are **#11 Emergencies** (the trust differentiator's vulnerability/
weather triage is mostly dead code or hardcoded-off) and **#4/#12 field
execution** (checklists, notes→invoice, "I'm out", on-device voice).

---

## Cross-cutting foundation (everything routes through these)

| Subsystem | Status | Evidence |
|---|---|---|
| **Proposal/approval/audit engine** | ✅ | 39-value `ProposalType` (drift-guarded, `shared/src/enums.ts:163`); approve/reject/undo (`proposals/actions.ts:134/346/400`) with RBAC; 5s undo window (`lifecycle.ts:40`); audit on every mutation |
| **"Never auto-execute"** | ✅ | Two layers: `actionClassForProposalType` (`proposals/proposal.ts:233-345`) hard-blocks all money/comms/irreversible types from auto-approval regardless of confidence; auto-approved still waits out the 5s undo window before the worker runs |
| **Execution worker** | ✅ | ~35 handlers in a dispatch `Map` (`execution/handlers.ts:699`), 1-sec leader-locked `setInterval`, boot guard `assertVoiceHandlersWired` crashes boot if a persist-critical handler is degraded while a pool exists (`app.ts:1467`) |
| **Billing engine** | ✅ | `shared/billing-engine.ts` — single integer-cents path, basis-points tax, one rounding point; imported by *both* estimate + invoice (no competing impl); unit + integration tested |
| **Catalog price grounding** | ✅ | `ai/resolution/catalog-resolver.ts` grounds LLM line prices; uncatalogued → confidence capped at **0.85 < 0.9 auto-approve floor**; integration-pinned (`mms-to-quote.int.test.ts`) |
| **Entity resolver** | ✅ | `PgEntityResolver` (only impl — no `NullEntityResolver`); resolves customer/job/invoice/appointment; ambiguity → `voice_clarification`, never a silent guess. **The `CLAUDE.md` mocked-pool column bug is closed** for customer/job via `test/integration/entity-resolution.test.ts` |
| **LLM gateway** | ✅ (gated) | `createLLMGateway` with breaker/retry/failover/cache/quota, heavily tested; **real only with `AI_PROVIDER_API_KEY`, else mock**. OpenAI-compatible provider only (Anthropic reachable via `AI_PROVIDER_BASE_URL`); failover list is single-element today |
| **Correction loop** | 🟡 SPLIT | RAG half ✅ wired+tested (`proposal-correction-worker` diffs drafted-vs-executed → embedded chunks, gated on embeddings key). Structured-lesson half (`correction_lessons` table mig. 185, `recordCorrectionLessons`/`PgCorrectionLessonRepository`) is **🔩 BUILT-NOT-WIRED** — fully integration-tested but **no production caller**, so the digest "what I learned" only ever fires its chunk-count *fallback* |
| **Integrations** | ✅ (off-by-default) | Twilio (HMAC sig), Vapi (HMAC, 503 without secret), Stripe (sig + idempotency), SendGrid (EC sig), ElevenLabs, Google (OAuth). **Xero = 🧪 stub** |
| **Webhook base / async workers** | ✅ | `webhook_events` `(source, idempotency_key)` dedup; 15+ sweeps via `registerInterval` + `runAsLeader`; reaction jobs via `workerRegistry` |

---

## JTBD deep dives

### #1 — Intake & Booking ✅ Strong
*"AI answers your phone, books your jobs."*

- **Intent classification** ✅ — 56 intents (55 + `unknown`), LLM-gateway-backed with deterministic regex guardrails + a 0.6 confidence floor → `unknown` (`intent-classifier.ts`). `INTENT_TO_PROPOSAL_TYPE` maps 31 intents to proposals.
- **Calling-agent FSM** ✅ — 12 states (`idle → greeting → identifying → intent_capture → entity_resolution → intent_confirm → proposal_draft → closing`, plus `escalating/degraded/terminated`), a pure reducer (`transitions.ts`) driven by **both** the telephony voice-turn processor *and* the in-app adapter. Global guards fast-path emergency/abuse/hangup/operator-request.
- **Both channels live** ✅ — telephony (`TwilioGatherAdapter` + a Media Streams server) and in-app (`/api/voice/sessions`). Caller-ID identification pre-loads recent job + open invoice.
- **Dropped-call SMS recovery** ✅ — `DroppedCallScheduler` wired into *both* adapters; snapshots FSM context and resumes via SMS. Fully tested.
- **Caveats:** streaming STT (Deepgram, ~300 ms) is gated behind `TWILIO_MEDIA_STREAMS_ENABLED` + key — default path is `<Gather>` (higher latency). Whole pipeline inert without `AI_PROVIDER_API_KEY`.

### #2 — Estimating ✅ Strong backend / 🟡 UI surfacing gap
*"Sends your estimates," with confidence shown where it matters.*

- **AI estimate drafting** ✅ — `estimate-task.ts` drafts line items, grounded against the tenant catalog; uncatalogued lines capped below auto-approve.
- **Workflow** ✅ — `draft → ready_for_review → sent → accepted/rejected/expired`; `sendEstimate` auto-transitions to `sent`. Public approval `/e/:token` with version guard, signature/IP/UA capture, and `before/after_approval` Stripe deposit checkout.
- **🟡 The gap is UI, not backend:** the `pricingSource: 'catalog'|'ambiguous'|'uncatalogued'|'manual'` enum exists in the shared contract (`shared/src/contracts/money.ts:43`) but is **rendered nowhere in web** — the "what I wasn't sure about" markers (P2-035) aren't surfaced; approval cards show only a coarse High/Med/Low bar.
- **🟡 Ambiguity picker MISSING** — no entity/catalog disambiguation component; operators edit fields manually (matches open backlog item).
- **🟡 `estimate` entity-kind not resolved** by the entity resolver (no trigram index) — voice references to estimates by free text won't resolve.

### #3 — Scheduling ✅ Strong
*"Books your jobs," with conflict-aware holds.*

- **Conflict checker + feasibility** ✅ — overlap/availability/travel-time/skill-match, DB-backed, wired into the voice action router; emits `voice_clarification` on conflict.
- **Booking holds** ✅ — migration 094 (`hold_pending_approval` + `hold_expiry_at` + partial index); dual-confirmation ritual (hold → `create_booking` approval), release-on-reject, read-time expiry filtering.
- **Reminders + late-arrival** ✅ — T-24h reminder worker (hourly, leader-gated, idempotent); `DelayNotificationCoordinator` texts the tech's *next* same-day customer ("running 20 min late").
- **❌ No held-slot reaper** — expired holds rot as `scheduled` rows with `holdPendingApproval=true` forever; only lazily skipped on read. Would pollute any raw appointment list/report.
- **🟡 "Voice ETA update" doesn't mutate the appointment** — the delay path notifies the next customer but never writes `arrivalWindowStart/End`.
- **🟡 Conflict-checker query is mock-tested only** — the exact `CLAUDE.md`-flagged risk (lower-stakes; indirectly covered by the emergency-hold integration test).

### #4 — Job Execution 🟡 Partial
*"You learned the trade" — the field-work record.*

- **Job lifecycle** ✅ — 5-state FSM (`new → scheduled → in_progress → completed/canceled`) with a timeline repo.
- **MMS/photo capture** ✅ — inbound-MMS-from-tech webhook seam enqueues → async worker (identity gate → active job → media fetch → attach), failure-isolated.
- **Auto-invoice on completion** ✅ — raises a `draft_invoice` proposal on job completion, sourced from the accepted estimate or logged time entries.
- **🟡 Tech notes → invoice lines** — NOT implemented; the "notes→invoice" framing has no extraction path.
- **❌ Voice checklists** — no checklist code exists anywhere.

### #5 — Invoicing & Payments ✅ Strong (end-to-end)
*"Chases your invoices," collects the money.*

- **Invoice state machine** ✅ — `draft → open → partially_paid → paid → void/canceled`, with reversal paths for NSF/chargebacks. `issueInvoice()` stamps `issuedAt` + tenant-tz `dueDate` from payment terms.
- **Open question resolved in code:** `send_invoice` is comms-only and does **not** auto-transition draft→open — issuing is a separate `issue_invoice` proposal (deliberately asymmetric with estimates). Documented only via inline comment (`routes/invoices.ts:494-498`).
- **Public payment `/pay/:token`** ✅ — real Stripe `<Elements>`/`<PaymentElement>`; payment links gated to open/partially_paid; deposit-credit auto-applied on estimate→invoice conversion.
- **Stripe webhook** ✅ — 11 event types, raw-body signature verification (timing-safe, 5-min tolerance), idempotent via `webhook_events`; `checkout.session.completed` → `recordPayment` with overpayment capping; full ACH `payment_intent.*` settlement lifecycle.
- **Deposits** ✅ — `evaluateDepositRule` capped at total, webhook credit capped at `depositRequiredCents`, mirrored by a DB CHECK constraint.

### #6 — Customer Mgmt ✅ Good/Strong
*"Built for the shop" — accounts, not just contacts.*

- **`account_type`** ✅ — residential/b2b/property_manager (migration 183), parent-account hierarchy with cycle detection.
- **B2B/property-manager recognition (Jenna's "Greenfield" moment)** ✅ — genuinely **wired into voice**: caller-ID → `assembleB2bAccountContext` (loads parent + sub-accounts) → session PRIORITY flag → triage + vulnerability detector + prompt assembly.
- **AI-drafted SMS replies** ✅ — brand-voiced, draft-only (never auto-send), via `/api/conversations/:id/suggest-reply`.
- **Customer feedback** ✅ — full pipeline (request → consent/DNC-gated send worker → public submit → audit).

### #7 — Admin Reduction ✅ Now working (was "weakest")
*"You approve what matters in 30 seconds a day."*

- **SMS one-tap approval transport (P2-034)** ✅ — inbound Twilio SMS → `dispatchInboundSms` → `registerProposalReplySms`; `Y/YES/OK`=approve, `N reason`=reject, `EDIT`=10-min LLM edit session; idempotent on `MessageSid` *before* dispatch; fails closed for money/comms/low-confidence (link-only). Migration `156_proposal_sms_events`.
- **End-of-day digest** ✅ — `runDailyDigestSweep` (15-min leader-locked, fires on tenant-local `digest_time`); "what I wasn't sure about" = top-3 pending proposals + overdue/unbilled flags; one-tap HMAC approve links. (Caveat: the "things I learned" line falls back to RAG chunk-counts — the structured correction-lessons table is never populated; see dead-code list.)
- **Approval inbox (web)** ✅ — proposal cards, one-tap approve/reject, chain batch-approve.
- **🟡 Digest→SMS uses P2-029 HMAC links, not the P2-034 reply transport** — replying "Y" to a digest doesn't approve through the reply path (backlog item 6 only partially done).
- **⚠ Two parallel digest workers** (`runDailyDigestSweep` RV-061 + `runDigestSweep` P5-020) are *both* scheduled, writing different tables — a duplicate-SMS hazard / dead-code-not-removed.
- **🟡 P2-035 confidence markers** not surfaced in the inbox UI (see #2).

### #8 — Accounting 🟡 Partial (QuickBooks built, off-by-default)
*"We surface hours; QuickBooks pays."*

- **CSV / tax export** ✅ — RFC-4180 + formula-injection hardening, route + integration tested.
- **🟡 QuickBooks — CONTRADICTS the docs.** Not "deferred/not built": a *complete* QBO OAuth + API client (createCustomer/createSalesReceipt, retry/backoff) + sync service (paid invoices → SalesReceipts, idempotent via `accounting_sync_log`) + tests exist. The 5-min sweep auto-schedules whenever `QUICKBOOKS_CLIENT_ID/SECRET` are set (`app.ts:4033`). The deferral is operational (credentials/rollout), not a code gap.
- **🧪 Xero** is a stub.

### #9 — Marketing & Reviews ✅ Good
*"Reputation monitoring is core" — shipped from day one.*

- **Google review monitoring** ✅ — 15-min sweep, real OAuth, idempotent persistence with 429 backoff; on a new review, drafts a `review_response_proposal` with all three parts: public response (always), private apology (when customer matched), capped service credit — each independently approvable.
- Outbound marketing campaigns remain "Later (post-PMF)" per scope; review monitoring is the shipped core, matching strategy.

### #10 — Reporting ✅ Good
*"The end-of-day digest is the dashboard."*

- **Reports router** ✅ — `/api/reports`: revenue-by-source, money-dashboard, time-given-back, HFCR, tax-export, job-profit; web `MoneyDashboardPage`/`RevenueBySourcePage`.
- **16 voice lookup skills** ✅ — ("what did we quote the Patel job") intent-classified, entity-resolved, recorded to `lookup_events`.
- **Digest as dashboard** ✅ — the pricing artifact (see #7), no real-time charts required.

### #11 — Emergencies 🟡 Partial (fast-path ✅, triage aspirational)
*"Emergency intent overrides automation" — the trust differentiator.*

- **Emergency fast-path** ✅ — rule-based regex detector (gas/CO/fire/flood/electrical + no-heat-at-risk) runs **before any LLM** on the live path; the FSM fast-paths `emergency_dispatch` past entity-resolution/confirm to `escalating`.
- **`emergency_dispatch` handler** 🟡 — creates an urgent job, places a tentative 2h appointment hold on the soonest feasible slot (integration-tested), and pages — **but pages the OWNER (`ownerPhone ?? transferNumber`), not the on-call rotation**; on-call paging is a *separate* live-call `patchOwnerThrough` ladder.
- **🟡 Vulnerability-aware triage is largely aspirational:**
  - The wired triage uses an **LLM grader** (`vulnerability-grader.ts`) that runs **streaming-only** (Media Streams adapter); `<Gather>`-mode calls are silently not graded.
  - The entire rule-based `ai/vulnerability/` detector subsystem (age/medical/property/**weather**) is **DEAD CODE** — zero production call sites (yet still has passing tests).
  - **Weather-aware triage is OFF everywhere** — the wired path hardcodes `weatherUnavailable: true`; no real weather provider exists in `src`.

### #12 — Field Tech 🟡 Partial
*"Would Mike, in the attic, gloves on, find this useful in 5 seconds?"*

- **Mobile approval** ✅ — `EstimateApprovalPage` with ≥44px (`min-h-11`) targets, no 320px overflow; pinned by a jsdom class-contract test + Playwright viewport test.
- **Tech job view / clock-in-out / photo uploader** ✅ — wired in web; inbound MMS photos ingested (see #4).
- **🔩 "I'm out" tech status — BUILT-NOT-WIRED.** `sms/tech-status/handler.ts` (OUT/SICK/UNAVAILABLE, anti-spoof, reschedule proposals) is complete + unit-tested, but `registerTechStatusKeywords()` is **never called in `app.ts`** — tech status SMS fall to the unhandled path. One bootstrap line activates it.
- **❌ Capacitor on-device voice** — spike never built (no `@capacitor/*` deps).

---

## Where the code disagrees with the docs (the honest section)

**Better than documented:**
1. **SettingsPage stubs mostly fixed** — not "~8 `()=>{}` stubs"; only **3** `toast.info('Coming soon')` rows remain (Roles & permissions, Reminders & follow-ups, Zapier). Payment methods + Deposit rules are now fully wired.
2. **QuickBooks is fully built** (off-by-default), not "deferred/not built."
3. **B2B/property-manager routing is genuinely live in voice**, not just a field.

**Worse / more aspirational than documented:**
4. **Vulnerability + weather emergency triage is mostly dead code / hardcoded-off** — the single biggest trust-differentiator claim is the least real.
5. **No "second classifier reviews every booking/quote."** The "supervisor" is a deterministic *downgrade-only* policy + an advisory LLM annotator, **both off by default** (`supervisor_agent` flag inert per tenant). De-facto review = the classifier confidence floor + catalog confidence cap.
6. **"I'm out" tech status is built-but-not-wired.**
7. **P2-035 confidence/ambiguity markers are not in the UI** (enum exists, 0 render).
8. **Digest→SMS isn't on the P2-034 reply transport** (uses HMAC links).
9. **The whole AI pipeline is a no-op mock without `AI_PROVIDER_API_KEY`.**

**Hygiene/dead-code debt (violates `CLAUDE.md` "remove built-but-never-wired"):**
- `ai/vulnerability/` rule-based detectors + `WeatherClient/WeatherTransport/PgWeatherCache` — never instantiated.
- Second digest worker (`runDigestSweep` P5-020) superseded by RV-061 but still scheduled.
- Structured correction-lesson domain (`correction_lessons` mig. 185, `recordCorrectionLessons`, `PgCorrectionLessonRepository`) — full machinery + integration test, but no production caller writes the table.
- `registerTechStatusKeywords` unwired.
- `pages/dispatcher/ConversationalIntake*` — built + tested but not routed (orphaned).
- Duplicate `normalizeForMatch` definitions (catalog).

**Testing gaps:**
- Conflict-checker query is mock-only.
- Public estimate-approval e2e mocks the backend (layout-only, no live token→approve→deposit flow).
- Invoice/appointment entity-resolver columns pinned only by mocked unit tests.

---

## Recommended next actions (ordered by owner-impact / effort)

1. **Wire `registerTechStatusKeywords()` in `app.ts`** — one line; unblocks JTBD #12 "I'm out" + the Carlos no-show story. (S)
2. **Surface P2-035 `pricingSource` markers + build the ambiguity picker** in the inbox — closes the #2 UI gap and the "what I wasn't sure about" trust promise. (S–M)
3. **Decide the supervisor-agent story** — either turn the annotator on by default (with a budget) or formally descope the "second classifier reviews everything" claim. It's the #5 locked decision and currently inert. (M)
4. **Make vulnerability/weather triage real or cut it** — delete the dead `ai/vulnerability/` rule modules, and either wire a real weather provider + grade `<Gather>` calls, or drop the weather claim from the pitch. (M)
5. **Remove the duplicate digest worker**, and route digest items through the P2-034 reply transport. (S)
6. **Add a held-slot reaper** sweep, and pin the conflict-checker query with an integration test. (S)
7. **Flip on QuickBooks** for a pilot tenant (credentials only — code is ready). (ops)
8. **Wire the structured correction-lesson loop** — call `recordCorrectionLessons()` from the executor/dispatch flow so the digest "what I learned" reports real lessons, not chunk-counts. (S)
