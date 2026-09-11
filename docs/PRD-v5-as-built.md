# Rivet — Product Requirements Document

**Version:** 5.0 — *reconstructed from the code as built*
**Reconstructed:** 2026-09-11, against `main` @ `9000267`
**Supersedes:** `docs/PRD.md` (v2.0, 2026-05-17) · `docs/PRD-rivet-master.md` (1.0, 2026-07-12) · `docs/PRD-v4-part-E-state.md` · `docs/PRD-v4-part-F-decisions.md`
**Retains:** `docs/PRD-execution-catalog.md` as the story-level engineering archive
**Owner:** Product

---

## 0. About this document

Every prior PRD in this repository was written **forward** — a statement of
intent, followed some months later by an audit measuring how far the code had
drifted from it. This one is written **backward**. It reads the shipping system
and states what the product actually is, what it requires of itself, and — by
tracing the decision log and the shape of the code — what the user must have
needed for it to have become this.

That inversion is the point. A product that has been built has already answered
most of its own requirements questions. The answers are in the enums, the
gates, the invariants the tests refuse to let you break, and the twenty-nine
recorded decisions where someone chose one thing over another and wrote down
why. This document recovers those answers and states them as requirements, so
that the PRD and the system finally agree.

**Method.** Twelve parallel read-only sweeps across 3,868 source files —
282,247 LOC in `packages/api`, 111,568 in `packages/web`, plus mobile, shared,
and a 1,403-file API test corpus — cross-read against the decision log
(D-001–D-029), the strategy spine (`docs/strategy/day-in-the-life.md`), the
go-to-market brief, and the 2026-09-06 full-verification run. Where
documentation and code disagreed, **the code won and the disagreement is
recorded in §12**.

**Status convention.** Functional requirements carry a build-state marker,
using the ladder this repository itself invented in PRD v4 Part E:

| Rung | Meaning |
|---|---|
| **0 Absent** | Nothing implements it |
| **1 Specced** | Design exists; no implementation |
| **2 Present** | Implemented but with no live caller — built and dormant |
| **3 Wired** | Reachable in production; proof is mocked-DB only |
| **4 Proven** | A Docker-gated integration test proves the write **and** its audit event against real Postgres |
| **5 Reachable** | Proven *and* reachable by a real user on the surface the requirement names |
| **6 Live** | Observed working in production, with real tenants |

**Rung 6 is empty across the entire product.** That is the single most
important fact in this document, and §12 treats it as such rather than burying
it.

---

## 1. The product in one sentence

> **You learned the trade. We'll run the business.**

Rivet is a **voice-first AI back office** for 1–3-truck home-service shops.
Customers call and the AI answers, qualifies, and books. The owner talks to the
business — *"invoice the Martins for two hours and a capacitor," "move
Thursday's Williams job to Tuesday," "did I make money on the Hernandez job?"*
— and the AI turns speech into typed, **approvable** actions that write to the
system of record only after a human taps.

It is not a CRM with a microphone bolted on. The web app exists for audit,
configuration, and the approval tap. The voice channel is the product.

**The wedge, in one line:**

> Jobber gives the owner better paperwork. Avoca answers the phone. Rivet does
> the office work — the owner speaks, it happens, and they get to stay a
> tradesperson.

**North star:** owner hours returned per week (target 12+ by week 8).
**Secondary:** time-to-cash — days from job completion to money received.
**The litmus test that kills features:** *no feature ships that adds admin work
to the owner's day.*

---

## 2. The problem: administrative debt

Skilled tradespeople rarely fail because they can't do the trade. They grind
themselves down under **administrative debt** — the office work a 1–3-person
shop has nobody to do. The owner becomes, against their will, the *dispatcher,
CSR, estimator, bookkeeper, collections agent, and marketing manager*. Only the
last role they wanted was "tradesperson."

Three constraints make a screen the wrong answer:

1. **The owner's hands are occupied.** In conduit, under a sink, on a roof, in
   gloves. A screen requires stopping work.
2. **The customer calls because they want to talk.** A booking form loses them.
3. **The work doesn't wait.** It piles up until 10pm, or it never happens.

**Why now.** Three things became true in the last 18 months: real-time voice
models hold a competent service conversation under $1/min in COGS; Twilio +
Stripe + modern ASR/TTS are mature enough for an AI to run a whole money flow;
and the labor crisis removed the alternative — "hire a receptionist" is not an
option at this size.

> **Market-sizing correction, carried forward and binding:** the real contractor
> first-year failure rate is **~15–20%** (Census), **not** the widely cited 70%.
> That figure is debunked and must not appear in any Rivet document, deck, or
> pitch.

---

## 3. Users

The defining ICP trait is not company size. It is **single-threaded admin
load** — one person, or no person, doing all the office work.

**Primary ICP:** owner-operator HVAC or plumbing shops, **1–3 trucks, no
dedicated office staff, $200K–$1M revenue**, US, English (with Spanish
supported end-to-end at the language layer).

### 3.1 Personas

**Mike Rivera — HVAC, Phoenix, 2 trucks, ~$680K.** 38, married, two kids, wife
works full-time. One employee (Carlos, his cousin, a tech who won't touch
paperwork). His real job title is dispatcher, CSR, estimator, bookkeeper,
collections agent, marketing manager, and HVAC tech — only the last is the one
he wanted. Peak season is 102°F and the phone never stops.

**Jenna Walsh — plumbing, Cleveland, solo, ~$340K.** 41, divorced, raising a
teenager. 18 years in the trade, 3 on her own. **Does not want a fleet** —
wants to stay solo and reclaim her life. Being single-threaded makes the AI
back office *more* urgent for her, not less. Frozen-pipe season at 4am is her
peak.

**The tech going independent** *(top of funnel)*. Just left a 500-person
company. No systems, no price book, no processes. Rivet is the first software
they buy, and it stands up their back office during onboarding. Lowest CAC,
zero switching cost. They become Mike or Jenna.

**The owner's spouse, doing the books Saturday morning** *(the unseen second
user)*. The end-of-day digest and the weekly summary must work for them.

### 3.2 Anti-personas — do not optimize for

- **The dispatcher at a 12-truck shop.** Different product; buys ServiceTitan.
- **The franchise owner.** Wants brand-compliance tooling, not a back office.
- **The hobbyist / side-hustle plumber.** Revenue doesn't justify the price.
- **The owner who wants AI fully unsupervised.** That is a different trust
  contract than the one this product sells — and §5 shows the code enforces the
  refusal structurally, not as a policy.

### 3.3 Jobs to be done

| # | Job | The moment it bites |
|---|---|---|
| J1 | *Answer my phone when I can't.* | In an attic, gloves on, phone buzzing in a pocket |
| J2 | *Book the job without me.* | 4am frozen pipe; whoever answers first wins |
| J3 | *Know when it's an emergency and get me.* | 104°F, elderly caller on oxygen |
| J4 | *Draft the quote from what was already said.* | 6:15am, making lunches one-handed |
| J5 | *Bill it the moment it's done.* | Walking out of the job |
| J6 | *Chase the money so I don't have to.* | 30 days later, $12K outstanding |
| J7 | *Tell me what happened today.* | 9:30pm, kids in bed |
| J8 | *Tell me what you got wrong.* | Whenever the AI was wrong — the trust pillar |
| J9 | *Let me fix it by talking.* | Driving to the next job |
| J10 | *Don't embarrass me in front of my customer.* | Always |

---

## 4. The requirement chain: how the user produced this system

This section is the derivation. Each requirement exists because a specific user
moment demanded it, and each produced a specific, checkable structure in the
code. Read it as the argument the codebase is making.

### R1 — "Answer the phone" ⇒ a conversational agent, not a phone tree

Mike loses at least one job a week to missed calls; three missed calls from the
same number at 5:45am is the founding image. An IVR loses the caller.
Voicemail loses the caller.

⇒ Two telephony transports behind **one channel-agnostic state machine**, so
the call flow is written once and the transport is an implementation detail.
The machine is a **pure reducer** — `dispatch(event) → SideEffect[]`, no I/O —
with 13 states and 10 side-effect types. This is why a failing low-latency call
can be REST-redirected mid-flight onto the resilient transport carrying the
same session and the same conversational state, and why the fallback route
structurally cannot re-enter the failing path.

### R2 — "But I don't trust it with my money or my customers" ⇒ the proposal gate

This is the load-bearing requirement of the entire product. Owner-operators do
not trust software with their schedule and their money, and an AI that writes
directly is unshippable to them.

⇒ **D-004, proposal-first:** the AI never writes to an operational entity. It
drafts a **typed proposal** validated by a Zod contract; a human approves; a
deterministic execution handler performs the write. Every AI-initiated mutation
in the product passes through this one gate. Sections §5 and §7 are almost
entirely consequences of that sentence.

### R3 — "Some decisions cost more than others" ⇒ action classes

Booking an appointment and issuing an invoice are not the same risk. Treating
them identically means either blocking everything (useless) or permitting
everything (unsafe).

⇒ An **action class** on every one of the 52 proposal types — `capture`,
`comms`, `money`, `irreversible`, `manual` — assigned by an **exhaustive
switch**, so adding a proposal type without classifying its risk is a compile
error. The class, not the proposal type and not the channel, decides what
approval costs.

### R4 — "It has to be right about *my* prices" ⇒ catalog grounding

Mike's bad Tuesday opens with a quote priced off last year's labor rate. A
hallucinated price that reaches a customer is worse than no quote at all.

⇒ **Catalog grounding.** An AI-emitted price is never authoritative. Every
drafted line resolves against the tenant's own catalog through a **pure,
deterministic, LLM-free resolver** before the proposal is shown. A confident
match overwrites the model's number; an ambiguous match gates the proposal to
draft; an uncatalogued line keeps the spoken price but is stamped as
uncatalogued and forces human review through a flag a tenant **cannot override
by lowering their auto-approve threshold**.

There is one deliberate subtlety worth stating as a requirement: when the
drafted price deviates from the catalog by more than *both* a relative and an
absolute threshold, the system does **not** overwrite it. It treats it as a
possible deliberate act ("half price for Mrs. Henderson") and surfaces a
choice. The product respects that the owner may mean it.

### R5 — "Don't guess who I meant" ⇒ the entity resolver and clarification

"Invoice the Martins" is ambiguous when there are two Martins. A silent guess
bills the wrong customer.

⇒ A tenant-scoped **entity resolver** across nine entity kinds with a
three-band outcome: confident → resolve silently; middle band → a spoken
one-tap "did you mean…?"; ambiguous → a **clarification**, never a guess. Zero
matches produce an explicit "no such record," never silence.

⇒ **D-029** adds the structural rule that makes this honest: *a gate on an
entity id is only legitimate if a resolver can lift it.* A gate nothing can
lift is a capability that can never be approved — which is exactly what sixteen
chat capabilities turned out to be before that rule was written. Two of them
(`convert_lead`, `mark_lead_lost`) gated on a `leadId` when no lead entity kind
existed at all: unreachable by construction, on every surface.

### R6 — "Tell me when you're unsure" ⇒ confidence markers, not percentages

A confidence percentage on every line is alarm fatigue. Silence about
uncertainty is the competitor's failure mode.

