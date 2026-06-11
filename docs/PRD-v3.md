# Rivet — Product Requirements Document v3.0

**Brand name:** Rivet  
**Product name:** ServiceOS  
**Version:** 3.0  
**Status:** Canonical reference — supersedes v2.0  
**Date:** 2026-06-11  
**Owner:** Product  

---

## Companion documents

| Document | Purpose |
|----------|---------|
| `docs/strategy/day-in-the-life.md` | Emotional and operational spine; the personas; the bad-day failure modes |
| `docs/strategy/parity-jobs-invoicing.md` | Jobs/invoicing Jobber parity roadmap (P20–P27) |
| `docs/competitive-gap-analysis.md` | Verified competitive gap map with sequenced plan |
| `docs/PRD-execution-catalog.md` | Per-story build prompts, acceptance criteria, dependencies (v1 source of truth for un-amended stories) |
| `CLAUDE.md` | Locked patterns, allowed files, build verification rules |
| `docs/stories/` | Dispatchable story files by phase |

**When this doc and v2 disagree, this doc wins.** Stories from v2 not contradicted here remain in effect.

---

## 1. Executive Summary

### The pitch

> **You handle the work. We handle the business.**
>
> Rivet answers your phone, books your jobs, sends your estimates, issues your invoices,
> and chases your payments — all by voice, all with your approval. You stay a tradesperson.
> We run your back office.

### What it is

A **voice-and-AI-first back office** for small home-service businesses (HVAC and plumbing in V1).
The owner does not manage a dashboard. The owner speaks — to the app, to a customer, to a tech —
and the AI executes the business logic, surfaces every action as a reviewable proposal, and
delivers a one-tap approval via SMS when the owner can't talk.

Voice works in both directions:
- **Inbound**: customers call in; the AI agent answers, qualifies, books, and handles the conversation in the shop's voice.
- **Outbound / back-office**: the owner speaks to issue invoices, check the schedule, add job notes, look up profit — the AI proposes, the owner approves.

SMS is the async approval and notification channel — not the primary interface.

### What it is not

