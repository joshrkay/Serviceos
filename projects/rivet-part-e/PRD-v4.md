# Rivet — Product Requirements v4

**Status:** DRAFT — **A, B, C written. D, E, F are stubs — see each section for what produces it.**
**Created:** 2026-07-28 · **Revised:** 2026-07-28 (rev 5)
**Supersedes:** ⚠️ **UNRESOLVED** — see §0.2. Until this is decided, this document has no authority and `docs/PRD-v3.md` remains canonical.
**Do not read D/E/F as pending-and-fine.** Part E in particular is the document's evidence base, and nothing in A–C is verified until it exists.

> **Rev 5 changes:** Added explicit **Part D / E / F stub sections** with locked schemas and blocking status. Previously these existed only as a line in the header, which read as "pending and fine" rather than "the evidence base is missing."
>
> **Rev 4 changes:** Added **C8 Runtime truth** (code truth ≠ runtime truth) and **rung 6 "Live"** to the done ladder, grounded in the 2026-07 audit findings.
>
> **Rev 3 changes:** Added **Part C — Definition of Done & the Quality Bar**, anchored on the existing Launch Quality Bar. Parity/state/decisions shift to Parts D/E/F. **Resolved the scale question (C4.1):** 1,000 concurrent is the architectural design target and a standing design constraint; the launch gate is ~200 with a measured per-instance ceiling.
>
> **Rev 2 changes:** Added **B1 Setup & Tenant Foundation** (the lifecycle previously began at "the phone rings" — tenant provisioning, users, the money rail, and territory were entirely absent). Added **B2 Situational Context** (geographic and temporal grounding for voice). Added native mobile to A8 as a flagged scope reversal. Sections B3–B11 are the former B1–B9, renumbered — **"Narrate" moved from B5 to B7.**

---

## 0. How to use this document

### 0.1 The rule that keeps this document from rotting

**This document describes intent. It does not describe build state.**

Every prior PRD merged the two, and each time reality moved, the document was rewritten to match it — which is how the original intent got sanded off across v1 → v2 → v3.2. That is the loop this version exists to break.

| Question | Document | Changes when |
|---|---|---|
| What are we building and why? | **This document (A + B + C)** | Strategy changes. Rarely. |
| Where does Jobber still beat us? | Part D — parity appendix | Competitor ships something |
| Did we actually build it? | Part E — state table | Every code audit |
| What's still undecided? | Part F — decisions register | A decision closes |

**Part E is generated from the codebase, never authored.** If you find yourself editing build status in this file, stop — that belongs in E. The absence of ✅/🔧/📋 markers in Part B is deliberate.

### 0.2 Open: supersession

This document cannot become canonical until it is decided whether it retires:

- `docs/PRD-v3.md` (v3.2, 2026-06-14)
- `RIVET-MASTER-PRD-voice-ai.md` (2026-07-12)
- `docs/PRD-execution-catalog.md`

Recommendation: **A + B supersede the strategy and requirements sections of all three; the execution catalog survives as a story index only.** Old files move to `docs/archive/` with a header pointing here. Without this, we have four documents claiming authority and the loop continues.

### 0.3 Naming

The product is **Rivet**. "ServiceOS" is retired and should not appear in any new artifact, code comment, or customer-facing surface. Existing occurrences are a cleanup task, not a decision.

---

# PART A — THE SPINE

*This section should change roughly once a year. If it's changing more often, something upstream is wrong.*

## A1. The product in one sentence

**Rivet is the office manager a 1–3 truck shop can't afford: the owner does the trade work, tells Rivet what happened, and Rivet runs the entire back office.**

The longer version: the AI owns the system of record and *writes to it* — every action as a typed proposal the owner approves with one tap. Competitors' AI sits on top of their system and hands every decision back to the human. Ours is the system.

## A2. The thesis

Owner-operators in the trades do not fail because they are bad at the trade. They fail from **administrative debt** — the compounding backlog of calls not answered, quotes not sent, invoices not chased, and follow-ups not made, accumulated by one person who is also the technician.

The defining characteristic of the ICP is not company size. It is **single-threaded admin load**: one person, or no person, doing all of the office work. That person is who Rivet replaces.

The demo writes itself: *owner under a sink; phone rings; appointment books itself; invoice issues from a spoken sentence; QuickBooks updates overnight.*

## A3. North star

**Owner hours returned per week.**

Measured against a structured time-diary baseline captured at onboarding, re-measured at weeks 4 and 8. **Target: 12+ hours/week for the median pilot at week 8.**

Secondary: **time-to-cash** — median days from job completion to payment received. Target < 10 days against a 14–21 day baseline.

Every feature is judged by whether it adds to or subtracts from these two numbers. Nothing else is a success metric.

## A4. Who this is for

**Primary ICP:** Owner-operator home-service shops. 1–3 trucks, no dedicated office staff, $200K–$1M revenue, in HVAC, plumbing, or electrical.

**The sweet spot:** the experienced tradesperson going independent — leaving a large company to start their own shop — and the 1–3 person shops they become. Masters of the field work, allergic to the office work.

### Personas

| | **Mike Rivera** | **Jenna Walsh** | **The Independent** |
|---|---|---|---|
| Trade | HVAC, Phoenix | Plumbing, Cleveland | HVAC / plumbing / electrical |
| Shape | 38, 2 trucks, 1 employee (Carlos) | 41, solo, wants to stay solo | Just left a 500-person company |
| Revenue | $680K | $340K | $0 → building |
| Real job title | Dispatcher, CSR, estimator, bookkeeper, collections agent, marketing manager — and HVAC tech | All of the above, alone | Doesn't know yet |
| Why Rivet | Admin load is strangling a working business | Single-threaded load makes it *more* urgent, not less | No systems, no price book. Rivet is the first software they buy. |
| Funnel role | Core | Core | **Top of funnel** — becomes Mike or Jenna |

**Design against the bad day, not the good day.** Mike's bad day: stale labor rate in a quote, hallucinated part, missed emergency, dropped call, customer gaming the price, tech no-show, 1-star review. Jenna's bad day: property-manager account not recognized, photo quote too generic, wrong labor rate on an invoice, no-show notice to the wrong customer. Every one of those is a product requirement.

### Anti-personas — do not optimize for these