⇒ **Typed confidence markers**, emitted only where doubt matters — an
uncatalogued part, a price off the tenant's rolling average, an urgency call
the classifier is unsure of, an unverified B2B claim, brand-voice drift. No
"X% confident" badge appears anywhere in the product. The four-level vocabulary
(`high`/`medium`/`low`/`very_low`) is what the gates read; `low` and `very_low`
structurally block auto-approval, and `medium` deliberately does not.

### R7 — "Catch what you missed" ⇒ the supervisor pass

The flat-voiced elderly caller who says "it's hot" and gets booked for tomorrow
is the failure that costs a customer and a reputation.

⇒ **Two supervisors, deliberately different in kind.** A *deterministic policy
engine* runs synchronously inside proposal creation, enforcing per-proposal and
daily spend caps and an auto-approval rate limit — and it is **monotone
downgrade-only**: the strongest verdict it can produce moves a proposal toward
review, never toward approval. A *second-model reviewer* then runs at the
pre-dispatch chokepoint on a cheaper tier, checking missed urgency, pricing
anomalies, brand-voice drift, and account-routing errors within a hard 60-second
budget, **failing open** so the money loop is never blocked by a reviewer
outage. Only the two customer-harm checks can hold a proposal, and only in
enforce mode.

### R8 — "Never negotiate for me" ⇒ the negotiation guardrail

A customer who says "20% off or I go elsewhere" is asking the AI to spend the
owner's money.

⇒ The AI **acknowledges and routes**, never concedes. **D-012** later added a
per-tenant discount policy with a catalog-grounded floor that **fails closed**
at zero, so opting in is a deliberate act and the default behavior is
unchanged. Even the permissive verdict only decides whether a discount may be
*proposed* — never applied.

### R9 — "Emergencies override everything" ⇒ safety before the model

Urgency plus vulnerability (medical, age, weather, water damage in progress) is
the one case where booking is the *wrong* answer.

⇒ A **deterministic keyword scan that runs before any LLM call**, on every
transcript chunk including interim ones, scanning English *and* Spanish phrases
unconditionally regardless of the session language. Safety tiering takes the
**maximum** of every signal, with the reasoning stated in the code: *a false
positive costs one unnecessary transfer; a false negative can cost a life.*

⇒ **D-027** extends the same posture to complaints: an angry caller reaches a
person, with no tenant toggle able to route them into a brush-off, and the
escalation leaves a reviewable paper trail.

### R10 — "Don't lose the caller when the call drops" ⇒ SMS recovery

A dropped call at 1:31pm is a lost job unless something happens in the next
minute.

⇒ **Durable dropped-call SMS recovery** at 60 seconds, carrying partial
transcript context, threaded to the same intake conversation — and, crucially,
**re-evaluated at send time** so a caller who actually completed a booking is
never texted. This replaced an in-process timer that was lost on every restart.

### R11 — "I'm driving; let me just say it" ⇒ the owner's spoken command line

Directing work is *labor*. It must be speakable.

⇒ Push-to-talk on every authenticated screen, a recorded-memo path, and an
in-app chat surface — all feeding the same classifier, the same proposal gate,
the same execution handlers. Chat and voice share the task-handler registry *by
construction*, because they had already drifted once.

⇒ **But approval is exempt by design.** Directing work is labor; **approving**
it is *control* — deliberate, visual, one tap. **D-025** later corrected a
mis-citation here: owner voice approval on a caller-ID-identified owner line
*is* permitted, because the real invariant (D-019) is about **actors**, not
channels. No `system:` actor may ever approve. A human speaking is a human
approving.

### R12 — "Learn from my corrections" ⇒ the correction loop

If Mike fixes the labor rate once and the AI repeats the mistake tomorrow, the
product has failed its own promise.

⇒ Owner edits are mined for **structured lessons** — a labor rate, a SKU price,
a banned phrase, a template choice — applied forward the same day, reported in
the digest as "what I learned today," and **reversible**, because every lesson
stores both its before and after so undo is a pure reversal rather than a
recompute. Extraction is deliberately conservative: a single agreed rate, a
catalog-bound SKU, a contiguous phrase or nothing.

⇒ And a second-order loop the strategy documents never asked for: after the
owner corrects the same thing three times, **the AI drafts a proposal to fix it
permanently** — a catalog price change, or a standing instruction — through the
normal inbox, never auto-approved. A rejection suppresses it, but a *fresh*
repetition after the rejection re-earns the proposal. The system is allowed to
ask again when it has new evidence, and not otherwise.

### R13 — "Tell me what happened today" ⇒ the digest is the dashboard

Mike will not open a dashboard. He will read one text at 9pm.

⇒ An **end-of-day digest** in tenant-local evening hours: jobs done, money
invoiced and collected, quotes out, follow-ups and their outcomes, tomorrow's
schedule — and the two sections nobody else ships: **"what I wasn't sure about
today"** and **"what I learned today."** Its revenue math reuses the same
functions as the money dashboard, pinned by a parity test, so the digest and
the dashboard can never tell the owner two different numbers. When the language
model is down it falls back to deterministic copy, because *the digest must
never fail to send because the LLM was unavailable.*

### R14 — "It has to sound like my shop" ⇒ brand voice, captured then locked

Every AI utterance is the shop's reputation.

⇒ A per-tenant brand-voice profile applied in the **system** prompt slot with
explicit authority over anything in the message context — and then enforced
*again in code* after generation, because the model is only *asked* not to use a
banned phrase and can ignore that. A stripped phrase or a register mismatch
**caps the proposal's confidence at low**, routing it to review rather than
letting it auto-approve.

⇒ **D-023 (F-2)** settles the boundary precisely: capture and edit are
*speakable* as an approval-gated proposal; **locking is tap-only**, and the
payload contract has no lock-shaped field, so a spoken "lock my brand voice"
structurally cannot set it.

### R15 — "Don't text people who told you to stop" ⇒ one consent model

Two consent fields with no cross-enforcement meant a customer who revoked by
phone could still be texted.

⇒ **D-017:** one append-only consent ledger behind both outbound gates, with a
deliberately **asymmetric** rule — *a revocation of contact consent blocks every
channel; a grant never crosses channels.* Objecting to being recorded blocks
voice but not appointment texts, because that is a privacy preference, not a
revocation of contact. Honoring a revocation everywhere is always safe;
propagating a grant would fabricate consent.

### R16 — "My data is mine" ⇒ tenancy at the database, not the application

⇒ `tenant_id` on every entity, row-level security **forced** at the database, a
per-request transaction-scoped setting (never a session-scoped one, which would
leak across a pooled connection to the next request), and a dedicated
**non-bypassing runtime role** — because the application's own connection
principal owns the tables and would make RLS a no-op. The server refuses to boot
in production if that role cannot be assumed.

### R17 — "HVAC and plumbing are different trades" ⇒ vertical packs

⇒ **D-008:** vertical behavior is an activatable **pack** layered on a shared
core. A pack carries far more than a label: a hierarchical service taxonomy,
a **terminology map with aliases** (so "my outside unit is froze up" resolves to
the condenser), intake questions that beat "can you tell me more?" when the
classifier is unsure, objection scripts, speech-recognition keyword boosts so
trade jargon isn't mis-transcribed, repair templates, and the price-book seed.

### R18 — "I want the booking even when nobody's watching" ⇒ bounded autonomy

Every booking that waits for a tap while the owner is on a roof is a lost
booking — and the highest-value calls arrive precisely when nobody is watching.

⇒ **D-015:** a per-tenant, **default-OFF** autonomous booking lane, scoped to
exactly two capture-class types, behind a stricter dedicated confidence floor,
clean entity resolution, a verified customer, a live held slot inside business
hours, no vulnerability/emergency/negotiation flag, a platform-wide kill switch
checked first, an owner SMS carrying a one-tap UNDO, and a digest line so
autonomous activity is never silent even when nothing goes wrong. Thirteen named
ineligibility reasons are stamped on every evaluation, pass or fail. Money,
comms, and irreversible classes are **structurally** excluded.

⇒ And the counter-example that proves the posture. **D-018** extended the same
idea to closing a sale on the call, with the system approving proposals on the
owner's behalf under a carefully argued sanction. **D-019 revoked it the next
day** as a human-authority violation, deleted the code, and added a structural
guard: the lifecycle now refuses *any* transition to approved by a `system:`
actor, so the invariant cannot be reintroduced by a future caller.

*The product is willing to delete a shipped, carefully-designed capability to
keep this line.* That is the clearest statement of what Rivet is.

### R19 — "The phone is not a trusted surface" ⇒ surface-conditional capability

An anonymous caller and the owner are not the same user, and the system had been
offering them the same menu. A live sweep found that an identified *customer*
could be read the tenant's revenue.

⇒ **D-026** and **D-028**: authorization on the phone resolves an **actor** once
from caller-ID at session establishment and **never from utterance content**,
then applies the same role gate every other surface uses. The classifier prompt
itself is assembled **per surface profile**, and a post-parse guard maps any
classification outside the surface's accept rule to `unknown` — **audited, never
silent**. A caller cannot talk their way into a wider taxonomy, and an unknown
future channel fails **closed** to the most restrictive profile.

Two structural notes belong in the requirement, not the implementation. First,
caller-ID is an authentication factor that is *spoofable by design*; the
decision log says so explicitly and names the widened blast radius rather than
hiding it. Second, the real security boundary is narrower than the prompt: an
allowlist of proposal types an unauthenticated transcript may ever reach.
Adding an intent to the map can never widen what a stranger on the phone can
cause.

### R20 — "Prove it, don't claim it" ⇒ verification as a product requirement

The repository's own history is the argument: three separate audits found
documentation claiming capabilities the code did not have, *and* code containing
capabilities the documentation had written off as unbuilt.

⇒ Contract tests that pin the capability catalog to the code and fail the build
on drift. A **coverage table** that forbids undeclared (capability × surface)
cells, so a refusal is always deliberate and silence is impossible. Docker-gated
integration tests as the standard of proof for any claim that touches the
database. A rung ladder that refuses to score a mocked test as proof of a real
write. And a decision register in which a decision without a test *does not
exist as far as CI is concerned*.

---

## 5. Product invariants — the lines the code will not cross

These are not aspirations. Each is enforced somewhere in the codebase, most
structurally, and many are pinned by a test that fails the build if broken.
They are listed before the feature sections because everything downstream is a
consequence of them.

