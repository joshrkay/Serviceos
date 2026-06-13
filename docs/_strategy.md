# AI Service OS — Product Strategy

**Date:** 2026-06-13
**Source of truth:** `/home/user/Serviceos/docs/_state-map.md` (verified current-state audit; HEAD `db0dc31`).
**Thesis owner's frame:** Tradespeople are great at the trade, overloaded/reluctant business owners, bad at the business side, and they hate software. The product is an **AI employee** that runs the back office. The app is the AI's toolbox, not the owner's workplace. The owner interacts by voice/text and approves — ideally never opening the app.

---

## 0. The one fact that should reorder the whole roadmap

The audit's punchline: **the hard half is already built and green; the easy-sounding half is dead.**

- WIRED and real: deep in-call voice agent (12 lookup skills + 5 mutation skills), the 38-type proposal engine, the mode-aware auto-approve gate with an unsupervised hard-block, 5s undo, advisory-lock idempotency, as-executed payload capture, Stripe pay + webhook reconciliation, RLS 75/75.
- DEAD or unwired: **SMS reply-to-approve (does not exist), proactive owner notification (`queue_and_sms` has no sender, owner-cell-patch has no caller), operator voice-approval (test-only), multi-step dunning (`selectDueReminderSteps` zero callers), late-fee math (zero callers), proposal-outcome analytics (in-memory, unwired).**

Translation: we have built an AI employee that **can do the work and asks permission correctly — but has no way to reach the owner when the owner isn't already staring at the app.** The entire thesis ("never open the app") is blocked by a notification channel and an approve-by-text handler, not by AI capability. **That is a weeks-not-quarters gap sitting on top of the quarters-of-work moat.** Strategy follows from that asymmetry: stop building new surfaces; connect the owner to the engine that already exists.

---

## 1. Positioning + one-liner

**Positioning:** Not field-service software. An **AI office manager you hire by the phone number.** It answers the calls you miss, books the job, sends the invoice, and chases the money — and texts you only when it needs a yes.

**One-liner:**
> **"It answers your phone and gets you paid. You just reply YES."**

Internal positioning statement: *For the solo-to-10-truck trade owner who is drowning in admin and allergic to apps, AI Service OS is an AI employee that runs quote-to-cash over text and voice. Unlike ServiceTitan/Jobber/Housecall (software you have to operate), the owner operates nothing — the AI does the work and asks permission.*

---

## 2. The wedge and why it's 10x, not incremental

**Wedge = the two ends of the money pipe, joined by an AI that needs no training:**
- **Front:** capture the missed call. The in-call voice agent (twilio-adapter, 12 lookups + book/estimate skills, lead auto-create — all WIRED) answers when the owner is under a sink, and books or quotes.
- **Back:** invoice and collect. Auto-invoice-on-completion drafts the invoice (WIRED), Stripe pay + reconciliation move and confirm the money (WIRED). The collection tail (dunning, late fees) is written and just needs wiring.

**Why this is 10x, not 10%:**
1. **It replaces a person, not a tool.** Incumbents sell a better filing cabinet; the owner still has to open it and do the work. We sell the work *getting done*. The unit of value is "calls answered + dollars collected," not "features available." A tradesperson who refuses to learn Jobber will happily reply YES to a text.
2. **The missed call is pure new revenue, not migrated revenue.** A missed call at a trade is a lost job (~$300–$3,000). Recovering even a fraction is found money the owner never has to manage — the most visceral possible "aha." This is the wedge's emotional 10x: incumbents make existing work 20% easier; we add jobs that were going to disappear.
3. **The interaction model is the moat against incumbents, not the feature list.** Every incumbent's instinct is to add a screen. Ours is to remove the app. A "suite" with a voice add-on is still a suite. Run-by-text is a different *product category*, and it's the one category the trade owner will actually adopt.

**Where this would be a worse incumbent (and we must NOT go there): if we ship a dashboard the owner is expected to live in.** The moment the strategy becomes "all the features of Jobber plus AI," we have built a worse Jobber. The whole reason to exist is that the owner does not operate the software.

---

## 3. North Star metric

**North Star: Dollars collected per tenant per month that the AI moved end-to-end without the owner opening the app.**