- The dispatcher at a 12-truck shop → wants ServiceTitan
- The franchise owner → wants brand-compliance tooling, not a back office
- The hobbyist / side-hustle tradesperson → revenue doesn't justify the price
- **The owner who wants AI fully unsupervised** → that is a different trust contract and a different product

**Disqualifying signals:** 5+ employees with a dedicated office manager · already on ServiceTitan and satisfied · aspires to a 20-truck fleet · does not carry a smartphone.

## A5. The non-negotiables

These constrain every feature. A design that breaks one is wrong by definition — find another way.

**Product**

1. **Voice is the primary interface, both directions.** The owner speaks to run the back office; customers speak to book. SMS is the async approval channel. The web app is for audit, configuration, and oversight — **no daily action requires opening it.**
2. **AI proposes, owner approves.** Every action is a typed proposal. Nothing executes without explicit human approval. The single exception is low-risk, high-confidence *capture-class* proposals where the owner has pre-authorized the category.
3. **Approval is a control act, not a labor act** — and is deliberately **not** voice-reachable. See B0.
4. **Confidence is surfaced, not hidden.** Where the system is unsure — parts, prices, urgency, account identity, *location* — the doubt is visible before anything goes out.
5. **A supervisor agent reviews every booking and quote.** A second, cheaper classifier catches missed urgency, pricing anomalies, brand-voice drift, and account-routing errors, within 60 seconds.
6. **Emergency intent overrides automation.** Urgency + vulnerability signals route to the owner's phone immediately — triage, not booking.
7. **The AI never discounts or commits to scope changes.** Pricing pushback and scope expansion route to the owner with a recommendation. The AI refuses to negotiate.
8. **Brand voice is configurable, then locked.** Every AI utterance sounds like the shop.
9. **Every AI mistake is a learning event.** The owner's correction updates the system; the digest reports what was learned.
10. **The litmus test: no feature ships that adds admin work to the owner's day.**

**Engineering** *(from `CLAUDE.md`; enforced, not aspirational)*

Money is integer cents · time stored UTC, rendered tenant-local · every row carries `tenant_id` with **RLS FORCE** · every mutation emits an audit event · all AI calls route through the **LLM gateway** · proposals are typed **Zod** contracts, human-approved, never auto-executed · AI-drafted prices are **catalog-resolved** before a proposal is built · high-stakes outputs pass the supervisor agent · **no component is architected in a way that structurally precludes 1,000 concurrent sessions** (see C4).

## A6. The wedge

| Competitor | What they are | Where we win |
|---|---|---|
| **Jobber** | The direct head-to-head at this ICP. Genuinely good software. Its AI is a bolt-on that hands every decision back to the human. | *Jobber gives you better paperwork. Rivet does the paperwork.* Their AI sits on top of the system; ours **is** the system. |
| **ServiceTitan** | Enterprise. Built for big fleets with office staff, priced accordingly. | We serve the 1–5 person shop and price for one. Not a feature fight — a segment they've abandoned. |
| **Avoca** | Voice-native AI receptionist for trades. **The only competitor attacking our actual differentiation.** | Avoca answers the phone and stops. Rivet answers the phone *and* books, quotes, invoices, and collects. Our moat is the closed loop, not the voice. |
| **Housecall Pro** | Mid-market horizontal FSM. | Same as Jobber, less depth. |

⚠️ Avoca is the competitor to track. Anyone who closes the loop behind a voice receptionist is attacking the wedge directly. Parity gaps against Jobber cost us deals; Avoca closing the loop costs us the thesis.

## A7. Why now

1. Real-time voice models can hold a competent service conversation for under **$1/min** in COGS.
2. Twilio + Stripe + SMS + payment-link APIs are mature enough for an AI to run a full money flow end to end.
3. The owner-operator labor crisis: no admin staff available, no time to train one. "Hire a receptionist" is no longer an option — so the AI *is* the receptionist, bookkeeper, and dispatcher.

## A8. Scope at launch

**Verticals: HVAC · Plumbing · Electrical.**
**Platform: native mobile app · responsive web.**

Both of these are **changes from PRD-v3 that need logged decisions.** Neither should appear silently in a new PRD. Precedent: the multi-location plan reversed a standing PRD non-goal and was gated on a formal `docs/decisions.md` entry before any code was written. → **Part F.**

### ⚠️ Reversal 1 — Electrical at launch

PRD-v3 §9 sequences verticals as Wave 1 (HVAC + plumbing) → Wave 2 (electrical + pest control) → Wave 3 (painting + handyman). Launching electrical requires an electrical **vertical pack** that does not exist today.

The pack is already specced in PRD-v3 §9 — permit-aware estimates with AHJ-confirmation prompts, two-person job detection, an NEC-compliance guardrail (the AI never gives code advice or certifies compliance; it surfaces compliance questions as confidence markers only), EV-charger and panel-upgrade tiered templates, license-verification flags on dispatch proposals, and electrical emergency indicators (arcing, burning smell, smoke, sparks, complete outage). **Specced is not built.**

### ⚠️ Reversal 2 — Native mobile at launch

PRD-v3 treats native mobile as roadmap: the parity map lists tech mobile as "PWA (Capacitor native roadmap), Jobber leads," and risk-register item 8 is explicitly *"native mobile gap loses customers to Jobber."* Making it a launch requirement reverses that.

**This is not only a distribution decision — it unlocks capability the PWA cannot deliver:**

| Capability | Why native matters |
|---|---|
| Background location | B5 ETA and B2 geographic grounding depend on location while the app is backgrounded. Browsers throttle or kill this. |
| Reliable push | Approval prompts currently lean on SMS. Native push is cheaper, richer, and doesn't consume the SMS approval budget in B11. |
| Voice capture reliability | Push-to-talk and mic permissions in a mobile browser are the weakest link in B7 — the single most important interaction in the product. |
| Offline capture | B6.4 queue-and-sync is materially more reliable natively. |
| Store presence | A tradesperson looks for software in an app store. Absence reads as "not real." |

**Open sub-decision:** native (React Native / Expo, store-distributed) vs. Capacitor wrapping the existing PWA. Capacitor is far cheaper given the shipped web app and delivers store presence, background location, and push. It does not fix the voice-capture weak link as thoroughly. **Recommendation: Capacitor for launch, measured against B7 voice reliability, with native re-evaluated after pilot.** → Part F.