| # | Invariant | How it is enforced |
|---|---|---|
| **I1** | **The AI never writes to an operational entity.** It drafts a typed proposal; a deterministic handler executes after approval. | D-004. Execution handlers are the only code permitted to mutate money or schedule state from a proposal. |
| **I2** | **No `system:` actor may ever approve a proposal.** | D-019. A structural guard in the single lifecycle transition seam, so the rule survives future callers. |
| **I3** | **Approval is a human control act.** Owner voice approval is permitted on a verified owner line; money and irreversible classes additionally require a spoken challenge, capped at three failures then locked for the session. | D-025. The readback is composed **from the proposal payload, never from the owner's utterance**, and the confirm is a deterministic matcher, never an LLM. |
| **I4** | **An AI-emitted price is never authoritative.** | A pure, deterministic, LLM-free catalog resolver ahead of proposal creation; uncatalogued lines force review through a flag a tenant cannot override. |
| **I5** | **Ambiguity becomes a clarification, never a silent guess** — on every surface, in that surface's own idiom, through one shared disambiguation matcher so the surfaces cannot drift. | D-029. |
| **I6** | **A gate on an entity id must have a resolver behind it.** | D-029. A gate nothing can lift is a capability that can never be approved. |
| **I7** | **The AI never discounts, never commits scope, never promises a human.** | Deterministic negotiation guardrail; discount policy fails closed at zero. |
| **I8** | **Safety escalation beats containment. No config flag may override it.** | Deterministic emergency detection ahead of the classifier; complaint escalation has no tenant toggle (D-027). |
| **I9** | **All money is integer cents**, end to end, with one shared engine as the only source of totals math and **one** percent-of-money helper so rounding cannot drift. | D-003. Line totals are recomputed server-side, discarding the client's number. |
| **I10** | **All times stored UTC, rendered in the tenant's timezone.** | An unset tenant timezone makes booking **refuse**, never fall back to a default zone — a Phoenix mis-booking postmortem removed the column default. |
| **I11** | **Every entity carries `tenant_id`; RLS is FORCED at the database**, under a dedicated non-bypassing runtime role the server refuses to boot without in production. | The database, not application code, is the isolation boundary. Exactly two tables are exempt, each with its rationale recorded as a SQL comment, and the runtime role is dynamically revoked from any table that would otherwise slip through. |
| **I12** | **Every mutation emits an audit event** attributable to actor id, role, and channel. The guarantee has **two tiers, and they are not the same strength** — see below. | Execution-outcome audit is transactional on the DB-only path; handler-emitted domain audit is best-effort. |
| **I13** | **Caller speech is untrusted data for its whole lifetime** — including when read back to the operator hours later. | Fenced with explicit hardening copy before entering any operator-facing model context; fence-closing markers in the caller's own text are neutralized. |
| **I14** | **A revocation of contact consent blocks every channel; a grant never crosses channels.** | D-017, on an append-only ledger behind both outbound gates. |
| **I15** | **All LLM calls route through one gateway.** No module outside it may import a provider SDK. | D-005, enforced by a CI guard. |
| **I16** | **A capability's surface coverage is declared, not accidental.** Undeclared (capability × surface) cells fail a structural test. | The coverage table. Refusals happen on purpose; silence is impossible. |
| **I17** | **Auto-approval is a scoped, opt-in, reversible exception — never a posture.** | D-015: two capture-class types, default OFF, stricter floor, kill switch, one-tap UNDO, digest visibility. |
| **I18** | **No feature ships that adds admin work to the owner's day.** | The litmus test; the reason seven planned v1 phases were cut or deferred (D-011). |

### 5.0b I12 in detail — the audit guarantee is two-tiered

This deserves its own statement because an earlier draft of this document
asserted a single, stronger guarantee than the code provides, and a review
caught it. The product has **two** audit layers:

**Tier 1 — execution-outcome audit (transactional).** Every proposal execution
writes a `proposal.executed` / `proposal.execution_failed` event through the
shared audited-command helper. On the DB-only handler path this commits in the
**same transaction** as the handler's mutation, the idempotency record, and the
status transition — all four succeed or none do. This is the guarantee that
closes the crash window: a proposal cannot execute and then lose its status
write.

**Tier 2 — handler domain audit (best-effort).** A handler additionally emits
its own domain event (`catalog_item.created`, `credit.applied`, and so on)
*after* its mutation, and **a failure there is swallowed**. The rationale is
sound in isolation — a logging outage should not unwind a successful customer-
visible action — but the consequence must be stated rather than implied:

> **During an audit-store outage, operational state can be created without its
> domain audit row.** The execution-outcome row still lands on the DB-only path;
> the domain-level event does not.

Two further limits belong with it: handlers marked as performing external I/O
run their mutation **outside** the executor's transaction by necessity (the
network send cannot be rolled back), so Tier 1's atomicity covers the
idempotency record, status, and audit — not the handler's own writes. And the
tiers differ by design, not by oversight.

Whether Tier 2 should be strengthened is a real product question, recorded in
§12.2 rather than resolved here.

### 5.1 The trust thesis

No AI system is right 100% of the time. **The trust mechanism is not perfection
— it is how the system behaves when it is wrong.** The competitive set papers
over its failures. Rivet's wedge is being the system that tells the truth about
itself. The four pillars: it surfaces its own uncertainty; a supervisor reviews
high-stakes output; it never makes irreversible-for-the-business decisions
unilaterally; and the end-of-day digest reports what it got wrong.

### 5.2 The action-class ladder

Every proposal type carries exactly one class, assigned by an exhaustive switch.

There are **53 proposal types**. The four non-capture classes are small and worth naming
exhaustively, because they are the entire set of things the product will not let
an AI do unsupervised. Everything else — 36 types — is capture.

| Class | Members | Approval |
|---|---|---|
| `capture` (36) | Records or schedules something; compensable if wrong | One tap. **The only class eligible for batch approval or the D-015 autonomous lane.** |
| `comms` (8) | `send_invoice` · `send_estimate` · `send_estimate_nudge` · `send_payment_reminder` · `send_customer_message` · `notify_delay` · `request_feedback` · `review_response_proposal` | One tap. Never auto-approves. D-025 records this as a deliberate, reserved soft edge. |
| `money` (5) | `issue_invoice` · `record_payment` · `record_refund` · `apply_credit` · `apply_late_fee` | One tap, plus a spoken challenge on the voice surface. Never auto-approves. |
| `irreversible` (2) | `cancel_appointment` · `emergency_dispatch` | One tap, plus a spoken challenge on the voice surface. Never auto-approves. |
| `manual` (2) | `adopt_entity_alias` · `update_brand_voice` | Owner-only, and never auto-approves at **any** trust tier — structural, not threshold-dependent. |

Two design notes belong in the requirement rather than the code:

- **`voice_clarification` is classified `capture` but has no execution handler at
  all**, and approval of it is refused outright. It is a *question*, not an
  action. This was learned the hard way: approving one previously wedged it in
  `executing` through stale-recovery retries.
- **The trust ladder has four tiers and only one of them behaves differently.**
  `autonomous` can reach auto-approval for capture; `graduates_fast`,
  `graduates_slowly`, and `always_asks` all fall through to draft. The ledger
  that would graduate a tenant does not exist. The data is attached so it can be
  built retroactively — but today the product has one trust tier and four names
  for it (§12.4, §14 O-3).

An unrecognized class **fails closed** to an explicit confirmation on the mobile
client, which is the correct default for a value the server may add before the
app updates.

### 5.3 Fail-open, fail-closed — the rule behind the rules

The codebase draws one line consistently, and it is worth stating as a product
requirement because it explains a dozen otherwise-arbitrary behaviors:

> **Fail open for availability. Fail closed for authority.**

The supervisor review gate, the policy snapshot, the threshold resolver, and the
business-hours check all fail *open* — a monitoring outage must not stop the
owner getting paid. Authorization loading, webhook signature verification with
no configured secret, PII redaction with an unreachable backend, an unpriced
model's cost, an unknown feature flag, a missing RLS role at boot, a metrics
endpoint with no token in production, and an unrecognized action class all fail
*closed*.

---

## 6. The system as built

### 6.1 Shape, in one paragraph

A TypeScript monorepo on Railway. The AI is **not** an agentic loop — there is
no planner, no tool-calling cycle, no ReAct. It is a one-shot pipeline: *speech
→ surface-conditional intent classification → a constant-map lookup → a task
handler that drafts one typed proposal → human approval → a separate
deterministic execution subsystem*. **That restraint is the safety property.**
An agent that plans its own actions cannot be gated the way this one can.

```
speech / text
  → [multi-action?] transcript decomposition      (the one multi-step affordance)
  → deterministic reference resolution            (pronouns, ellipsis — no LLM)
  → intent classification                         (ONE LLM call; prompt built per surface profile)
       ├─ deterministic pre-LLM phrase short-circuits
       └─ post-parse surface guard → off-profile becomes `unknown`, audited
  → branch by intent class:
       lookup_*  → shared lookup dispatch  → spoken answer, NO proposal
       en_route  → direct audited act      → NO proposal
       confirm / language_switch / operator_request → the FSM intercepts
       otherwise → intent→proposal-type map → task handler → typed Proposal
  → entity resolution     (ambiguous → clarification, never a guess)
  → catalog grounding     (AI price → tenant price, or confidence-capped)
  → supervisor review     (deterministic policy, then a second model)
  → proposal persisted
  ══════════════════ HUMAN APPROVAL ══════════════════
  → 5-second undo window
  → execution handler → row written + audit event, in ONE transaction
```

### 6.2 Surfaces

| Surface | Who | Transport |
|---|---|---|
| **Inbound phone — resilient path** | Customers | Twilio `<Gather>`; each webhook is one state-machine tick |
| **Inbound phone — realtime path** | Customers | Twilio bidirectional media WebSocket → streaming ASR → FSM → streaming TTS. Per-tenant rollout behind a circuit breaker |
| **In-app voice** | Operators | Push-to-talk on every authenticated screen, with a live event stream |
| **Voice memo** | Owner, techs | Recorded dictation → async transcription → the same router. Offline-capable on mobile |
| **Chat** | Operators | Typed; same taxonomy, same task handlers, by construction |
| **SMS** | Owner + customers | The approval rail and the customer comms rail |
| **Web** | Operators | React SPA — audit, configuration, the approval tap |
| **Mobile** | Owner, techs | One Expo binary, three personas, real voice, camera, push, offline queue, tap-to-pay |
| **Public pages** | Customers | Token-gated, no login: booking, intake, estimate approval, invoice payment, feedback, portal |

### 6.3 The classifier is surface-conditional

The system prompt is assembled per **profile**, derived from *session identity
only* — never from anything the caller says.

| Profile | Who | Intents advertised / accepted |
|---|---|---|
| `caller` | Anonymous or customer-resolved inbound | 18 / 20 |
| `field_tech` | Caller-ID-resolved employee | 15 / 15 |
| `owner_line` | Verified owner line | 60 / 70 |
| `operator` | Memo, chat, in-app voice, evals | 68 / 78 |

The advertised set is **derived** from the accepted set rather than hand-kept,
so accepted ⊇ advertised holds structurally. The taxonomy is versioned (78
intents at version 1.18.0) and the operator prompt is byte-hash-pinned, so the
recorded test fixtures and the gateway cache keys stay stable as profiles change
around it.

**The prompt is a hint, not a gate.** A classification outside the surface's
accept rule becomes `unknown` and is **audited** (`voice.intent_off_surface`),
not silently dropped. An unknown future channel fails **closed** to `caller`, the
most restrictive profile.

**And the real security boundary is narrower still.** An unauthenticated caller's
transcript can reach exactly **eight** proposal types, whatever the classifier
returns and whatever the intent map says:

`create_customer` (themselves, dedupe-gated) · `create_appointment` ·
`create_booking` · `create_job` · `reschedule_appointment` (their own) ·
`draft_estimate` (catalog-grounded, reversible draft) · `callback` (routes to a
human, mutates nothing) · `voice_clarification` (an ask, not an action)

