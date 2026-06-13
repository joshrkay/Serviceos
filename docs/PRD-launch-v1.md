# PRD — AI Service OS v1 ("Run-By-Text AI Office Manager") — Launch

**Author:** Founder / Product Engineering
**Date:** 2026-06-13
**Status:** Draft for review
**Ground truth:** `/home/user/Serviceos/docs/_state-map.md` (verified current-state audit, HEAD `db0dc31`) and `/home/user/Serviceos/docs/_strategy.md` (product strategy). Every current-state claim below carries a **[WIRED]** / **[EXISTS-UNVERIFIED]** / **[STUB]** tag and a `file:line` cite drawn from the state map.

> **Tag legend.** **[WIRED]** = traced end-to-end, reachable in prod · **[EXISTS-UNVERIFIED]** = exists, wiring unconfirmed · **[STUB]** = placeholder / mock / dead code (defined but unreachable). The full citation appendix is at the end of this document.

---

## 1. TL;DR

AI Service OS is **an AI office manager you hire by the phone number.** It answers the calls a tradesperson misses, books the job, drafts the quote and invoice, and chases the money — and it texts the owner only when it needs a yes.

The brutal-honesty finding from the audit reorders the entire roadmap: **the hard half is already built and green; the easy-sounding half is dead.** The in-call voice agent (12 lookup + 5 mutation skills) **[WIRED]** (`telephony/twilio-adapter.ts:28-39`), the 38-type proposal engine **[WIRED]** (`proposals/proposal.ts:24`), the mode-aware auto-approve gate with an unsupervised hard-block **[WIRED]** (`proposals/auto-approve.ts:21-25,82`), 5s undo + advisory-lock idempotency **[WIRED]** (`proposals/lifecycle.ts:40`, `proposals/execution/idempotency-lock.ts:31`), Stripe pay + webhook reconciliation **[WIRED]** (`payments/stripe-payment-intent.ts:56-103`, `webhooks/routes.ts:718`), and RLS 75/75 FORCE **[WIRED]** (`db/schema.ts`) are all real.

What is dead is the owner's **channel**: there is **no SMS reply-to-approve handler** (`sms/inbound-dispatch.ts:94` — only STOP/START registered) **[CONFIRMED ABSENT]**, the proactive owner-SMS sender does not exist (`queue_and_sms` routing has no sender) **[STUB]** (`proposals/proposal.ts:399`), operator voice-approval is test-only **[STUB]** (`ai/tts/readback.ts:19-21`), multi-step dunning is dead code **[STUB]** (`invoices/dunning-schedule.ts:35`), and late-fee math has zero callers **[STUB]** (`invoices/late-fee.ts:47`).

**Translation: we built an AI employee that can do the work and asks permission correctly — but has no way to reach the owner when the owner isn't already staring at the app.** The thesis ("never open the app") is blocked by a notification channel and an approve-by-text handler, not by AI capability. That is a weeks-not-quarters gap sitting on a quarters-of-work moat. v1's job is to **stop building new surfaces and connect the owner to the engine that already exists** — then make collections actually collect, surface one dollar-denominated ROI number, and harden trust for launch.

**The wedge leads. The suite is an expansion story only and must not be built now.**

---

## 2. Vision & positioning

**Positioning:** *Not field-service software. An AI office manager you hire by the phone number.* It answers the calls you miss, books the job, sends the invoice, and chases the money — and texts you only when it needs a yes.

**One-liner:** **"It answers your phone and gets you paid. You just reply YES."**

**Internal positioning statement:** For the solo-to-10-truck trade owner who is drowning in admin and allergic to apps, AI Service OS is an AI employee that runs quote-to-cash over text and voice. Unlike ServiceTitan / Jobber / Housecall (software you must operate), the owner operates nothing — the AI does the work and asks permission.

**The product category claim:** Run-by-text is a different *product category* from "a suite with an AI add-on." Every incumbent's instinct is to add a screen; ours is to remove the app. The app is the AI's toolbox, not the owner's workplace. The interaction model — voice + text, approve-by-reply, never open the app — is the moat, not the feature list.

**The line we will not cross:** the moment the strategy becomes "all the features of Jobber plus AI," we have built a worse Jobber. The whole reason to exist is that the owner does not operate the software.

---

## 3. Problem

Tradespeople are great at the trade and bad at the business side — and they hate software. They are overloaded, reluctant business owners. Concretely:

1. **Missed calls are lost jobs.** When the owner is under a sink, the phone rings out. A missed call at a trade is a lost job worth roughly **$300–$3,000**. This is pure *new* revenue that evaporates silently — the most visceral pain and the most visceral "aha."
2. **The back-office tail leaks money.** Invoices go out late or not at all; overdue invoices get one nudge (if any) and then silence; late fees are never charged. Cash that was earned never gets collected.
3. **Incumbent software makes it worse, not better.** ServiceTitan / Jobber / Housecall sell a better filing cabinet the owner still has to open and operate. A tradesperson who refuses to learn Jobber will happily reply YES to a text. Every screen the owner is expected to live in is a screen they won't use.
4. **The owner is not at a desk.** Their channel is the phone and SMS — the two things they already live in. Any product that requires opening an app, email, or a web chat to act has already lost them.

The product must therefore deliver **the work getting done**, not features available — measured in calls answered and dollars collected — and must reach the owner where they are (text/voice), asking only for a yes.

---

## 4. Target user & personas

**Primary persona — "Mike, the owner-operator."**
- Solo-to-10-truck trade business (HVAC, plumbing, electrical, etc.). Likely starting vertical: **the highest missed-call-pain emergency trade (HVAC or plumbing).**
- Spends the day in the field, hands dirty, phone in pocket. Misses calls constantly.
- Reluctant business owner: never wanted to run admin, does it badly, resents it.
- **App-averse.** Will not log into a dashboard daily. Lives in phone calls and text messages.
- Cares about exactly two things: *did I lose a job?* and *did I get paid?*
- Trusts other trade owners over any ad or salesperson.

**Secondary persona — "the office partner / spouse-bookkeeper."**
- Sometimes a spouse or part-time bookkeeper handles invoicing and chasing money.
- More app-tolerant than Mike, but still wants less work, not a new tool to master.
- The "salary anchor": the AI is compared to the cost of this part-time receptionist/bookkeeper (~$2–4k/mo fully loaded).