### Explicit non-goals at launch

Pest control · painting · handyman · marketing automation · route optimization beyond drive-time feasibility · full autonomous operation · Rivet holding customer funds (see B1.7).

---

# PART B — LIFECYCLE REQUIREMENTS

*Organized by the path a job takes through the business, not by feature area. A feature-area organization (CRM / Jobs / Invoicing / Dispatch) is the Jobber-parity shape — it is unbounded and it is why previous versions kept growing. Under this shape, scope is testable: **a requirement belongs here if it is a step in the lifecycle. Competitive checkboxes that aren't lifecycle steps go to Part D.***

## B0. The voice test — and its one deliberate exception

Every requirement below is tagged:

| Tag | Meaning |
|---|---|
| 🎙️ **Voice** | Must be doable with a spoken sentence while driving. If it isn't, the feature is not complete. |
| 📱 **Tap** | Screen or SMS. Deliberately not voice. |
| ⚙️ **System** | Automatic. No human initiation. |

**The exception, stated plainly:** proposal approval, rejection, and editing are **hard-refused on the voice channel** (`RV-071/225`) and approve by screen or SMS tap at launch.

This is a locked decision (D-013), not a gap. The reasoning: approval is a *control* act, not a labor act. The delta between a tap and a spoken word is roughly 15 seconds a day, measured against a north star of **hours** returned per week — not worth opening an audio-triggered path to money movement. Anyone reading this document and filing "voice approval" as a missing feature has misread it.

---

## B1. Setup — the tenant becomes operational

*Trigger: an owner signs up. Nothing in B3–B10 works until this section is complete.*

**Time-to-value target: signup → first AI-handled call in under 24 hours.**

### Tenancy and identity

| # | Requirement | |
|---|---|---|
| B1.1 | Tenant is provisioned on first owner signup; auth is email+password or Google SSO | 📱 |
| B1.2 | **Every row carries `tenant_id` with RLS FORCE.** Tenant is the security boundary — not an application-level filter | ⚙️ |
| B1.3 | Multiple users per tenant, each with their own login and identity | 📱 |
| B1.4 | Roles: owner · admin · dispatcher · technician. **Technicians cannot approve financial proposals.** | ⚙️ |
| B1.5 | Owner invites team members; invited technicians get a short 2–3 question setup (name + phone), then land in the field view | 📱 |
| B1.6 | Every user action is attributable in the audit trail, including which human approved which proposal | ⚙️ |

### The money rail

| # | Requirement | |
|---|---|---|
| B1.7 | **Each tenant connects their own Stripe account. Customer payments settle into the tenant's bank account. Rivet never holds tenant funds.** | 📱 |
| B1.8 | The owner initiates and completes bank connection from inside the app — Stripe-hosted onboarding, KYC, and payout setup, no support ticket, no manual back-office step | 📱 |
| B1.9 | Connection status is visible and recoverable: not-started / pending-verification / restricted / active, with the specific blocking requirement surfaced when Stripe asks for more | 📱 |
| B1.10 | **Nothing in B9 that moves money is enabled until the connection is active.** Invoices can be drafted; sending a payable invoice is blocked with a clear reason, never a silent failure | ⚙️ |
| B1.11 | No embedded card or bank fields anywhere in Rivet — Stripe-hosted surfaces only (D-009, PCI scope) | ⚙️ |
| B1.12 | Rivet's own subscription billing is a **separate concern** from the tenant's Connect account and must never be confused with it in code or UI | ⚙️ |

> **Note for Part E:** `packages/api/src/billing/stripe-connect.ts` exists, but Connect **onboarding UX** was explicitly scoped out of the quote-to-cash verification campaign as "a separate tenant-billing concern." Backend presence is not the same as an owner being able to self-serve a bank connection. B1.7–B1.11 need verification, not assumption.

### Business configuration

| # | Requirement | |
|---|---|---|
| B1.13 | Phone number provisioned in-app: area-code search → pick → claim → ready, with status polling | 📱 |
| B1.14 | **Service territory** — home base address plus service radius or named areas. Load-bearing for B2. | 📱 |
| B1.15 | Business hours, timezone, after-hours policy | 📱 |
| B1.16 | Price book / catalog imported or built. **Without it, the catalog resolver in B8.2 has nothing to resolve against.** | 📱 |
| B1.17 | Vertical pack selected (HVAC / plumbing / electrical); multi-trade is supported and layers additively — adding a second vertical never resets the first | 📱 |
| B1.18 | Brand voice captured, then locked | 🎙️ |
| B1.19 | Conversational onboarding agent — target 10–15 exchanges covering pricing, team, and tools, with a recursive clarification loop when an answer opens a new question | 🎙️ |
| B1.20 | Onboarding is skippable with a persistent banner; dependency gaps show as inline notes, not blocks | 📱 |

## B2. Situational context — what the system knows before anyone speaks

**A spoken sentence is radically underspecified. This section is what makes it resolvable.**

When a tradesperson says *"the Elm Street job,"* they mean the Elm Street a quarter mile away — not one of the several hundred Elm Streets in the country. Every ambiguous reference must be resolved against a standing model of where this tenant works, where this speaker is right now, and who they deal with. Getting this wrong doesn't produce an error; it produces a **confidently wrong address on a real job**, which is worse.

| # | Requirement | |
|---|---|---|
| B2.1 | Every tenant has a **service territory** (B1.14). It is the outermost prior on every location interpretation. | ⚙️ |
| B2.2 | Address interpretation is biased in this order: **(1)** tenant service territory → **(2)** speaker's current location → **(3)** the referenced customer's known addresses → **(4)** recent job locations | ⚙️ |
| B2.3 | A partial address (*"Elm Street," "the Maple house," "1120 Oak"*) resolves to the candidate inside the service territory; ties break by proximity to the speaker | ⚙️ |
| B2.4 | **An address outside the service territory is never silently accepted.** It becomes a clarification or a confidence marker, always. | ⚙️ |
| B2.5 | Addresses are geocoded and validated before they land on a job or an appointment | ⚙️ |
| B2.6 | Ambiguity produces a one-tap clarification, never a guess — the same contract the entity resolver already honors for customers and jobs | ⚙️ |
| B2.7 | Relative time (*"Thursday at 2," "tomorrow morning," "end of the week"*) resolves in **tenant-local time**, stored UTC | ⚙️ |
| B2.8 | The system knows **who is speaking** — owner or technician — and that shapes both what they can do and what "my schedule" or "my jobs" means | ⚙️ |
| B2.9 | Person and company names resolve against **this tenant's** customer list, never globally | ⚙️ |
| B2.10 | Location context is available to the inbound call agent too — a caller giving a cross-street or a landmark is resolved the same way | ⚙️ |