Everything else — every invoice, payment, send, cancellation, reassignment — is
structurally coerced to a clarification, and the enforcement runs at **both**
creation and execution. The stated reason is precise: on that surface *"the money
moves to the wrong party set."* One narrow exemption exists,
`emergency_dispatch`, unlocked only by a flag the **deterministic keyword
matcher** writes and that no transcript can produce — and even then it still
requires owner approval.

The requirement this expresses: **the surface is a property of session identity,
never of transcript content.** *"Please send the Henderson invoice to me,"* spoken
by a caller, is an attack, not an authorization. Adding an intent to the map can
never widen what a stranger on the phone can cause; only editing the allowlist
can.

### 6.4 Safety runs before the model

Tiering takes the **maximum** of every signal.

| Tier | Meaning | Behavior |
|---|---|---|
| **E1** | Life safety — gas, CO, fire, electrical, injury | Speak the safety script, **revoke pending bookings**, notify the tenant on every channel, close without bridging. Never books, from any state. |
| **E2** | Urgent | Safety line, bridge to a human, and an `emergency_dispatch` proposal |
| **E3** | Routine | Normal booking flow |

A hard 1,500 ms audit deadline bounds the only await between the keyword hit and
the spoken safety line, and the paging ladder is durable — each retry is a
delayed queue job with an idempotency key, explicitly biased toward paging.

> **Open, and flagged in code:** the E1 script is a placeholder. Its constant
> `E1_SCRIPT_REVIEW_REQUIRED` is `true` and the comment is explicit — *"the
> routing is built; the words are not signed off."* A life-safety script is not
> an engineering artifact. See §12.

### 6.5 Bounded everything

Every conversational ladder has an explicit cap, so no loop runs away and no
cost escapes.

| Bound | Value |
|---|---|
| Intent confidence floor to act | 0.75 |
| Entity confidence: resolve / confirm-first | 0.80 / 0.60 |
| Max reprompts · quote refinements · disambiguations · language switches | 3 · 3 · 2 · 2 |
| Min speech-recognition confidence to dispatch a turn | 0.5 |
| Max consecutive low-confidence turns · speech-turn failures | 2 · 2 |
| Silence reprompt · audio idle timeout | 8 s · 30 min |
| Per-turn classifier input budget | 9,000 tokens — **derived** from a worst-case structural assembly, not sampled |
| Session token caps (telephony · in-app) | 72,000 · 90,000 — derived as budget × expected turns, pinned by test |
| Session cost caps (telephony · in-app) | 40¢ · 80¢ |

A low-confidence final transcript is **not dispatched into the state machine at
all**, for the reason stated in the code: *a misheard turn acted on as if
correct is worse than one extra reprompt — "cancel" dispatched from a misheard
"confirm."*

The token budget deserves its own note, because it is a requirement about
**method**. It is not a guess that was tuned until things worked. It is computed
from the largest prompt the code can structurally assemble — the widest profile,
plus the protection section, plus a full vertical pack including intake
questions and objection scripts, plus the maximum tenant training assets, plus a
long utterance — multiplied by a margin and rounded up, with the arithmetic
pinned by a test asserting the real worst case stays under 85% of it. The
earlier number was derived from a sample that omitted three of those terms and
left about 1% of slack against a configuration tenants could actually reach.
That is how a quality gate failed at 10/20 on first-sentence cost-cap
exhaustion.

### 6.6 Tenancy and the request path

1. Clerk session verification (RS256 + JWKS; legacy HMAC double-gated to dev).
2. **Authorization is DB-authoritative, not from the JWT.** Live membership is
   loaded per request and *overwrites* the token's role claim, deliberately
   uncached so a demotion takes effect on the next request. A loader failure is
   503; no membership, a revoked user, or a non-active status is 403.
3. Tenant-context middleware opens **one transaction per request**, sets the
   tenant with a transaction-scoped setting, assumes the non-bypassing role,
   applies statement and idle timeouts, and **commits only on a sub-400
   status** — so a failed request never half-writes. Two narrow, method-and-path
   anchored allowlists exist for long-lived streams and long LLM calls.
4. Row-level security policies read that setting.
5. Three legitimate bypasses exist and are named: global (non-tenant) tables, a
   dedicated cross-tenant sweep role for platform monitoring, and workers that
   set the context by hand.

### 6.7 Background work

No separate worker binary by default: sweeps are intervals in the API process,
with a `PROCESS_ROLE` split (`web` | `worker` | `voice` | `all`) so the surfaces
deploy independently. Two primitives carry the whole automation surface: a
Postgres work queue using `FOR UPDATE SKIP LOCKED` with visibility backoff and a
dead-letter table, and **leader advisory locks** — 26 distinct sweep keys with a
collision discipline recorded after one shared key silently serialized two
unrelated sweeps.

One detail is a requirement, not an implementation choice: the queue and its
dead-letter table **redact at the sink**. Any field named like a transcript or
message body is stored as an excerpt plus a hash, and error *messages* are never
persisted — only a class and a fingerprint — because a telephony provider error
can echo a customer's phone number into a log nobody is watching.

### 6.8 The LLM gateway

Every model call routes through one gateway, enforced by a CI guard. Three tiers
(`lightweight` / `standard` / `complex`) with an exhaustive task→tier map, so
adding a task type without routing it is a compile error. The resilience stack
composes innermost to outermost — retry, deadline, circuit breaker, cross-
provider failover, per-tenant quota, cache — with retry *inside* the breaker so
the breaker counts only final outcomes, and the cache *outside* it so a hit
never burns breaker budget.

Three details rise to requirements:

- **Cost is accounted in micro-cents**, so a sub-cent classification never
  rounds to zero, and rounding happens exactly once at the display boundary. An
  unpriced model resolves to `null` cost — **never a guessed price** — because
  pricing errors must fail safe to *unknown*, not to *wrong*.
- **Classifier traffic gets its own quota buckets**, because a classifier prompt
  carries the full taxonomy and would otherwise starve everything else.
- **Every call writes a run record, including cache hits**, so the audit is
  never blind.

---

## 7. The capability catalog — what a user can actually do

This is the functional heart of the PRD. Its contents are **derived from
`docs/reference/voice-action-catalog.md`**, which carries a machine-readable
block that *is* pinned to the code by a contract test — if an intent, proposal
type, action class, or execution handler changes and that file is not updated,
the build fails. That mechanism exists because an earlier prose feature list
rotted badly enough to mislead the team.

> **This file is not itself under that test.** The section below is a
> point-in-time transcription, accurate as of the reconstruction date, and it
> can drift the same way every prior feature list did. **The pinned catalog is
> the source of truth; when the two disagree, that one is right.** Extending the
> contract test to cover this section — or replacing it with a generated include
> — would close the gap, and is worth doing before this document is treated as
> load-bearing.

A capability is only real when it has **all three**: a classifier intent, a
map entry, and an execution handler wired to its real dependency. A boot guard
enforces the third — the server refuses to start if a voice-reachable proposal
type has no handler, or if its wiring probe is missing (it fails closed on the
missing probe, not open).

### 7.1 Speakable and executable today — 48 capabilities

Action class in brackets.

**Quoting**
`draft_estimate` [capture] · `update_estimate` [capture] · `send_estimate` [comms] ·
`send_estimate_nudge` [comms] · `create_change_order` [capture] ·
`create_service_agreement` [capture]

**Billing and collection**
`create_invoice` → `draft_invoice` [capture] · `update_invoice` [capture] ·
`issue_invoice` [**money**] · `send_invoice` [comms] · `batch_invoice` [capture] ·
`record_payment` [**money**] · `record_refund` [**money**] · `apply_credit` [**money**] ·
`apply_late_fee` [**money**] · `send_payment_reminder` [comms] ·
`create_invoice_schedule` [capture]

**Work — jobs, scheduling, dispatch**
`create_job` [capture] · `update_job` [capture] · `create_appointment` [capture] ·
`reschedule_appointment` [capture] · `cancel_appointment` [**irreversible**] ·
`reassign_appointment` [capture] · `confirm_appointment` [capture] ·
`add_crew_member` [capture] · `remove_crew_member` [capture] ·
`emergency_dispatch` [**irreversible**] · `notify_delay` [comms] ·
`schedule_inspection` → `create_appointment` [capture] ·
`log_warranty_claim` → `create_job` [capture]

**Customers and records**
`create_customer` [capture] · `update_customer` [capture] ·
`add_service_location` [capture] · `add_note` [capture] ·
`send_customer_message` [comms] · `convert_lead` [capture] ·
`mark_lead_lost` [capture] · `request_feedback` [comms] ·
`respond_to_review` → `review_response_proposal` [comms]

**Field capture — the tradesperson's own record**
`log_time_entry` [capture] · `log_expense` [capture] ·
`log_mileage` → `log_expense` [capture] · `add_material` [capture] ·
`log_permit` → `add_note` [capture]

**Configuration the owner may speak**
`add_catalog_item` [capture] · `update_catalog_item` [capture] ·
`create_standing_instruction` [capture] · `update_brand_voice` [**manual**]

> **On the intents that collapse onto shared types.** `log_mileage` executes as
> an expense and `log_permit` as a note; `schedule_inspection` and
> `log_warranty_claim` do the same for appointments and jobs. This is
> deliberate: **the vocabulary a tradesperson uses is part of the product
> surface even when the row it writes is not novel.** A plumber says "log the
> permit," not "add a note."

### 7.2 Read-only voice queries — 20 lookups

These never mint a proposal. The intent→proposal map deliberately returns a
clarification type for every one, so the drift test reads their exclusion as
intentional rather than as a gap.

`lookup_my_day` · `lookup_day_overview` · `lookup_appointments` ·
`lookup_availability` · `lookup_crew_schedule` · `lookup_jobs` ·
`lookup_job_profit` · `lookup_customer` · `lookup_account_summary` ·
`lookup_estimates` · `lookup_invoices` · `lookup_balance` · `lookup_revenue` ·
`lookup_leads` · `lookup_agreements` · `lookup_catalog` · `lookup_materials` ·
`lookup_timesheets` · `lookup_pending_items` · `lookup_digest`

**Requirement — one dispatch, thin adapters (D-026).** Lookup dispatch is a
single enumerated switch. Each surface contributes only an adapter owning
identity, response shape, failure copy, and telemetry — **never its own copy of
the switch**. The phone previously carried a private 14-case fork of a 20-case
switch, which is how five lookups became silently unreachable there, and how an
identified *customer* could be read the tenant's revenue. The requirement is
therefore structural: **adding a surface means adding an adapter, not copying a
switch.**

**Requirement — default-deny on the phone.** With no resolved actor, the phone
answers only the caller's own records plus an explicit tenant-public allowlist,
which today has exactly one member: `lookup_availability` — the one lookup a
customer legitimately asks ("when could you come out?"), revealing only
aggregate booking density. Anything added to that set must be argued for in the
decision log.

**Requirement — self-scoping is the access control.** `lookup_my_day` carries no
permission entry by design: it is scoped to the *acting speaker* and cannot be
widened. A technician naming a colleague is ignored — the speaker is always
self. Correspondingly, an unresolvable speaker **fails the turn** rather than
falling back to the whole crew, and an unresolved crew-member name refuses
honestly rather than widening.

### 7.3 Direct status acts — audited, never proposed