Call it **Hands-Free Collected Revenue (HFCR)** — invoiced-and-paid dollars where every required step (book → invoice → chase → collect) was driven by the AI and approved by voice/text, with zero app session. One dollar number, and it can only go up if the *entire compounding loop works over text*. It is deliberately punishing: it forces us to fix the notification + approve-by-text gap (without it, HFCR is structurally near zero because every approval today requires opening the app), and it forces collections to actually fire.

**The core loop it proves (Zuckerberg lens):**
> **call answered → job booked → work done → invoice sent → payment collected → (data captured) → AI trusted with more.**
Each turn of this loop raises the owner's trust, which earns the AI a higher rung on the autonomy ladder, which raises hands-free throughput — a compounding loop, not a funnel.

**Supporting metrics (diagnostic, not the goal):**
- **Missed-call recovery rate** — % of unanswered inbound calls that become a booked job or live lead. Proves the front.
- **Approval-over-text rate** — % of proposals approved without an app session. Proves "never open the app" is real. **Today this is ~0 by construction** (no SMS approve handler) — it is the single most important number to move off the floor.
- **Time-to-cash** — completion → payment received, in hours. Proves the back tail (dunning) is live.
- **Autonomy rung mix** — share of tenants at tap / text / auto. The flywheel's gauge.
- **Revenue retention by HFCR cohort** — does delivered hands-free money predict who stays. The investability proof.

**Vanity metrics to explicitly ignore:** seats, MAU, logins, "AI calls handled" (handling a call that books nothing is theater).

---

## 4. Scope cuts / explicit non-goals

Decision-forcing. Each is a thing the code *could* grow into and must not.

1. **NO general field-service suite.** No crew GPS, no inventory/parts management, no marketing-campaign builder, no job-costing analytics console. Every screen we add is a step back toward being a worse ServiceTitan. The app is the AI's toolbox; humans visit it rarely.
2. **Kill or quarantine the prototypes — now.** `service-os-app` (Next.js, **bypasses the proposal/audit gate** — directly contradicts "never auto-execute"), `service-os-agent` (Python LangGraph, known defects), and `/infra` (CDK deployed by nothing) are strategic liabilities that dilute the one product. One canonical product on Railway. Delete the forks or wall them off so no one confuses them for production.
3. **NO QuickBooks build yet.** QBO is a pure UI mock (`QuickBooksModal.tsx` — `setTimeout` + hardcoded "#8821"). It is a **credibility landmine in demos** and an integration tar pit. Either hide it until real, or do read-only export. Accounting sync is a retention feature for month 12, not a wedge.
4. **NO outbound AI cold-calling.** DNC/consent gating is built with nothing to gate (no `calls.create` anywhere). Outbound dialing is a compliance minefield and off-thesis. The wedge is *inbound* missed calls. Leave it dead.
5. **NO two-way calendar sync, NO multi-channel inbox (email/DMs/web chat) for v1.** Calendar is push-only (fine). The owner's channel is **phone + SMS**, the two things a tradesperson already lives in. Adding email/chat surfaces re-creates the "app you must operate."
6. **NO unsupervised money/comms autonomy — ever, by design.** The gate already hard-blocks comms/money/irreversible from auto-approval. Keep it. The product's trust story *depends* on "the AI never spends or speaks for you without a yes." This is a feature, not a limitation — market it.
7. **Defer the analytics/dashboard layer.** Proposal-outcome analytics is in-memory and lost on restart. Persist it (cheap, high-leverage — see moat) but do **not** build owner-facing charts. The owner does not want a dashboard; investors and the model do.

---

## 5. The autonomy-ladder roadmap (Altman lens)

The product earns trust per business and climbs rungs. This is the roadmap. **The state map says rung 1 exists, rung 2's channel is dead, rung 3's gate exists but is unreachable.** So the roadmap is mostly *wiring what's already built*, in trust order.

**Rung 0 — Tap-on-screen (SHIPPED).** Web approve, single + batch ≤50, screen-gating policy, undo, idempotency. All WIRED. This is the floor and it works. *Nothing to build.*