> **Note for Part E:** the entity resolver supports `customer · job · appointment · invoice · estimate · pending_proposal`. It has **no place or address kind**, and no technician kind. Geocoding, service-location lat/lng, and a travel-time provider (Google Distance Matrix with haversine fallback) all exist and are wired. The pieces are there; the resolver kind that would use them for spoken addresses is not. B2 is mostly new build on existing foundations.

## B3. Capture — the call comes in

*Trigger: a customer calls the shop's number, or texts, or submits the web form.*

| # | Requirement | |
|---|---|---|
| B3.1 | AI answers every inbound call, 24/7, in the tenant's locked brand voice | ⚙️ |
| B3.2 | Caller is resolved against existing customers; unknown numbers create a lead-linked record | ⚙️ |
| B3.3 | Intent and urgency are classified from the call description | ⚙️ |
| B3.4 | **Severity triage** per vertical — plumbing severity from description, HVAC seasonal load, electrical emergency indicators | ⚙️ |
| B3.5 | **Vulnerability signals** (age, medical, weather, water-damage-in-progress, no-heat/no-cool) elevate urgency | ⚙️ |
| B3.6 | Urgency + vulnerability → **immediate patch-through to the owner's phone**. Triage, not booking. | ⚙️ |
| B3.7 | **Dropped-call SMS recovery within 60 seconds**, carrying partial transcript context | ⚙️ |
| B3.8 | **B2B account recognition** — property managers, agents, repeat commercial accounts route differently from one-off residential | ⚙️ |
| B3.9 | Equipment / installed-asset history surfaces on the call for known customers | ⚙️ |
| B3.10 | Inbound customer SMS that no keyword claims is captured into a customer-threaded conversation, never dropped | ⚙️ |
| B3.11 | Customer MMS photo → draft estimate (distinct from the tech photo path — different identity, trigger, and output) | ⚙️ |
| B3.12 | The AI never quotes a firm price on the call and never negotiates | ⚙️ |
| B3.13 | Public web booking link, no login required | 📱 |

## B4. Book — the job gets on the calendar

| # | Requirement | |
|---|---|---|
| B4.1 | Call produces a **booking proposal**, not a booking | ⚙️ |
| B4.2 | Proposal is checked for **drive-time feasibility** against the existing day | ⚙️ |
| B4.3 | **Conflict detection** against existing appointments | ⚙️ |
| B4.4 | Owner approves the booking | 📱 |
| B4.5 | Approved booking sends a customer confirmation in brand voice | ⚙️ |
| B4.6 | Day-before reminder | ⚙️ |
| B4.7 | Owner can book, move, or cancel by speaking — *"schedule Carlos Thursday at 2"* | 🎙️ |
| B4.8 | Ambiguous references trigger one-tap clarification, never a silent guess (see B2.6) | ⚙️ |
| B4.9 | New customer + new job arrive as **one combined proposal**, not two | ⚙️ |
| B4.10 | Booking proposals expire after 48h | ⚙️ |

## B5. Dispatch — someone is assigned and en route

| # | Requirement | |
|---|---|---|
| B5.1 | Dispatch board, appointment-centric day view | 📱 |
| B5.2 | Drag-and-drop on the board creates a proposal, not a direct mutation | 📱 |
| B5.3 | Owner assigns work by speaking — *"assign Carlos to the Johnson job"* | 🎙️ |
| B5.4 | Tech is notified by push and SMS | ⚙️ |
| B5.5 | Tech goes "on my way" by app, SMS keyword, or voice | 🎙️ |
| B5.6 | "On my way" computes drive-time ETA from the latest GPS ping and sends a branded ETA SMS | ⚙️ |
| B5.7 | Predicted late arrival sends a proactive customer update | ⚙️ |
| B5.8 | Tech no-show or cancellation generates **cascade reschedule proposals** for the affected day | ⚙️ |
| B5.9 | Electrical: dispatch proposal surfaces license scope and flags two-person job types | ⚙️ |

## B6. Execute — the trade work happens

**Rivet does not touch this step. That is the product.**

The only requirements here are capture surfaces that must not interrupt the work:

| # | Requirement | |
|---|---|---|
| B6.1 | Field app works one-handed, in gloves, in daylight | 📱 |
| B6.2 | Tech photo capture attaches to the job (clock-in gated) | 📱 |
| B6.3 | Time entries captured against the job | 🎙️ |
| B6.4 | Offline capture queues and syncs on reconnect | ⚙️ |

## B7. Narrate — the tradesperson tells Rivet what happened

**This is the differentiated step and the center of gravity of the product.** It is the "*they explain it to us*" in the north-star sentence. Neither Jobber nor ServiceTitan has an equivalent, which is precisely why a parity-organized requirements document will never surface it — and why previous versions of this PRD kept drifting back toward being a Jobber clone spec.

The canonical moment: **the tech is driving away from the job, phone in the cupholder, talking.** Everything in B2 exists to make that sentence resolvable.

| # | Requirement | |
|---|---|---|
| B7.1 | Push-to-talk capture from any screen in the app | 🎙️ |
| B7.2 | Speech → transcript → intent classification → entity resolution → typed proposal | ⚙️ |
| B7.3 | Free-text references (customer, job, invoice, estimate, technician, **place**) resolve to verified IDs; ambiguity → clarification, never a guess | ⚙️ |
| B7.4 | Job notes and outcome dictated after the job | 🎙️ |
| B7.5 | Parts and materials added by speaking, as structured name + quantity + unit | 🎙️ |
| B7.6 | *"They need a new capacitor, add it to the estimate"* — spoken line-item addition to an existing estimate | 🎙️ |
| B7.7 | Job status moved by voice | 🎙️ |
| B7.8 | Expense capture by voice — *"I spent $84 at Ferguson on the Miller job"* | 🎙️ |
| B7.9 | Read-only lookups answered by voice without generating a proposal — schedule, customer history, job P&L, outstanding balances, truck inventory | 🎙️ |
| B7.10 | Crew add / remove by voice | 🎙️ |
| B7.11 | Every voice action maps to a proposal type through a **code-checked capability matrix** — a handler without a classifier intent is a silent failure and must fail a drift test | ⚙️ |
| B7.12 | An execution handler whose dependencies aren't wired must fail loudly, never pass through a synthetic ID that saves nothing | ⚙️ |