`en_route` ("on my way") is the one spoken act that is neither a read nor a
proposal. A technician saying "on my way" is **the human acting themselves**,
not the AI proposing — the same precedent already granted to an owner sending
their own reply. It fires the identical audited act as the in-app button, plus
the branded ETA text to the customer.

Two safeguards make the voice leg safe where a tap needs none: a low-confidence
classification **clarifies instead of firing**, and resolution is
**speaker-scoped** — a technician's "on my way" resolves only within their own
assignments and can never target another tech's appointment. A bare "on my way"
resolves to their next upcoming appointment today; two candidates clarify; zero
yields an explicit "you have no upcoming appointment," never silence.

### 7.4 Classified but deliberately gated

`approve_proposal`, `reject_proposal`, `edit_proposal` are recognized by the
classifier and **hard-refused on the recorder channel**. They are actionable
only on a live, verified owner session (§5, I3). A locked decision, not a gap.

> **On the sale-closing lane, because the name survives the decision.** The
> autonomous-close evaluator still exists and still stamps its verdict on every
> chain member — but **as telemetry only**. Since D-019 it decides nothing about
> execution. On a strict-confirmed, consent-captured, catalog-clean close the
> agent *holds the slot* and *stages a draft chain* (`draft_estimate` →
> `send_estimate` → `create_booking`), then sends the owner **one** one-tap
> approval SMS. If the PRD, a deck, or a demo script ever describes "an agent
> that closes the sale," the accurate sentence is: **it prepares the close for
> one-tap owner approval.**

### 7.5 Executable but with no spoken on-ramp — by design

| Proposal type | Why no voice path |
|---|---|
| `create_booking` | Minted by the inbound-caller state machine, not the owner's command line |
| `adopt_entity_alias` | Minted when an operator resolves an ambiguity; owner-only approval |
| `callback` | Minted internally as a companion or fallback (negotiation, complaint, after-hours), never a top-level utterance |
| `onboarding_*` (5 types) | Emitted by the onboarding conversation, a separate surface from the intent classifier |

### 7.6 White space — named, unbuilt

| A tradesperson would expect this to work | Missing |
|---|---|
| *"Assign the closest certified tech to this job"* | Proposal type, handler, and intent all absent — and the skill matcher behind it is a nine-line stub that returns no requirements, so the gate is vacuously clean |
| *"Add the Carrier unit I serviced in May to this customer"* | **No equipment or asset entity exists anywhere in the product** |

The second is the more significant. Equipment history is a named HVAC
differentiator in every strategy document, and there is no equipment table. §12
treats this as a first-class gap.

---

## 8. Functional requirements by lifecycle

Organized along the ten-stage spine the product's own verification uses.

### 8.1 Setup — the first 15 minutes

**Requirement: onboarding status is derived from facts, never stored as wizard
state.** Seven ordered steps — signup, identity, pack, phone, billing, AI check,
test call — each satisfied by a *fact about the tenant* rather than a "step
complete" flag. A resumed session cannot disagree with reality.

**Requirement: the gate is soft.** The CRM unlocks as soon as identity is saved;
later steps nudge and never hard-block. An owner who wants to look around first
is not a problem to be solved.

**Requirement: timezone is load-bearing and has no default.** The column's
default was deliberately *dropped* after a Phoenix mis-booking. Without a chosen
zone, a spoken booking becomes a clarification — the system asks rather than
books the wrong hour.

| Capability | Rung | Note |
|---|---|---|
| Tenant bootstrap on signup (webhook, idempotent) | 4 | Signature verified with replay window enforced *before* verification |
| Identity, hours, timezone, service area, rate | 5 | |
| Vertical pack selection + price-book seeding | 4 | One shared implementation for the form and conversational paths, serialized by an advisory lock |
| Phone number provisioning (own subaccount, messaging service, number) | 3 | Production path throws without real credentials; CI gets a magic test number |
| Subscription + 14-day trial | 4 | Plan prices validated live against Stripe on every checkout; a plan that fails validation is **omitted, never shown wrong** |
| AI verification + test call | 3 | |
| Conversational onboarding (multi-turn, bounded at 15 turns) | 3 | Engine is real and tested; the shipped UX is the form wizard |
| Brand voice capture | 3 | Behind a default-off flag; six fields; edit only via explicit web action with a 15-minute cooldown, version-bumped and audited |
| Team invites | 4 | Local invitation row written **first**, so a Clerk outage cannot lose tenant intent; refuses to demote the last owner |

### 8.2 Capture — answering the phone

| Capability | Rung |
|---|---|
| Answer 24/7 in the shop's voice, tenant resolved from the dialed number | 5 |
| Recording disclosure spliced before capture; audio is not forwarded to ASR until it has played | 5 |
| Caller identification from caller-ID; unknown → lead | 4 |
| Intent + urgency classification, surface-conditional | 5 |
| Deterministic emergency detection (E1/E2/E3), pre-LLM, bilingual | 5 |
| Vulnerability grading → patch the owner's cell with a 5-second non-PII preface | 3 |
| Dropped-call SMS recovery at 60 s, durable, re-evaluated at send | 4 |
| Customer photo → draft estimate (MMS) | 3 |
| Public web booking, no login, real availability | 5 |
| Unclaimed inbound SMS → threaded conversation | 4 |
| Never quotes a firm price, never negotiates | 5 |
| B2B / property-manager recognition | 2 — recognized and assembled, **but the assembled context is still not consumed by routing** |

**Requirement: the voice gate is a ladder, and every rung fails to voicemail.**
Subscription status, then go-live, then trial caps (60 minutes/day, 100 total, 2
concurrent). A gate that *throws* also lands on voicemail. The caller always
reaches something.

**Requirement: unknown numbers and provider errors never produce dead air.** An
unrecognized dialed number returns a spoken "not in service," a database error
returns a retryable status so the provider retries, and a handler exception
returns a graceful hangup rather than an error — because a retry would duplicate
the session.

### 8.3 Book

| Capability | Rung |
|---|---|
| Call → booking **proposal**, never a booking | 5 |
| Availability: 30-minute grid, per-day business hours, DST-correct wall-clock math, travel buffer, technician hours and time-off | 4 |
| **Config provenance on availability** — cold tenants are told these are defaults, not silently guessed | 4 |
| Write-side twin guarantees a POST can only book what GET would offer | 4 |
| Held slots (24 h) so a second prospect gets a conflict with fresh alternatives, reaped on a sweep | 4 |
| Conflict detection; double-booking excluded at the **database** level | 4 |
| Owner approves; ambiguity clarifies | 5 |
| Confirmation to the customer on approval | 4 |
| Day-before reminder | 3 |
| Book / move / cancel by speaking | 4 |
| Schedule proposals expire after 48 h and are re-proposable | 3 |
| Drive-time feasibility (real provider, or great-circle fallback, flagged as unverified) | 3 — wired to the dispatch board, **not** to the three booking-creation paths |

### 8.4 Dispatch

| Capability | Rung |
|---|---|
| Dispatch board, day view, drag-and-drop | 5 |
| Drag produces a **proposal**, never a direct mutation | 5 |
| Live multi-user collaboration: revision tokens with total ordering, presence leases showing who is dragging which card | 4 |
| Technician day view with a same-tenant ownership guard | 4 |
| "On my way" — app, voice, and SMS keyword, all one audited act | 4 |
| Running late with a 10/20/30-minute chip picker where the chip row *is* the confirm | 4 |
| Geofence/dwell lateness engine with a confidence breakdown | 3 |
| Tech texts OUT → one reschedule **proposal per appointment**, each carrying a brand-voiced customer message for review | 4 |
| Skill-based assignment | **0 — a nine-line stub** |
| Route optimization / multi-stop sequencing | **0 — absent** |

**Requirement: the tech-out cascade is per-appointment, never bulk.** Each
affected customer is a separate proposal with its own drafted message, because
the owner may want to handle one differently. Three or more offers batch
approval.

### 8.5 Execute — the field

| Capability | Rung |
|---|---|
| One-handed, gloved, daylight-legible field screens | 3 |
| Job photos with categories and before/after pairing | 4 |
| Time entries by voice | 3 |
| Offline capture with a crash-safe journal, poison-parking, and flush on the reconnect edge | 5 |
| Tap-to-pay card-present on mobile | 3 — requires an active Connect account, else a clean 409 |

**Requirement: the durable artifact is deleted only on confirmed flush.** The
offline queue removes local audio only after the server acknowledges, and never
attaches credentials on public paths.

### 8.6 Narrate — the owner's spoken command line

| Capability | Rung |
|---|---|
| Push-to-talk from any screen | 5 |
| Speech → typed proposal pipeline | 5 |
| Free-text references resolve to ids across nine entity kinds | 4 |
| Job status by voice | 5 |
| Spoken line item onto an existing estimate | 3 |
| Dictated notes, expenses, mileage, materials, time | 3 |
| Read-only lookups by voice | 4 |
| Spoken address as a first-class resolvable entity | **0 — no place entity kind exists** |
| Parts capture with quantity **and unit** | 3 — units now round-trip, but there is no job-level parts domain |

### 8.7 Quote

| Capability | Rung |
|---|---|
| Estimate from a spoken description or a photo | 3 |
| Catalog-resolved pricing; uncatalogued caps confidence and forces review | 5 |
| Confidence markers surfaced on the line that earned them | 5 |
| Good / better / best tiers with add-ons | 5 |
| **Headline total is the default selection, not the sum of all options** | 5 |
| Customer approval by token link, with signature | 4 |
| Stale-revision guard: once revised, approval requires the version the customer saw | 4 |
| **One accepted estimate per job**, enforced by a partial unique index and race-mapped to a clean conflict | 4 |
| Deposits — percentage or fixed, before- or after-approval policy | 4 |
| Auto follow-up on unviewed estimates | 3 |
| Supervisor review of quotes | 3 — reaches voice-drafted quotes; photo- and wizard-drafted quotes are not reviewed |
| Negotiation pushback → owner proposal; the AI never concedes | 5 |

**Requirement: a locked estimate is cloned, never edited.** Acceptance, or any
paid deposit, locks the document. The escape hatch is an explicit clone, so the
record the customer approved is never rewritten underneath them.

**Requirement: grounding is all-or-nothing.** If *any* priced line is ambiguous,
uncatalogued, or missing a pricing source, the estimate is not grounded and the
voice agent speaks **no numbers at all** — rather than reading out the subset it
happens to trust.

### 8.8 Bill

| Capability | Rung |
|---|---|
| Invoice from a spoken sentence (two steps: draft, then issue) | 4 |
| Estimate → invoice, billing exactly the accepted selection | 3 |
| Auto-invoice on completion (opt-in, still a proposal) | 3 |
| Payment links, hosted checkout, embedded elements | 4 |
| Card-present, ACH with the full processing→settled→reversed lifecycle, saved cards off-session | 4 |
| Partial payments and deposit credits via guarded atomic updates | 4 |
| Void and cancel — deactivating links and cancelling in-flight intents | 4 |
| Refunds as accumulating adjustments, never a status flip, idempotent per provider refund id | 4 |
| Dunning: three reminders at 3/7/14 days, idempotent per step key | 5 |
| Late fees, capped, idempotent | 3 |
| Progress/milestone billing, with a remainder milestone absorbing rounding | 3 |
| Memberships: auto-renew, member pricing, priority booking, dues auto-collection | 3 |
| Integer cents end to end | 5 |