**Anti-persona (explicitly not v1):** the multi-location operator who wants dashboards, crew GPS, inventory, job-costing analytics, and a marketing console. Serving them pulls us toward being a worse ServiceTitan. They are a month-12+ expansion story, not the wedge.

---

## 5. Goals & non-goals

### Goals (v1)
- **G1 — Make "never open the app" true.** Ship the text-approval spine: proactive owner SMS on every proposal needing sign-off + an inbound YES/APPROVE/EDIT/APPROVE-ALL handler, reusing the existing autonomy engine and SMS dispatch registry. Move Approval-over-text rate off its structural zero.
- **G2 — Make collections actually collect.** Wire the dead multi-step dunning cadence and late-fee math into the overdue worker so cash that was earned gets chased and recovered.
- **G3 — Prove the value in dollars.** Surface **Hands-Free Collected Revenue (HFCR)** as the in-product hero metric + a weekly owner summary, and make the onboarding payoff a recovered-call/dollar moment.
- **G4 — Earn the next autonomy rung with data.** Persist proposal outcomes to the DB (not in-memory), build per-tenant trust telemetry and tunable thresholds — so capture-class capabilities a given owner always approves can stop asking. Money/comms/irreversible never auto-execute.
- **G5 — Make reliability a product feature.** Hit the launch trust gates: green CI, prod secrets, prod migration + RLS-FORCE verification, money-render fix, `/ready` returns 503 on DB outage, two-tenant isolation proof + webhook-replay drill.
- **G6 — Don't lose the demo on credibility landmines.** Fix the hardcoded greeting, the cents-dropping money formatter, hide the QuickBooks mock, and delete dead-but-dangerous code with misleading docstrings.
- **G7 — Price the employee, not the seat.** Salary + commission on HFCR, with in-product ROI framing.

### Non-goals (cut hard — defer anything login-required or off the core loop)
- **No general field-service suite.** No crew GPS, inventory/parts, marketing-campaign builder, or job-costing analytics console. (Strategy §4.1.)
- **No owner-facing analytics dashboard / charts.** Persist proposal-outcome data (cheap, high-leverage) but do **not** build owner-facing charts. The owner does not want a dashboard; investors and the model do. (Strategy §4.7.) HFCR ships as a single number in the weekly text + a single in-app hero tile, not a console.
- **No QuickBooks build.** QBO is a pure UI mock **[STUB]** (`QuickBooksModal.tsx:23-26`) and a credibility landmine in demos. Hide it until real. (Strategy §4.3.)
- **No outbound AI cold-calling.** No `calls.create` anywhere **[WIRED] (confirmed absent calling)** (state map §Reliability); DNC gating exists with nothing to gate. The wedge is *inbound*. Leave it dead. (Strategy §4.4.)
- **No two-way calendar sync** (push-only is fine; `integrations/calendar-sync.ts:11-16` **[WIRED] one-way**) and **no multi-channel inbox** (email / DMs / web chat). The owner's channel is phone + SMS. (Strategy §4.5.)
- **No unsupervised money / comms / irreversible autonomy — ever, by design.** The gate already hard-blocks these **[WIRED]** (`proposals/proposal.ts:225-322`). Keep it and market it.
- **No concierge route built in code for v1** (founder-led/manual concierge is a GTM motion, not a build — see Epic 4 + Risks).
- **Quarantine the prototypes.** `service-os-app` (bypasses the proposal/audit gate), `service-os-agent`, `/infra` are strategic liabilities. Out of scope for the product; wall them off so no one ships them.

---

## 6. Success metrics + North Star

### North Star (single, dollar-denominated)
**Hands-Free Collected Revenue (HFCR):** *invoiced-and-paid dollars per tenant per month where every required step (book → invoice → chase → collect) was driven by the AI and approved by voice/text, with **zero app session.***

One dollar number. It can only rise if the *entire compounding loop works over text*. It is deliberately punishing: today HFCR is **structurally near zero**, because every approval currently requires opening the app (no SMS approve handler **[CONFIRMED ABSENT]** `sms/inbound-dispatch.ts:94`) and collections fire exactly once **[WIRED]** (`workers/overdue-invoice-worker.ts:110`) then go silent. HFCR forces us to fix the text-approval gap *and* make collections fire. It is also the basis of the commission pricing meter (§10).

**The core loop HFCR proves:**
> call answered → job booked → work done → invoice sent → payment collected → (data captured) → AI trusted with more.

### Supporting metrics (diagnostic, not the goal)
- **Missed-call recovery rate** — % of unanswered inbound calls that become a booked job or live lead. Proves the front.
- **Approval-over-text rate** — % of proposals approved without an app session. **Today ~0 by construction.** The single most important number to move off the floor.
- **Time-to-cash** — completion → payment received, in hours. Proves the dunning tail is live.
- **Autonomy rung mix** — share of tenants at tap / text / auto. The flywheel's gauge.
- **Revenue retention by HFCR cohort** — does delivered hands-free money predict who stays. The investability proof.

### Vanity metrics to explicitly ignore
Seats, MAU, logins, "AI calls handled" (handling a call that books nothing is theater).

### Launch targets (first cohort, directional)
- Approval-over-text rate **> 50%** of eligible (capture/comms) proposals within 30 days of a tenant going live.
- Every live tenant has **HFCR > $0** within 30 days (proof the loop closes end-to-end at least once).
- Median **Time-to-cash** for AI-driven invoices trends down month-over-month once dunning ships.

---

## 7. Current state vs target