**Rung 1 — Reply-by-text (THE UNLOCK — build first).** The thesis is blocked here and only here.
- (a) **Proactive owner notification:** wire a sender that reads `unsupervised_proposal_routing`/`queue_and_sms` and actually sends the SMS. The setting, schema, and routing all exist (`proposal.ts:399`); **no code sends.** Build the sender.
- (b) **SMS reply-to-approve handler:** register an APPROVE/YES keyword (and a money/comms tap-to-confirm fallback) in `inbound-dispatch.ts`. The classifier and screen-gating policy already decide what's text-approvable vs tap-only — consume them.
- (c) **Operator voice-approval:** wire `readback.ts` (`isVoiceApprovable`, `classifyVoiceApproval`) into a runtime handler. Built and unit-tested; **test-only today.**
- **This rung alone makes "never open the app" true and moves Approval-over-text rate off zero.** It is the highest-leverage work in the entire product. Estimate: small, because the engine underneath is done.

**Rung 2 — AI-just-did-it, per capability, per business (earn it with data).** Once text approval works, the as-executed payload history (`proposal_executions`, WIRED) shows which capabilities a given owner *always* approves. Raise that owner's threshold for that one capability so the AI stops asking and acts, with the 5s undo as the safety net. Capture-class only; comms/money stay gated forever. **Autonomy is granted per-business and per-capability from observed approvals — not a global toggle.** This is the flywheel's payoff and the reason to capture the data.

**Rung 1.5 — Make collections actually collect (parallel, do alongside Rung 1).** Today: one overdue nudge, then silence. Wire `selectDueReminderSteps` (multi-step dunning, dead) and `computeLateFeeCents` (late fees, dead) into the overdue worker. Each dunning step is a comms-class proposal the owner approves by text (Rung 1) or, once trusted, auto-fires (Rung 2). **This is where Time-to-cash and HFCR actually move** — and it's mostly connecting written-but-dead code.

**Ordering rule:** wiring before building. Every rung-1/1.5 item is "connect existing code," which is why the AI-employee thesis is closer to true than a feature audit would suggest. Don't build new model scaffolding the next model deletes (Altman) — the in-call agent and proposal engine are the durable substrate; the gaps are plumbing.

---

## 6. Pricing approach — price the employee, not the seat

**Frame: you are hiring an employee, so you pay it like one — a base wage plus commission — not a per-seat SaaS fee.**

- **Base "salary" (flat monthly):** the AI mans the phone and runs the office. Anchor against the cost of a part-time receptionist/bookkeeper (~$2–4k/mo fully loaded), priced at a fraction — a few hundred dollars/month. The owner is comparing to a human, not to Jobber's $49 tier, and that comparison is the whole pricing power.
- **"Commission" (outcome fee) — the core innovation:** a small % of **HFCR** — money the AI booked and collected. This aligns price with the North Star: we get paid when the owner gets paid. It makes the front-end wedge (recovered missed calls) self-justifying — the owner happily pays a cut of money they otherwise never would have seen.
- **Why not per-seat:** seats punish the exact thing we want (the owner *not* logging in; the AI doing more). Per-seat caps our revenue at the size of a tiny company. Outcome pricing scales with the value delivered and is the AI-native model (Altman): you don't sell seats to an employee.

**Packaging cut:** one plan, two meters (salary + commission). No "Pro/Enterprise" feature ladder — feature laddering pushes us back toward suite-think. The *autonomy rung* a business reaches is earned by trust, not bought.

**Open risk to validate (see §8):** outcome fees can feel like a "tax on my own money." May need a cap, or to fold it into a higher flat tier for owners who hate variable pricing. Test both.

---

## 7. Distribution options to test

The buyer hates software *and* hates being sold software. Distribution must meet them where they already are.