**Requirement: nothing auto-sends.** The overdue sweep does not text the
customer. It raises a **proposal** the owner approves with one tap. Collections
is the most relationship-sensitive thing the product touches, and the owner
stays in it.

**Requirement: invoice numbers are never burned by a failure.** Creation inserts
with a placeholder and allocates the number after, so a failed create cannot
consume a sequence number and leave a gap in the tenant's books.

**Requirement: `paid` is not terminal.** It can be reopened by a reversal,
because an ACH return is a real event and a system that cannot represent it will
lie about the balance.

### 8.9 Close

| Capability | Rung |
|---|---|
| Thank-you SMS +2 h after completion, stamped for idempotency | 4 |
| Review request +24 h, default on | 4 |
| Review gating: 4★+ routed to public review, below kept private | 5 |
| Google review monitoring, classified, with drafted public and private responses | 3 |
| **Service credits by tier, capped per customer per 12 months** | 3 |
| End-of-day digest, tenant-local, with "what I wasn't sure about" and "what I learned" | 3 |
| Weekly owner summary including a *repeat-correction* rate | 3 |
| Correction loop: lessons forward, digest-reported, reversible | 5 |
| Repeated corrections mint an owner-reviewed fix proposal | 4 |
| QuickBooks one-way sync | 3 |
| Unified comms inbox with AI-suggested replies (owner edits and sends; never auto-sent) | 5 |

**Requirement: the review classifier degrades to the safer label.** Below a
confidence floor, an ambiguous review is treated as a *vague* complaint rather
than guessed into a specific one — the product would rather under-claim
understanding than put words in a customer's mouth.

**Requirement: an over-cap service credit is omitted, not zeroed.** Proposing
"$0 credit" is worse than proposing no credit.

---

## 9. Data model

The schema is **277 migrations expressed as TypeScript string constants**, not
`.sql` files, replayed **in full on every boot** under a global advisory lock
with **no version ledger** — which is why every statement is written to be
idempotent, and why a post-processor injects `DROP POLICY IF EXISTS` and
`DROP CONSTRAINT IF EXISTS` for the two DDL forms Postgres gives no
`IF NOT EXISTS`.

**Immutability is the substitute for a ledger**, and it is enforced: a test pins
a SHA-256 hash for every one of the 277 migrations, so editing a shipped
migration in place fails CI. That test exists because it happened — a migration
was renamed and mutated, the `CREATE TABLE IF NOT EXISTS` made the added column
a no-op on existing databases, and boot crashed on a column that did not exist.
The rules are therefore stated as requirements: a new migration needs a
lexicographically greater key; renaming a key is forbidden; **removing one is
forbidden.**

~128 tables. 120 of them have RLS **enabled and forced** — the enable-set and
force-set are exactly equal, asserted by test. **Exactly two** carry `tenant_id`
without RLS, each with its rationale recorded as a durable `COMMENT ON TABLE`
(an OAuth nonce table consumed before tenant context exists; an ops log that
must survive a tenant purge), and the runtime role is dynamically revoked from
any table that would otherwise slip through. Production is verified
out-of-band by a read-only probe asserting that zero tables are enabled-but-not-
forced and that only those two are exempt.

**Domain spine:**

```
tenants ─┬─ customers ─┬─ service_locations
         │             ├─ customer_contacts · tags · custom fields · groups
         │             └─ jobs ─┬─ appointments ── appointment_assignments ── users
         │                      ├─ estimates ── estimate_line_items
         │                      ├─ invoices ── invoice_line_items ── payments ── payment_refunds
         │                      ├─ job_photos · forms · custom fields · timeline
         │                      └─ feedback_requests ── feedback_responses
         ├─ leads ──────────(originating_lead_id)──→ customers · jobs · invoices
         ├─ proposals ── proposal_executions · proposal_sms_events
         ├─ conversations ── messages ── conversation_links
         ├─ voice_sessions · call_transcript_turns · call_summaries · voice_recordings
         ├─ consent_events (append-only) · tenant_dnc_list
         ├─ audit_events · ai_runs · supervisor_reviews · knowledge_chunks
         └─ tenant_settings · pack_activations · catalog_items · brand_voice_versions
```

**Requirements expressed in the schema itself:**

- **All money is `INTEGER` or `BIGINT` cents**, and rates are integer basis
  points. Two deliberate exceptions are worth stating explicitly rather than
  discovering later:
  - **`ai_runs.cost_micro_cents` is the one scale break** — LLM spend is tracked
    in micro-cents so a sub-cent classification does not round to zero. Still an
    integer, different scale from every other money column.
  - **Line-item `quantity` is `NUMERIC`**, because 1.5 hours is real. So
    `quantity × unitPriceCents → totalCents` is the **one place a non-integer
    touches money arithmetic**. The rounding happens in the shared billing
    engine, and the server recomputes every line total rather than trusting the
    client's — which is exactly why that recomputation is an invariant (I9) and
    not an optimization.
- **Denormalized balances are maintained by guarded single-statement updates**
  whose `WHERE` clause *is* the invariant — a void invoice cannot be credited, a
  payment cannot push paid above total — and whose in-memory test doubles mirror
  those guards exactly, so races are testable without a database.
- **Idempotency is a unique constraint, not application logic**, everywhere it
  matters: dunning steps, refunds by provider id, recurring occurrences, batch
  invoice runs, webhook events, one-tap nonces, tech status per local day.
- **`tech_status_today` has a composite primary key on (tenant, tech, local
  date)** — so the midnight clear emerges from the key with no cron at all.
- **Three distinct recurrence models exist**, and this is a real product-shape
  finding rather than duplication: `recurring_jobs` (a visit series),
  `service_agreements` (memberships and dues), and `maintenance_contracts` (a
  thin, create-and-read-only surface with free-text customer and location). The
  third is the least-built thing in the product.

---

## 10. Non-functional requirements

### 10.1 Security and isolation

Beyond I11: authorization is DB-authoritative and uncached; platform-admin
status lives in a table with **no JWT claim at all**, so a token cannot be forged
into it; public token surfaces compare hashes in constant time and store only the
hash; cross-entity reference forgery is validated against the caller's tenant;
and a cross-tenant read is a 404, indistinguishable from nonexistence.

Every inbound webhook verifies a signature with a replay window, and the Twilio
handler **returns an error when no auth token is configured** rather than
accepting unsigned traffic — a deliberate fail-closed.

### 10.2 Compliance

- **TCPA:** consent enforcement defaults to *block* in production and staging
  when unset. Quiet hours are enforced at 8:00–21:00 recipient-local.
- **Recording consent:** two-party-consent states are enumerated with statute
  citations, and an unknown caller state gets the two-party copy — the safer
  fallback. A live objection detector recognizes ten phrases **before any LLM
  call**, pauses recording, and acknowledges.
- **PII:** log redaction covers secrets, PII-shaped keys, URL values, and public
  token path segments, and is CI-enforced. Training assets run Presidio-first
  redaction and **quarantine on an unreachable backend** rather than falling back
  to regex alone. Image bytes are never persisted into model run snapshots.
- **Retention:** a purge worker deletes all four data classes for an expired
  recording — object, transcript, derived summary, and embeddings — then
  tombstones and audits the per-class counts. Legal holds are unconditionally
  exempt. Tenant deletion discovers tables dynamically and purges object storage,
  because *a deletion that misses derived data is not a deletion*.
- **Transcripts are not retained at all** when no encryption key is configured.

> **Two compliance gaps are named in §12:** the AI-identity disclosure module is
> fully implemented and **never invoked**, and two jurisdiction lists disagree
> about which states require two-party consent.

### 10.3 Performance

| Metric | Target |
|---|---|
| Streaming speech recognition | < 300 ms |
| Time to first audio, inbound call | < 800 ms |
| Spoken booking → proposal | **< 5 s — asserted in a test that gates deploy** |
| Voice turn latency p95 | < 3,500 ms (alerting threshold) |
| Lookup → spoken answer | 5 s soft / **7 s hard** (a hard quality-gate failure) |
| Supervisor review | < 60 s, fail-open |
| Dropped-call SMS recovery p95 | < 60 s |
| Concurrent voice sessions | 1,000 |

Latency is attacked structurally, not just measured: pre-rendered filler audio
covers model thinking time with no randomness and no cross-language leakage;
streaming TTS removes several hundred milliseconds of buffering; and barge-in
aborts synthesis, invalidates the outbound turn, and flushes the provider's
buffer so the agent stops talking the moment the caller starts.

### 10.4 Reliability

Graceful drain on shutdown (readiness flips, new connections refused, live calls
given a drain window, with a force-exit backstop) — and an uncaught exception
routes through the *same* drain, so a synchronous throw can no longer drop live
calls. A circuit breaker votes once per call leg **at close time** from real
outcomes, which fixes the establish-then-die trap where a failing path looks
healthy at connect. Backpressure on the media socket is explicit: bounded
queues, a high-water mark, unacknowledged-mark limits, and a slow-consumer grace
window.

**Two monitors watch the watchers.** An SLO monitor alerts a human on call
completion rate, queue staleness, sweep lag, and turn latency. A *silent-failure*
monitor exists because of a specific incident recorded in its own header: an AI
task **ran 26,894 times over two days and completed zero times**, exhausting the
token budget and tripping the provider breaker, taking intent classification down
as collateral. The fix is in the metric's definition — it measures
**non-completion**, `(total − completed) / total`, rather than an explicit
failure status, *because a status-based rule would have missed that storm
entirely.*

**Spend has a policy ceiling, and the shipped defaults are tighter than the
module's.** The platform constants allow $50,000 per proposal and $250,000 daily;
the application wires $2,500, $10,000, and 30 auto-approvals per hour. A
per-proposal breach **blocks**; a projected daily breach **forces review** rather
than blocking outright — the distinction being that one proposal is wrong, while
a busy day is merely unusual.

### 10.4b Requirements written by incidents

An unusual and valuable property of this codebase is that most non-obvious
constants carry their postmortem in a comment. These are requirements, not
trivia, and they should survive into any future rewrite:

| The incident | The requirement it produced |
|---|---|
| A booking in Phoenix landed three hours early | **Timezone has no default.** The column default was dropped; an unset zone makes booking *refuse*, never guess |
| Two sweeps silently serialized on a shared advisory-lock key | Lock keys are a **registry with a collision discipline**, not ad-hoc integers |
| A non-production environment with real credentials could text real customers | The **environment gate precedes the credential check** in provider selection |
| A provider error echoed a customer phone number into a log | Queue and dead-letter sinks store an error **class and fingerprint**, never the message |
| Build logs expanded a provider credential; an nginx access log captured bearer tokens | Credentials are **never Docker build arguments**; token-bearing endpoints disable access logging. Pinned by a test that reads the Dockerfile |
| A migration was renamed and mutated; `IF NOT EXISTS` made the new column a silent no-op and boot crashed | **Migrations are immutable**, pinned by 277 content hashes |
| The first classifier turn exhausted the session cost cap on the caller's opening sentence | Caps are **derived from a worst-case structural assembly**, never sampled — and the arithmetic is pinned by test |
| Handlers returned success with a fresh id and persisted nothing | A **boot guard fails startup** when a voice-reachable handler is unwired, and **fails closed** on a missing probe |
| Approving a clarification card wedged it in `executing` through retries | A clarification **has no execution handler** and approval of it is refused |
| A model returning `{_meta: {overallConfidence: "high"}}` in an edit delta would have flipped a low-confidence proposal into auto-approvable form | Edit deltas **drop any key starting with `_`**, then re-validate the merged payload |