> **The most dangerous failure mode in the product lives here.** A voice action with an execution handler but no classifier intent means the owner speaks, the transcript is silently skipped, and *nothing happens with no error*. B7.11 and B7.12 exist specifically to make that class of failure impossible.

## B8. Quote — the estimate goes out

| # | Requirement | |
|---|---|---|
| B8.1 | Estimate drafted from a spoken description or a photo | 🎙️ |
| B8.2 | **Every AI-drafted line item is catalog-resolved** before the proposal is built; uncatalogued items cap confidence at 85% | ⚙️ |
| B8.3 | Confidence markers surface on parts, prices, and scope where the system is unsure | ⚙️ |
| B8.4 | **Supervisor agent reviews every quote** before it reaches the owner — pricing anomalies, missed scope, brand-voice drift | ⚙️ |
| B8.5 | Owner reviews with inline editable line items | 📱 |
| B8.6 | Tiered estimate options (good / better / best) | ⚙️ |
| B8.7 | Estimate sent to customer on approval, delivery channel configurable per tenant | ⚙️ |
| B8.8 | Customer approves via token-gated link, no login | ⚙️ |
| B8.9 | **Automatic estimate follow-up** — sends by default, disableable per estimate or globally | ⚙️ |
| B8.10 | Estimate nudge by voice on demand | 🎙️ |
| B8.11 | Customer price pushback or scope expansion → owner proposal with a recommendation. The AI refuses to negotiate. | ⚙️ |
| B8.12 | Negotiation guardrail enforced **at the proposal-execution boundary**, not only by classifier | ⚙️ |
| B8.13 | Deposit collected on acceptance, under either timing policy, with a working payment path from every surface that says money is owed | ⚙️ |
| B8.14 | Electrical: permit line item auto-added with an AHJ-confirmation confidence marker | ⚙️ |

## B9. Bill — the money comes in

*Everything here depends on B1.7–B1.11. No connected account, no money movement.*

| # | Requirement | |
|---|---|---|
| B9.1 | Invoice issued from a spoken sentence — *"charge Johnson 420 for the disposal"* | 🎙️ |
| B9.2 | Approved estimate converts to invoice with a review step before creation | 📱 |
| B9.3 | Auto-invoice on job completion | ⚙️ |
| B9.4 | Batch invoice by voice — *"invoice everything I finished today"* | 🎙️ |
| B9.5 | Invoice sends with a payment link; **funds settle to the tenant's connected account** | ⚙️ |
| B9.6 | Card payments; **ACH originated by the platform**, not merely detected on inbound webhooks | ⚙️ |
| B9.7 | In-flight ACH is credited against the invoice balance on `processing`, reconciled on `succeeded`, reversed on `failed` — the owner is never blind during multi-day settlement | ⚙️ |
| B9.8 | Partial payments and deposits | ⚙️ |
| B9.9 | Saved cards / auto-pay (off-session) | ⚙️ |
| B9.10 | **Automatic dunning cadence** on overdue invoices | ⚙️ |
| B9.11 | Late fees | ⚙️ |
| B9.12 | Payment reminder and late fee triggerable by voice | 🎙️ |
| B9.13 | Memberships / maintenance plans with auto-renew, member pricing, priority booking | ⚙️ |
| B9.14 | Receipt on payment | ⚙️ |
| B9.15 | Money is integer cents end to end. No floats anywhere in this section. | ⚙️ |

## B10. Close — the loop finishes and the system learns

| # | Requirement | |
|---|---|---|
| B10.1 | Post-job review request, automated | ⚙️ |
| B10.2 | **Review gating** — 4+ star intent routes to Google; below that routes to the owner privately | ⚙️ |
| B10.3 | Google review monitoring with AI-drafted public response + private apology, owner-approved | 📱 |
| B10.4 | **End-of-day digest, 6–9pm tenant-local — this is the dashboard.** What was billed, what's owed, what needs attention, and a "what I wasn't sure about today" section. No real-time charts. No morning log-in. | ⚙️ |
| B10.5 | **Correction loop** — owner edits become structured lessons, applied forward within the same tenant-day, reported in the digest as "what I learned today", fully reversible | ⚙️ |
| B10.6 | Correction extraction is conservative: clear patterns only, ambiguous edits produce no lesson | ⚙️ |
| B10.7 | QuickBooks sync (one-way in V1) | ⚙️ |
| B10.8 | Every mutation is audited and undoable; proposals carry a 5-second undo window and idempotency | ⚙️ |
| B10.9 | Unified communication inbox — SMS, email, and voice history per customer, with AI-suggested replies | 📱 |
| B10.10 | Owner-authored free-text replies send directly (the owner *is* the human) — audited and DNC-gated. AI-initiated outreach always goes through proposals. | 📱 |

---

## B11. Load-bearing constraints on the whole lifecycle

| Constraint | Target |
|---|---|
| Owner approvals per day | **< 15** — sustainable. If a feature pushes this up, it fails the litmus test in A5. |
| Approval median latency, business hours | < 10 minutes |
| Supervisor agent flag latency | < 60 seconds |
| Supervisor false-positive rate | < 5% |
| Supervisor false-negative rate | < 2% on labeled set |
| Dropped-call SMS recovery, P95 | < 60 seconds |
| Proposal execution success | > 99% |
| LLM gateway availability | > 99.5% |
| Signup → first AI-handled call | < 24 hours |
| Estimate proposal approval rate | ≥ 70% (PMF gate) |
| Clean approval rate — no edits | ≥ 30% (PMF gate) |
| Invoice proposal approval rate | ≥ 75% (PMF gate) |
| Concurrent sessions — **launch gate** | ~200, with per-instance ceiling measured and linear replica scaling proven (C4.1) |
| Concurrent sessions — **architectural design target** | 1,000, dual web + voice SLO. Design constraint always in force; full run fires on the C4.1 promotion trigger. |

