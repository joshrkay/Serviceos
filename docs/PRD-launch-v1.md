# PRD — AI Service OS v1 ("Run-By-Text AI Office Manager") — Launch

**Author:** Founder / Product Engineering
**Date:** 2026-06-13
**Status:** Draft for review
**Ground truth:** a file-level current-state audit of the canonical product (`packages/api`, `packages/web`, `packages/shared`) at HEAD `db0dc31`, build gate **PASS**. Every current-state claim below carries a **[WIRED]** / **[EXISTS-UNVERIFIED]** / **[STUB]** tag and a `file:line` cite; the citation appendix at the end of this document is the self-contained record.

> **Tag legend.** **[WIRED]** = traced end-to-end, reachable in prod · **[EXISTS-UNVERIFIED]** = exists, wiring unconfirmed · **[STUB]** = placeholder / mock / dead code (defined but unreachable). The full citation appendix is at the end of this document.

> **How to read this PRD.** §1–§7 frame the wedge and the current-state delta. §8 is the build spec: each epic carries Requirements + Acceptance Criteria, and each **P0** epic additionally carries an **Implementation** subsection (exact files/dead-wires/migrations/contracts/tests) and a **Tickets** subsection (dependency-ordered, sized engineering tickets). §9 sequences all P0 tickets into one critical path. §10–§12 broaden scope (competitive analysis, financial model, phased roadmap). §13–§19 are journeys, pricing, DoD, milestones, GTM, risks, open questions, and the citation appendix.

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

One dollar number. It can only rise if the *entire compounding loop works over text*. It is deliberately punishing: today HFCR is **structurally near zero**, because every approval currently requires opening the app (no SMS approve handler **[CONFIRMED ABSENT]** `sms/inbound-dispatch.ts:94`) and collections fire exactly once **[WIRED]** (`workers/overdue-invoice-worker.ts:110`) then go silent. HFCR forces us to fix the text-approval gap *and* make collections fire. It is also the basis of the commission pricing meter (§14).

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
| Dunning-event persistence table | **[WIRED] schema exists, unused** `db/schema.ts:3520-3541` (`invoice_dunning_events`, RLS-FORCE, `UNIQUE(tenant_id,invoice_id,kind,step_key)`) | Wire reads/writes into the sweep for idempotency (Epic 2). |
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

> **Engineering-depth convention.** Each P0 epic (0, 2, 3, 5) carries an **Implementation** subsection (files/dead-wires/migrations/contracts/integration points/test plan) and a **Tickets** subsection (dependency-ordered, sized SPINE-/COLLECT-/HFCR-/GATE- tickets). All P0 tickets are sequenced in §9. P1 epics (1, 4, 6, 7) carry Implementation notes inline without a ticket breakdown.

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

#### Implementation

**Files / modules to touch**
- **Outbound notifier (new):** `proposals/notify-owner.ts` — a `notifyOwnerOfProposal(proposal, deps)` function invoked from the unsupervised route. The route point is `proposals/proposal.ts:399` (`decideInitialStatus` returns `ready_for_review`); the comment at `proposal.ts:359-360` and `auto-approve.ts:68-69` already *promise* a "routing worker [that] notifies the owner per `tenant_settings.unsupervised_proposal_routing`" — this is the worker that does not yet exist. Do NOT notify from inside the pure `decideInitialStatus` (keep it I/O-free); hook the notifier at the `createProposal` callsite (`proposal.ts:515-528`) after persistence, or in a thin post-create step in the composition root.
- **Send primitive (reuse, do not rebuild):** the `sendSms({ to, body })` shape from `voice/triage/owner-cell-patch.ts:150`. Extract/share the underlying provider rather than copying; the notifier depends on the same SMS provider interface wired in `app.ts`.
- **Routing read:** `settings/settings.ts:64-69` + `routes/me.ts:46` already expose `unsupervised_proposal_routing` (`queue_and_sms` | `queue_only` | `escalate_to_oncall`, schema `db/schema.ts:1831-1832`). The notifier branches on this: `queue_only` → no SMS; `queue_and_sms` → owner SMS; `escalate_to_oncall` → on-call escalation (reuse `ai/skills/escalate-to-human.ts`).
- **Inbound handler (new):** `sms/approve/approve-keyword-handler.ts` implementing the existing `KeywordHandler` interface (`sms/inbound-dispatch.ts:49-52`: `{ readonly keywords; handle(ctx): Promise<HandlerResult> }`). Register via `registerKeywordHandler(...)` at the same bootstrap point as STOP/START (`app.ts:661-662`). Note the dispatcher routes **only the first token** (`inbound-dispatch.ts:97`) and **must not throw** (`:19-22`) — the handler catches its own errors and returns a structured `HandlerResult`. Register keywords: `YES`, `APPROVE`, `EDIT`, `APPROVE-ALL` (and `APPROVE_ALL`). Because dispatch is first-token only, `APPROVE 7421` routes on `APPROVE` and the handler parses the token from `ctx.body`.
- **Approval routing (reuse):** `proposals/actions.ts:35` (`approveProposal`) and `:67` (`approveProposalsBatch`, ≤50). The handler resolves the target proposal(s) for `ctx.tenantId` then calls these — never a parallel approval path. Latest-pending resolution + `EDIT` deep-link semantics live in the handler.
- **Screen-gating (reuse):** `actionClassForProposalType` (`proposal.ts:225-322`). The handler classifies the resolved proposal; capture → YES approves; comms/money/irreversible → require confirm token or tap.
- **Voice-approval (wire):** `ai/tts/readback.ts` — `isVoiceApprovable` (`:19-21`), `buildReadbackScript` (`:53`), `classifyVoiceApproval` (`:144-156`). Wire into the in-call/operator turn path (`ai/voice-turn/create-voice-turn-processor.ts`, near the `handleCreateProposal` region `:423-484`) so the readback script is spoken and the classified response drives approval. Today these three exports are imported only by `test/ai/tts/readback.test.ts:10-14`.