### 10.5 Cost

Per-session token and cost caps, derived rather than picked. Per-tenant quota
buckets with classifier traffic isolated. Cost tracked in micro-cents with
unknown-price models resolving to `null`. A documented per-call spend ceiling
gap is recorded in §12.

---

## 11. The quality bar — how this product proves itself

This section is a requirement, not a report. Rivet's differentiator is honesty
about its own behavior, and honesty is a testing discipline before it is a
feature.

**The standard of proof is real Postgres.** A DB-touching claim is proven by a
Docker-gated integration test that asserts the row **and its audit event**, run
under the least-privilege role so a query that breaks under RLS fails PR CI, not
an opt-in job. Mocked-DB tests are explicitly not proof: the entity resolver once
shipped referencing nonexistent columns because its connection pool was mocked.

**Current state, 2026-09-06 full verification** — every automated gate green:

| Lane | Result |
|---|---|
| API unit | 14,158 tests / 1,158 files |
| API integration (real Postgres + RLS role) | 1,218 tests / 213 files |
| Web · Mobile · Shared | 2,058 · 826 · 173 |
| Production typecheck, lint, gateway guard, FK paths, migration keys, env coverage | pass |
| Voice-quality corpus + launch gate | 73/73, all 11 buckets at or above threshold, zero drift |
| Playwright hermetic tier | 19 passed, 0 flaky |

**Five independent evaluation systems**, deliberately not variations of one:

1. **Voice-quality Layer 1** — 75 scripted calls against a 12-criterion rubric
   with recorded model responses. Eight *floor* criteria must pass **100%**: no
   PII leak, no auto-mutation, no hang, no cost-cap break, no tenant leak, no
   duplicate customer, compliance gates respected, hangup handled. Per-bucket
   thresholds run from 1.0 on the happy paths to 0.7 on ambiguity, concurrency,
   and adversarial.
2. **Layer 2** — real audio, three runs, with a deliberate voting design: floor
   criteria require **unanimity**, disposition criteria a 2-of-3 majority, hard
   slots must produce an *identical* value across all three, and latency is
   median-of-three. Disagreement is recorded as a flake indicator; unanimous
   failure is consensus.
3. **The in-app 50-case register** — 50 real operator utterances × three surfaces
   (voice, chat, chat-in-voice-mode) = 150 rows, hermetic, with only the
   classifier scripted. **Currently 150/150.** Its scoring thesis is the
   important part: a case does not pass because "some proposal id came back" —
   the failure mode of the live probes it replaced — it passes when the action
   path the operator asked for actually happened, with the right payload, on the
   right entity ids. Its signature failure shape, `intent_capture_only`, names
   exactly the thing that looks like success and isn't: *the assistant
   understood the request and then produced nothing an operator can act on.*
4. **Intent and slot evaluation** — targets of 92% intent accuracy and 0.88 slot
   micro-F1 against a live classifier, cost-capped and gated.
5. **Dialect and accent evaluation** — word error rate per dialect across both
   recognition engines.

**And the honesty caveats are written into the harness itself**, which is the
most Rivet-shaped thing in the repository. The Layer 1 disposition criterion for
intent classification is documented as a *tautology* — the mock classifier
derives its intent from the expectation — with the instruction: **"Do not read a
green Layer 1 run as evidence that classification works."** That is precisely why
the live evaluation exists. A nightly Postgres variant was deleted rather than
kept, because its runner was a throwing stub and *the nightly was decorative*.

**The decision register is executable.** The founding decisions live in a test
file with a three-state protocol: passing, `it.fails` for a decision that *should*
hold but currently does not (it turns red the moment the infrastructure catches
up, forcing promotion), and `it.todo` for infrastructure that does not exist. The
rule is stated plainly: *a decision without at least one test here does not exist
as far as CI is concerned.*

**What blocks a merge:** production typecheck, lint, the AI-gateway guard, FK-path
coverage, migration-key ordering, env-var coverage, agent-graph coverage, unit
tests, mobile unit tests with per-lane coverage thresholds, Docker-gated
integration tests, a global coverage floor, per-module coverage thresholds
(95% on the billing engine, 90% on payments and invoices, 85% on estimates,
execution handlers, auth and middleware), the voice-quality corpus gate, corpus
PII leakage, and cassette presence and drift.

Deploy adds two gates PR does not have: the **owner-loop critical path** and a
**synthetic voice smoke test**. A real phone call runs daily against staging, and
that workflow **hard-fails when its secrets are absent**, on the stated principle
that *a skipped run is not a passing gate*.

---

## 12. What is not built — the honest register

This section exists because the product's core claim is that it tells the truth
about itself. A PRD that only describes what works would violate the thing it
documents.

### 12.1 The one that matters most

> **Rung 6 is empty. Nothing in this product has been observed working in
> production with real tenants.** The July verification found the live Stripe
> platform account had **zero connected accounts and zero payments ever
> created**. Every gate below is green against a system no customer has used.
> The gap between rung 5 and rung 6 is the entire remaining product risk, and no
> amount of additional rung-4 proof closes it.

### 12.2 Safety and compliance — act before launch

| Gap | Why it matters |
|---|---|
| **The E1 life-safety script is placeholder copy**, self-flagged as requiring review | The routing is built and tested; the words a caller hears in a gas-leak call have not been signed off by anyone qualified |
| **AI-identity disclosure is fully implemented and never invoked** | Bot-disclosure law (e.g. CA SB 1001) logic exists with tests and has zero live callers |
| **Two jurisdiction lists disagree** on which states require two-party recording consent (one omits Connecticut and Oregon) | Two sources of truth for a legal question |
| **The voice approval PIN is a static per-tenant secret**, re-spoken on every approval | Redaction from transcripts shipped; per-approval codes did not. Exposure accumulates with each recorded call |
| **No absolute per-call wall-clock cap** — the idle timer re-arms on comfort noise | A looping caller bills telephony, recognition, model, and synthesis indefinitely |
| **Domain audit events are best-effort** (§5.0b, tier 2) | During an audit-store outage, operational state can be created without its domain audit row. The execution-outcome row still lands on the DB-only path, so the proposal trail survives — but "every mutation is auditable" is weaker than it reads. Worth deciding explicitly: strengthen tier 2, or state the limit in any compliance claim that rests on the audit trail |

### 12.3 Money — correctness defects

| Gap | Effect |
|---|---|
| **Discount is not proportionally allocated** across taxable and non-taxable lines; the full discount is subtracted from the tax base *and* in full from the subtotal | Systematic **under-taxing** on any mixed-taxability invoice carrying a discount |
| **`taxExempt` is a phantom** — referenced in supervisor logic, no column exists | A B2B signal that cannot be recorded |
| Single flat document-level tax rate; no jurisdiction engine, no per-line rates, no exemption certificates | Stated as a v1 decision; becomes a real constraint at multi-jurisdiction scale |
| Currency hard-coded; no currency column | Single-market by construction |
| **E-signature is a name, IP, user-agent, and a canvas image** | No document hash, no certificate, no ESIGN/UETA artifact. This is a legal claim the data cannot currently support |
| **No ledger or double-entry layer.** Money state is invoices, payments, and two denormalized counters | The reconciliation sweep *detects* drift across five invariants and writes audit events — but **never repairs**, by design |

**The discount defect, made concrete.** A $200 invoice — one $100 taxable line,
one $100 non-taxable — with a $100 discount and a 10% tax rate:

| | Taxable base | Tax | Total |
|---|---|---|---|
| **Today** | `max(0, 100 − 100)` = **$0** | **$0.00** | $100.00 |
| **Proportionally allocated** | $100 − $50 = **$50** | **$5.00** | $105.00 |

The tenant under-collects $5 of tax they owe. Worse, the floor at zero means any
discount at or above the taxable subtotal drives tax to $0 while the full
discount still reduces the total. The fix is to allocate the discount across
lines in proportion to their share of the subtotal before computing the tax base.

### 12.4 Built but dormant — capability that exists and is unreachable

Every one of these represents engineering already paid for.

- **A complete urgency-tier classifier** with its own rules file and unit tests —
  **zero production callers.**
- **A lateness computation** with geofence, dwell, and a confidence breakdown —
  complete, unit-tested, **no worker or route invokes it.**
- **Conversational onboarding** — a real multi-turn engine, persisted and tested;
  **zero clients call it.** The shipped experience is the form wizard.
- **RAG retrieval** — the knowledge-chunk table, embeddings, scoping, and an
  evaluation-run table all exist; the code says plainly that **no caller in main
  reads or writes today**.
- **A workflow-trigger subsystem** with modes and configuration — **zero callers
  anywhere**, not even tests.
- **A guardrail expiration module** — superseded by the worker, still present with
  zero callers.
- **Two AI skills** (customer-history summarization, AI-identity disclosure) —
  tests only.
- **The escalation-outcome route is a stub** that validates its input and returns
  success while persisting nothing.
- **A prompt registry** that versions exactly one prompt and has no database
  implementation.
- **Trust graduation** — the tiers (`graduates_fast`, `graduates_slowly`,
  `always_asks`) are defined and carried on every proposal, and all of them fall
  through to draft. The ledger that would graduate them does not exist. The data
  is attached so it *can* be built retroactively, which is the right call, but
  the product currently has one trust tier and four names for it.

### 12.4b Schema debt

Three tables are **fully dead** — zero references anywhere outside the schema
file: `weather_cache` (whose consumer field `vulnerability_signals.weather_unavailable`
exists, so the reader was designed and the cache never wired),
`tenant_provisioning_costs` (a per-tenant Twilio/SendGrid cost-attribution model
never connected to provisioning), and `digest_entries` — which has its own RLS
policy and is superseded by `daily_digests`.

Roughly a dozen more are **schema-only or single-writer**, superseded by a later
design but never removed: `prompt_versions` (with `ai_runs.prompt_version_id`
pointing at it *without a foreign key*), `llm_cache`, `provider_health`,
`estimate_provenance`, `evaluation_snapshots`, `wording_preferences`,
`quality_metrics`, `service_bundles`.

And three concepts are **modeled twice**: `job_photos` alongside `attachments`
(the newer migration explicitly keeps both for back-compatibility),
`daily_digests` alongside `digest_entries`, and the vertical pack registry —
whose DB `CHECK` still permits only HVAC and plumbing while the code registry
carries four verticals.

One is a live correctness gap rather than tidiness: **`jobs.money_state` is a
plain `TEXT` column with no `CHECK` constraint**, and its shared contract
schema is `z.string()` with a TODO. A six-state money machine — the thing that
drives what the owner is told about every job — is currently unvalidated at both
the database and the contract boundary.

### 12.5 Parity holes — declared, not hidden

Six (capability × surface) cells are marked as holes in the coverage table. The
sharpest is on the **primary realtime transport**: a classified lookup there
falls into the drafting state machine and typically ends as a clarification card
instead of a spoken answer. The other two surfaces route to the shared dispatch;
the realtime turn pipeline never gained the branch.