- Not a dashboard the owner opens every morning.
- Not a dispatch console for a 10-person ops team.
- Not an enterprise field-service platform (that's ServiceTitan — a different product, different ICP).
- Not a marketing automation platform.
- Not a tax, payroll, or legal tool.

### Why Rivet beats Jobber for our ICP

Jobber gives the owner **better paperwork** — a polished UI to manage the office.  
Rivet **does the office work** — the AI runs it while the owner runs their trade.

Jobber's AI is a bolt-on assistant that hands off to the human for every decision.  
Rivet's AI owns the system of record and writes to it — every action via a typed proposal
the owner approves with one tap or one word.

The demo writes itself: *owner under a sink, phone rings, appointment books itself, invoice
issues from a spoken sentence, QuickBooks updates overnight. Jobber cannot bolt this on:
their AI sits on top of the system. Ours is the system.*

### North-star metric

**Owner hours returned per week.** Every feature is judged by whether it adds to or subtracts from this number.

Secondary: **time-to-cash** (days from job completion to payment received).

### Why now

1. Real-time voice models can hold a competent service-business conversation under $1/min in COGS.
2. SMS + payment links + Stripe + Twilio APIs are mature enough for an AI to run a full money flow.
3. The owner-operator labor crisis — no admin staff available, no time to train one — forces demand. "Hire a receptionist" is no longer an option. The AI is the receptionist, the bookkeeper, and the dispatcher.

---

## 2. Customers and Personas

### Primary ICP

**Owner-operator home-service shops: 1–3 trucks, no dedicated office staff, $200K–$1M annual revenue, in HVAC or plumbing.**

The defining characteristic is not the company size — it's the **single-threaded admin load**:
one person (or no person) doing all the office work. That is the person Rivet replaces.

**Disqualifying signals:**
- 5+ employees with a dedicated office manager
- Already on ServiceTitan and satisfied
- Aspires to grow into a 20-truck fleet (we serve owner-operators, not aspirational enterprises)
- Does not carry a smartphone

**The sweet spot:** The experienced tradesperson going independent — leaving a large company to run their own shop — and the 1–3 person shops they become. They are masters of the field work and allergic to the office work.

### Persona 1 — Mike Rivera (HVAC, Phoenix, 2 trucks)

38, married, two young kids. Wife works full-time as a nurse. One employee (Carlos, cousin, technician). Revenue $680K. Real job title: *dispatcher, CSR, estimator, bookkeeper, collections agent, marketing manager, and HVAC tech* — only the last is what he wanted.

**What a good day looks like with Rivet:**
Six overnight calls were answered and four jobs were booked while he slept. Estimates went out with catalog-priced line items. Two invoices were issued by telling the app what the job cost. The end-of-day SMS said he billed $4,200 today and has $12,400 in open invoices.

**What a bad day looks like (product must handle):**
Stale labor rate in a quote (caught in approval queue). Hallucinated part (confidence marker fires). Emergency missed (supervisor agent flags). Dropped call (SMS recovery). Customer games the price (guardrail blocks; owner proposal generated). Carlos no-show (cascade reschedule proposals). 1-star review (draft response in queue).

*Full narrative: `docs/strategy/day-in-the-life.md` §"Persona 1 — Mike."*

### Persona 2 — Jenna Walsh (plumbing, Cleveland, solo)

41, divorced, raising a 14-year-old son. 18 years in the trade, 3 years on her own. Revenue $340K. Doesn't want to grow into a fleet — wants to stay solo and reclaim her life. Single-threaded admin load makes the AI back office *more* urgent for her, not less.

**What a good day looks like:**
Phone rings at 4am — frozen pipe season. AI answers, triages severity, books the first four slots. She drives to the first job. Photos of the damage go straight to a draft estimate with confidence markers. She approves by voice while driving. Invoice issues as she walks out the door.

**What a bad day looks like:**
Property manager account not recognized (B2B routing fails). MMS photo quote too generic (no line-item breakdown). Invoice goes out with wrong labor rate. No-show notification goes to the wrong customer.

*Full narrative: `docs/strategy/day-in-the-life.md` §"Persona 2 — Jenna."*

### Persona 3 — The Owner-Operator Going Independent

The plumber or HVAC tech who just left a 500-person company. Has no admin systems, no processes, no price book. Rivet is the first software they buy — and it sets up the back office in the onboarding flow. This is the top-of-funnel ICP. They will become Mike or Jenna.

### Anti-personas (do not optimize for)

- The dispatcher at a 12-truck shop → wants ServiceTitan.
- The franchise owner → wants brand-compliance tooling, not a back office.
- The hobbyist / side-hustle plumber → revenue doesn't justify $300–500/mo.
- The owner who wants AI fully unsupervised → that's a different trust contract.

---

## 3. Locked Product Decisions

These 16 decisions drive every feature and design choice. **Decision #1 is updated in v3.**
All 14 decisions from v2 remain in force; two are added.

| # | Decision | Implication |
|---|----------|-------------|
| 1 | **Voice is the primary interface — both directions** | The owner speaks to run the back office. Customers speak to book. SMS is the async approval and notification channel for when the owner can't talk. The web app is for audit, configuration, and oversight — no daily action requires opening it. |
| 2 | **End-of-day digest is the dashboard** | A 6–9pm SMS summary with a "what I wasn't sure about today" section. No real-time charts. No morning log-in. |
| 3 | **One-tap approvals with dictation edits** | Every proposal SMS supports APPROVE / EDIT / REJECT. Edits accept voice dictation. No forms. |
| 4 | **AI proposes, owner always approves** | The AI creates a typed proposal for every action. Nothing executes without an explicit human approval. The exception is low-risk, high-confidence "capture class" proposals where the owner pre-authorizes a category (e.g., "auto-send appointment confirmations"). |
| 5 | **Confidence is surfaced, not hidden** | Where the system is unsure (parts, prices, urgency, account identity), the doubt is visible to the owner before anything goes out. Not a percentage on every line — surfaced only where it matters. |
| 6 | **Supervisor agent reviews every booking and quote** | A cheaper, second classifier reviews primary outputs for missed urgency, pricing anomalies, brand-voice drift, and account-routing errors. It flags within 60 seconds. |
| 7 | **Emergency intent overrides automation** | Urgency + vulnerability signals (medical, age, weather, water-damage-in-progress) route to the owner's phone immediately — voice triage, not booking. |
| 8 | **AI never discounts or commits to scope changes** | Pricing pushback, scope expansion, "let me talk to the owner" — all route through the owner with a recommendation. The AI refuses to negotiate. |
| 9 | **Dropped calls trigger automatic SMS recovery** | Voice → text fallback within 60 seconds, with partial transcript context. |
| 10 | **B2B account recognition is first-class** | Property managers, real-estate agents, and repeat commercial accounts route differently from one-off residential calls. |
| 11 | **Vertical packs matter** | Plumbing: MMS-to-quote and severity triage. HVAC: equipment history and seasonal load awareness. Architecture supports both without forks. |
| 12 | **Google review monitoring with draft-response approval** | Shipped from day one. Reputation recovery is part of the back office. |
| 13 | **Brand voice is configurable, then locked** | Every AI utterance — calls, texts, invoices, follow-ups, review responses — sounds like the shop. Locked after onboarding. |
| 14 | **Every AI mistake is a learning event** | The owner's correction updates the system. The digest reports what the system has learned. |
| 15 | **No feature ships that adds admin work to the owner's day** | The litmus test. If using the feature requires opening the web app for more than 30 seconds as part of daily operations, it's the wrong surface. |
| 16 | **The client hub is a link, not a login** | Customers approve estimates and pay invoices via a token-gated link. No account, no app, no friction. |

---

## 4. Voice-First Architecture

### The two voice directions

```
┌─────────────────────────────────────────────────────────────┐
│  Direction 1: Customer → Business (Inbound Voice)            │
│                                                               │
│  Customer calls → AI answers → classifies intent             │
│  → entity resolution → slot check → booking proposal         │
│  → owner approves via SMS or voice → confirmation to caller  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Direction 2: Owner → System (Back-Office Voice)             │
│                                                               │
│  Owner speaks → STT → intent classification → entity resolve │
│  → task execution → typed proposal → owner approves          │
│  → deterministic execution → confirmation via TTS or SMS     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  SMS: Async Approval + Notification Channel                  │
│                                                               │
│  When owner can't talk → proposals arrive as SMS one-tap     │
│  APPROVE / EDIT (voice dictation) / REJECT                   │
│  End-of-day digest → the day in 30 seconds                   │
└─────────────────────────────────────────────────────────────┘
```

### Why voice, not a screen

- The owner's hands are in conduit, under sinks, on a roof. A screen requires stopping.
- The tech's hands are in gloves. A screen requires removing them.
- The customer calls because they want to talk. A booking form loses them.

Voice is not a feature layer. It is the primary interface. Every capability must be exercisable by speaking.

### Voice capability requirements

Every domain in §6 (Feature Map) must answer: *"Can the owner do this with a spoken sentence while driving to their next job?"*

If the answer is no, the feature is not complete.

---

## 5. Rivet vs. Jobber — Feature Parity Map

Jobber is the primary head-to-head competitor at this ICP. The table below is the canonical competitive comparison for sales and strategy. Status column reflects the 6-month build plan.

| Workflow | Jobber | Rivet | Rivet edge | Status |
|----------|--------|-------|------------|--------|
| **Phone answering** | AI Receptionist captures request; human still books | AI agent answers, classifies intent, creates booking proposal; owner one-taps approval | Loop closed without human touch; equipment/account history on every call | ✅ Built (Media Streams) |
| **Inbound booking** | AI captures, human dispatches | AI proposes booking from call; owner approves via SMS | No dispatcher needed | ✅ Built |
| **Online booking (web)** | Public booking widget | Token-free public booking link | Parity | ✅ Built |
| **Scheduling** | Manual + AI suggestions | Voice-driven, drive-time feasibility, conflict detection | "Schedule Carlos Thursday at 2" = done | ✅ Built |
| **Dispatch / assignment** | Manual drag-drop board | Voice assignment ("Assign Carlos to the Johnson job") → proposal | Spoken, not clicked | ✅ Built |
| **Tech GPS + ETA texts** | Auto ETA on departure | Location → ETA calc → brand-voice SMS to customer | Parity | ✅ Built |
| **Tech "on my way"** | Mobile button | SMS keyword or voice | Parity | ✅ Built |
| **Tech "I'm out"** | Manual phone call / text to dispatcher | SMS "OUT" → cascade reschedule proposals | No dispatcher to call | ✅ Built |
| **Estimating (manual)** | Template-based editor | Voice-drafted, catalog-priced line items | No screen needed | ✅ Built |
| **Tiered estimates (good/better/best)** | Yes | Yes | Parity | ✅ Built |
| **Deposit on acceptance** | Yes | Yes (Stripe on portal accept) | Parity | ✅ Built |
| **MMS-to-quote (plumbing)** | No | Photo → AI analysis → draft estimate | Differentiator | ✅ Built |
| **Estimate portal approval** | Yes (Client Hub) | Yes (token-gated portal) | Parity | ✅ Built |
| **Estimate follow-up** | Automated reminders | AI-proposed follow-up sequence | Parity | 📋 Specced (P8 follow-up agent) |
| **Auto-invoice on completion** | Yes | Yes (job completion → draft invoice proposal) | Parity | 📋 Specced (P20) |
| **Voice-issued invoice** | No | "Invoice the Martins for today's job" → catalog-priced proposal | Differentiator | ✅ Built |
| **Invoice portal (customer pay)** | Yes (Client Hub) | Yes (token-gated payment link) | Parity | ✅ Built |
| **ACH payments** | Yes | Yes (Stripe automatic_payment_methods) | Parity | ✅ Built |
| **Tip capture** | Yes | Roadmap | Jobber leads | 📋 Specced (P22) |
| **Consumer financing (Wisetack)** | Built-in | Roadmap | Jobber leads | 🔮 Wave 3 |
| **Tap-to-pay (field)** | Yes | Roadmap (Stripe Terminal) | Jobber leads | 📋 Specced (P22) |
| **Auto-pay / saved card** | Yes | Roadmap | Jobber leads | 📋 Specced (P22) |
| **Dunning / overdue follow-up** | Automated reminders | Multi-step dunning cadence + digest summary | Parity | 📋 Specced (P20) |
| **Late fees** | Yes | Roadmap | Jobber leads | 📋 Specced (P20) |
| **Customer management** | Full CRM | Full CRM + account types | Parity | ✅ Built |
| **B2B account recognition** | Basic | Property manager routing, sub-accounts, priority flow | Differentiator | ✅ Built |
| **Equipment history (HVAC)** | No | Unit model + service age + repair history | Differentiator | 📋 Specced (P24) |
| **Truck inventory** | No | Parts on truck → auto-deduct into invoice lines | Differentiator | 📋 Specced (P14) |
| **Per-job profit (voice)** | Top plan only | "Did I make money on the Hernandez job?" by voice | Differentiator | 📋 Specced (P22-005) |
| **Unified messaging inbox** | Yes (SMS + email threads) | Yes + AI-suggested replies in brand voice | Parity + AI drafts | ✅ Built |
| **Review request (post-job)** | Automated | Automated + review gating (4+ stars → Google) | Parity | ✅ Built |
| **Review response drafting** | No | AI drafts public response + private apology | Differentiator | ✅ Built |
| **Memberships / maintenance plans** | Full engine (auto-renew, member pricing) | Engine built; auto-renew + member pricing in roadmap | Jobber leads (closing) | 🔧 Partial — deepening |
| **Client Hub / customer portal** | Full (book, approve, pay, history) | Lightweight (approve + pay only, no login) | Jobber leads on depth | ✅ Built (lightweight) |
| **QuickBooks sync** | Deep, battle-tested | Basic sync (Wave 3) | Jobber leads | 📋 Specced (P23) |
| **Route optimization** | Available | Drive-time feasibility (Google Maps) | Jobber leads on optimization | ✅ Built (feasibility) |
| **Custom job forms** | Builder | Vertical-specific voice checklists | Different model | 🔮 Wave 4 |
| **Mobile app (tech)** | Native iOS/Android | PWA (Capacitor native roadmap) | Jobber leads | 🔧 PWA built; native roadmap |
| **End-of-day digest** | No | Yes — the dashboard. Every day's P&L + "what I got wrong" | Differentiator | ✅ Built |
| **Offline voice capture** | No | PWA + queue (voice notes sync on reconnect) | Differentiator | 📋 Specced (Capacitor spike) |
| **AI writes to system of record** | No (read-mostly AI) | Yes — via typed proposals with approval + audit | Core differentiator | ✅ Built |
| **Trust / approval layer** | None | Every AI action = typed proposal + undo + audit | Core differentiator | ✅ Built |
| **Correction loop** | No | Owner edits → system learns → digest reports | Differentiator | 📋 Specced (N-009) |

**Legend:** ✅ Built · 🔧 Partial · 📋 Specced (story exists, not yet built) · 🔮 Wave 3+

---

## 6. Full Feature & Workflow Map

Every domain below answers: **what is the workflow, what triggers it, what does the AI do, what does the owner approve.**

---

### 6.1 Phone & Voice Agent (Customer Inbound)

**Trigger:** Customer calls the shop's Twilio number.

| Step | What happens | Voice / AI | Human |
|------|-------------|------------|-------|
| Answer | AI answers in brand voice: *"M&R Mechanical, how can I help you?"* | AI | — |
| Identify | Phone number → customer match; loads history, equipment, open invoices, membership status | AI | — |
| Recognize membership | *"Hi Sarah, I see you're on our Gold plan — you have priority scheduling"* | AI | — |
| Detect emergency | Urgency + vulnerability signals → fast-path escalation (skip booking flow) | AI | Owner phone patch-through |
| Classify intent | Book service, get quote, check appointment status, general question, complaint, B2B account | AI | — |
| Disambiguate | *"Is this for heating or cooling?"* / *"Is this an emergency or can we schedule a visit?"* | AI | — |
| Scope + price context | Equipment age, service history, vertical terminology injected into prompt | AI | — |
| Slot check | Available slots in tenant timezone, drive-time feasibility, conflict check | AI | — |
| Booking proposal | Creates `create_booking` proposal with date/time/tech/job details | AI | Owner one-tap SMS |
| Confirmation | *"I've booked you for Tuesday at 2pm — you'll get a text confirmation"* | AI | — |
| Post-call | SMS confirmation to customer, call summary logged, AI run recorded | AI | — |
| Dropped call | Drop detected in < 5s; SMS recovery sent to caller within 60s with partial transcript | AI | — |

**Vertical behaviors:**
- HVAC: equipment unit type, service history, seasonal urgency context
- Plumbing: severity triage (active leak > frozen no leak > routine)
- B2B: property manager routing, sub-account association, occupied-property flag

---

### 6.2 Owner Back-Office Voice Interface

**Trigger:** Owner speaks to the in-app assistant (mobile push-to-talk or voice session).

| Intent | Owner says | AI does | Owner approves |
|--------|-----------|---------|----------------|
| Schedule check | "What's on my schedule today?" | Reads today's appointments by tech + time | No approval needed (query) |
| Revenue | "How much did I make this week?" | Returns revenue billed + collected | No approval needed (query) |
| Issue invoice | "Invoice the Martins for today's job — two hours labor and a capacitor" | Drafts catalog-priced invoice proposal | One-tap SMS |
| Add note | "Add a note to the Rodriguez job — replaced compressor, unit is 7 years old" | Creates note + equipment entry on the job | No approval needed (low-risk) |
| Historical lookup | "What did I charge the Smiths last time for an AC service?" | Returns last invoice for that job type | No approval needed (query) |
| Assign tech | "Assign Carlos to the Johnson job tomorrow at 10" | Reassign proposal | One-tap SMS |
| Reschedule | "Move Thursday's Williams appointment to next Tuesday" | Reschedule proposal + customer SMS draft | One-tap SMS |
| Follow-up | "Send a reminder to everyone with invoices over 30 days overdue" | Batch follow-up proposals | Batch one-tap SMS |
| Profit check | "Did I make money on the Hernandez job?" | Returns per-job P&L (labor + parts + expenses vs revenue) | No approval needed (query) |
| Parts check | "What's on my truck?" | Returns truck inventory list | No approval needed (query) |
| Expense capture | "I spent $84 at Ferguson on the Miller job — two ball valves" | Creates job expense + updates truck inventory | Low-risk auto or one-tap |

---

### 6.3 Scheduling & Dispatch

**Workflows:**

1. **Booking from call** — Slot availability → conflict check → drive-time feasibility → booking proposal
2. **Booking from web / portal** — Public booking link → token-free flow → held appointment → owner proposal
3. **Reschedule** — Voice request or owner-initiated → reschedule proposal → customer notified via SMS
4. **Cancel** — Cancellation proposal → customer SMS draft in brand voice → owner approves
5. **Emergency dispatch** — Skip normal queue → direct patch-through to owner → high-priority booking
6. **Tech assignment** — AI ranked proposal ("assign Carlos — closest + certified, 2 jobs today") → one-tap
7. **Tech "I'm out" / sick day** — SMS keyword "OUT" → all-day reschedule proposals cascade → one-tap each
8. **"On my way" → ETA** — Tech taps or says "on my way" → location → drive-time calc → branded ETA SMS to customer
9. **Late arrival** — Predicted delay > N min → proactive ETA update to customer
10. **Multi-tech coordination** — Owner assigns different techs to different jobs; conflict detection across calendar
11. **Route suggestion** — Morning digest suggests optimal tech sequence (drive-time optimized) → owner approves

**Data requirements:** Appointment, job, technician, service location, customer, tenant timezone, travel-time cache (Google Maps with haversine fallback).

---

### 6.4 Estimating & Quoting

**Workflow A — Voice-drafted (standard):**
1. Post-call context → AI drafts line items from call transcript + customer history
2. Catalog resolver prices every line item against tenant's active catalog
3. Uncatalogued items capped at 85% confidence (always lands in front of a human)
4. Good/better/best tiers generated for relevant service types
5. Confidence markers attached to uncertain items (part not in history, price deviation > 10%)
6. Supervisor agent reviews for pricing anomalies + brand-voice drift
7. Proposal reaches owner via SMS or voice for approval
8. Approved → emailed/SMS'd to customer with portal link
9. Customer selects tier, signs, Stripe deposit captured

**Workflow B — MMS-to-quote (plumbing):**
1. Customer sends photo via SMS
2. AI analyzes image + customer history + property age
3. Draft estimate with severity markers and confidence flags
4. Same approval and portal flow as above

**Workflow C — Unsold estimate follow-up:**
1. Estimate reaches expiry window (configurable, e.g., 7 days)
2. Follow-up agent proposes a reminder SMS in brand voice
3. Owner one-tap approves
4. Second follow-up if no response in 72 hours
5. Outcome reported in digest

**Estimate portal (client hub):**
- Token-gated link, no login
- Customer sees summary, tiered options, terms
- Signs + selects tier
- Deposit charged via Stripe on acceptance
- Owner notified, proposal marked accepted

---

### 6.5 Invoicing & Payments

**Workflow A — Auto-invoice on completion:**
1. Job marked complete (tech tap or voice) → trigger `draft_invoice` worker
2. AI drafts line items from: time entries, parts used (truck inventory), job notes, vertical pack template
3. Every line item catalog-priced
4. Invoice proposal sent to owner via SMS
5. One-tap approve → invoice issued, payment link SMS'd to customer

**Workflow B — Voice invoice:**
1. Owner: *"Invoice the Martins for today's job — two hours labor and a capacitor"*
2. AI resolves entities (customer, job), prices line items from catalog
3. Draft proposal surfaced for approval
4. One-tap → invoice issued

**Workflow C — Progressive / milestone invoicing:**
1. *"Bill 50% now, balance on completion? [Yes]"* → linked milestone invoices
2. Deposit invoice issued immediately
3. Balance invoice held until job completion trigger

**Payment methods (V1):** Card (Stripe), ACH, payment link (customer pays via portal)  
**Payment methods (roadmap):** Tap-to-pay (Stripe Terminal), tips at checkout, consumer financing (Wisetack), auto-pay / saved card for memberships

**Dunning & collections:**
1. Overdue sweep runs nightly
2. Configurable cadence: reminder at 7 days, follow-up at 14 days, final notice at 30 days
3. Each step generates a proposal (owner approves or skips)
4. Late fee auto-accrues after threshold (configurable)
5. Digest summarizes outstanding receivables daily
6. Owner voice query: *"What's my total outstanding AR?"*

**Accounting sync (Wave 3):** Paid invoices → QuickBooks Online sales receipts, customers synced, payments matched.

---

### 6.6 Customer Management (CRM)

**Customer record contains:**
- Name, phone, email, account type (residential / commercial / property manager)
- Parent account (for commercial sub-accounts / properties under management)
- Service locations (multiple per customer)
- Equipment history (HVAC: unit model + service age + repair history; plumbing: fixture age + known issues)
- Communication history (all channels: calls, SMS, email in one timeline)
- Job history (dates, revenue, tech, outcomes)
- Payment history + current balance
- Open estimates, open invoices
- Next scheduled appointment
- Membership / maintenance plan status
- Internal notes (voice-captured)
- B2B flags and account associations

**Voice lookups:**
- *"Pull up the Hernandez account"* → customer record read out + voice navigation
- *"When did I last service the Smiths' AC?"* → date + job summary
- *"What equipment do I have on file for 14 Oak Street?"* → equipment list

**Account recognition on inbound calls:**
- Phone number → customer match
- Low-confidence match → surfaced as confidence marker to owner
- B2B account claims → verified against account database or flagged uncertain
- New callers → new customer created from call, prefilled from conversation

---

### 6.7 Maintenance Plans & Memberships

**Plan features (V1 build target for PMF):**
- Plan creation: name, price, included services, billing frequency (monthly / annual)
- Customer enrollment via owner voice or web
- Auto-renewal: Stripe `off_session` charge on renewal date
- Member pricing: discount applied to estimates and invoices on enrollment
- Priority booking flag: consumed by booking flow to surface open slots before non-members
- Scheduled service generation: auto-creates job + draft invoice on schedule
- Plan expiry warning: 90/30/7 day digest notices to owner
- Plan cancellation: immediate or end-of-period, prorated refund proposal

**Voice interactions:**
- *"Enroll the Smiths in the Gold HVAC plan"* → enrollment proposal
- *"What's on the Williams maintenance schedule?"* → plan + next service date
- On inbound call: AI recognizes member and greets with plan status

**Competitive note:** This closes the primary membership gap vs. Jobber. Member pricing + auto-renew + priority booking is the Jobber parity target for V1 to PMF.

---

### 6.8 Field Operations (Mobile)

**Tech's daily workflow:**
1. Opens app → today's schedule with addresses + job details
2. Taps "On my way" → ETA text sent to customer
3. Arrives → job check-in (tap or voice)
4. Voice notes during job: *"Replaced capacitor, ran diagnostics, unit is 7 years old — recommend replacement in 2–3 years"* → logged as job note + equipment update
5. Time tracking (start/stop per phase)
6. Parts used → deducted from truck inventory → added to draft invoice
7. Photos captured (job documentation, for MMS-to-quote)
8. Scope change needed → proposal to owner, never unilateral
9. Job complete → tap or voice → triggers auto-invoice flow
10. On-site invoice (optional) → payment link or tap-to-pay
11. "I'm out" (sick, emergency) → single SMS keyword → cascade reschedule
12. Receipt capture: snap receipt → OCR → expense logged to job

**Offline capability (PWA):**
- Voice notes queued when signal lost → sync on reconnect
- Photos stored locally → upload on reconnect
- Time tracking offline → sync on reconnect
- No loss of field data in basements, crawlspaces, or poor-signal areas

**Mobile experience target:**
- All tap targets ≥ 44px (glove-friendly)
- No horizontal overflow at 320px
- Works on the truck, one-handed, in sunlight
- PWA first; native Capacitor app on roadmap

---

### 6.9 Communications & Messaging

**Inbound channels:** Voice (Twilio), SMS, email  
**Outbound channels:** SMS, email, voice (emergency patch-through)

**Unified customer timeline:**
- All inbound and outbound interactions in one thread per customer
- Call transcripts, SMS threads, email, job notes, proposals — all in one view
- No siloed inboxes

**AI-suggested replies:**
- Every inbound message surfaces an AI draft reply in brand voice
- Owner edits and sends — never auto-sent
- Draft appears in inbox card as one-tap compose action

**Automated customer communications (autonomous, no approval needed):**
- Appointment confirmation (on booking)
- Day-before reminder (24 hours prior)
- "On my way" ETA (on tech departure)
- Invoice sent (on issue)
- Payment received (on payment)
- Review request (post-job, DNC-gated)

**Owner-approved communications (always proposal-gated):**
- Estimate sends
- Invoice follow-ups / dunning notices
- Review response (public + private)
- Any outbound not in the autonomous set above

**Negotiation guardrail:**
- Discount requests, scope changes, "speak to the manager," deadline threats → AI refuses to negotiate
- AI acknowledges politely: *"Let me check with [owner first name] on that — I'll get back to you within the hour"*
- Proposal generated for owner with recommendation
- Owner receives via SMS within 30 seconds

**Brand voice config:**
- Register (formal / friendly / casual)
- Opening lines, sign-off, shop persona name
- Banned phrases
- Validated on every AI-generated utterance
- Locked after onboarding; changes are web-only and audit-logged

---

### 6.10 Client Hub (Customer Portal)

**Access:** Token-gated link (emailed or SMS'd). No account required. No login.

**V1 scope (PMF target):**
- Estimate review: see line items, tier options, terms
- Tier selection: customer picks good/better/best
- E-signature: sign estimate approval
- Deposit: Stripe checkout on acceptance
- Invoice view: see itemized invoice
- Invoice payment: card or ACH via Stripe
- Receipt: downloadable after payment

**V2 scope (post-PMF):**
- Service request submission
- Appointment history view
- Upcoming appointment details + tech bio
- Plan / membership status
- Communication preferences

**Design constraints:**
- Works on any phone, any browser
- No JavaScript required for core payment flow (progressive enhancement)
- Single-use token, 72-hour expiry (configurable), one-click resend from owner

---

### 6.11 Reviews & Reputation

**Proactive review requests:**
1. Job marked complete → post-job SMS proposed to owner (DNC-gated)
2. Approval → SMS sent to customer with review-gating flow
3. Rating ≥ 4 stars → routed to Google Business Profile link
4. Rating < 4 stars → routed to internal feedback form (not to public platforms)
5. Outcome logged + digest line

**Google review monitoring:**
1. Google Business Profile polled every 15 minutes
2. New review → classified (praise / specific complaint / vague complaint / wrong business)
3. For any review < 4 stars: AI drafts public response (brand voice, addresses specific complaint)
4. If customer identifiable: AI drafts private apology SMS + optional service credit offer
5. Proposal reaches owner via SMS within 30 minutes of posting
6. Owner approves public response + private message via one-tap

**Non-goal:** Yelp / Facebook / Nextdoor monitoring in V1.

---

### 6.12 Reporting & Analytics (Voice-Accessible)

**Philosophy:** The end-of-day SMS digest *is* the dashboard. Every metric must also be queryable by voice.

**Daily digest (6–9pm in tenant timezone):**
- Jobs completed: count + revenue invoiced + revenue collected
- Quotes sent: count + pipeline value
- Unpaid invoice follow-ups sent: count + outcomes
- Tomorrow's schedule confirmation
- *"What I wasn't sure about today"*: confidence markers that fired + owner decisions
- *"What I learned today"*: corrections applied to prior outputs
- Outstanding AR summary

**Voice-queryable metrics:**
- Revenue (today / this week / this month / by job type)
- Outstanding invoices (total AR, oldest invoice, highest balance)
- Jobs (completed today, scheduled this week, win/loss)
- Per-job profit: *"Did I make money on the Hernandez job?"*
- Estimate win rate: *"What's my quote acceptance rate this month?"*
- Technician utilization: *"How many hours did Carlos work this week?"*

**Reporting surfaces (web — audit/config only):**
- Revenue by source / tech / job type (monthly)
- Time-to-cash trend
- Estimate win/loss funnel
- Tax export (accountant-ready CSV)

**QuickBooks sync (Wave 3):**
- Paid invoices → QuickBooks sales receipts (async worker, invisible to owner)
- Customers synced on first invoice
- Failed syncs surface as digest line with one-tap retry

---

### 6.13 Trust & Safety Architecture

The AI back office handles money, scheduling, and customer communication on behalf of the owner. The trust architecture is what separates this from a voice assistant that occasionally embarrasses the business.

**The four trust pillars:**

1. **The AI surfaces its own uncertainty** — confidence markers fire when a part isn't in history, a price deviates > 10%, urgency is inconsistent, an account claim is unverified, or brand voice deviates.

2. **The supervisor agent reviews high-stakes outputs** — a second, cheaper classifier reviews every booking, quote, and invoice before it reaches the owner. Checks for: missed urgency, pricing anomalies, brand-voice drift, account-routing errors. Critical flags hold the proposal and send a direct owner alert. Target: review completes in < 60 seconds.

3. **No irreversible actions without explicit approval** — discounts, scope changes, refunds, price commitments, and emergency rerouting always route to the owner. No exceptions.

4. **The end-of-day digest tells the truth** — *"what I wasn't sure about today"* and *"what I learned today"* appear every evening. The digest is the system's self-report card.

**The seven failure modes (and their designed-in recoveries):**

| Failure | Recovery |
|---------|---------|
| Wrong quote (stale rate) | Caught in approval queue with a correction prompt; rate updates forward |
| Hallucinated part | Low-confidence marker + owner prompted to verify |
| Missed emergency intent | Supervisor agent flags within 60 seconds; direct owner alert |
| Dropped call | SMS recovery within 60 seconds with partial transcript |
| Customer games the price | AI refuses to negotiate; routes to owner with recommendation |
| Carlos no-show (tech doesn't show) | Cascade reschedule proposals generated; customer notified |
| 1-star Google review | Detected within 30 minutes; draft response + private apology in approval queue |

**Correction loop:**
When the owner edits a proposal, the system extracts a lesson and applies it forward:
- Labor rate change → updates tenant's default rate
- Part price change → updates tenant's price for that SKU
- Banned phrase rejected → adds to brand-voice negative prompt
- Scope re-classified → adjusts vertical-pack template selection

Lessons are auditable and reversible. Each is reported in that day's digest.

---

### 6.14 AI Architecture (Technical)

```
Inbound Voice (Twilio Media Streams)
    ↓
Deepgram Streaming STT (< 300ms)
    ↓
Intake & Triage Layer
    Intent Classification · Vulnerability Detector · Severity
    B2B Account Recognizer · Dropped-Call Recovery
    ↓
Conversation Layer
    Threads · Transcripts · Entity Resolution · Customer History
    ↓
AI Orchestration
    Context Assembly · Vertical-Pack Routing · Task Selection
    ↓
LLM Gateway
    Provider Adapters · Tier Routing · Health / Failover · Cache
    Tier 1: classify (fast/cheap) · Tier 2: proposals · Tier 3: estimates
    ↓
Catalog Resolver (every AI-drafted price grounded in tenant catalog)
    ↓
Proposal Engine (Trust Boundary)
    Typed Contracts · Confidence Markers · Brand-Voice Validator
    Negotiation Guardrails · Expiry
    ↓
Supervisor Agent (second-pass review)
    Re-scores Urgency · Pricing Anomalies · Brand Drift · Routing Errors
    Latency budget: < 60s post-proposal
    ↓
SMS Approval Transport
    Renders proposals as < 320-char SMS · One-tap APPROVE/EDIT/REJECT
    Accepts voice-dictated edit replies · Tracks approval state
    ↓ (approved only)
Deterministic Execution
    Entity Mutations · Idempotency · Audit Events · Rollback-safe
    ↓
Operational Data Layer (PostgreSQL, RLS, tenant-scoped)
    Customers · Accounts · Jobs · Appointments · Estimates
    Invoices · Payments · Equipment · Proposals · Audit
    ↓
Reporting & Learning
    AI Runs · Prompt Versions · Edit Deltas · Correction Loop
    Daily Digest Generator · Weekly Summary
    ↓
Reputation Layer
    Google Business Polling · Review Classifier · Draft Response
```

**Key invariants (non-negotiable):**
- Money: integer cents, never floating point
- Time: stored UTC, rendered in tenant timezone
- Entities: every row has `tenant_id`; RLS enforced with FORCE
- Mutations: emit audit events
- AI calls: route through LLM gateway only
- Proposals: typed Zod contracts; human-approved
- AI-drafted prices: resolved against tenant catalog before proposal creation
- High-stakes outputs: supervisor agent reviewed before reaching owner/customer

---

## 7. Onboarding Flow

New shop → active AI back office in < 48 hours.

| Step | Owner does | System does |
|------|-----------|-------------|
| Signup | Name, email, business name, vertical (HVAC / plumbing / both) | Creates tenant + workspace |
| Business setup | Address, service radius, business hours | Stores for scheduling + timezone |
| Price book | CSV import or conversational catalog building | Seeds catalog resolver |
| Brand voice | 6-field form: register, opening line, sign-off, banned phrases, persona name | Locks brand-voice profile |
| Phone number | Confirm or pick a Twilio number | Provisions number, points to agent |
| Technician setup | Add tech names + phones | Enables assignment + dispatch SMS |
| Test call | Owner calls their own number | AI answers in brand voice, books a test slot |
| First real call | First non-owner inbound call | Activation event recorded; funnel progresses |

**Activation metric:** Identity-based (first real caller ≠ owner phone, detected via Vapi webhook or count-based logic on Twilio). Idempotent per tenant.

---

## 8. The 6-Month Roadmap (V1 to PMF)

Target: 25 beta customers retained at week 4, NPS > 50.

### Now: Go-Live Hardening (Weeks 1–2)

Fix the blockers that undermine money integrity and tenant isolation before any new features.

| Blocker | Fix |
|---------|-----|
| Stripe/Clerk webhook dedup in-memory only | Move to durable DB table (restart-safe) |
| Requests commit even on error | Transaction rollback on 4xx/5xx |
| RLS enabled but not FORCED on 29 tables | Force RLS on all entity tables |
| Proposal approval in web UI is unauthenticated | Add auth check to approval endpoint |
| In-process cron sweeps on every instance | Leader-elect with runAsLeader pattern |
| No payment audit events | Emit audit on every recordPayment call |

### Phase 1: Make the Voice Promise True (Weeks 2–5)

Deliver the core voice loop end-to-end for both directions.

| Story | What | Why |
|-------|------|-----|
| P2-034 — SMS Approval Transport | Proposals render to < 320-char SMS with one-tap APPROVE/EDIT/REJECT | Owner in a truck needs to approve from their thumb |
| P2-035 — Confidence Markers | Surface "I wasn't sure about: [item]" on proposal + SMS | Trust foundation |
| P2-037 — Supervisor Agent | Second-pass classifier reviews every booking/quote/invoice | Can't ship to customers without this |
| P8-012 — Media Streams | Real-time voice STT via Deepgram WebSocket (< 800ms TTFA) | Competitive with Avoca; < Gather polling |
| P5-020 — End-of-Day Digest | Daily SMS summary delivered 6–9pm with "wasn't sure" + "learned" | The dashboard |
| P2-038 — Correction Loop | Owner edits → lesson extracted → forward-applied | Makes the system smarter every day |

### Phase 2: Close the Jobber Gaps (Weeks 5–10)

| Story | Jobber gap closed | What |
|-------|-------------------|------|
| Memberships deepening | Auto-renew, member pricing, priority booking | Stripe off_session + plan-aware booking + estimate discounts |
| P7-026 — Google Review Draft Response | Review monitoring + AI-authored responses | Already built; wire approval transport |
| P8 follow-up agent | Unsold estimate chases, maintenance reminders | Found money with zero owner effort |
| Client Hub — portal (lightweight) | Estimate approval + payment (no login) | Already partially built; complete the flow |
| P2-036 — Negotiation Guardrail | Discount requests handled safely | AI refuses; owner proposal with recommendation |

### Phase 3: Field & Money Depth (Weeks 10–18)

| Story | What |
|-------|------|
| P24 — Equipment Registry | HVAC unit history on every call and estimate; repair-vs-replace context |
| P14 — Truck Inventory (simple) | One truck per tech, parts auto-deduct into invoice lines |
| P22-005 — Per-job profit by voice | "Did I make money on that job?" answerable by speaking |
| P20 — Auto-invoice + dunning cadence | Job completion → invoice → multi-step follow-up + late fees |
| P23 — QuickBooks sync | Paid invoices → QBO sales receipts (async, invisible to owner) |
| Capacitor native (spike → ship) | Evaluate on-device STT; native push notifications; camera integration |
| P4-015 — Brand Voice Configurator | Full onboarding brand voice setup + validation |
| N-008 — Vulnerability-Aware Triage | Age + weather + medical context elevates urgency |
| N-007 — Dropped-Call SMS Recovery | Full recovery flow wired |

### Deferred (Post-PMF)

| Feature | Rationale |
|---------|-----------|
| Consumer financing (Wisetack) | Integration-heavy; Tier 3 at this ICP; revisit after PMF |
| Route optimization (full) | Drive-time feasibility is sufficient for 1–3 trucks; optimization is a fleet feature |
| Multi-location / team hierarchies | Not ICP for V1 |
| Full inventory (multi-warehouse) | Owner-operators carry parts in the truck; simple truck inventory is sufficient |
| Customer portal — full self-service | Lightweight portal covers PMF needs; full portal is post-PMF |
| Custom form builder | Canned vertical checklists cover the ICP |
| Marketing campaigns | Follow-up agent covers the relevant use cases without building a campaign engine |
| Customer portal — full history view | Post-PMF; lightweight estimate + pay is enough |

---

## 9. Success Metrics

### North star

**Owner hours returned per week.** Measured with a structured time-diary baseline at onboarding and re-measured at weeks 4 and 8.

**Target:** 12+ hours/week saved for the median pilot at week 8.

### Mike's day (HVAC, 2 trucks)

| Metric | Baseline | V1 Target |
|--------|----------|-----------|
| Calls answered during work hours | ~40% | 100% |
| Quotes drafted within 4 hours of intake | ~30% | > 90% |
| Invoices sent within 24 hours of completion | ~50% | > 90% |
| Time-to-cash (median days, invoice → paid) | 14–21 | < 10 |
| Owner SMS approvals/day | n/a | < 15 (sustainable) |
| Owner SMS approval median latency | n/a | < 10 minutes during business hours |

### Jenna's day (plumbing, solo)

| Metric | Baseline | V1 Target |
|--------|----------|-----------|
| Calls answered (frozen-pipe season) | < 30% | 100% |
| B2B calls routed correctly | n/a | > 95% |
| Photo-to-quote median time | 4–24h | < 2h |
| Owner SMS approvals/day | n/a | < 12 |

### AI quality gates

| Metric | Threshold | Gate |
|--------|-----------|------|
| Estimate proposal approval rate | ≥ 70% | PMF |
| Clean approval rate (no edits) | ≥ 30% | PMF |
| Invoice proposal approval rate | ≥ 75% | PMF |
| Proposal execution success | > 99% | Hardening |
| LLM gateway availability | > 99.5% | Hardening |
| Supervisor agent critical-flag false-positive rate | < 5% | PMF |
| Supervisor agent critical-flag false-negative rate | < 2% on labeled set | PMF |
| Dropped-call SMS recovery latency (P95) | < 60s | PMF |
| Vulnerability triage correct-escalation rate | > 95% on labeled set | PMF |
| Brand-voice deviation detection precision | > 85% | PMF |
| End-of-day digest delivery rate | > 99% within window | PMF |
| Google review draft-response approval rate | > 70% | PMF |

### Business metrics

| Metric | 3-month target | 6-month target |
|--------|----------------|----------------|
| Active paying customers | 5 | 25 |
| Week-4 retention | 80% | 90% |
| MRR per customer | $300–500 | $300–500 |
| Time: signup → first AI-handled call | < 48h | < 24h |
| NPS (pilot cohort) | n/a | > 50 |

---

## 10. Risk Register

| # | Risk | Mitigation |
|---|------|-----------|
| 1 | AI mis-quotes and owner approves without reading; customer angry | Confidence markers + supervisor agent flag out-of-pattern totals; catalog-resolver floors AI pricing |
| 2 | Voice mis-understood; bad booking made | Dropped-call SMS recovery; supervisor re-classifies; confidence marker on urgency |
| 3 | Owner ignores SMS approvals during a busy day; backlog grows | Approval-count target < 15/day; digest summarizes pending; onboarding sets expectations |
| 4 | Pilot churns because "it's not magic enough" | Manage expectations in sales: proposal model is intentional — safety, not limitation |
| 5 | Supervisor agent false-positive rate high; alert fatigue | < 5% target; tune in pilot; per-tenant calibration in Wave 3 |
| 6 | Google Business API limits or changes | Polling with backoff; fallback to manual; "monitoring degraded" banner |
| 7 | LLM provider deprecates model; quality regression | Gateway abstraction + shadow comparison (P2-030) + pinned model versions |
| 8 | Native mobile gap loses customers to Jobber | PWA with Capacitor native on roadmap; prioritize based on beta feedback |
| 9 | Vulnerability triage misses real medical emergency | Conservative threshold; document non-medical disclaimer; vulnerability alone = high-priority booking + owner notify |
| 10 | Memberships not competitive enough vs. Jobber | Phase 2 closes auto-renew + member pricing; monitor beta feedback on membership churn |
| 11 | QuickBooks delay loses customers with accountants | Basic CSV tax export buys time; emphasize "accountant-ready export" while sync is built |
| 12 | Client hub is too lightweight vs. Jobber Client Hub | Monitor usage; V2 scope (full history + request submission) if demand validated |

---

## 11. Competitive Positioning Summary

| | Jobber | ServiceTitan | Avoca | **Rivet / ServiceOS** |
|---|---|---|---|---|
| Target | 1–50 techs | 10–1000 techs | Front desk add-on | **1–3 techs, owner-operator** |
| AI role | Assistant features (Copilot, AI Receptionist) | Bolt-on | Answers phone, read-mostly | **Runs the back office, writes via proposals** |
| Owner's office workload | Reduced (still requires daily app use) | Shifted to office staff | Calls only | **Eliminated — voice and SMS, never a console** |
| Trust / safety model | None | None | Limited | **Typed proposals + supervisor agent + undo + audit** |
| Phone answering | AI captures, human books | Partial | AI answers, hand-off | **AI answers, proposes booking, owner approves** |
| Voice as primary interface | No (chat assistant in app) | No | No | **Yes — both directions** |
| Equipment history | No | Yes (enterprise) | No | **Yes (HVAC differentiator)** |
| Truck inventory | No | Yes (warehouse) | No | **Yes (simple truck model — roadmap)** |
| Per-job profit by voice | Top plan only | Yes | No | **Yes (roadmap)** |
| Native mobile | iOS/Android | iOS/Android | n/a | **PWA → native (roadmap)** |
| End-of-day digest | No | No | No | **Yes — the dashboard** |
| AI writes to system of record | No | No | No | **Yes — the core architecture** |
| Price for a 2-person shop | $79–249/mo | Prohibitive | Add-on cost | **$300–500/mo (full back office)** |

**The wedge in one sentence:** Jobber gives the new business owner better paperwork; Rivet does the paperwork — they speak, it happens, they get to stay a tradesperson.

---

## 12. Glossary

| Term | Definition |
|------|-----------|
| **Proposal** | A typed, reviewable, human-approvable representation of a proposed mutation (create customer, draft estimate, send invoice, reschedule, etc.). Nothing executes without an approved proposal. |
| **Confidence marker** | A typed flag indicating AI uncertainty about a specific element (part, price, urgency, account, brand voice). Surfaced in SMS + web; never a percentage on every line. |
| **Supervisor agent** | A cheaper second-pass classifier that reviews primary AI outputs for missed urgency, pricing anomalies, brand-voice drift, and account-routing errors. Completes within 60 seconds. |
| **Correction loop** | The mechanism by which owner edits are extracted into structured lessons and applied forward to future AI outputs. Reported in the daily digest. |
| **Vertical pack** | A bundle of HVAC- or plumbing-specific terminology, severity classifiers, intake skills, and estimate templates. Loaded per tenant. |
| **Catalog resolver** | The module that prices every AI-drafted line item against the tenant's active catalog. Uncatalogued items cap confidence at 85%. |
| **Vulnerability signal** | Age, weather, medical, or property-type context that elevates urgency in triage. Vulnerability + urgency → owner patch-through. |
| **Client hub** | The token-gated customer portal for estimate approval and invoice payment. No login required. |
| **Digest** | The end-of-day SMS summary delivered 6–9pm tenant-local. The dashboard. |
| **Brand voice** | The locked tone, register, and lexical profile for all AI utterances. Captured in onboarding, locked after setup, validated on every outbound message. |
| **Wave** | A delivery phase: Hardening → Phase 1 (voice promise) → Phase 2 (Jobber gaps) → Phase 3 (field & money depth). |
| **Entity resolver** | The module that resolves free-text customer/job/account references from voice to verified database UUIDs. Ambiguity triggers a one-tap clarification. |

---

## 13. Document History

| Version | Date | Summary |
|---------|------|---------|
| 1.0 | 2026-03 | Initial 8-phase execution catalog. |
| 2.0 | 2026-05-17 | Re-framed around AI back office strategy. Added 11 new stories (SMS approval, supervisor agent, digest, review monitoring, dropped-call recovery, vulnerability triage, correction loop, brand voice, tech status). |
| 3.0 | 2026-06-11 | **Voice-first reframe** — voice elevated to primary interface (both directions); SMS is async approval/notification channel. Added full Jobber feature parity map. Added job costing, memberships depth, client hub (lightweight portal), native mobile strategy. Updated ICP to include "going independent" persona. 6-month roadmap with phased priorities. Updated all 16 product decisions. |

**Next review:** After Phase 1 exit (weeks 5–6), before Phase 2 kick-off.  
**Change protocol:** PRD changes require a recorded decision in `docs/decisions.md` and a paired update to `docs/strategy/day-in-the-life.md` if the change affects the customer experience.