---

---

# PART C — DEFINITION OF DONE & THE QUALITY BAR

## C0. Why this is in a PRD

Engineering standards usually live in `CLAUDE.md`, not a product document. This one is here for a specific reason.

**Part E — the state table — is worthless without an agreed definition of "built."** The failure this whole document exists to correct was not a bad feature list. It was a PRD that marked 48 things ✅ when the code delivered 44, and where the three loudest overclaims (MMS-to-quote, ACH, B2B recognition) had *foundations present and the flow never completed*. Someone wrote ✅ in good faith against a partially-wired feature.

So Part C defines the ladder that Part E scores against. **A requirement is not "built" because a file exists that mentions it.**

## C1. The done ladder

Every requirement in Part B is at exactly one of these. **Only rung 6 is ✅.**

| Rung | Name | Means |
|---|---|---|
| 0 | **Absent** | No code |
| 1 | **Specced** | A story or plan exists |
| 2 | **Present** | Code exists — a module, a handler, a schema column |
| 3 | **Wired** | Reachable from production entry points. Registered in `app.ts`, not just exported. |
| 4 | **Proven** | Tested against a **real database**, not a mock. Audit event asserted. Cross-tenant negative asserted. |
| 5 | **Reachable** | The persona can actually get to it — including **by voice, if Part B tags it 🎙️** |
| 6 | **Live** | Configured and working *in the deployed environment*. Code truth is not runtime truth — see C8. |

**Rung 3 is where the historical overclaims died.** A handler with no classifier intent is Present, not Wired. An execution handler whose dependencies aren't injected is Present, not Wired — and passes back a synthetic ID that saves nothing.

**Rung 5 is Rivet-specific and non-negotiable.** A capability with a working API and no voice on-ramp is not done, because §A5.1 makes voice the primary interface. This is what the capability-matrix drift test (B7.11) enforces mechanically.

## C2. Test discipline

**The rule, learned the hard way: a mocked-database test once shipped columns that did not exist.** The entity resolver passed its suite against phantom columns.

| # | Requirement |
|---|---|
| C2.1 | **Any change touching the database requires a Docker-gated integration test against real Postgres.** Mocked-DB tests are insufficient and do not count toward rung 4. |
| C2.2 | Every integration test includes a **cross-tenant negative** — proof that tenant A cannot see tenant B |
| C2.3 | Every test set covers four cases: **happy path · edge · error/permission · integration (DB)** |
| C2.4 | Money assertions read `*_cents` columns and never compare floats |
| C2.5 | Every bug fix ships with a regression test |
| C2.6 | Money, RLS, and auth paths additionally carry adversarial / property tests |
| C2.7 | Migrations are immutable and additive; enforced by `test/db/migration-immutability.test.ts` |

## C3. CI gates