This is the honest consequence of a known structural problem the code names
itself: **the per-turn pipeline is implemented four times**, and the four copies
have drifted. The coverage table, its structural test, and behavioral anchors
make that drift *visible and testable* rather than eliminating it.
Consolidation is in flight and unfinished. **The requirement going forward is
that a capability cannot land on one surface and silently miss another** — which
the structural test now enforces even while the duplication remains.

### 12.6 Documentation-vs-code discrepancies found in this reconstruction

| Claim | Reality |
|---|---|
| **Pricing: the GTM brief says one tier at $297/month** | The code implements **two plans — basic at $50 and enterprise at $150** — with no functional differentiation between them anywhere: no plan value is read to gate any feature. This is the single largest strategy-to-code gap in the product and it needs a product decision, not a code change |
| Trial caps | 60 min/day and 100 min total; an active subscription bypasses **all** caps. Paid plans are uncapped and unmetered — there is no usage metering or overage billing despite the brief's per-minute overage |
| "Supervisor reviews every quote" | Reviews voice-drafted quotes; photo- and wizard-drafted quotes are never reviewed |
| "Delivery channel configurable per tenant" | Per-send choice only; no tenant-level setting |
| "Estimate follow-up disableable" | No disable mechanism exists, per-estimate or globally |
| "The digest is the dashboard, 6–9pm" | Digest is **default-off** with no UI toggle and no window constraint |
| The review-response approval UI | The sub-component approval UI referenced in code comments does not exist as described |
| Roles | Four roles specced across documents; **three exist** (`owner`, `dispatcher`, `technician`). `admin` was never built |
| Equipment history | Named as an HVAC differentiator throughout; **no equipment entity exists** |
| Geocoding | Described as wired; **absent entirely**. Latitude/longitude columns exist and are never populated; travel-time providers only consume them |

### 12.7 Deliberate non-goals — unchanged

**Out of scope, ever:** tax filing · payroll calculation (hours are surfaced;
QuickBooks or Gusto pays) · legal advice · vendor price negotiation · HR and
firing decisions · AI-initiated discounting or scope commitment · anything
requiring the owner to sit in a dashboard for more than ~30 seconds.

**Deferred post-PMF:** multi-location aggregation · parts inventory and supplier
integration · route optimization · predictive maintenance · outbound marketing
automation · two-way accounting reconciliation.

---

## 13. Success metrics

### North star

**Owner hours returned per week.** Target **12+** for the median pilot by week 8,
against a time-diary baseline taken at onboarding.

The product measures this itself. A **time-given-back** report assigns explicit
per-action minute credits under a versioned constant — 12 minutes for a drafted
estimate, 8 for a drafted invoice, 5 for a booking, 3 for a recorded payment,
**0 for a clarification** — and converts to dollars using the tenant's hourly
rate, returning null rather than a guess when the rate is unset. Publishing the
version and the credits is a requirement: the number is a *model*, and a model
you can't inspect is a marketing claim.

### The hero metric

**Hands-Free Collected Revenue.** Net payments on invoices whose chain of gating
proposals was approved **without anyone opening the web app**. An unknown
approval channel is conservatively counted as web. It is the one number that
directly measures the product's actual promise, and it is deliberately
constructed to under-claim.

### Secondary

Time-to-cash · calls answered during work hours (baseline ~40% → target 100%) ·
quotes drafted within 4 hours of intake (~30% → >90%) · invoices sent within 24
hours of completion (~50% → >90%) · owner approvals per day (<15, sustainable) ·
approval median latency (<10 min in business hours).

### AI quality gates

| Metric | Threshold |
|---|---|
| Estimate proposal approval rate | ≥ 70% |
| Clean approval rate (no edits) | ≥ 30% |
| Edit rate | < 40% |
| Execution failure rate | < 5% |
| Median time to review | < 90 s |
| Low-confidence rate | < 25% |
| Proposal execution success | > 99% |
| Stale proposal rate | < 10% |
| Clarification resolution rate | > 60% |
| Intent accuracy · slot micro-F1 (live) | ≥ 92% · ≥ 0.88 |
| Voice-quality floor criteria | **100%** |
| In-app 50-case register, per surface | 50/50 |

### Business

3 pilots → 10–25 beta customers · 80% → 90% week-4 retention · NPS > 50.

---

## 14. Open decisions and risks

### Decisions needed from product, not engineering

| # | Decision | Why it's blocked |
|---|---|---|
| **O-1** | **What is the price?** | Code says two tiers at $50/$150 with no differentiation; GTM says one tier at $297 with metered overage. Engineering cannot pick |
| **O-2** | **Who signs off on the E1 life-safety script?** | Flagged in code as requiring review. Not an engineering decision |
| **O-3** | **Does the trust ladder ship?** | Three tier names exist and all behave identically. Either build the graduation ledger or delete the names |
| **O-4** | **Per-approval voice codes, or accept static PIN exposure?** | Money-class voice approval should not be considered shipped until this resolves |
| **O-5** | **Is e-signature a legal claim we make?** | If yes, the data model needs a document hash and a certificate |
| **O-6** | **Which realtime transport carries voice approval?** | An approval exchange does not fit inside the resilient transport's hang timer |
| **O-7** | **Does equipment history ship?** | Named as an HVAC differentiator in every strategy document; the entity does not exist |

### Risks

| Risk | Exposure | Mitigation in place |
|---|---|---|
| **No production usage** | Total. Every claim is rung ≤5 | Nothing yet mitigates this. It is the top risk |
| **Under-taxing on discounted mixed invoices** | A correctness defect in money math | Known, unfixed |
| **Four copies of the turn pipeline** | Silent per-surface divergence | Coverage table + structural test make drift visible; consolidation in flight |
| **Caller-ID as an auth factor** | Spoofable by design; blast radius is any employee mobile on file | Recorded explicitly; net tightening over the prior state where revenue had no gate at all; a spoken challenge for owner-grade lookups is the named follow-up |
| **Dormant subsystems** | Paid-for capability delivering nothing, and a maintenance surface | §12.4 inventory; each needs wire-or-delete |
| **Unbounded per-call spend** | Cost | Session token and cost caps exist; the wall-clock cap does not |
| **Single-process assumptions** | Portal rate limits, flag caches, alert cooldowns, latency histograms | Each documented in code rather than hidden; Redis paths exist for the fan-out cases |

---

## 15. Decision history

The twenty-nine recorded decisions, in one table, because the *shape* of this
list is itself a product artifact: it shows a team that repeatedly chose the
harder, safer option and wrote down why.

| # | Decision | Status |
|---|---|---|
| D-001 | Single-cloud AWS deployment | **Superseded by D-016** |
| D-002 | Clerk for auth | Live |
| D-003 | Integer cents for all money | Live, invariant |
| D-004 | Proposal-first AI safety model | **Live, the load-bearing decision** |
| D-005 | Provider-agnostic LLM gateway | Live, CI-enforced |
| D-006 | Shared line-item schema for estimates and invoices | Live |
| D-007 | Appointment-level assignment as truth | Live |
| D-008 | Vertical packs on a shared core | Live |
| D-009 | Payment links, not embedded checkout | Superseded in practice — elements, terminal, ACH, and saved cards all shipped |
| D-010 | Manual-trigger QuickBooks sync | Live, one-way |
| D-011 | Reframe as an AI back office for owner-operators | Live — cut seven planned phases |
| D-012 | Negotiation discount policy, fail-closed at zero | Live |
| D-013 | Status correction: QuickBooks and the correction loop are built | Record |
| D-014 | *(template)* | — |
| D-015 | Autonomous booking lane — scoped, opt-in, reversible | Live, default OFF |
| D-016 | Railway supersedes AWS; prototypes removed | Live |
| D-017 | One consent model — revoke everywhere, grants never cross | Live |
| D-018 | Autonomous close lane with system approval | **Revoked by D-019 within 24 hours** |
| D-019 | On-call close requires explicit owner approval | **Live — the human-authority invariant** |
| D-020 | Sent-estimate retract is soft-delete ("Withdraw") | Live |
| D-021 | One Expo app serves supervisor and technician | Live |
| D-022 | The `app.ts` problem is dependency wiring, not route sprawl | Live |
| D-023 | Two-step invoice issuance; brand-voice lock stays tap-only | Live |
| D-024 | Decompose by construction kind, not domain | Live, stage 1 |
| D-025 | Owner voice approval is permitted; the invariant is about actors | Live |
| D-026 | The phone authorizes by a caller-ID-resolved actor's DB role | Live |
| D-027 | A live-call complaint escalates to a human | Live |
| D-028 | The classifier prompt is surface-conditional; caps are derived | Live |
| D-029 | A gate on an entity id must have a resolver behind it | Live |

Three entries are worth reading as a set. **D-018 → D-019 → D-025** is the
product finding its own line: an autonomous capability was designed carefully,
shipped, revoked the next day as a governance violation, deleted from the code,
and then made structurally impossible to reintroduce — after which D-025
discovered that a *different* prohibition everyone believed in had never actually
been decided, was attributed to an unrelated entry, and had been silently
contradicted by shipped code for months.

That sequence is the best evidence for the product's central claim. A team that
will delete a working feature to preserve an invariant, and then audit its own
log and admit that a rule everyone cited was never agreed, is a team whose system
can credibly tell a customer when it was wrong.

---

## 16. Glossary

- **Surface** — a way a person reaches the product: the live phone, a recorded
  memo, in-app chat or voice, web, mobile.
- **Transport** — an implementation of the phone surface. A capability targets
  *the phone*, never a transport.
- **Shared dispatch** — the one per-skill implementation a family of capabilities
  runs through, regardless of surface.
- **Surface adapter** — the thin per-surface caller of a shared dispatch. Owns
  identity, response shape, failure copy, telemetry. **Never contains a switch.**
- **Actor** — the tenant user a request is authorized *as*. On the phone,
  resolved once from caller-ID at session establishment and never from anything
  the caller says.
- **Owner line** — a caller-ID matching the owner's or backup supervisor's
  mobile. Transport-level recognition, not identity proof.
- **Capability** — one thing a tradesperson can do by speaking: an intent, plus
  whatever answers or executes it.
- **Parity** — the same capability behaves the same on every surface it targets.
  *Structural* parity means a new capability cannot land on one surface and
  silently miss another.
- **Proven** — a capability has a real-database integration test on the surface in
  question, not merely an in-memory one.
- **Proposal-first** — the AI never writes to operational entities; it drafts a
  typed proposal a human approves. Lookups are read-only and are never proposals.
- **Turn pipeline** — the one per-turn implementation every live voice surface
  runs through. Guard-ladder order and intent-family precedence live here.
- **Coverage table** — the declared cell per (intent family × surface):
  reachable, or refuse with honest copy. A structural test forbids undeclared
  cells, so refusals happen on purpose and silence is impossible.
- **Action class** — the risk tier of a proposal type: capture, comms, money,
  irreversible, manual. Decides what approval costs.
- **Rung** — the build-state ladder in §0. Rung 4 requires a real-database proof
  including the audit event; rung 6 requires production observation.

---

*Reconstructed from the code. Where this document and the code disagree, the
code is right and this document is a bug.*