| Capability | Current state (tagged + cite) | Target (v1) |
|---|---|---|
| Web approve (single + batch ≤50) | **[WIRED]** `routes/proposals.ts:211-232`, batch `:187-209`, cap `:36` | Keep as the floor (Rung 0). Unchanged. |
| SMS reply-to-approve | **[CONFIRMED ABSENT]** `sms/inbound-dispatch.ts:94` (only STOP/START registered) | YES/APPROVE/EDIT/APPROVE-ALL handler registered; money/irreversible require explicit confirm token (Epic 0). |
| Proactive owner notification | **[STUB]** `queue_and_sms` routing read but no sender; `proposals/proposal.ts:399`; setting exists `db/schema.ts:1831-1832` | A sender reads `unsupervised_proposal_routing` and texts the owner on every proposal needing sign-off (Epic 0). |
| Owner-cell-patch SMS sender | **[STUB]** real send exists `voice/triage/owner-cell-patch.ts:150` but no production caller | Reuse the send primitive in the proactive notifier (Epic 0). |
| Operator voice-approval (readback) | **[STUB]** test-only `ai/tts/readback.ts:19-21,53,144-156` | Wire `isVoiceApprovable` / `classifyVoiceApproval` into a runtime handler (Epic 0). |
| Screen-gating policy (class → tap vs text) | **[WIRED]** pure fn `proposals/proposal.ts:225-322` | Consume it in the SMS handler; money/comms/irreversible force tap/confirm-token (Epic 0). |
| Autonomy auto-approve gate | **[WIRED]** `proposals/auto-approve.ts:21-25,82`; `proposal.ts:339-408` | Keep. Add per-tenant tunable thresholds earned from data (Epic 1). |
| Proposal-outcome analytics | **[STUB]** in-memory only, unwired `proposals/analytics.ts:35` | Persist to PG; per-tenant trust telemetry (Epic 1). |
| Collections (overdue) | **[WIRED] one nudge only** `workers/overdue-invoice-worker.ts:110` (guard `:92`, never re-fires) | Multi-step dunning cadence wired into worker (Epic 2). |
| Multi-step dunning cadence | **[STUB] dead code** `invoices/dunning-schedule.ts:35` (zero callers) | `selectDueReminderSteps()` driven by the overdue sweep (Epic 2). |
| Late-fee math | **[STUB] zero callers** `invoices/late-fee.ts:47` | `computeLateFeeCents` wired into overdue worker (Epic 2). |
| Auto-invoice-on-completion | **[WIRED]** drafts a `draft_invoice` proposal (does not auto-send) `invoices/auto-invoice-on-completion.ts:55,120-135` | Keep (it correctly requires approval). Feeds HFCR loop. |
| Stripe pay + reconciliation | **[WIRED]** `payments/stripe-payment-intent.ts:56-103`; webhook `webhooks/routes.ts:718,927,1030` | Keep. (Named `invoice-payment-reconciler.ts` is **[STUB]** dead code — delete, Epic 6.) |
| HFCR / ROI hero metric | **does not exist** | Computed metric + in-app hero tile + weekly owner SMS summary (Epic 3). |
| Onboarding | **[WIRED] 7-step self-serve** `onboarding/contracts.ts:64`; **no concierge** `routes/onboarding.ts` | Near-zero onboarding + payoff moment; founder-led concierge as GTM (Epic 4). |
| `/ready` on DB outage | **[WIRED] by design but never 503s** `app.ts:530` emits `degraded`, never `down` (`health/health.ts:45`) | `/ready` returns 503 on real DB outage (Epic 5). |
| RLS FORCE | **[WIRED]** 75/75 distinct-table parity (`db/schema.ts`) | Verify in prod migration; two-tenant isolation proof (Epic 5). |
| Webhook idempotency | **[WIRED] fail-closed** `webhooks/routes.ts:187-194` | Webhook-replay drill in launch gates (Epic 5). |
| Money render (InvoicesPage) | **[BUG] 9 sites drop cents** `InvoicesPage.tsx:256,257,275,376,552,723,735,744,868` | Shared money formatter, all 9 sites correct (Epic 5/6). |
| Greeting "Good morning, Mike" | **[STUB] hardcoded** `HomePage.tsx:323` | Real name + real time-of-day (Epic 6). |
| QuickBooks | **[STUB] pure mock** `QuickBooksModal.tsx:23-26` | Hidden until real (Epic 6). |
| Pricing | seat/SaaS framing (implicit) | Salary + commission on HFCR; in-product ROI framing (Epic 7). |

---

## 8. Epics (requirements + acceptance criteria, prioritized)

> **Ordering rule (Altman lens):** wiring before building. Nearly every P0 item is "connect existing code," which is why the AI-employee thesis is closer to true than a feature audit would suggest. Don't build new scaffolding the next model deletes — the in-call agent and proposal engine are the durable substrate; the gaps are plumbing.

---

### Epic 0 — The text-approval spine (P0, **HEADLINE**)

**Why:** This is *the* unlock. The thesis is blocked here and only here. The engine underneath (classification, auto-approve gate, undo, idempotency) is done; what's missing is the owner's channel.

**The three dead wires to connect (named):**
1. `queue_and_sms` routing — the setting/enum/schema/`/me`-read all exist (`db/schema.ts:1831-1832`, `settings/settings.ts:64-69`, `app.ts:2620,2628`, `routes/me.ts:46`) but **no code reads `unsupervised_proposal_routing` to send an SMS** **[STUB]** (`proposals/proposal.ts:399`).
2. Owner-cell-patch sender — a real owner-SMS send exists at `voice/triage/owner-cell-patch.ts:150` (`deps.sendSms(...)`) **but has no production caller** **[STUB]**.
3. `readback.ts` voice-approval — `isVoiceApprovable` / `buildReadbackScript` / `classifyVoiceApproval` exist (`ai/tts/readback.ts:19-21,53,144-156`) but are **referenced only by their unit test** **[STUB]**.