Every story clears, at minimum:

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm test
npm run test:integration --workspace=packages/api
```

Beyond that, `docs/launch/ci-gating.md` is **the table of record** for what blocks a merge versus what only reports. That distinction is deliberate and should stay explicit — a check that everyone routes around is worse than no check.

| Gating | Advisory |
|---|---|
| Type check, unit, integration | Quality metrics collection |
| Synthetic voice smoke — every deploy | Dead-code report (knip, configured so `test/**` doesn't count as a consumer) |
| Migration-discipline guard | |
| Declared-env check | |
| Decisions test | |

## C4. The Launch Quality Bar

`npm run launch-quality-check` — **twelve checks, all must pass before self-serve opens.** Tier 1 is calibrated for 10–50 customers.

| Group | Checks |
|---|---|
| **H1** Idempotency | Guard required at compile time (not optional); DB unique index as the belt-and-braces backstop |
| **H2** Voice smoke | Synthetic on every deploy; real outbound call daily via cron, asserting a proposal lands in staging |
| **H3** Alerting | Sentry rules + Slack pipeline, runbook verified |
| **H4** Recovery | Rollback runbook, migration-discipline runbook, discipline guard test |
| **H5** Capacity | Voice load test run and recorded; **stale after 30 days** |
| **D1–D3** Discipline | Decisions test, smoke tests, migration immutability |

**Tier 2 is deferred against explicit triggers, not vibes** — PagerDuty when the first non-US-timezone customer signs up; dashboards at 50+ customers; canary deploys after two deploy-traceable incidents in a quarter; auto-rollback once the synthetic voice smoke is proven non-flaky for 30 days. *None of these are "do later." They are "do when the trigger fires," and they carry no implementation debt in the meantime.*

### C4.1 Scale — design target vs. launch gate

**1,000 concurrent sessions across dual web + voice SLOs is the architectural design target. It is not the launch gate.** These are different commitments and conflating them either blocks launch on a Series-B-scale proof or ships an architecture with a ceiling baked into it.

**The design constraint (always in force, checkable at review — no load run required).** No component may be built in a way that structurally precludes 1,000 concurrent. Concretely:

| # | Constraint |
|---|---|
| C4.1a | **API instances are stateless.** A voice session is WebSocket-bound to one instance, so any session state that must survive must be externalized or reconstructible — never in-process-only. |
| C4.1b | **Horizontal scale is the scaling story.** New connections distribute across replicas; adding capacity is `--replicas N`, not a bigger box. |
| C4.1c | **Concurrent sessions must not mean concurrent DB connections.** Pooled access, connection-per-request discipline, no long-held transactions across a voice turn. |
| C4.1d | **Slow work leaves the request path** onto the durable queue; workers scale independently of the API. |
| C4.1e | **The LLM gateway is the shared chokepoint and must not serialize.** Tiered routing keeps the majority of calls on lighter models; provider rate limits and failover are handled inside the gateway, not by callers. |
| C4.1f | **No tenant is a hot partition.** One large tenant's load must not degrade another's — the same isolation promise RLS makes for data, made for performance. |
| C4.1g | **Degrade, don't collapse.** Under overload, voice falls back to SMS recovery (B3.7). Silence is the one unacceptable failure. |

**The launch gate (must be green before self-serve opens).** Establish the **per-instance ceiling** — never yet measured above 50 concurrent — prove replicas scale it roughly linearly, and carry **~20× headroom over realistic peak.** At the 6-month target of 25 tenants, realistic peak is on the order of 10 concurrent voice sessions, so the gate lands near **200 concurrent**, not 1,000. Record the ceiling in `voice-capacity.md`; it goes stale after 30 days.

**The promotion trigger.** The full 1,000-session dual-SLO run fires when **sustained peak crosses 50% of the proven per-instance ceiling × current replica count**, or on any change to the voice provider stack, instance size, or `telephony/media-streams/`.

> **Note on how the run is instrumented.** A 1,000-session load test with the LLM gateway live costs real inference money — at the ~$1/min COGS in A7, a single 5-minute hold is on the order of $5,000, and one run is never enough. Run it with the gateway in test mode (the pattern the synthetic voice smoke already uses) and it proves transport, connection handling, and backpressure — which is the part that's architecturally hard. Reserve live-gateway runs for a small sampled subset. **Be precise about which claim a given run supports; "we handle 1,000 concurrent" means nothing without saying which stack was hot.**

## C5. Review gates — where autonomy stops

Most changes merge on green. Three categories never do:

> **Money movement · RLS / tenant isolation · auth.**
> These are implemented on a branch in clearly-labeled separate commits, and **held for explicit human review before merge.** Never merged autonomously, no matter how green.

This mirrors the product-side trust model exactly: the AI proposes, a human approves, and the highest-stakes categories are the ones where the human gate is absolute. **The engineering process and the product's interaction model should not have different theories of trust.**

## C6. AI quality gates

Model quality is a product requirement, not an engineering detail — a fluent wrong answer is the failure mode that loses a pilot customer. Thresholds live in **B11**; this section only asserts they are *gates*, measured continuously, not aspirations reviewed at retro.

The two that matter most and are easiest to let slide:

- **Supervisor false-negative rate < 2% on a labeled set.** False positives cause alert fatigue; false negatives let a bad quote reach a customer. Track them separately — a single "accuracy" number hides the one that hurts.
- **Clean approval rate ≥ 30%.** If the owner edits nearly everything, the AI isn't returning hours; it's generating review work. That inverts the north star.

## C7. Failure visibility

**Quality is not only "did the tests pass" — it is "would we find out."** A silent failure is worse than a loud one, and this product has an unusual number of ways to fail silently: a voice transcript skipped for want of a classifier intent, a proposal executed against an unwired handler, a gateway error that never creates an `ai_runs` row to alert on.

| # | Requirement |
|---|---|
| C7.1 | AI task failure rates alert per task type, with a volume floor to prevent low-sample noise |
| C7.2 | Known blind spots are **documented in the runbook, not just fixed** — an operator seeing no `ai_runs` alert must know pre-row gateway failures exist and where they surface instead |
| C7.3 | Every alert has a documented response: threshold, sample floor, and the first three things to check |
| C7.4 | Any capability reachable by voice fails **loudly** when its dependencies are absent (B7.12) |

## C8. Runtime truth — is it actually live?

Rungs 0–5 are **code truth**: does the repository deliver the requirement. Rung 6 is **runtime truth**: is it configured and working in the environment customers touch. These fail independently, and the second is the one with no test suite.

**The proof case is already in the repo.** `SENTRY_DSN` is declared in `.env.example`, `.env.production.example`, `packages/api/.env.example`, and `docs/prod-env-checklist.md` — four manifests, every rung of code truth green. Sentry was still dark in production, because the variable was never set on the Railway dashboard and config-as-code cannot set Railway service variables. Nothing was broken in the code. Nothing would have caught it.

### C8.1 The Railway topology trap

**`web`, `worker`, and `voice` are three separate Railway services sharing one entrypoint, differentiated by `PROCESS_ROLE`.** A variable set on `web` is not set on `worker` — and the worker is where every sweep and the SLO monitor run. A variable set on two of three leaves a third silently degraded.

| # | Requirement |
|---|---|
| C8.1a | Environment verification runs **per service**, never once against "production" |
| C8.1b | `railway*.toml` is **not** a declaration site — it holds only `[build]` / `[deploy]` keys. Do not read it as evidence a variable is set. |
| C8.1c | Declared ≠ set. `check:env-declared` proves a variable is *declarable*; only the dashboard proves it is *set*. Both checks are required and neither substitutes for the other. |

### C8.2 Configuration hygiene

| # | Requirement |
|---|---|
| C8.2a | Every env var read by code is declared in an environment manifest. `check:env-declared` makes a new undeclared read a build failure. |
| C8.2b | Config is read through the **Zod-validated config object**, never raw `process.env` — the validated path coerces empty-string secrets to `undefined`, and a raw empty string is truthy |
| C8.2c | The app **fails to start** if a required secret is missing. Silent degradation is not acceptable for anything on the money or voice path. |
| C8.2d | Flags that must be provably false in production are asserted at boot, not trusted — anything of the shape "allow missing," "simulated," or "cassette fallback" |

### C8.3 Third-party liveness

Every external dependency needs a **liveness proof, not a key-presence check.** A key can be present, well-formed, and pointed at the wrong environment.

| Dependency | What must be proven, per environment |
|---|---|
| **Twilio — voice** | The provisioned number's webhook points at *this* environment's mediastream endpoint, and a real inbound call produces a proposal (the daily real-call smoke already does this — H2.B) |
| **Twilio — SMS** | Messaging service SID resolves; an outbound send is delivered and logged; STOP/DNC enforcement is live |
| **Voice/AI stack** | A synthetic turn completes end to end through STT → gateway → TTS, with the tiered routing actually routing |
| **LLM gateway** | Reachable, failover configured, and **`ai_runs` rows are being written** — the alert in C7.1 is blind without them |
| **Stripe — platform** | Live vs. test keys are unambiguous per environment; webhook signature verification active; the webhook handler is genuinely instrumented |
| **Stripe — Connect** | A tenant can complete onboarding end to end and payouts route to *their* bank (B1.7–B1.11) |
| **Clerk** | Auth enforced; any dev-mode token path provably disabled in production |
| **Everything else** | QuickBooks, SendGrid, PostHog, storage, push/EAS — each either verified live or explicitly recorded as not-configured, never assumed |

> **Not-configured is an acceptable state. Unknown is not.** The output of a runtime verification pass is a per-service, per-dependency table where every cell says live, not-configured, or broken — with no blanks.

### C8.4 Volume, not only failure rate

The audit's headline incident was a worker that burned **27,000 API calls with every call succeeding.** A failure-rate alert would never have fired. Runaway *volume* on any AI task type must page a human independently of whether the calls succeed — this is a cost-control requirement, and at the COGS in A7 it is a material one.

## C9. Red team

Run against the shipped system and against its own fixes:

cross-tenant data leakage · money-flow abuse · approval-gate bypass · **prompt injection against the voice agent** · concurrency and idempotency failures under double delivery · and the personas' documented bad-day failure modes from A4.

Prompt injection deserves specific attention: the voice agent takes untrusted input from strangers on the phone and its output drives typed proposals against a money system. The approval gate is the last line of defense, which is exactly why C5 treats it as absolute.

## C10. The documentation truth rule

**No claim ships without verification against the codebase.**

Applies to this PRD, to marketing, to sales decks, and to demos. Where documentation and code disagree, **the code is right and the document is wrong** — update the document, don't argue with the code. Where a feature is partial, it is described as partial. The three downgraded features stay described as partial until Part E says otherwise.

Accuracy is a brand value here, not just engineering hygiene: the entire product proposition is that an owner can trust an AI with their money. A company that overclaims in its own documentation has a credibility problem it cannot market its way out of.

---

# PART D — PARITY APPENDIX

**Status: NOT WRITTEN.** Blocked by choice, not by capability.

Scope: `docs/PRD-v3.md` §5 refreshed and extended to full enumeration per the launch-requirement
decision. Competitive checkboxes that are not lifecycle steps live here rather than in Part B.

**Deliberately sequenced after Part E.** A parity comparison built on assumed build state is a set of
claims, not a comparison — and a large `UNKNOWN` block on the voice path would make it misleading in
exactly the direction that flatters us.

---

# PART E — STATE TABLE

**Status: NOT WRITTEN. Cannot be authored from documentation.**

This is the answer to *"did we build what we intended, and is it live?"* — one row per Part B
requirement, each scored on the C1 ladder, each backed by evidence a skeptic could re-check.

**Produced by:** `rivet-part-E-state-verification-master-prompt.md` — a read-only verification run
against `/packages`. It fixes nothing, so the table stays re-runnable as a progress measure.

**Any attempt to fill this section by reading documents reproduces the exact failure this PRD
exists to correct.** Part E is generated. If it is ever hand-edited, it is no longer evidence.

### Locked output schema

| Req | Requirement | Tag | Rung | Evidence | Missing link |
|---|---|---|---|---|---|
| *B7.5* | *Parts added by speaking* | *🎙️* | *3* | *`handlers.ts:412`; absent from `INTENT_TO_PROPOSAL_TYPE`* | *No classifier intent — utterance silently skipped* |

Accompanied by: rung distribution per lifecycle section · **voice coverage %** (of requirements
tagged 🎙️, how many reach rung 5 — the headline number) · a delta list running **both** directions ·
the Track C runtime table, per Railway service × per dependency, no blanks · a punch list ordered by
persona impact.

**Known gate:** rung 6 (Live) requires Railway API and staging credentials. Without them the run
returns rungs 0–5 and must say so — that is most of the value, but it will not catch the
Sentry-class failure where every code rung is green and the capability is dark in production.

---

# PART F — DECISIONS REGISTER

**Status: NOT WRITTEN.**

Open and blocking:

| # | Decision | Blocks |
|---|---|---|
| 1 | **Supersession** (§0.2) — does v4 retire PRD-v3, the 7/12 master, and the execution catalog? | Everything. Until this closes, this document has no authority. |
| 2 | **Electrical at launch** (A8) — reverses the Wave 1 / Wave 2 split; needs a vertical pack that doesn't exist | Launch scope |
| 3 | **Native mobile at launch** (A8) — reverses a documented roadmap item; sub-decision native vs. Capacitor | Launch scope, and B2/B5 location capability |
| 4 | **Pricing** — unresolved across sessions | All GTM material |
| 5 | **D-014** — canonical inbound call path. Likely answerable from observed traffic in the Part E run. | Voice architecture |
| 6 | **D-015** — carried forward from `docs/decisions.md` | — |

Resolved and recorded here for traceability: **scale** (C4.1 — 1,000 concurrent is the architectural
design target, ~200 is the launch gate) · **naming** (§0.3 — Rivet, ServiceOS retired) · **D-013**
(B0 — voice approval is a locked refusal, not a gap).


---

## Next

- **Part D** — parity appendix. PRD-v3 §5 refreshed and extended.
- **Part E** — state table. Requires a fresh code audit; not authorable from documentation. Priority verification targets: B1.7–B1.11 (Connect onboarding UX), B2 (place resolution), B7.11 (capability-matrix drift test).
- **Part F** — decisions register. Open: supersession (§0.2) · electrical at launch (A8) · native vs. Capacitor (A8) · pricing · D-014 · D-015. *(Scale resolved in C4.1.)*

## Sources

`docs/PRD-v3.md` v3.2 (thesis, north star, personas, 16 locked decisions, parity map, vertical waves §9, §6 workflow map, success metrics, risk register, glossary) · `docs/PRD-execution-catalog.md` (locked architecture decisions, proposal-engine story catalog, roles) · `docs/plans/2026-06-14-001-feat-voice-action-pipeline-audit-and-gap-buildout-plan.md` (voice capability matrix, `INTENT_TO_PROPOSAL_TYPE`, RV-071/225 approval refusal, synthetic-ID passthrough risk, entity-resolver kinds) · `docs/plans/2026-06-14-001-feat-prd-gap-closure-roadmap-plan.md` (MMS-to-quote, ACH staging, B2B account type, ETA/travel-time provider, review gating) · `docs/plans/2026-06-14-001-chore-verify-quote-to-cash-portal-flow-plan.md` (`billing/stripe-connect.ts` presence; Connect onboarding UX scoped out) · `docs/plans/2026-06-14-002-fix-after-approval-deposit-collection-plan.md` (deposit timing policies) · `docs/plans/2026-06-15-001-feat-crm-comms-multilocation-jobber-parity-plan.md` (comms inbox, owner-authored replies, address model, non-goal reversal precedent) · `docs/plans/2026-06-14-001-feat-voice-appointment-verification-and-phone-picker-plan.md` (phone provisioning) · `serviceos-coding-audit-master-prompt.md` (repo invariants, dual SLO targets).