**Confirm-token design (new, R0.4)**
- New table `proposal_confirm_tokens` (migration required): `id`, `tenant_id` (NOT NULL, FK `tenants(id)`), `proposal_id` (FK, ON DELETE CASCADE), `token` (short numeric, e.g. 4 digits), `expires_at TIMESTAMPTZ`, `consumed_at TIMESTAMPTZ NULL`, `UNIQUE(tenant_id, proposal_id, token)`. **RLS: must add both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` plus the `tenant_isolation_*` policy keyed on `current_setting('app.current_tenant_id')`** — mirror the exact pattern at `db/schema.ts:3537-3541`. Token issued when the outbound notifier sends a money/irreversible SMS; single-use (set `consumed_at` inside the approval transaction); time-boxed (e.g. 30 min). Reuse `idempotency-lock.ts:31` advisory lock keyed by `(tenant\0proposalId)` so a duplicate inbound token reply consumes once.

**DB schema / migration changes**
- `proposal_confirm_tokens` — new table + RLS-FORCE + policy (see above). This is the only new table Epic 0 requires.
- **No new column** needed for routing — `unsupervised_proposal_routing` (`schema.ts:1831-1832`) and `auto_approve_threshold` (`schema.ts:2019-2030`) already exist.

**New contracts / Zod payloads**
- `packages/shared`: an `InboundApprovalCommand` discriminated union — `{ kind: 'yes' | 'approve' | 'approve_all' | 'edit' | 'confirm_token', token?: string }` parsed from `ctx.body`. Keep parsing in `shared` so the web inbox can reuse the same vocabulary later.
- Outbound SMS copy templates (capture vs money/irreversible) as typed builders, co-located with the notifier.

**Integration points**
- SMS inbound: `webhooks/routes.ts:1952` (`POST /twilio/sms/:tenantId`) → `dispatchInboundSms` (`:1881-1891`). The audit write (`sms.inbound.dispatched` / `sms.inbound.unhandled`) is the route's responsibility per `inbound-dispatch.ts:24-27` — extend it to also record `proposal.approved.via_sms`.
- Autonomy engine: approvals flow through `approveProposal`/`approveProposalsBatch`, which already drive execution + 5s undo + idempotency. Do **not** bypass.
- Audit: `audit_events` (`db/schema.ts:60-78`) via the existing `auditRepo.create` pattern.

**Test plan**
- *Unit:* `parseInboundApprovalCommand` (YES / APPROVE / `APPROVE 7421` / APPROVE-ALL / EDIT / junk); confirm-token issue/consume/expire; classifier branch (capture vs money/irreversible) drives the gating decision; notifier branch per routing enum value.
- *Integration:* AC0.1–AC0.7 against in-memory + a test SMS provider. Two of these are isolation-critical: **(a)** an inbound `APPROVE` from tenant A's owner referencing a proposal id that belongs to tenant B must NOT approve tenant B's proposal (RLS + tenant-scoped resolution); **(b)** confirm-token lookup is tenant-scoped — a valid token string from tenant A cannot consume tenant B's token. Add an explicit **two-tenant isolation assertion** for both.
- *Idempotency:* fire the same inbound `messageSid`/body twice; assert one approval + one execution (AC0.7).
- *Build gate:* AC0.8.

#### Tickets

| ID | Title | Scope | Acceptance | Size | Depends on |
|---|---|---|---|---|---|
| **SPINE-1** | Owner-notify primitive + routing read | Extract shared `sendSms` provider from `owner-cell-patch.ts:150`; `notify-owner.ts` reads `unsupervised_proposal_routing` and branches | Given routing `queue_and_sms`, a `ready_for_review` proposal triggers exactly one owner SMS; `queue_only` triggers none (test provider) | S | — |
| **SPINE-2** | Hook notifier into the unsupervised route | Call `notifyOwnerOfProposal` at the `createProposal` callsite (`proposal.ts:515-528`) post-persist; keep `decideInitialStatus` pure | AC0.1 passes; `decideInitialStatus` remains I/O-free (unit test unchanged) | S | SPINE-1 |
| **SPINE-3** | Inbound approve handler (capture path) | New `KeywordHandler` for YES/APPROVE; resolve latest-pending capture proposal for tenant; call `approveProposal`; return confirm SMS; register at `app.ts:661-662` | AC0.2; handler never throws (returns `HandlerResult`) | M | — |
| **SPINE-4** | Screen-gating in handler | Consume `actionClassForProposalType`; bare YES on money/irreversible refused with tap/confirm instruction | AC0.3 (no state change on money YES) | S | SPINE-3 |
| **SPINE-5** | Confirm-token table + issue/consume | Migration `proposal_confirm_tokens` (+RLS-FORCE+policy); issue on money/irreversible notify; consume in approval txn under advisory lock | AC0.4; token single-use + expiring; two-tenant token isolation | M | SPINE-2, SPINE-4 |
| **SPINE-6** | APPROVE-ALL over text | Map APPROVE-ALL → `approveProposalsBatch` (≤50), exclude money/irreversible | AC0.5 (51→50, money skipped) | S | SPINE-3, SPINE-4 |
| **SPINE-7** | Audit + idempotency for SMS approvals | Emit `proposal.approved.via_sms`; advisory-lock dedup on duplicate inbound | AC0.7 (dup SMS → single approval/execution) | S | SPINE-3 |
| **SPINE-8** | Operator voice-approval wiring | Wire `readback.ts` exports into `create-voice-turn-processor.ts`; capture → "say approve", money → "tap to confirm" | AC0.6 (voice approve capture; refuse money) | M | SPINE-4 |
| **SPINE-9** | Two-tenant isolation + build-gate green | Cross-tenant approve/token tests; tsc build gate | Cross-tenant approve is a no-op on B's rows; AC0.8 | S | SPINE-5, SPINE-6, SPINE-7 |

Critical path within Epic 0: **SPINE-1 → SPINE-2 → SPINE-3 → SPINE-4 → SPINE-5** (notify + approve + gate + token is the minimum spine that makes "never open the app" safely true). SPINE-6/7/8 parallelize after SPINE-4; SPINE-9 closes the epic.

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

**Implementation notes (P1 — no ticket breakdown).** The interface already exists: `ProposalAnalyticsRepository` (`analytics.ts:30-33`) with `ProposalOutcome` (`:4-13`) and `AnalyticsSummary` (`:15-28`). Build `PgProposalAnalyticsRepository` behind that interface (mirror `PgProposalExecutionRepository` wired at `app.ts:901,1218`); add a `proposal_outcomes` table (RLS-FORCE + policy, per the `schema.ts:3537-3541` pattern). Wire it at the composition root and call `recordOutcome` from the approve/reject/edit paths in `proposals/actions.ts`. **Threshold-shape caveat:** `tenant_settings.auto_approve_threshold` (`schema.ts:2019-2030`) is currently a JSONB map keyed by **mode** (`{supervisor,both,tech}`), consumed by `resolveAutoApproveThreshold` (`auto-approve.ts:76`). Per-**capability** tuning (R1.3) requires extending that shape to `{ [capability]: { [mode]: number } }` (or a parallel `auto_approve_threshold_by_capability` JSONB) and threading the capability into `ResolveThresholdInput` — note this as a contract change, not a flip. The hard-block (`auto-approve.ts:82`, returns `null` when unsupervised; money/comms/irreversible never reach the threshold branch) must remain untouched (AC1.3).

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

#### Implementation

**Key finding (reduces scope):** the persistence + idempotency substrate already exists. `invoice_dunning_events` is a real table (`db/schema.ts:3520-3541`) with `kind IN ('reminder','late_fee')`, a `step_key` column, `amount_cents`, `channel`, and a `UNIQUE(tenant_id, invoice_id, kind, step_key)` constraint — plus ENABLE+FORCE RLS and the tenant-isolation policy already declared. **No new migration is needed for dunning persistence.** The dead pure functions even document this exact wiring in their headers (`dunning-schedule.ts:1-10`, `late-fee.ts:1-13`): the sweep calls them, sends each step, then records one `invoice_dunning_events` row per step for idempotency.

**Files / modules to touch**
- **Overdue sweep:** `workers/overdue-invoice-worker.ts`. Today it only emits an `invoice.overdue` audit event + a single `transactionalComms.notifyInvoiceOverdue` on the *transition into* overdue (`:92,109-111`). Extend the per-invoice loop (`:74-113`) to, for every overdue (not just newly-overdue) invoice: load sent `step_key`s from `invoice_dunning_events`, call `selectDueReminderSteps(config, { dueDate, now, sentStepKeys })` (`dunning-schedule.ts:35`), and raise one comms proposal per returned step. The current single-fire `notifyInvoiceOverdue` becomes step 0 of the cadence (or is folded into it) — keep the existing audit event.
- **Dunning config source:** `invoices/dunning-config.ts` (`DunningConfig`, `ReminderStep`, `reminderStepKey`). Read per-tenant policy from settings; an empty/disabled config short-circuits (`selectDueReminderSteps` returns `[]` when `!config.enabled`, `:39`).
- **Reminder repo (new):** a thin `InvoiceDunningEventRepository` (read sent `step_key`s by `(tenantId, invoiceId)`; insert reminder/late_fee rows; rely on the table's UNIQUE for race-safety — catch `23505` and treat as already-sent, mirroring the lead-create idempotency pattern at `find-or-create-lead.ts:33`).
- **Late fee:** `computeLateFeeCents(config, input)` (`late-fee.ts:47`) + `daysPastDue` (`:34`). Fee math via `applyBps` from `shared/billing-engine` (`late-fee.ts:15`), integer cents, with the `lateFeeMaxCents` cap honored via `alreadyAccruedCents`. Surface as a **money-class** proposal; record an `invoice_dunning_events(kind='late_fee')` row keyed by accrual period (`step_key='initial'` for one-time, per the schema comment `:3526-3527`).
- **Proposal raising:** reuse `createProposal` (`proposal.ts:515-528`). Reminder steps are comms-class; late fees are money-class — both flow through the gate, so via Epic 0 a reminder is text-approvable and a late fee requires a confirm token. Neither auto-applies (comms/money never auto-approve, `proposal.ts:384`).
- **Driver:** `runOverdueInvoiceSweep` cadence in `app.ts:2927-2939` (setInterval). No new driver — the same hourly sweep now does cadence selection.

**DB schema / migration changes**
- **None for dunning** — `invoice_dunning_events` (`schema.ts:3520-3541`) already exists with RLS-FORCE and the right UNIQUE. (If a tenant-level dunning config column is missing from `tenant_settings`, add it as JSONB with RLS already inherited at the table level; verify before assuming a migration.)

**New contracts / Zod payloads**
- `packages/shared`: a `DunningStepProposalPayload` (invoiceId, stepKey, channel, copyKey/templateId) and a `LateFeeProposalPayload` (invoiceId, amountCents, periodKey). Both validated by Zod, consistent with the typed-proposal-payload rule.

**Integration points**
- Autonomy engine / Epic 0: each step is a proposal; approval (text or auto once trusted) drives the actual send via the existing comms path. **Do not send directly from the worker.**
- Billing engine: all fee math through `shared/billing-engine` (integer cents).
- Audit: keep `invoice.overdue`; add `invoice.dunning.step_raised` / `invoice.late_fee.raised`.

**Test plan**
- *Unit:* `selectDueReminderSteps` already has fixtures — add sweep-level tests that map elapsed days → exact due steps (AC2.1); `computeLateFeeCents` to-the-cent incl. grace, cap, bps rounding (AC2.3); cents-only assertion grep on new files (AC2.5).
- *Integration:* one overdue invoice across two sweeps raises each due step exactly once (AC2.4) — assert via `invoice_dunning_events` rows + UNIQUE-violation-as-noop; each step is a comms/money **proposal**, not a direct send (AC2.2/AC2.3 — assert no comms egress without approval).
- *Two-tenant isolation:* tenant A's overdue sweep never reads or writes tenant B's `invoice_dunning_events` or invoices (RLS holds under the sweep's per-tenant `set_config`). Explicit assertion.

#### Tickets

| ID | Title | Scope | Acceptance | Size | Depends on |
|---|---|---|---|---|---|
| **COLLECT-1** | Dunning-event repo | `InvoiceDunningEventRepository` over existing `invoice_dunning_events`; read sent keys, insert with 23505-as-noop | Sent `step_key`s round-trip per `(tenant,invoice)`; duplicate insert is a no-op | S | — |
| **COLLECT-2** | Wire `selectDueReminderSteps` into sweep | Extend `overdue-invoice-worker.ts` loop to compute due steps for every overdue invoice using config + sent keys | AC2.1 (N-days → exact due steps) | M | COLLECT-1 |
| **COLLECT-3** | Raise comms proposal per step | Each due step → `createProposal` comms-class with `DunningStepProposalPayload`; record event row | AC2.2 (proposal not direct send) | M | COLLECT-2, SPINE-2 |
| **COLLECT-4** | Wire `computeLateFeeCents` | Compute fee via billing engine; raise money-class proposal; honor grace + cap | AC2.3 (to-the-cent, money-class, never auto-applied) | M | COLLECT-1 |
| **COLLECT-5** | Idempotent cadence across sweeps | UNIQUE-backed dedup; re-run sweep is a no-op for sent steps/fees | AC2.4 (no duplicate steps/fees) | S | COLLECT-3, COLLECT-4 |
| **COLLECT-6** | Cents discipline + two-tenant isolation | Grep/assert no float money in new paths; cross-tenant sweep isolation test | AC2.5; tenant A sweep never touches B's rows | S | COLLECT-5 |

Critical path: **COLLECT-1 → COLLECT-2 → COLLECT-3** (reminders live) then **COLLECT-4 → COLLECT-5 → COLLECT-6**. COLLECT-3 depends on SPINE-2 (a raised proposal is only useful once the owner can be notified/approve).

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

#### Implementation

**The "zero app session" determination is the crux.** HFCR is not just "paid invoices" — it is paid invoices whose *every required approval* happened over text/voice. The signal lives in the **approval channel**: an SMS/voice approval (Epic 0) vs an HTTP web approval (`routes/proposals.ts:211-232`). To compute HFCR you must record, per proposal approval, the channel it came through.

**Files / modules to touch**
- **Approval-channel stamp (depends on Epic 0/1):** extend the approval write path (`proposals/actions.ts:35,67`) to record `approval_channel ∈ {web, sms, voice, auto}`. Store on the proposal-outcome row (Epic 1's `proposal_outcomes` table) and/or directly on the invoice/job lineage. A web approval anywhere in the chain disqualifies that invoice from HFCR.
- **HFCR computation (new):** `metrics/hfcr.ts` — `computeHfcrForTenant(tenantId, period, deps)` joining: paid invoices (Stripe webhook `recordPayment`, `webhooks/routes.ts:927,1030`), their originating job/booking (voice-originated), the auto-invoice proposal (`auto-invoice-on-completion.ts:55`), and the approval channel of every gating proposal in the chain. Sum `amount_paid_cents` only where the chain is fully non-web. Integer cents throughout.
- **Hero tile (new, web):** a single tile component (NOT a dashboard) on `HomePage.tsx` rendering current-month HFCR + recovered-call count, using the **shared money formatter** from Epic 5/6 (the same fix that corrects `InvoicesPage.tsx`). Backed by a `GET /me/hfcr` (or similar) read endpoint.
- **Weekly summary (new):** a weekly job (same setInterval-driver style as the overdue sweep `app.ts:2927-2939`) that composes and sends the summary SMS via the Epic 0 `sendSms` primitive; idempotent once-per-tenant-per-week (a `hfcr_weekly_sends(tenant_id, week_key)` UNIQUE, RLS-FORCE).
- **Recovered-call count:** derived from voice sessions that produced a booked-job proposal (`find-or-create-lead.ts:33` lead creation + booking proposal in `create-voice-turn-processor.ts:423-484`).

**DB schema / migration changes**
- Add `approval_channel` to the proposal-outcome row (Epic 1's table) — coordinate with Epic 1.
- `hfcr_weekly_sends` table (idempotency for R3.3) — new, RLS-FORCE + policy (`schema.ts:3537-3541` pattern).

**New contracts / Zod payloads**
- `HfcrSummary` in `packages/shared`: `{ tenantId, periodStart, periodEnd, hfcrCents, recoveredCallCount }`. The web tile and the SMS builder both consume it.

**Integration points**
- Stripe webhook payments (the only authoritative "paid" signal): `webhooks/routes.ts:927,1030`.
- Epic 0 send primitive (R3.3) and Epic 1 channel persistence (R3.1).
- Shared money formatter (Epic 5/6) for the tile (R3.2/AC3.3).

**Test plan**
- *Unit:* HFCR sum over a seeded fixture mixing hands-free and app-touched chains — only hands-free counts (AC3.1); an app-session approval anywhere in a chain excludes that invoice (AC3.2); recovered-call count from seeded voice sessions.
- *Integration:* `GET /me/hfcr` returns the right figure; weekly job sends once per tenant per week (AC3.4) and is idempotent on re-run (`hfcr_weekly_sends` UNIQUE).
- *Two-tenant isolation:* HFCR for tenant A never includes tenant B's payments/proposals (RLS + tenant-scoped query). Explicit assertion.
- *Render:* tile uses the shared formatter; `$X.05` never renders `$X` (AC3.3, shared with Epic 5/6).

#### Tickets

| ID | Title | Scope | Acceptance | Size | Depends on |
|---|---|---|---|---|---|
| **HFCR-1** | Stamp approval channel | Record `approval_channel` on approval in `actions.ts`; persist on outcome row | Every approval records web/sms/voice/auto | S | SPINE-3, Epic 1 outcome table |
| **HFCR-2** | HFCR computation | `metrics/hfcr.ts`: join paid invoices → chain → channel; sum non-web only, integer cents | AC3.1, AC3.2 (app-touched excluded) | M | HFCR-1, COLLECT-3 |
| **HFCR-3** | Read endpoint + hero tile | `GET /me/hfcr`; single `HomePage.tsx` tile via shared formatter | AC3.3 (correct cents, recovered-call count) | M | HFCR-2, GATE-4 (formatter) |
| **HFCR-4** | Weekly summary SMS | Weekly driver; compose + send via Epic 0 primitive; `hfcr_weekly_sends` idempotency | AC3.4 (once/week, correct figure) | M | HFCR-2, SPINE-1 |
| **HFCR-5** | Onboarding payoff + isolation | Surface first hands-free dollar/recovered call at onboarding terminal; two-tenant HFCR isolation test | AC3.4 payoff present; A's HFCR excludes B | S | HFCR-3, HFCR-4 |

Critical path: **HFCR-1 → HFCR-2 → {HFCR-3, HFCR-4} → HFCR-5**. HFCR-2 is the long pole (it depends on COLLECT-3 so the "chase" leg of the loop can be hands-free) and HFCR-3 depends on the shared formatter (GATE-4).

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

**Implementation notes (P1).** No new onboarding *route* — instrument only. Time-to-first-recovered-call = (tenant created at `onboarding/derive-status.ts:59`) → (first voice session that yields a booked-job proposal, `create-voice-turn-processor.ts:423-484`). Concierge is a founder-run runbook using the existing self-serve endpoints (`routes/onboarding.ts`); the guardrail (AC4.3) is enforced by keeping `service-os-app` quarantined (it is the only path that bypasses the gate).

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

#### Implementation

**Files / modules to touch**
- **Money formatter (R5.4, shared with Epic 6/Epic 3):** add a single `formatMoneyCents(cents)` helper (web util) and replace the 9 `.toLocaleString()` calls in `InvoicesPage.tsx` (`:256,257,275,376,552,723,735,744,868`). The correct reference already exists in the edit path (`.toFixed(2)` at `:247`). The HFCR tile (Epic 3) consumes the same helper.
- **`/ready` 503 (R5.5):** the DB health check (`app.ts:530`) only ever returns `{status:'degraded'}`; `health/health.ts:45` keeps `/health` at 200 (Railway liveness), and `/ready` (`:60`) *can* 503 on `down` but never receives `down`. Make the DB check emit `down` on a real connection failure (distinguish a true outage from a slow query) so `/ready` 503s. Verify by simulating an unreachable DB.
- **RLS verify (R5.3):** a prod migration check + live query asserting 75/75 distinct-table ENABLE+FORCE parity (`db/schema.ts`). Note the raw-line-count artifact (≈79 ENABLE / ≈78 FORCE from duplicate ALTERs across migration history) is NOT a gap — assert on the distinct-table set.
- **Two-tenant isolation harness (R5.6):** a reusable test fixture that seeds two tenants and, under each tenant's `set_config('app.current_tenant_id', ...)`, asserts cross-tenant reads/writes return zero rows / are rejected across the key tables (proposals, invoices, `invoice_dunning_events`, `proposal_outcomes`, `proposal_confirm_tokens`, audit_events). This harness is reused by Epic 0/2/3 isolation ACs — build it here once.
- **Webhook-replay drill (R5.7):** a test (and a prod smoke step) that re-posts a processed Stripe event id and asserts the fail-closed dedup (`webhooks/routes.ts:187-194`) makes it a no-op (no duplicate `recordPayment`).
- **Secrets (R5.2):** prod config assertion that `METRICS_TOKEN`, `TRANSCRIPT_ENCRYPTION_KEY`, Stripe/Twilio creds, DB URL are present; `/metrics` 503s without token (`bootstrap/metrics-auth.ts`).

**DB schema / migration changes**
- None — R5.3 *verifies* existing RLS; it does not add tables. New tables introduced by Epics 0/1/3 (`proposal_confirm_tokens`, `proposal_outcomes`, `hfcr_weekly_sends`) MUST be added to the isolation harness's table list.

**Test plan**
- *Integration:* the two-tenant isolation harness (R5.6) as the keystone; webhook-replay no-op (R5.7); `/ready` 503 under simulated DB outage (R5.5).
- *Unit:* `formatMoneyCents` rounding/cents (R5.4).
- *Ops verification (not unit-testable):* prod secrets present (R5.2), prod migration applied + RLS live query (R5.3), CI green on launch commit (R5.1).

#### Tickets

| ID | Title | Scope | Acceptance | Size | Depends on |
|---|---|---|---|---|---|
| **GATE-1** | Two-tenant isolation harness | Reusable fixture; cross-tenant read/write assertions over key tables | R5.6; harness reused by SPINE-9/COLLECT-6/HFCR-5 | M | — |
| **GATE-2** | `/ready` 503 on DB outage | DB check emits `down` on real outage; `/ready` 503s | R5.5 (verified via simulated outage) | S | — |
| **GATE-3** | Webhook-replay drill | Re-post processed event id → no-op; no dup payment | R5.7 | S | — |
| **GATE-4** | Shared money formatter (9 sites) | `formatMoneyCents`; replace `InvoicesPage.tsx` 9 sites | R5.4 ($X.05 never $X) | S | — |
| **GATE-5** | RLS prod verify | Prod migration applied; live 75/75 ENABLE+FORCE query | R5.3 (zero mismatch) | S | — |
| **GATE-6** | Secrets + CI green | Prod secrets asserted; `/metrics` 503 without token; CI green on launch commit | R5.1, R5.2 | S | GATE-1..5 (launch commit) |

GATE-1 and GATE-4 unblock other epics' ACs (isolation tests; HFCR tile). GATE-2/3/5/6 are independent and parallelizable.

---

### Epic 6 — Credibility polish (P1)

**Why:** Demo and first-run landmines erode trust faster than missing features.

**Requirements**
- R6.1 — **Fix the greeting.** Replace hardcoded `<h1>Good morning, Mike ☀️</h1>` **[STUB]** (`HomePage.tsx:323`) with the real signed-in owner's name and real time-of-day.
- R6.2 — **Money formatter for InvoicesPage.** Apply the shared cents-correct formatter to the 9 sites **[BUG]** (`InvoicesPage.tsx` listed lines). (Coordinated with R5.4/GATE-4.)
- R6.3 — **Hide the QuickBooks mock.** Hide `QuickBooksModal.tsx` **[STUB]** (`:23-26`, fake `setTimeout` + hardcoded "#8821") until a real integration exists (non-goal §5). No fake "Connected" state reachable.
- R6.4 — **Delete dead-but-dangerous code with misleading docstrings.** Remove the dead `invoice-payment-reconciler.ts` (`reconcilePayment`, zero callers **[STUB]**, misleadingly named — real reconciliation is the webhook path), and fix the stale comment in `proposal-execution.ts:22-24` that falsely claims "no caller writes this surface yet" (it IS written, `executor.ts:165,259`). Audit `auto-approve.ts:68-69` / `proposal.ts:359-360` comments that promise a non-existent "routing worker" (Epic 0 makes that worker real — update the comments accordingly).

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

**Implementation notes (P1).** Commission = `applyBps(hfcrCents, commissionBps)` via the shared billing engine (integer cents), consuming the Epic 3 `HfcrSummary`. No new metering infra — HFCR is the meter.

---

## 9. P0 critical path

The launch wedge is buildable in this sequence. Tickets across Epics 0/2/3/5 are interleaved so the longest pole (HFCR, which needs both the text spine and live collections) is unblocked as early as possible.

1. **Foundations (parallel, no deps):** `GATE-1` (isolation harness), `GATE-4` (money formatter), `GATE-2` (/ready 503), `GATE-3` (webhook replay), `SPINE-1` (notify primitive), `COLLECT-1` (dunning-event repo).
2. **Spine core (serial):** `SPINE-2` (hook notifier) → `SPINE-3` (inbound approve) → `SPINE-4` (screen-gating) → `SPINE-5` (confirm token). *Exit: "never open the app" is safely true for capture; money requires a token.*
3. **Spine fan-out (parallel after SPINE-4):** `SPINE-6` (APPROVE-ALL), `SPINE-7` (audit/idempotency), `SPINE-8` (voice-approval).
4. **Collections (after SPINE-2):** `COLLECT-2` → `COLLECT-3` (reminders are proposals) → `COLLECT-4` (late fees) → `COLLECT-5` (idempotent) → `COLLECT-6` (cents + isolation).
5. **HFCR (after COLLECT-3 + Epic 1 outcome table + GATE-4):** `HFCR-1` (channel stamp) → `HFCR-2` (compute) → {`HFCR-3` (tile), `HFCR-4` (weekly SMS)} → `HFCR-5` (payoff + isolation).
6. **Close the gates:** `SPINE-9`, `COLLECT-6`, `HFCR-5` consume `GATE-1`; then `GATE-5` (prod RLS verify), `GATE-6` (secrets + CI green on the launch commit).

**Longest pole:** SPINE-1→2→3→4→5 then COLLECT-2→3 then HFCR-1→2→3. Everything else parallelizes around it. Epic 1's `proposal_outcomes` table is a soft dependency of HFCR-1 (the channel stamp lives there) — schedule the Epic 1 persistence ticket alongside SPINE-2 even though Epic 1 is otherwise P1.

---

## 10. Competitive analysis

The trade-software market splits into two camps the wedge sits between — and neither can copy run-by-text without abandoning their own business model.

### 10.1 The incumbents — "a suite you must live in"

| Competitor | What they are | Where they're strong | Why they can't be us |
|---|---|---|---|
| **ServiceTitan** | Enterprise FSM suite (dispatch, CRM, inventory, marketing, payroll, reporting). | Multi-location, high-ACV operators; deep ops + analytics. | Built for the owner who *staffs an office to operate the software*. The product IS the screens. Mike will never log in. Their incentive is to add screens, not remove them. |
| **Jobber** | SMB FSM (scheduling, quoting, invoicing, client hub). | The 1–10-truck SMB; clean UX; the obvious "graduation" tool. | Still "software you operate." An AI add-on bolted onto a suite is still a suite. A tradesperson who won't learn Jobber will reply YES to a text. |
| **Housecall Pro** | SMB FSM + consumer-grade payments/booking. | Solo-to-small; good payments; consumer booking. | Same structural trap — the owner is the operator. Their AI is a feature inside the app, not a replacement for opening it. |
| **Angi (Angie's List)** | Lead marketplace. | Demand generation. | Sells *leads*, not the office. Doesn't answer the phone, book, invoice, or collect. Complementary, not competitive. |

The common failure mode: **they sell a better filing cabinet the owner still has to open.** Every one of them, asked to improve, adds a screen. Their revenue model (per-seat / per-tier SaaS) *requires* the owner to operate the tool — so "the owner never opens the app" is structurally off-limits to them. That is the moat: not a feature they lack, a business model they can't adopt.

### 10.2 The answering services — "dumb call-answering"

Human answering services and basic AI voice-bots (e.g. generic receptionist bots) answer the missed call — and stop there. They take a message or book into a calendar, then hand off. They do **not** run quote-to-cash: no auto-invoice, no Stripe collect, no multi-step dunning, no late fees, no approve-by-text spine, no per-business autonomy earned from history. They capture the front of the pipe and leak the entire back half — exactly the half where HFCR is made.

### 10.3 Our position — "run-by-text + collect," and why it's defensible

We are neither a suite nor a call-answering bot. We **join the two ends of the money pipe** — answer the missed call (front) *and* invoice-and-collect (back) — through an AI that asks permission by text and never makes the owner operate software. Defensibility:

1. **A different product category, not a better feature.** "Remove the app" is incompatible with per-seat SaaS. Incumbents would have to cannibalize their model to copy us.
2. **The interaction model is the moat.** Voice + text, approve-by-reply, never open the app. Copying the AI feature isn't copying the category.
3. **The data moat compounds and is hard to replicate.** Every executed proposal stores its **as-executed payload** **[WIRED]** (`proposal_executions`, `executor.ts:165,259`, table `db/schema.ts:1541-1565`) and every call stores a full **transcript** **[WIRED]** (`voice/pg-voice-audit.ts:126`, encrypted AES-256-GCM `integrations/crypto.ts:15-22`). This is a labeled corpus of *what a trade office actually did, decision by decision, per business* — the exact substrate for per-business/per-capability autonomy (Epic 1). An incumbent can ship an AI button; they cannot retroactively manufacture this run-history per customer. (Today it's underused because proposal-outcome analytics is in-memory-only **[STUB]** `proposals/analytics.ts:35` — Epic 1 turns the latent moat on.)
4. **Outcome pricing aligns us with the moat.** We get paid on HFCR (§14), so our incentive is the owner's collected dollars, not their seat count — the opposite of the incumbents' incentive to keep them logging in.

**The line we hold:** the day we add the suite to "win the comparison," we forfeit the category and become a worse Jobber (§2). Competitive pressure must be answered with *more hands-free dollars*, never more screens.

---

## 11. Financial model sketch (illustrative — assumptions labeled, not audited)

> **All figures below are illustrative founder estimates to frame unit economics, not validated financials.** The real dollar value of a recovered call by trade (§18 Open Q) and the commission ceiling are unknown until field data. Money is integer cents in code; the round numbers here are modeling shorthand.

### 11.1 Pricing shape (from §14)
- **Salary (flat monthly):** anchored to a part-time receptionist/bookkeeper fully-loaded cost (~$2–4k/mo), priced at a fraction — **assume ~$300–500/mo** for the model.
- **Commission:** a small % of **HFCR**. **Assume ~5–10% of HFCR** as the illustrative band (ceiling unvalidated — §18).

### 11.2 Illustrative per-customer unit economics (single owner-operator, monthly)

| Line | Assumption (illustrative) | Monthly |
|---|---|---|
| Recovered missed calls → booked jobs | 4 jobs/mo recovered, avg job $600 (front wedge) | $2,400 booked |
| Hands-free collected (HFCR) | ~70% of recovered + AI-collected existing invoices flow through hands-free | ~$3,000 HFCR (assumed) |
| **Revenue: salary** | flat | **$400** |
| **Revenue: commission** | 7.5% × $3,000 HFCR | **$225** |
| **Gross revenue / customer** | | **~$625/mo** |

### 11.3 Cost drivers (per customer, illustrative)

| Driver | Why it scales | Illustrative monthly |
|---|---|---|
| **LLM gateway** (all AI routed through `packages/api/src/ai/gateway`) | Per in-call turn + per proposal draft + per dunning/summary copy. The cost lever most tied to call volume. | $30–80 |
| **Telephony (Twilio)** | Inbound minutes + A2P 10DLC SMS (proactive notify, approve replies, dunning, weekly summary). Scales with calls + proposal volume. | $20–60 |
| **Stripe** | ~2.9% + 30¢ per collected payment (on collected dollars, not HFCR margin). | varies w/ collected $ |
| **Transcription / storage** | Per-call transcription + encrypted transcript retention. | $5–15 |
| **Infra (Railway, DB)** | Largely fixed/amortized per tenant at small scale. | low |
| **Concierge onboarding (first cohorts)** | Founder time, not COGS at steady state; a CAC line, not a per-month cost. | one-time |

**Illustrative contribution:** at ~$625 gross revenue vs ~$60–155 variable AI+telephony+transcription cost (excluding Stripe pass-through on collected dollars), the per-customer contribution looks healthy *if* the recovered-call and HFCR assumptions hold. **The whole model rises or falls on §18 Open Q4 (real dollar value of a recovered call by trade)** — that single number sets both the wedge ROI and the commission anchor. Treat 11.2 as a sensitivity to that input, not a forecast.

### 11.4 What makes the model investable (not vanity)
Revenue is metered on HFCR, the North Star — so revenue growth *is* delivered-value growth (no seat/usage decoupling). **Revenue retention by HFCR cohort** (§6) is the investability proof: if delivered hands-free dollars predict retention, the commission line compounds with trust (autonomy rung climb, Epic 1) rather than with headcount.

---

## 12. Phased roadmap beyond launch

v1 (Epics 0–7, §8) makes the wedge true. What follows is sequenced strictly so we **earn each step with data and never drift into the suite**. The autonomy-ladder framing (Strategy §5) governs the order.

### Phase 2 — Autonomy rung 2: per-capability auto-act, earned from history (next)
Once the text spine (Epic 0) and persisted outcomes (Epic 1) are live, the `proposal_executions` as-executed history **[WIRED]** plus the new `proposal_outcomes` store reveal which **capture-class** capabilities a given owner *always* approves. Phase 2 raises that owner's threshold for that one capability so the AI stops asking and acts, with the 5s undo **[WIRED]** as the safety net. **Strictly per-business, per-capability, capture-class only.** Money/comms/irreversible never auto-execute — ever, by design (`auto-approve.ts:82`). This is the flywheel's payoff and the direct monetization of the data moat (§10.3). Requires the per-capability threshold-shape extension flagged in Epic 1.

### Phase 3 — Suite expansion as the EXPANSION story only (later, gated)
Only after the wedge is proven (HFCR-positive retention, §6) do we consider adjacent capability — and only where it *deepens hands-free dollars*, never where it adds a screen the owner must live in. Candidate adjacencies are evaluated against one test: *does it raise HFCR without making the owner operate software?* Anything that fails that test is out, permanently. This is the one place "more surface" is allowed, and it is a month-12+ motion, not a launch hedge.

### Later / maybe — the currently-dead/unwired surfaces, explicitly deferred
These exist in code but are dead/one-way today and are deliberately **not** v1, sequenced here so no one mistakes them for near-term:

| Surface | Current state | Why later/maybe |
|---|---|---|
| **Two-way calendar sync** | push-only **[WIRED] one-way** (`integrations/calendar-sync.ts:11-16`) | Push is enough for the wedge. Inbound/pull is a retention nicety, not a hands-free-dollar driver. Build only if scheduling friction demonstrably caps HFCR. |
| **QuickBooks real integration** | pure UI mock **[STUB]** (`QuickBooksModal.tsx:23-26`) | Accounting sync is a month-12 *retention* feature, not a wedge; and a demo landmine until real. Hidden at launch (Epic 6); build only when retention (not acquisition) needs it. |
| **Outbound** | no `calls.create` anywhere **[WIRED] (confirmed absent)**; DNC gates nothing | A compliance minefield and off-thesis (the wedge is inbound). Stays dead unless a consent-clean, owner-initiated use case proves out. |
| **Operator voice-approval at scale / multi-channel** | voice-approval wired in Epic 0; email/DM/web-chat inbox absent by choice | The owner's channel is phone + SMS. Email/chat re-creates "an app you must operate" (§5). Not on the roadmap. |
| **Tech-status OUT/SICK SMS** | built but **not registered [STUB]** (`sms/tech-status/index.ts:29`) | Cheap to re-register on the Epic 0 dispatch registry; a small post-launch quality-of-life add, not a wedge item. |

**Sequencing rule across all phases:** wiring before building; earn autonomy with data; expand only into hands-free dollars; the day expansion becomes "win the feature comparison," stop (§2).

---

## 13. Key user journeys

1. **Missed call → booked job (the front wedge).** Owner is under a sink; phone rings out; AI answers (in-call voice agent **[WIRED]** `twilio-adapter.ts:28-39`), runs lookups, books the slot or captures the lead (lead auto-create **[WIRED]** `find-or-create-lead.ts:33`) as an approval-gated proposal. Owner gets a text, replies **YES**, job is on the books. *(Epic 0 makes the YES possible.)*
2. **Job done → invoice → paid (the back wedge).** Job marked complete → auto-invoice drafts a `draft_invoice` proposal **[WIRED]** (`auto-invoice-on-completion.ts:55`). Owner replies **YES** (or a confirm token, money-class). Invoice sent; customer pays via Stripe **[WIRED]** (`stripe-payment-intent.ts:56-103`); webhook reconciles **[WIRED]** (`webhooks/routes.ts:927`). HFCR ticks up.
3. **Overdue → chased → collected (the dunning tail).** Invoice goes overdue; the sweep raises the next due dunning step as a comms proposal (Epic 2). Owner replies **YES**; reminder goes out; if still unpaid, the next step + (policy-permitting) a late fee proposal follows. Money lands; Time-to-cash drops.
4. **Trust earned → AI stops asking (the ladder).** After the owner has approved the same capture-class proposal type many times (persisted outcomes, Epic 1), that capability auto-approves for that tenant, with 5s undo as the net. Money/comms/irreversible still always ask.
5. **Weekly proof.** Sunday text: "This week I collected $X hands-free and recovered N calls." Owner never opened the app. *(Epic 3.)*
6. **Money/irreversible — the deliberate confirm.** AI proposes a refund/credit (money-class). Owner gets a text with a confirm token; a bare YES is refused; owner replies `APPROVE 7421` to confirm. The screen-tap guarantee is preserved over text. *(Epic 0, R0.4.)*

---

## 14. Pricing & packaging

**Frame: you are hiring an employee, so you pay it like one — a base wage plus commission — not a per-seat SaaS fee.**

- **Base "salary" (flat monthly):** the AI mans the phone and runs the office. Anchored against the fully-loaded cost of a part-time receptionist/bookkeeper (~$2–4k/mo), priced at a fraction (a few hundred dollars/month). The owner compares to a *human*, not to Jobber's $49 tier — that comparison is the pricing power.
- **Commission (outcome fee) — the core innovation:** a small % of **HFCR** — money the AI booked and collected. We get paid when the owner gets paid. It makes the recovered-missed-call wedge self-justifying.
- **One plan, two meters.** No Pro/Enterprise feature ladder (laddering = suite-think). The autonomy *rung* is earned by trust, not bought.
- **Why not per-seat:** seats punish the owner *not* logging in and the AI doing more — both of which are the whole point — and cap revenue at company size.

**Open risk to validate (§18):** commission can feel like a "tax on my own money." May need a cap or a flat-rate escape hatch for variable-pricing-averse owners. Test both.

---

## 15. Launch Definition of Done

Launch is **done** when all of the following hold:

- [ ] **Epic 0 shipped:** proactive owner SMS fires on every proposal needing sign-off; YES/APPROVE/EDIT/APPROVE-ALL handler works; money/irreversible require a confirm token (screen-tap guarantee preserved); voice-approval wired. (AC0.1–AC0.8; SPINE-1..9.)
- [ ] **Epic 2 shipped:** multi-step dunning + late-fee math wired into the overdue worker, idempotent, cents-only. (AC2.1–AC2.5; COLLECT-1..6.)
- [ ] **Epic 3 shipped:** HFCR computed correctly, in-app hero tile + weekly owner SMS summary live, onboarding payoff present. (AC3.1–AC3.4; HFCR-1..5.)
- [ ] **Epic 5 all gates green:** green CI + build gate; prod secrets; prod migration + RLS 75/75 FORCE verified live; money-render fixed; `/ready` 503s on DB outage; two-tenant isolation proof; webhook-replay drill. (R5.1–R5.7; GATE-1..6.)
- [ ] **Credibility landmines removed:** greeting fixed, money formatter applied (9 sites), QuickBooks mock hidden, dead-but-dangerous reconciler deleted + misleading docstrings fixed. (Epic 6.)
- [ ] **Invariants hold:** money/comms/irreversible never auto-execute; all money is integer cents; all mutations emit audit events; all tenants RLS-isolated.
- [ ] **Approval-over-text rate is measurably > 0** for at least one live tenant (proof the spine works in prod).
- [ ] Prototypes (`service-os-app`, `service-os-agent`, `/infra`) quarantined / not deployable.

Epics 1, 4, 7 (P1) are launch-adjacent: pricing and the autonomy ladder can follow within the first weeks; they are not blockers for the wedge to be true, but Epic 7 must be settled before charging the first cohort, and Epic 1's `proposal_outcomes` table must land alongside SPINE-2 because HFCR's channel stamp lives there.

---

## 16. Milestones

- **M0 — Spine (P0, week 1–2):** Epic 0 spine core (SPINE-1..5) + Epic 5 foundations (GATE-1 isolation harness, GATE-2 /ready 503, GATE-4 money-render, build/CI green). *Exit: Approval-over-text rate off zero in staging.*
- **M1 — Collect (P0, week 2–3):** Epic 0 fan-out (SPINE-6..9) + Epic 2 (COLLECT-1..6 dunning + late fees) + Epic 3 (HFCR-1..5 metric + weekly summary). *Exit: HFCR computes end-to-end on a seeded tenant; first hands-free dollar demoable.*
- **M2 — Launch gates (P0, week 3–4):** Epic 5 remainder (GATE-3 webhook replay, GATE-5 prod RLS verify, GATE-6 secrets) + Epic 6 polish. *Exit: Launch DoD green; first cohort onboarded.*
- **M3 — Ladder + price (P1, week 4–6):** Epic 1 (persist outcomes, trust telemetry, tunable thresholds) + Epic 7 (salary+commission billing) + Epic 4 (founder-led concierge for first cohorts). *Exit: at least one tenant auto-acting on a capture capability; commission billing live.*

---

## 17. GTM / distribution

*The product is acquired through the customer's own phone number and proven by their own missed-call money — not through a marketing funnel they'd ignore.*

1. **The phone number IS the install.** Port/forward the business number; the AI answers the next missed call; the **first booked job is the activation event** (terminal onboarding step `test_call` **[WIRED]**). Time-to-first-recovered-call is the activation metric.
2. **Missed-call win-back cold proof.** For a prospect, show "you missed 6 calls this week — here's what I'd have booked." Sells the wedge with the prospect's own lost money. Strictly inbound/consent-clean — no outbound dialing.
3. **Trade-specific channels.** Supply houses, trade associations, distributor counters, the YouTube/Facebook personalities trade owners follow. **One vertical first** (highest missed-call-pain trade, likely HVAC or plumbing emergency work) to nail in-call skills + dunning copy before going horizontal.
4. **Referral with teeth.** Reward tied to the referred shop's *recovered revenue*, not a flat $50 — same outcome-aligned logic as pricing.
5. **Founder-led concierge onboarding** for the first cohorts (white-glove number porting / A2P help) — a sales motion, not a code build (Epic 4).

---

## 18. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Owner won't trust an AI to talk to their customers.** Existential to the front wedge. | One trade first; concierge-led first cohort; emergency escalation **[WIRED]** (`escalate-to-human.ts`); show the recovered-money proof fast. |
| 2 | **Text-approval inbox becomes noise the owner ignores** → Approval-over-text collapses → churn. | Notification batching/cadence (Open Q §19); APPROVE-ALL; weekly summary instead of per-event spam where possible; tune via telemetry (Epic 1). |
| 3 | **Owner approves something half-looking that's wrong** (AI booked a bad slot, quoted low, dunned an already-paid customer). | Reliability-as-feature (Epic 5); 5s undo **[WIRED]**; money/irreversible require confirm token (R0.4); comms/money never auto-execute. |
| 4 | **A bare YES approving a money/irreversible action.** | Confirm-token requirement (R0.4) + screen-gating classifier **[WIRED]** (`proposal.ts:225-322`); AC0.3/AC0.4 enforce. |
| 5 | **Commission feels like a tax on my own money.** | Test cap / flat-rate escape hatch (Epic 7); ROI framing (Epic 3) makes value legible. |
| 6 | **Telephony onboarding friction (porting/forwarding, A2P 10DLC).** "Phone number is the install" assumes this is smooth. | Founder-led concierge for first cohorts; validate the telephony path early (Open Q §19). |
| 7 | **Dunning fires duplicate/wrong reminders** (re-running sweep). | Idempotent cadence (R2.3/AC2.4) backed by the existing `invoice_dunning_events` UNIQUE constraint (`db/schema.ts:3532`). |
| 8 | **Prototypes mistaken for prod** (`service-os-app` bypasses the audit gate). | Quarantine/delete (non-goal §5); guardrail AC4.3. |
| 9 | **QuickBooks mock fires in a demo** ("#8821" fake connect). | Hide it (Epic 6/AC6.3). |
| 10 | **Dropped-call recovery is in-process `setTimeout`** (not durable across restart) **[WIRED] w/ caveat** (`dropped-call-recovery.ts:25`). | Known caveat; out of v1 scope to harden, but flagged; revisit if it bites activation. |
| 11 | **New tenant tables ship without RLS-FORCE** (Epic 0/1/3 add `proposal_confirm_tokens`, `proposal_outcomes`, `hfcr_weekly_sends`). | Mandatory ENABLE+FORCE+policy on every new tenant table (mirror `schema.ts:3537-3541`); GATE-1 harness asserts isolation on all of them. |

---

## 19. Open questions

1. **Will an app-averse owner actually let the AI answer their phone?** Existential to the wedge. Test before scaling.
2. **Will owners reply YES, or will the inbox become noise?** What's the right notification batching/cadence for Epic 0? Drives whether Rung 1 holds.
3. **Outcome-pricing acceptance:** is "% of money I collected" fair or extractive? What % is the ceiling? Is a flat-rate escape hatch required? (Sets the commission band in §11.)
4. **Real dollar value of a recovered missed call, by trade?** Drives wedge ROI, pricing anchor, vertical choice, and the entire §11 financial model. Needs field data.
5. **Which trade first?** HVAC vs plumbing vs electrical vs landscaping differ on missed-call pain, job value, dunning norms, emergency mix.
6. **Number porting/forwarding + A2P 10DLC reality.** If it's a multi-week slog, activation craters. Validate the telephony path.
7. **Liability when the AI is wrong** (bad slot, low quote, dunned a paid customer). Undo + gates limit it; owner tolerance is a business question.
8. **Concierge vs self-serve economics:** does white-glove onboarding lift activation enough to justify the build for a price-sensitive segment? Founder-led test first (Epic 4).
9. **Per-capability autonomy threshold shape (Epic 1/Phase 2):** the current `auto_approve_threshold` JSONB is keyed by mode, not capability (`schema.ts:2019-2030`). What's the minimal contract change to support per-capability tuning without weakening the money/comms hard-block?

---

## Appendix — Verified current-state map (citations)

File-level audit at HEAD `db0dc31` (2026-06-13). Build gate **PASS** (exit 0): `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`.

**WIRED (real, reachable in prod):**
- Web approval single + batch ≤50 — `routes/proposals.ts:211-232`, `:187-209`, cap `:36`; `proposals/actions.ts`; `web/.../InboxPage.tsx`.
- Screen-gating policy (pure fn) — `proposals/proposal.ts:225-322`.
- 38 proposal types — `proposals/proposal.ts:24,26-65`.
- Auto-approve gate (mode-aware 0.90/0.92/0.95, unsupervised hard-block) — `proposals/auto-approve.ts:21-25,32,82`; `proposal.ts:339-408,515-528`. Override map `tenant_settings.auto_approve_threshold` JSONB — `db/schema.ts:2019-2030`.
- 5s undo + advisory-lock idempotency — `proposals/lifecycle.ts:40`; `execution/executor.ts:88-97,164-175`; `execution/idempotency-lock.ts:31`.
- ~30 execution handlers — `execution/handlers.ts:413,472-552`.
- proposal_executions as-executed payload — `executor.ts:165,259`; `app.ts:901,1218`; table `db/schema.ts:1541-1565`. (Stale comment `proposal-execution.ts:22-24`.)
- Estimate AI-draft auto-approve (supervised) — `ai/tasks/estimate-task.ts:116`.
- Auto-invoice-on-completion (drafts a proposal, does not auto-send) — `invoices/auto-invoice-on-completion.ts:55,120-135`; `routes/jobs.ts:343-362`; `app.ts:2411-2419`.
- Stripe pay — `payments/stripe-payment-intent.ts:56-103`; `routes/public-payments.ts:106`; `app.ts:1652`.
- Reconciliation via Stripe webhook — `webhooks/routes.ts:718,927,1030,1075,1504,1637`; `app.ts:696,436`.
- Collections: one overdue nudge — `workers/overdue-invoice-worker.ts:110` (guard `:92`); `app.ts:2927-2939`.
- Dunning-event persistence table (exists, currently unused by any sweep) — `db/schema.ts:3520-3541` (`invoice_dunning_events`, ENABLE+FORCE RLS, `UNIQUE(tenant_id,invoice_id,kind,step_key)`).
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
- Proposal-outcome analytics — in-memory only, unwired; interface + types exist — `proposals/analytics.ts:4-13,15-28,30-33,35`.
- Multi-step dunning — dead code — `invoices/dunning-schedule.ts:35` (consumes `late-fee.ts` `daysPastDue`).
- Late-fee math — zero callers — `invoices/late-fee.ts:47,34`.
- Named Stripe reconciler — dead code — `payments/invoice-payment-reconciler.ts:12`.
- QuickBooks — pure UI mock — `web/.../settings/QuickBooksModal.tsx:23-26,143,190-192`.
- Language/voice overrides — placeholder — `web/.../settings/LanguageSettings.tsx:5-6`.
- review-response Google reply — silent no-op without resolver — `proposals/execution/review-response-handler.ts:201-206`; `handlers.ts:530-535`.
- "Good morning, Mike" — hardcoded — `web/.../home/HomePage.tsx:323`.

**CONFIRMED ABSENT:**
- SMS reply-to-approve handler — `sms/inbound-dispatch.ts:94` (only STOP/START; `compliance/stop-reply.ts:9,12`). Dispatch registry mechanism: `KeywordHandler` interface `:49-52`, `registerKeywordHandler` `:76`, `dispatchInboundSms` (first-token-only) `:94-110`; route `webhooks/routes.ts:1952`, dispatch `:1881-1891`.
- Concierge onboarding path — `routes/onboarding.ts` (self-serve only).

**BUG:**
- InvoicesPage drops cents via `toLocaleString` (9 sites) — `web/.../invoices/InvoicesPage.tsx:256,257,275,376,552,723,735,744,868` (edit path `.toFixed(2)` at `:247` is correct).
- `/ready` never 503s on DB blip — DB check emits only `degraded`, never `down` — `app.ts:530`; `health/health.ts:45,60`.

**Net headline:** the autonomy/approval core is genuinely WIRED and reachable; the drift since the prior audit is uniformly in the degrade direction — the owner's *channel* (proactive SMS, approve-by-text, voice-approval), collections tail (dunning, late fees), and proposal-outcome analytics are dead. The thesis is ~3 wires from true.