**Requirements**
- R0.1 — **Proactive owner notification.** When a proposal reaches `ready_for_review` (today's unsupervised route, `proposals/proposal.ts:399`), a sender reads the tenant's `unsupervised_proposal_routing` / `queue_and_sms` setting and sends the owner an SMS describing the proposal and how to act. Reuse the existing `sendSms` primitive (`owner-cell-patch.ts:150`); do not build a new send path.
- R0.2 — **Inbound approve handler.** Register an inbound-SMS handler in the existing dispatch registry (`sms/inbound-dispatch.ts:94`, same mechanism as STOP/START at `app.ts:661-662`) that understands **YES / APPROVE / EDIT / APPROVE-ALL**, resolves the referenced proposal(s) for that tenant, and routes through the **existing** `approveProposal` / `approveProposalsBatch` actions (`proposals/actions.ts:35,67`) — not a parallel approval path.
- R0.3 — **Screen-tap guarantee preserved.** Consume the existing screen-gating classifier (`actionClassForProposalType`, `proposals/proposal.ts:225-322`): **capture-class** is text/voice-approvable; **comms / money / irreversible force a screen tap** *or* an explicit confirm token. A bare YES must **never** approve a money/irreversible proposal.
- R0.4 — **Confirm token for money/irreversible.** For money/irreversible proposals, the outbound SMS includes a short, single-use, time-boxed confirm token; approval requires the owner to reply with that exact token (e.g. `APPROVE 7421`). A plain YES is rejected with a tap-on-screen instruction. This preserves today's screen-tap guarantee while still allowing a deliberate text confirm.
- R0.5 — **Operator voice-approval.** Wire `readback.ts` into a runtime voice handler: capture-class gets "Say approve or cancel"; money/comms/irreversible get "Tap to confirm on screen" (mirroring R0.3). `classifyVoiceApproval` drives the decision.
- R0.6 — **APPROVE-ALL parity.** Text APPROVE-ALL maps to the existing batch action with the same ≤50 cap and the same client-side-equivalent gating that the web "APPROVE ALL" enforces (`InboxPage.tsx`), and still excludes money/irreversible from the batch.
- R0.7 — **Audit + idempotency.** Every text/voice approval emits an audit event (`audit_events` **[WIRED]** `db/schema.ts:60-78`) and is idempotent (duplicate inbound SMS for the same proposal does not double-approve; reuse advisory-lock idempotency `idempotency-lock.ts:31`).

**Acceptance criteria (testable)**
- AC0.1 — Creating a capture-class proposal for a tenant with proactive routing enabled sends exactly one owner SMS containing the proposal summary and a reply instruction (assert outbound SMS via the test send provider).
- AC0.2 — Inbound `YES` (or `APPROVE`) for a pending **capture-class** proposal transitions it to approved via `approveProposal` and writes an audit event; a confirmation SMS is returned.
- AC0.3 — Inbound `YES` for a pending **money** or **irreversible** proposal does **not** approve it; the reply instructs the owner to use the confirm token or tap on screen; proposal stays pending. (Assert no state change.)
- AC0.4 — Inbound `APPROVE <token>` with the correct, unexpired token for a money proposal approves it; a wrong/expired token does not, and is rejected with a clear message.
- AC0.5 — `APPROVE-ALL` approves all eligible pending capture/comms proposals for the tenant up to 50, excludes money/irreversible, and is capped (51 pending → 50 approved, 1+money skipped).
- AC0.6 — Operator voice "approve" approves a capture-class proposal; voice "approve" on a money proposal is refused with the tap-to-confirm script (`classifyVoiceApproval` unit + integration test).
- AC0.7 — Duplicate inbound SMS for the same proposal results in a single approval and a single execution (idempotency proof).
- AC0.8 — Build gate stays green: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` exits 0.

---

### Epic 1 — Climb the autonomy ladder (P1)

**Why:** Once text approval works, the as-executed payload history shows which capabilities a given owner *always* approves. Raise that owner's threshold for that one capability so the AI stops asking — with the 5s undo as the safety net. This is the flywheel's payoff and the data moat.

**Requirements**
- R1.1 — **Persist `ProposalOutcome` to the DB.** Replace the in-memory-only analytics (`InMemoryProposalAnalyticsRepository` **[STUB]** `proposals/analytics.ts:35`, unwired in `app.ts`) with a PG-backed repository wired at the composition root, capturing proposed → approved/rejected/edited outcomes per tenant, per proposal type. (Builds on the WIRED as-executed payload capture `executor.ts:165,259`.)
- R1.2 — **Per-tenant trust telemetry.** From persisted outcomes, compute per-tenant, per-capability approval rates (and edit/reject rates).
- R1.3 — **Tunable thresholds.** Make the auto-approve thresholds (`auto-approve.ts:21-25`, already tenant-overridable) settable per tenant per capability, driven by observed approval history — not a global toggle.
- R1.4 — **Hard invariant preserved.** Money / comms / irreversible **never** auto-execute regardless of trust score; only capture-class can be promoted; unsupervised hard-block stays (`auto-approve.ts:82`).

**Acceptance criteria**
- AC1.1 — After approving N capture-class proposals of one type, the persisted outcome store reflects exactly N approvals for that tenant+type, and survives a process restart (proof it's not in-memory).
- AC1.2 — Raising a tenant's threshold for a capture-class capability causes a subsequent high-confidence proposal of that type to auto-approve, with the 5s undo window intact.
- AC1.3 — No threshold setting can cause a money/comms/irreversible proposal to auto-approve (assert the gate refuses regardless of configured threshold).
- AC1.4 — Telemetry endpoint/job emits per-tenant per-capability approval rates that match a hand-computed fixture.

---

### Epic 2 — Finish collections (P0)

**Why:** Today: one overdue nudge, then silence **[WIRED]** (`workers/overdue-invoice-worker.ts:110`, guard `:92`). This is where Time-to-cash and HFCR actually move — and it's mostly connecting written-but-dead code.

**The dead code to wire (named):** `selectDueReminderSteps()` **[STUB]** (`invoices/dunning-schedule.ts:35`, zero callers) and `computeLateFeeCents` / `daysPastDue` **[STUB]** (`invoices/late-fee.ts:47,34`, zero non-test callers).

**Requirements**
- R2.1 — **Wire the dunning cadence.** The overdue sweep (`runOverdueInvoiceSweep`, `app.ts:2927-2939`) calls `selectDueReminderSteps()` to determine which reminder step(s) are due for each overdue invoice and raises a **comms-class proposal per due step** (so each step is owner-approved by text via Epic 0, or auto-fires once trusted via Epic 1).
- R2.2 — **Wire late-fee math.** Where a tenant's policy enables late fees, `computeLateFeeCents` (using `daysPastDue`) computes the fee via the shared billing engine (integer cents, never float) and attaches it to the appropriate dunning step / invoice adjustment as a money-class proposal (never auto-applied — money is always gated).
- R2.3 — **Idempotent cadence.** Each dunning step fires at most once per invoice (no duplicate reminders on repeated sweeps), mirroring the existing single-fire guard pattern.
- R2.4 — **Cents discipline.** All fee math is integer cents end-to-end; no floating point (project rule).

**Acceptance criteria**
- AC2.1 — An invoice that is N days overdue triggers exactly the dunning steps whose due-day ≤ N and not yet sent (assert against `selectDueReminderSteps` fixtures).
- AC2.2 — Each dunning step produces a comms-class proposal (approvable by text per Epic 0), not a direct send.
- AC2.3 — A late fee for a known days-past-due and rate matches `computeLateFeeCents` to the cent, is surfaced as a money-class proposal, and is **never** auto-applied.
- AC2.4 — Re-running the overdue sweep does not re-create already-sent steps or duplicate late fees (idempotency).
- AC2.5 — No floating-point money appears in any new code path (cents-only assertion).

---

### Epic 3 — ROI hero metric "Hands-Free Collected Revenue" (P0)

**Why:** The owner cares about exactly one thing the product can prove: *did the AI make/collect me money without my having to do anything?* This is the North Star surfaced to the user and the investor.

**Requirements**
- R3.1 — **Compute HFCR.** A metric that sums invoiced-and-paid dollars per tenant per month where every required step (book → invoice → chase → collect) was AI-driven and approved by voice/text with **zero app session**. Source from the WIRED loop: voice bookings, auto-invoice proposals (`auto-invoice-on-completion.ts:55`), Stripe webhook payments (`webhooks/routes.ts:927,1030`), and the persisted approval channel (Epic 1) to confirm "zero app session."
- R3.2 — **In-app hero tile (single number, not a dashboard).** One prominent ROI tile showing this month's HFCR + the count of recovered missed calls. No charts, no console (non-goal §5).
- R3.3 — **Weekly owner summary by SMS.** A weekly text: "This week I collected $X hands-free and recovered N calls." Reuses the Epic 0 send primitive.
- R3.4 — **Onboarding payoff.** The onboarding terminal experience surfaces the first recovered call / first hands-free dollar as the activation moment (ties to Epic 4 and GTM "the phone number is the install").

**Acceptance criteria**
- AC3.1 — HFCR for a tenant equals the sum of paid invoice cents whose full loop (book/invoice/chase/collect) was AI-driven and text/voice-approved with no app session, verified against a seeded fixture with a mix of hands-free and app-touched invoices (only the hands-free ones count).
- AC3.2 — An invoice approved via an app session is **excluded** from HFCR (proof the "zero app session" constraint bites).
- AC3.3 — The in-app hero tile renders the current-month HFCR using the shared money formatter (correct cents — see Epic 5/6) and the recovered-call count.
- AC3.4 — The weekly summary SMS is sent once per tenant per week with the correct HFCR figure (assert via test send provider).

---

### Epic 4 — Concierge / near-zero onboarding (P1)

**Why:** Distribution is "the phone number is the install." The buyer is app-averse; onboarding friction craters activation.

**Current state:** 7-step self-serve onboarding **[WIRED]** (`onboarding/contracts.ts:64`: signup → identity → pack → phone → billing → ai_check → test_call); **no concierge path** **[CONFIRMED ABSENT]** (`routes/onboarding.ts`, self-serve only).

**Requirements**
- R4.1 — **Minimize self-serve friction** to first recovered call: terminal step is `test_call` (already wired); the AI answering the next missed call and the **first booked job is the activation event**.
- R4.2 — **Founder-led concierge as a GTM motion, not a code build for v1.** Human-assisted setup for the first cohorts (number porting/forwarding help, A2P registration), using the existing self-serve endpoints behind the scenes. Decide later whether to build a concierge route based on whether it lifts activation enough (Open Question).
- R4.3 — **Activation metric.** Instrument time-to-first-recovered-call.

**Acceptance criteria**
- AC4.1 — A new tenant can complete all 7 onboarding steps and reach `test_call` with the AI answering a real call (existing flow regression-tested).
- AC4.2 — Time-to-first-recovered-call is measurable per tenant (instrumentation present).
- AC4.3 — No concierge code path ships that bypasses the proposal/audit gate (guardrail: the prototype that does this — `service-os-app` — stays quarantined).

---

### Epic 5 — Trust / reliability launch gates (P0)

**Why:** Reliability is a product feature. The owner will approve something that "half looks right" by text; the system must be trustworthy enough that "half-looking" is still safe. A launch is not a launch until these are green.

**Requirements + acceptance criteria (each is a gate)**
- R5.1 — **Green CI.** AC: CI is green on the launch commit, including the build gate `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` (exit 0 — currently passing, state map §1).
- R5.2 — **Prod secrets present.** AC: `METRICS_TOKEN`, `TRANSCRIPT_ENCRYPTION_KEY`, Stripe + Twilio creds, DB URL all set in prod; `/metrics` returns 503 without token in prod (`bootstrap/metrics-auth.ts`) — assert configured.
- R5.3 — **Prod migration + RLS-FORCE verification.** AC: migrations applied to prod; a live query confirms 75/75 distinct tables have both ENABLE and FORCE ROW LEVEL SECURITY (matches `db/schema.ts` **[WIRED]**), zero mismatch.
- R5.4 — **Money-render fix.** AC: all 9 cents-dropping sites in `InvoicesPage.tsx` (`:256,257,275,376,552,723,735,744,868` **[BUG]**) render via a shared money formatter; `$1,234.05` never renders as `$1,234`. (Shared with Epic 6.)
- R5.5 — **`/ready` returns 503 on DB outage.** AC: the DB health check can emit `down` (not only `degraded`, `app.ts:530`), and `/ready` (`health/health.ts:60`) returns 503 when the DB is unreachable — verified by simulating a DB outage. (Today it never 503s — state map §Stubs/bugs.)
- R5.6 — **Two-tenant isolation proof.** AC: an automated test proves tenant A cannot read/write tenant B's rows across the key tables (RLS holds end-to-end, not just declared).
- R5.7 — **Webhook-replay drill.** AC: replaying a previously processed Stripe webhook (same event id) is a no-op (fail-closed dedup `webhooks/routes.ts:187-194` **[WIRED]** verified live), recording no duplicate payment.

---

### Epic 6 — Credibility polish (P1)

**Why:** Demo and first-run landmines erode trust faster than missing features.

**Requirements**
- R6.1 — **Fix the greeting.** Replace hardcoded `<h1>Good morning, Mike ☀️</h1>` **[STUB]** (`HomePage.tsx:323`) with the real signed-in owner's name and real time-of-day.
- R6.2 — **Money formatter for InvoicesPage.** Apply the shared cents-correct formatter to the 9 sites **[BUG]** (`InvoicesPage.tsx` listed lines). (Coordinated with R5.4.)
- R6.3 — **Hide the QuickBooks mock.** Hide `QuickBooksModal.tsx` **[STUB]** (`:23-26`, fake `setTimeout` + hardcoded "#8821") until a real integration exists (non-goal §5). No fake "Connected" state reachable.
- R6.4 — **Delete dead-but-dangerous code with misleading docstrings.** Remove the dead `invoice-payment-reconciler.ts` (`reconcilePayment`, zero callers **[STUB]**, misleadingly named — real reconciliation is the webhook path), and fix the stale comment in `proposal-execution.ts:22-24` that falsely claims "no caller writes this surface yet" (it IS written, `executor.ts:165,259`). Audit `auto-approve.ts:68-69` / `proposal.ts:359-360` comments that promise a non-existent "routing worker."

**Acceptance criteria**
- AC6.1 — Home greeting shows the real account holder's name and correct time-of-day greeting (no literal "Mike").
- AC6.2 — Every monetary value on InvoicesPage shows correct cents; a `$X.05` value never displays as `$X`.
- AC6.3 — The QuickBooks UI is not reachable in the shipped build (or is clearly labeled "coming soon" with no fake connected state).
- AC6.4 — `invoice-payment-reconciler.ts` is deleted (or proven wired); no docstring in the codebase claims behavior contradicting the wired reality (grep check for the stale phrases).

---

### Epic 7 — Employee-style pricing + in-product ROI framing (P1)

**Why:** Price the employee, not the seat. Seats punish the exact thing we want (the owner not logging in; the AI doing more).

**Requirements**
- R7.1 — **One plan, two meters:** a flat monthly **salary** (anchored against a part-time receptionist/bookkeeper ~$2–4k/mo, priced at a fraction) + a small **commission** on HFCR.
- R7.2 — **Commission meter on HFCR** (Epic 3): we get paid when the owner gets paid; the recovered-missed-call wedge is self-justifying.
- R7.3 — **No feature ladder.** No Pro/Enterprise tiers — feature laddering pushes back toward suite-think. The autonomy *rung* is earned by trust, not bought.
- R7.4 — **In-product ROI framing.** The HFCR hero tile and weekly summary explicitly frame value vs. cost ("I collected $X hands-free this month") to make the commission feel fair.
- R7.5 — **Validate the commission acceptance risk** (Open Question): test a flat-rate escape hatch / cap for owners who hate variable pricing.

**Acceptance criteria**
- AC7.1 — Billing computes salary + commission where commission = configured % × the tenant's HFCR for the period (integer cents), matching a fixture.
- AC7.2 — No feature is gated behind a higher tier (single plan); autonomy rung is driven by trust telemetry (Epic 1), not by plan.
- AC7.3 — The ROI framing surfaces the commission against HFCR so the meter is legible to the owner.

---

## 9. Key user journeys

1. **Missed call → booked job (the front wedge).** Owner is under a sink; phone rings out; AI answers (in-call voice agent **[WIRED]** `twilio-adapter.ts:28-39`), runs lookups, books the slot or captures the lead (lead auto-create **[WIRED]** `find-or-create-lead.ts:33`) as an approval-gated proposal. Owner gets a text, replies **YES**, job is on the books. *(Epic 0 makes the YES possible.)*
2. **Job done → invoice → paid (the back wedge).** Job marked complete → auto-invoice drafts a `draft_invoice` proposal **[WIRED]** (`auto-invoice-on-completion.ts:55`). Owner replies **YES** (or a confirm token, money-class). Invoice sent; customer pays via Stripe **[WIRED]** (`stripe-payment-intent.ts:56-103`); webhook reconciles **[WIRED]** (`webhooks/routes.ts:927`). HFCR ticks up.
3. **Overdue → chased → collected (the dunning tail).** Invoice goes overdue; the sweep raises the next due dunning step as a comms proposal (Epic 2). Owner replies **YES**; reminder goes out; if still unpaid, the next step + (policy-permitting) a late fee proposal follows. Money lands; Time-to-cash drops.
4. **Trust earned → AI stops asking (the ladder).** After the owner has approved the same capture-class proposal type many times (persisted outcomes, Epic 1), that capability auto-approves for that tenant, with 5s undo as the net. Money/comms/irreversible still always ask.
5. **Weekly proof.** Sunday text: "This week I collected $X hands-free and recovered N calls." Owner never opened the app. *(Epic 3.)*
6. **Money/irreversible — the deliberate confirm.** AI proposes a refund/credit (money-class). Owner gets a text with a confirm token; a bare YES is refused; owner replies `APPROVE 7421` to confirm. The screen-tap guarantee is preserved over text. *(Epic 0, R0.4.)*

---

## 10. Pricing & packaging

**Frame: you are hiring an employee, so you pay it like one — a base wage plus commission — not a per-seat SaaS fee.**

- **Base "salary" (flat monthly):** the AI mans the phone and runs the office. Anchored against the fully-loaded cost of a part-time receptionist/bookkeeper (~$2–4k/mo), priced at a fraction (a few hundred dollars/month). The owner compares to a *human*, not to Jobber's $49 tier — that comparison is the pricing power.
- **Commission (outcome fee) — the core innovation:** a small % of **HFCR** — money the AI booked and collected. We get paid when the owner gets paid. It makes the recovered-missed-call wedge self-justifying.
- **One plan, two meters.** No Pro/Enterprise feature ladder (laddering = suite-think). The autonomy *rung* is earned by trust, not bought.
- **Why not per-seat:** seats punish the owner *not* logging in and the AI doing more — both of which are the whole point — and cap revenue at company size.

**Open risk to validate (§15):** commission can feel like a "tax on my own money." May need a cap or a flat-rate escape hatch for variable-pricing-averse owners. Test both.

---

## 11. Launch Definition of Done

Launch is **done** when all of the following hold:

- [ ] **Epic 0 shipped:** proactive owner SMS fires on every proposal needing sign-off; YES/APPROVE/EDIT/APPROVE-ALL handler works; money/irreversible require a confirm token (screen-tap guarantee preserved); voice-approval wired. (AC0.1–AC0.8.)
- [ ] **Epic 2 shipped:** multi-step dunning + late-fee math wired into the overdue worker, idempotent, cents-only. (AC2.1–AC2.5.)
- [ ] **Epic 3 shipped:** HFCR computed correctly, in-app hero tile + weekly owner SMS summary live, onboarding payoff present. (AC3.1–AC3.4.)
- [ ] **Epic 5 all gates green:** green CI + build gate; prod secrets; prod migration + RLS 75/75 FORCE verified live; money-render fixed; `/ready` 503s on DB outage; two-tenant isolation proof; webhook-replay drill. (R5.1–R5.7.)
- [ ] **Credibility landmines removed:** greeting fixed, money formatter applied (9 sites), QuickBooks mock hidden, dead-but-dangerous reconciler deleted + misleading docstrings fixed. (Epic 6.)
- [ ] **Invariants hold:** money/comms/irreversible never auto-execute; all money is integer cents; all mutations emit audit events; all tenants RLS-isolated.
- [ ] **Approval-over-text rate is measurably > 0** for at least one live tenant (proof the spine works in prod).
- [ ] Prototypes (`service-os-app`, `service-os-agent`, `/infra`) quarantined / not deployable.

Epics 1, 4, 7 (P1) are launch-adjacent: pricing and the autonomy ladder can follow within the first weeks; they are not blockers for the wedge to be true, but Epic 7 must be settled before charging the first cohort.

---

## 12. Milestones

- **M0 — Spine (P0, week 1–2):** Epic 0 (text-approval spine) + Epic 5 partial (`/ready` 503, money-render, build/CI green). *Exit: Approval-over-text rate off zero in staging.*
- **M1 — Collect (P0, week 2–3):** Epic 2 (dunning + late fees) + Epic 3 (HFCR metric + weekly summary). *Exit: HFCR computes end-to-end on a seeded tenant; first hands-free dollar demoable.*
- **M2 — Launch gates (P0, week 3–4):** Epic 5 remainder (prod secrets, prod migration + RLS verify, two-tenant isolation, webhook-replay) + Epic 6 polish. *Exit: Launch DoD green; first cohort onboarded.*
- **M3 — Ladder + price (P1, week 4–6):** Epic 1 (persist outcomes, trust telemetry, tunable thresholds) + Epic 7 (salary+commission billing) + Epic 4 (founder-led concierge for first cohorts). *Exit: at least one tenant auto-acting on a capture capability; commission billing live.*

---

## 13. GTM / distribution

*The product is acquired through the customer's own phone number and proven by their own missed-call money — not through a marketing funnel they'd ignore.*

1. **The phone number IS the install.** Port/forward the business number; the AI answers the next missed call; the **first booked job is the activation event** (terminal onboarding step `test_call` **[WIRED]**). Time-to-first-recovered-call is the activation metric.
2. **Missed-call win-back cold proof.** For a prospect, show "you missed 6 calls this week — here's what I'd have booked." Sells the wedge with the prospect's own lost money. Strictly inbound/consent-clean — no outbound dialing.
3. **Trade-specific channels.** Supply houses, trade associations, distributor counters, the YouTube/Facebook personalities trade owners follow. **One vertical first** (highest missed-call-pain trade, likely HVAC or plumbing emergency work) to nail in-call skills + dunning copy before going horizontal.
4. **Referral with teeth.** Reward tied to the referred shop's *recovered revenue*, not a flat $50 — same outcome-aligned logic as pricing.
5. **Founder-led concierge onboarding** for the first cohorts (white-glove number porting / A2P help) — a sales motion, not a code build (Epic 4).

---

## 14. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Owner won't trust an AI to talk to their customers.** Existential to the front wedge. | One trade first; concierge-led first cohort; emergency escalation **[WIRED]** (`escalate-to-human.ts`); show the recovered-money proof fast. |
| 2 | **Text-approval inbox becomes noise the owner ignores** → Approval-over-text collapses → churn. | Notification batching/cadence (Open Q §15); APPROVE-ALL; weekly summary instead of per-event spam where possible; tune via telemetry (Epic 1). |
| 3 | **Owner approves something half-looking that's wrong** (AI booked a bad slot, quoted low, dunned an already-paid customer). | Reliability-as-feature (Epic 5); 5s undo **[WIRED]**; money/irreversible require confirm token (R0.4); comms/money never auto-execute. |
| 4 | **A bare YES approving a money/irreversible action.** | Confirm-token requirement (R0.4) + screen-gating classifier **[WIRED]** (`proposal.ts:225-322`); AC0.3/AC0.4 enforce. |
| 5 | **Commission feels like a tax on my own money.** | Test cap / flat-rate escape hatch (Epic 7); ROI framing (Epic 3) makes value legible. |
| 6 | **Telephony onboarding friction (porting/forwarding, A2P 10DLC).** "Phone number is the install" assumes this is smooth. | Founder-led concierge for first cohorts; validate the telephony path early (Open Q §15). |
| 7 | **Dunning fires duplicate/wrong reminders** (re-running sweep). | Idempotent cadence (R2.3/AC2.4) mirroring existing single-fire guard. |
| 8 | **Prototypes mistaken for prod** (`service-os-app` bypasses the audit gate). | Quarantine/delete (non-goal §5); guardrail AC4.3. |
| 9 | **QuickBooks mock fires in a demo** ("#8821" fake connect). | Hide it (Epic 6/AC6.3). |
| 10 | **Dropped-call recovery is in-process `setTimeout`** (not durable across restart) **[WIRED] w/ caveat** (`dropped-call-recovery.ts:25`). | Known caveat; out of v1 scope to harden, but flagged; revisit if it bites activation. |

---

## 15. Open questions

1. **Will an app-averse owner actually let the AI answer their phone?** Existential to the wedge. Test before scaling.
2. **Will owners reply YES, or will the inbox become noise?** What's the right notification batching/cadence for Epic 0? Drives whether Rung 1 holds.
3. **Outcome-pricing acceptance:** is "% of money I collected" fair or extractive? What % is the ceiling? Is a flat-rate escape hatch required?
4. **Real dollar value of a recovered missed call, by trade?** Drives wedge ROI, pricing anchor, and vertical choice. Needs field data.
5. **Which trade first?** HVAC vs plumbing vs electrical vs landscaping differ on missed-call pain, job value, dunning norms, emergency mix.
6. **Number porting/forwarding + A2P 10DLC reality.** If it's a multi-week slog, activation craters. Validate the telephony path.
7. **Liability when the AI is wrong** (bad slot, low quote, dunned a paid customer). Undo + gates limit it; owner tolerance is a business question.
8. **Concierge vs self-serve economics:** does white-glove onboarding lift activation enough to justify the build for a price-sensitive segment? Founder-led test first (Epic 4).

---

## Appendix — Verified current-state map (citations)

Summarized from `/home/user/Serviceos/docs/_state-map.md` (HEAD `db0dc31`, audit 2026-06-13). Build gate **PASS** (exit 0): `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`.

**WIRED (real, reachable in prod):**
- Web approval single + batch ≤50 — `routes/proposals.ts:211-232`, `:187-209`, cap `:36`; `proposals/actions.ts`; `web/.../InboxPage.tsx`.
- Screen-gating policy (pure fn) — `proposals/proposal.ts:225-322`.
- 38 proposal types — `proposals/proposal.ts:24,26-65`.
- Auto-approve gate (mode-aware 0.90/0.92/0.95, unsupervised hard-block) — `proposals/auto-approve.ts:21-25,32,82`; `proposal.ts:339-408,515-528`.
- 5s undo + advisory-lock idempotency — `proposals/lifecycle.ts:40`; `execution/executor.ts:88-97,164-175`; `execution/idempotency-lock.ts:31`.
- ~30 execution handlers — `execution/handlers.ts:413,472-552`.
- proposal_executions as-executed payload — `executor.ts:165,259`; `app.ts:901,1218`; table `db/schema.ts:1541-1565`. (Stale comment `proposal-execution.ts:22-24`.)
- Estimate AI-draft auto-approve (supervised) — `ai/tasks/estimate-task.ts:116`.
- Auto-invoice-on-completion (drafts a proposal, does not auto-send) — `invoices/auto-invoice-on-completion.ts:55,120-135`; `routes/jobs.ts:343-362`; `app.ts:2411-2419`.
- Stripe pay — `payments/stripe-payment-intent.ts:56-103`; `routes/public-payments.ts:106`; `app.ts:1652`.
- Reconciliation via Stripe webhook — `webhooks/routes.ts:718,927,1030,1075,1504,1637`; `app.ts:696,436`.
- Collections: one overdue nudge — `workers/overdue-invoice-worker.ts:110` (guard `:92`); `app.ts:2927-2939`.
- In-call voice: 12 lookups + 5 mutations, escalation, dropped-call recovery (setTimeout caveat), lead auto-create — `telephony/twilio-adapter.ts:28-39,1457-1660`; `ai/voice-turn/create-voice-turn-processor.ts`; `ai/skills/escalate-to-human.ts`; `telephony/dropped-call-recovery.ts:25`; `ai/skills/find-or-create-lead.ts:33`.
- Data flywheel: audit_events `db/schema.ts:60-78`; voice transcripts `voice/pg-voice-audit.ts:126`.
- RLS 75/75 ENABLE+FORCE — `db/schema.ts` (zero distinct-table mismatch).
- Webhook idempotency fail-closed — `webhooks/routes.ts:187-194`.
- /metrics auth-gated — `app.ts:560-585`; `bootstrap/metrics-auth.ts`.
- Transcripts AES-256-GCM — `integrations/crypto.ts:15-22`; `workers/transcription.ts:86,251`.
- Calendar sync push-only — `integrations/calendar-sync.ts:11-16,109,204`.
- 7-step self-serve onboarding — `onboarding/contracts.ts:64,84`; `onboarding/derive-status.ts:59,68`.
- No outbound calling (DNC gates nothing) — no `calls.create` in `packages/api/src`.

**STUB / dead / mock (defined but unreachable):**
- Operator voice-approval (readback) — test-only — `ai/tts/readback.ts:19-21,53,144-156`.
- Tech-status OUT/SICK keyword handler — built, **not registered** — `sms/tech-status/keyword-router.ts:20-21`, `sms/tech-status/index.ts:29` (no caller; `app.ts:661-662` registers only STOP/START).
- Proactive owner SMS via `queue_and_sms` — no sender — `proposals/proposal.ts:399`; setting `db/schema.ts:1831-1832`, `settings/settings.ts:64-69`, `app.ts:2620,2628`, `routes/me.ts:46`.
- Owner-cell-patch sender — no caller — `voice/triage/owner-cell-patch.ts:150,166,223`.
- Proposal-outcome analytics — in-memory only, unwired — `proposals/analytics.ts:35`.
- Multi-step dunning — dead code — `invoices/dunning-schedule.ts:35`.
- Late-fee math — zero callers — `invoices/late-fee.ts:47,34`.
- Named Stripe reconciler — dead code — `payments/invoice-payment-reconciler.ts:12`.
- QuickBooks — pure UI mock — `web/.../settings/QuickBooksModal.tsx:23-26,143,190-192`.
- Language/voice overrides — placeholder — `web/.../settings/LanguageSettings.tsx:5-6`.
- review-response Google reply — silent no-op without resolver — `proposals/execution/review-response-handler.ts:201-206`; `handlers.ts:530-535`.
- "Good morning, Mike" — hardcoded — `web/.../home/HomePage.tsx:323`.

**CONFIRMED ABSENT:**
- SMS reply-to-approve handler — `sms/inbound-dispatch.ts:94` (only STOP/START; `compliance/stop-reply.ts:9,12`).
- Concierge onboarding path — `routes/onboarding.ts` (self-serve only).

**BUG:**
- InvoicesPage drops cents via `toLocaleString` (9 sites) — `web/.../invoices/InvoicesPage.tsx:256,257,275,376,552,723,735,744,868` (edit path `.toFixed(2)` at `:247` is correct).
- `/ready` never 503s on DB blip — DB check emits only `degraded`, never `down` — `app.ts:530`; `health/health.ts:45,60`.

**Net headline:** the autonomy/approval core is genuinely WIRED and reachable; the drift since the prior audit is uniformly in the degrade direction — the owner's *channel* (proactive SMS, approve-by-text, voice-approval), collections tail (dunning, late fees), and proposal-outcome analytics are dead. The thesis is ~3 wires from true.