1. **The phone number IS the install.** Onboarding's terminal step is `test_call` (WIRED, 7-step self-serve). Lean into it: port/forward the business number, the AI answers the next missed call, and the **first booked job is the activation event.** Time-to-first-recovered-call is the activation metric. Frictionless because the product demos itself on a real missed call.
2. **Missed-call "win-back" cold proof.** Hardest, highest-converting: for a prospect, detect/observe missed calls and show "you missed 6 calls this week — here's what I'd have booked." Sells the wedge with the prospect's own lost money. (Stay strictly inbound/consent-clean — no outbound dialing, §4.)
3. **Trade-specific channels, not generic SMB ads.** Supply houses, trade associations, plumbing/HVAC/electrical distributor counters, and the YouTube/Facebook personalities trade owners actually follow. One vertical first (pick the highest missed-call-pain trade — likely HVAC or plumbing emergency work) to nail the in-call skills and dunning copy before going horizontal.
4. **Referral with teeth.** Trade owners trust other trade owners over any ad. Referral reward tied to the referred shop's *recovered revenue*, not a flat $50 — same outcome-aligned logic as pricing.
5. **"Concierge" white-glove onboarding as a sales motion (note: not built).** No concierge path exists in code (self-serve only). A human-assisted setup for the first cohorts would lift activation for app-averse owners — but it's a build, not a flip. Test manually (founder-led) before deciding to build the route.

**Distribution answer in one line:** *the product is acquired through the customer's own phone number and proven by their own missed-call money* — not through a marketing funnel they'd ignore.

---

## 8. Open business questions (cannot be derived from code)

1. **Will an app-averse owner actually trust an AI to talk to their customers on the phone?** The entire front wedge rests on this. The in-call agent is built; whether the target persona *lets it answer* is unknown and existential. Test before scaling.
2. **Will owners reply YES to text approvals, or will the inbox become noise they ignore?** Rung 1 is the unlock, but if proposals arrive faster than owners triage, approval-over-text collapses and they go back to the app (or churn). What's the right notification batching/cadence?
3. **Outcome pricing acceptance:** does "% of money I collected" feel fair (commission) or extractive (a tax)? What % is the ceiling before owners revolt? Is a flat-rate escape hatch required?
4. **What is the real dollar value of a recovered missed call, by trade?** Determines wedge ROI, pricing anchor, and which vertical to start in. Needs field data, not code.
5. **Which trade first?** Missed-call pain, job value, dunning norms, and emergency-vs-scheduled mix differ sharply (HVAC vs plumbing vs electrical vs landscaping). Pick the one where the wedge is most acute.
6. **Number porting/forwarding friction and carrier/compliance reality (A2P 10DLC registration).** "The phone number is the install" assumes porting/forwarding and SMS sender registration are smooth. If they're a multi-week slog, activation craters. Validate the telephony onboarding path.
7. **Liability when the AI is wrong.** It booked a slot that didn't exist, quoted too low, or dunned a customer who'd already paid. The undo window and approval gates limit this, but the owner's tolerance for AI mistakes-in-front-of-their-customers is a business/trust question, not a code one.
8. **Concierge vs self-serve economics:** does white-glove onboarding lift activation enough to justify the cost and the build, for a price-sensitive segment? Founder-led test first.

---

## Summary of the strategic calls

- **The thesis is ~3 wires from true, not quarters away.** The audit shows the AI-employee *engine* (voice agent + proposal/autonomy gate + money rails) is WIRED; what's dead is the owner's *channel* (proactive SMS sender, SMS approve handler, voice-approval). Build those first — everything else is downstream.
- **One North Star: Hands-Free Collected Revenue** — dollars the AI moved booking-to-cash with zero app session. It forces both the text-approval unlock and live collections, and it's the number investors and the pricing model both key off.
- **Pricing = salary + commission on HFCR**, not per-seat. Compare to a human employee; get paid when the owner gets paid; per-seat is structurally anti-thesis.
- **Roadmap = an autonomy ladder built mostly by wiring dead code:** Rung 1 reply-by-text (the unlock), Rung 1.5 wire dunning + late fees so collections actually collect, Rung 2 per-business/per-capability auto-act earned from the as-executed approval history (the data moat).
- **Hard scope cuts:** no FSM suite, no QBO until real (it's a demo landmine), no outbound calling, no email/chat inbox, prototypes deleted/quarantined (`service-os-app` bypasses the audit gate), comms/money never auto-approve.
- **Distribution = the phone number is the install**, proven by the owner's own recovered missed-call money; one trade first.
- **The latent moat is the captured data** (proposal_executions as-executed payloads + full voice transcripts) — but it's wasted while proposal-outcome analytics is in-memory-only. Persist it; it's what powers per-business autonomy and is hard for incumbents to replicate.
