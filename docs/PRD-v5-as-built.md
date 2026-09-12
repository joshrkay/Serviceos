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
(D-001–D-032), the strategy spine (`docs/strategy/day-in-the-life.md`), the
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
| **4− Written** | Real-Postgres **write** proven; the audit leg still uses an in-memory repository |
| **5 Reachable** | Proven *and* reachable by a real user on the surface the requirement names |
| **6 Live** | Observed working in production, with real tenants |

**A rung alone is not the definition of done.** It answers *"is this proven?"* for
one tenant. Rivet is a multi-tenant product whose isolation boundary is the
database, so every requirement also carries a **tenant grade T0–T4** saying how
many tenants the proof has actually met. The two compose: **the tenant grade caps
the rung.** §8.0 defines both and the capping rules; §11.0e reports the measured
baseline.


**Every rung in §5 and §8 was re-derived from the test suite on 2026-09-11.**
The first edition asserted them from reading the source, which is a prediction,
not a verdict — 28 rows were overclaimed and 16 underclaimed. **§8.0 explains how
a rung is now earned**, and every row carries the command that confirms or
refutes it. A rung without a command behind it should be treated as a guess.

**Three ways to read the requirement sections.** §5 and §8 each state the same
thing three ways, so one document serves three readers:

| If you are asking | Read | Which column |
|---|---|---|
| *What did the user need?* | the **story** — a named persona's voice | User story |
| *How would we know it works?* | the **acceptance criterion** — one falsifiable Given/When/Then | Acceptance criterion |
| *Can we confirm it today?* | the **rung**, and the command beside it | Rung · Confirm |

The third question is the one this edition exists to answer, and it is not the
same as the first two. **A rung is a verdict on evidence, not on value** — five
stories sit at rung 4 and still fail their user (§12.4c), and at least one
rung-3 story is probably fine (§8.0).

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

**The story columns in §5 and §8 refer to these people by initial.**

| | Persona | The shape of their problem |
|---|---|---|
| **M** | **Mike Rivera** — HVAC, Phoenix, 2 trucks, ~$680K | Dispatcher, CSR, estimator, bookkeeper and tech. Peak season is 102°F and the phone never stops |
| **J** | **Jenna Walsh** — plumbing, Cleveland, solo, ~$340K | Single-threaded by choice. Frozen-pipe season at 4am. Wants her life back, not a fleet |
| **T** | **The tech going independent** | No systems, no price book, no processes. Rivet is the first software they buy |
| **S** | **The owner's spouse, doing the books Saturday morning** | The unseen second user. The digest and the weekly summary are their whole product |


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

#### The ratified thesis: voice directs, SMS approves (D-030)

This is the one place the goal's *mechanism* moved, and until **D-030** the
repository had two canonical documents asserting different answers. `PRD.md`
v2.0 locked decision #1 said *"SMS is the primary interface."* The July master
PRD said *"the voice channel **is** the product."* The shipped system implements
neither literally:

| | Surface | Carried by |
|---|---|---|
| **Direction** — the labor | Phone, in-app voice, memo, chat | The 78-intent taxonomy, the command line, the proposal drafts |
| **Approval** — the control | SMS + one tap | One-tap HMAC links, `Y`/`N`/`EDIT` replies, the digest |

**D-030 ratifies that synthesis**, and supersedes v2.0's SMS-primacy claim. The
goal is unchanged — the north star and the founding sentence both stand. What
changed is the answer to *"where does the owner's hand go?"*, and the code had
already answered it consistently across four surfaces, three transports, and the
whole intent taxonomy. **The documentation is what drifted, not the build.**

Recording it matters for a reason this log has already proved once: D-025 found
a posture everyone cited that had never actually been decided, was attributed to
an unrelated entry, and had been contradicted by shipped code for months. Two
PRDs disagreeing about the primary interface is that same failure, one step
earlier.

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

They are also the **negative user stories** — the epic whose acceptance
criterion is that something *never happens*. An anti-persona is defined against
them: *"the owner who wants AI fully unsupervised"* is explicitly not the
customer, and the refusal is structural rather than policy. So each invariant is
stated three ways below — as a law, as the story a persona would tell, and as a
criterion a command can refute.

**Eleven of eighteen clear the real-Postgres or structural-guard bar. Five carry
a universal quantifier nothing proves. One has no enforcement at all.**

| # | The law, and the story behind it | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **I1** | **The AI never writes to an operational entity.** It drafts a typed proposal; a deterministic handler executes after approval (D-004). · *As M, I want the AI to never write to my records directly, only propose, so nothing happens without me* | **Given** a drafted proposal, **then** **zero** rows exist in the target table; after approval, exactly one row **and** its audit event | 4 | **D:** `integration/create-job-execution.test.ts` |
| **I1′** | *…and I want that true of **every** path, not just the ones someone tested* | **Given** any AI module, **then** it cannot call a repository write | **2** 🚨 | **CODE-ONLY** — no lint rule, no import guard. Per-path D-004 pins exist. *A tested behaviour, not an enforced invariant* |
| **I2** | **No `system:` actor may ever approve a proposal** (D-019) — a structural guard in the single lifecycle transition seam, so the rule survives future callers. · *As M, I want no automated actor able to approve on my behalf, so "approved" always means a human did it* | **Given** any starting status, **when** a `system:` actor attempts `approved`, **then** it throws `ForbiddenError` | 3 | **U:** `proposals/lifecycle.test.ts`. 🚨 *In-memory objects only; **zero** integration tests attempt a `system:` approval* |
| **I3** | **Approval is a human control act** (D-025). Owner voice approval on a verified owner line; money and irreversible classes additionally require a spoken challenge, capped at three failures then locked. · *As M, I want spoken approval of money to require a challenge, so a stranger with my phone can't approve a refund* | **Given** three wrong codes in one session — **including across a cancelled and restarted dialogue** — **then** the session locks for money/irreversible while capture-class still approves | 3 | **U:** `ai/tasks/proposal-approval-task.test.ts`, `telephony/voice-approval-gather.test.ts` |
| **I3′** | *…and I want the readback composed from the proposal, never from what I just said* | **Given** an approval readback, **then** its text derives from the payload, not the utterance | **2** 🚨 | **CODE-ONLY** — no provenance assertion exists |
| **I4** | **An AI-emitted price is never authoritative.** A pure, deterministic, LLM-free catalog resolver ahead of proposal creation; uncatalogued lines force review through a flag a tenant cannot override. · *As M, I want an AI-invented price to never be authoritative, so my catalog is the only source of truth* | **Given** one uncatalogued line, **then** `requiresReview === true` regardless of tenant settings or confidence, and `pricing_source` is CHECK-constrained on disk | 4 | **U:** `ai/resolution/catalog-resolver.test.ts` · **D:** `integration/invoice-pricing-source.test.ts` |
| **I5** | **Ambiguity becomes a clarification, never a silent guess** — on every surface, in that surface's own idiom (D-029). · *As M, I want it to ask instead of guessing, so it never acts on the wrong customer* | **Given** two same-named customers, **then** **exactly one** question is asked and no id persists until a follow-up names a candidate | 4 | **D:** `integration/chat-entity-resolution.test.ts` |
| **I5′** | *…through one shared matcher, so the surfaces cannot drift* | **Given** one disambiguation matcher, **when** surfaces diverge, **then** the build fails | **2** 🚨 | **FALSE AS WRITTEN.** A second, deliberately broader gate exists (`gated-reference-resolution.ts:602`) whose own comment says it *"is allowed to be slightly BROADER than the matcher behind it."* Nothing fails if they drift |
| **I6** | **A gate on an entity id must have a resolver behind it** (D-029). A gate nothing can lift is a capability that can never be approved (#909). · *As M, I want every question it asks me to be answerable, so it never blocks on something I can't resolve* | **Given** any entity-id gate a proposal contract can emit, **then** it is a key of `GATED_REFERENCE_SOURCES` | **2** 🚨 | **NO EVIDENCE** — and a test pins the **opposite** as supported: an unresolvable gate is a legal state (`gated-reference-resolution.test.ts:115`). **Both cannot be true. The weakest invariant in the table** |
| **I7** | **The AI never discounts, never commits scope, never promises a human.** Deterministic negotiation guardrail; discount policy fails closed at zero. · *As M, I want it to never give away my margin* | **Given** no configured discount policy, **then** zero concession on every ask — **and no registered proposal type can even express an AI-applied discount** | 4 | **U:** `proposals/guardrails/negotiation-invariant.test.ts`, `discount-evaluator.test.ts` — *a type-level impossibility proof, not a behaviour sample* |
| **I8** | **Safety escalation beats containment** (D-027). Deterministic emergency detection ahead of the classifier. · *As J, I want safety to beat every other consideration, so containment never wins over a life* | **Given** a tier-1 phrase, **then** E1 **with no rules loaded**, and complaint escalation fires from **every** live FSM state | 3 | **U:** `emergency-tier.test.ts`, `emergency-tier-transitions.test.ts`, `complaint-guardrail.test.ts` |
| **I8′** | *…and I want no setting anywhere able to switch that off, so a misconfiguration can't be fatal* | **Given** any tenant configuration, **then** safety cannot be suppressed | **2** 🚨 | **NO EVIDENCE.** Rests on the *absence* of a parameter, which nothing pins. A future flag would break it silently |
| **I9** | **All money is integer cents**, end to end, with one shared engine and **one** percent-of-money helper so rounding cannot drift (D-003). · *As M, I want the arithmetic exactly right, so I never have to explain a penny* | **Given** ≥1000 randomized documents, **then** every money field is an integer and totals never go negative; `createInvoice` persists the server total, **discarding the client's** | 4 | **U:** `shared/billing-engine.property.test.ts`, `line-item-normalization.test.ts` |
| **I9′** | *…from one engine as the only source of totals math* | **Given** any module, **then** it cannot compute document totals itself | **2** | **CODE-ONLY** — nothing forbids it |
| **I10** | **All times stored UTC, rendered in the tenant's timezone.** An unset zone makes booking **refuse** — a Phoenix mis-booking postmortem removed the column default. · *As M (Phoenix), I want a missing timezone to refuse, not guess* | **Given** no configured zone, **then** the draft has no window, approval **refuses**, and **zero** appointment rows exist | 4 | **D:** `integration/live-call-booking-timezone.test.ts` |
| **I11** | **Every entity carries `tenant_id`; RLS is FORCED at the database**, under a dedicated non-bypassing role the server refuses to boot without in production. The database, not application code, is the isolation boundary. · *As M, I want my data mine at the database, so a code bug can't leak it* | **Given** every `tenant_id` table, **then** RLS is **enabled and forced** with exactly two documented exemptions — and production **refuses to boot** without the role | 4 | **D:** `integration/rls-force-catalog.test.ts`, `rls-runtime-audit.test.ts`, `rls-runtime-role.test.ts` — **the best-evidenced invariant in the product** |
| **I12** | **Every mutation emits an audit event** attributable to actor id, role and channel. **Two tiers, and they are not the same strength — see §5.0b.** · *As M, I want every change to leave a trail I can audit* | **Tier 1: Given** an execution, **when** the audit insert fails, **then** the **whole unit rolls back** — no state change without its audit row | 4 | **D:** `integration/executor-audit-atomicity.test.ts` (both directions) |
| **I12′** | *Tier 2 — handler domain audit, best-effort* | **Given** a handler whose `auditRepo.create` throws, **then** it still succeeds with its mutation committed | 3 🚨 | **U:** `proposals/callback-handler.test.ts` — **one handler family only**, ~40 swallow sites untested, and no real-DB test of the §5.0b outage consequence |
| **I13** | **Caller speech is untrusted data for its whole lifetime** — including when read back to the operator hours later. · *As M, I want nobody able to talk the AI into doing something later* | **Given** a transcript containing fence-marker lookalikes, **then** marker counts are exactly 1 each and the caller block sits in the lowest-authority slot | 3 | **U:** `ai/untrusted-content.test.ts`, `customer-calling/untrusted-content.test.ts`, `i13-provenance.test.ts` |
| **I13′** | *…in **every** operator-facing model context* | **Given** any operator-facing prompt, **then** caller text is fenced | **2** 🚨 | **CODE-ONLY** — exactly three call sites; a new prompt inlining a transcript passes CI |
| **I14** | **A revocation of contact consent blocks every channel; a grant never crosses channels** (D-017), on an append-only ledger behind both outbound gates. · *As a customer, I want "STOP" to stop everything* | **Given** an SMS `STOP`, **then** an outbound **call** is blocked even while `consent_status` reads granted; **given** `START`, **then** SMS restores and the voice rollup stays revoked | 4 | **D:** `integration/consent-cross-channel.test.ts`, `stop-reply-unify.test.ts` |
| **I15** | **All LLM calls route through one gateway** (D-005). No module outside it may import a provider SDK. · *As M, I want every AI call through one place, so cost, retries and the audit trail can't be bypassed* | **Given** the clean tree, **then** the guard exits 0; **given** a planted offending file, **then** it exits non-zero | 4 | **STRUCTURAL with a genuine negative control.** **U:** `ai/gateway-ci-guard.test.ts`. *Scope caveat: OpenAI-specific — an `@anthropic-ai/sdk` import would pass it* |
| **I16** | **A capability's surface coverage is declared, not accidental.** Undeclared (capability × surface) cells fail a structural test; refusals happen on purpose and silence is impossible. · *As M, I want behaviour on each surface declared, so nothing is silently missing* | **Given** 11 families × 4 surfaces, **then** every cell is declared with no unknown keys — **and** every handler in the shared drafting registry is reachable or in a declared exception set on both voice/memo and chat | 4 | **U:** `ai/voice-turn/coverage-table.structural.test.ts`, `proposals/drafting-surface-parity.test.ts`. *The coverage table is inert at runtime; **cite `drafting-surface-parity` when defending this*** |
| **I17** | **Auto-approval is a scoped, opt-in, reversible exception — never a posture** (D-015): two capture-class types, default OFF, stricter floor, kill switch, one-tap UNDO, digest visibility. · *As M, I want "AI books it" to never become "AI runs it"* | **Given** a fresh tenant, **then** the lane is off at 0.95; a raw SQL drop to 0.80 is **refused by a DB CHECK**; and the lane is ineligible for each of 19 single-gate mutations, with the platform kill switch outranking tenant opt-in | 4 | **D:** `integration/settings-autonomous-booking.test.ts` · **U:** `proposals/autonomous-lane.test.ts`, `one-tap-undo.test.ts` |
| **I18** | **No feature ships that adds admin work to the owner's day** — the litmus test, and the reason seven planned v1 phases were cut (D-011). · *As M, this is the entire reason I bought this* | **Given** any owner-role action required on a normal day, **then** it is reachable by SMS, one-tap or voice — or is in a reviewed exemption list | **0** 🚨 | **No enforcement of any kind, and no test.** The product's founding promise is the only invariant with nothing behind it — see §5.0c |
| **C5** | *(not an invariant — founding commitment #5, listed here because it reads like one)* **A second classifier reviews every booking and quote.** · *As M, I want a second pair of eyes before a quote reaches a customer* | **Given** any booking/quote reaching an owner-facing dispatch — **any** origin, **any** status — **then** exactly one supervisor review exists first | **2** 🚨🚨 | **NOT KEPT — see §12.4e.** The gate has **2 call sites against 93 proposal-creation sites**; one is conditional on `ready_for_review` so **low-confidence quotes are skipped precisely because the agent was unsure**; default mode is `shadow` where nothing ever holds; and `pricing_anomaly` is not a harm check, so **it cannot hold even in `enforce`**. **Raised as O-9** |

### 5.0a The five invariants whose universal quantifier is unproven

I1′, I3′, I5′, I8′, I9′ and I13′ share one shape: **the instance is proven and
the universal is not.** "The AI never writes" is proven for the paths someone
thought to test; nothing stops the next path. That is the difference between a
tested behaviour and an enforced invariant, and it matters when someone adds the
next code path.

**I6 is the weakest**, because a test pins the opposite behaviour as supported.
I6's text says an unresolvable gate "is a capability that can never be approved."
The test says such a gate is a legal state. Both cannot be true.

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

### 5.0c Making I18 falsifiable

I18 is a product-process rule, not a code invariant, and it should not sit
unmarked beside I1–I17. Three mechanisms could operationalize it, in ascending
cost — **all three already have working precedent in this repo.**

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
the build**.

**(b) A budget assertion on the count.** `expect(ownerRequiredDailyWebActions).toHaveLength(N)`.
Cheap, mechanical, and a PR incrementing `N` is self-documenting in review.

**(c) An e2e "SMS-only day."** Drive a full simulated day — inbound call, quote,
approval, payment, review response — entirely through the SMS/webhook surface
with **zero authenticated web requests**. Most faithful to the intent; most
expensive to maintain.

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

Organized along the ten-stage spine the product's own verification uses. Each
stage is an **epic**, each row is a **user story in a named persona's voice**
with a falsifiable acceptance criterion, the **rung** that says how far we can
confirm it, and **the command that confirms or refutes it.**

### 8.0 How to read these rows

**Every rung below was derived from the test suite on 2026-09-11. The first
edition of this document asserted them from reading the source.** That is a
prediction of what a test would find, not a verdict, and the repo's own QA
harness forbids exactly that substitution:

> `expected` documents the pre-run prediction. **It is NOT the pass criterion** —
> actual pass/fail comes from runtime checks. — `packages/api/test/qa/matrix.ts`

Re-deriving them found **28 rows overclaimed and 16 underclaimed**, concentrated
in §8.7 Quote (7 of 12) — the surface where a wrong number becomes a price a
customer is bound to. Several capabilities were *undersold*: MMS-to-quote,
estimate nudges, voice invoicing, voice book/move/cancel, the correction loop
and QuickBooks sync are all stronger than claimed.

#### A rung is earned by an evidence class, never assigned by inspection

| Class | Meaning | Highest rung |
|---|---|---|
| **NO EVIDENCE** | No test asserts the claim | 2 |
| **CODE-ONLY** | The code reads correctly; nothing pins it. A refactor could silently remove it | 2 |
| **PROVEN-UNIT** | Behaviour proven against in-memory or mocked dependencies | 3 |
| **STRUCTURAL** | A guard or contract test **with a negative control** — plant a violation, the build fails | 4 |
| **REAL-DB-WRITE-ONLY** (**4−**) | Docker-gated test proves the row against real Postgres; the audit leg uses an in-memory repository | 4− |
| **PROVEN-REAL-DB** | Docker-gated test proves **the write AND its audit event** against real Postgres | 4 |

Rung **5** additionally requires **reachability**: a normally-provisioned tenant
gets there with no SQL, no platform-admin action, no environment variable. Rung
**6** requires live production traffic.

#### The tenant grade — the second half of the definition of done

An evidence class says *how* something was proven. It does not say **in what
world**. A Docker-gated test that writes a row and its audit event proves the
capability in a universe containing exactly one tenant — which is not the universe
the product ships into.

This matters more here than in most products, because **the isolation boundary is
the database, not application code** (I11). Application-level correctness is
therefore not evidence of tenant correctness: the query can be right and the
*answer* still wrong once a neighbour exists.

| Grade | What was proven | Typical shape of the proof |
|---|---|---|
| **T0 — Single** | One tenant existed. Nothing about neighbours is known | the default; not a claim |
| **T1 — Isolated** | A second tenant exists and **cannot see or touch** the first's rows | *"invisible to another tenant"*, *"rejects cross-tenant access"*, a raw query under the unprivileged role |
| **T2 — Non-interfering** | A second tenant's **data does not change the first's answer** — aggregates, availability, selection, counters | *"tenant A's appointment does not block tenant B's availability"* |
| **T3 — Divergently configured** | Two tenants with **different settings** each get their own correct result **in the same run** | *"a tenant on both packs gets both Diagnostic Fees at their pack prices"*; the Phoenix timezone case |
| **T4 — Really enumerated** | For anything that iterates tenants: the **production selector runs** (not a stubbed list), every eligible tenant is processed, and a failure on one **does not abort the rest** | a sweep test that seeds N tenants and asserts N outcomes |

**T1 is isolation; T2 is non-interference; they are different failures.** A
correctly tenant-scoped `WHERE` clause gives you T1 and tells you nothing about
T2 — a sweep can be perfectly scoped and still pick the wrong rows, double-count,
or starve a tenant. **T3 is where the Phoenix mis-booking lived**: both tenants'
queries were fine; the *configuration* was assumed shared.

**Capping rules — the tenant grade caps the rung:**

| Rule | Why |
|---|---|
| Rung **4** requires **T1** | "The write and its audit event are proven" is not proof for a multi-tenant product if only one tenant has ever existed |
| Rung **5** requires **T2**, and **T3** wherever the capability reads per-tenant configuration | Reachable *for one owner* is not reachable. If two differently-configured tenants would collide, the capability is not done |
| Any capability that **iterates tenants** is capped at rung **4** until **T4** | A sweep proven against a stubbed one-element tenant list has not been proven at all — the stub replaces the exact thing under test |
| Rung **6** requires **T4** plus live traffic from **≥2 real tenants** | One pilot tenant is a demo, not production |

**How to confirm a grade.** Each is a shell falsifier over the test that carries
the row's rung:

```bash
# T1/T2 — does the proving test even know a second tenant exists?
grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant" <test file>

# T3 — are two tenants configured DIFFERENTLY and asserted separately?
grep -nE "timezone|business_hours|labor_rate|threshold|pack|digest_enabled" <test file>

# T4 — is the tenant enumerator stubbed to a hand-picked list?
grep -nE "listTenantIds:\s*async\s*\(\)\s*=>\s*\[" <test file>
#   a single-element literal here means the sweep is T0, whatever its rung says
```


**The honest reading of the scale:** below 4, the story is a belief. At 4 it is
proven but may be unreachable. Only at **5** has the persona been served, and
only at **6** have we watched them be served. **Rung 6 is empty.**

#### A rung is a verdict on evidence, not on value

The two come apart in **both** directions, and neither direction is visible in
an engineering-only view:

- **Rung 4 and the story still fails.** 9.6 (the end-of-day digest) and 2.7
  (dropped-call recovery) are proven at real Postgres and **Mike cannot turn
  either on**. 4.11 is worse: Carlos is never notified of an assignment, and the
  module's own doc-comment claims otherwise.
- **Rung 3 and the story is probably fine.** 2.5 (emergency detection) has a
  thorough bilingual corpus and an upward-only bias. It is very likely correct.
  We simply cannot *confirm* it survives a real database — and for a life-safety
  path, that gap is itself the finding.

#### Three rules this audit had to learn the hard way

1. **Documentation is never evidence.** Two modules carry doc-comments that are
   actively false about their own wiring.
2. **Directory location is not evidence.** `packages/api/test/integration/` is
   not synonymous with real Postgres — three files there never open a pool, and
   one was carrying a **rung-5 claim on a `vi.fn()`**:

   ```bash
   for f in packages/api/test/integration/*.test.ts; do
     grep -q "getSharedTestDb\|TEST_DB_URL\|new Pool(\|withTestDb\|testDb" "$f" || echo "NO-DB: $f"
   done
   ```

3. **A mocked dependency caps the claim at the mock.** CLAUDE.md's own rule —
   *"tests that mock the DB are never the only proof a query works"* — and it is
   what demoted the dunning cadence, the 4★ review gate and the service-credit
   cap.

#### Running any command in this section

| Prefix | Lane | Command |
|---|---|---|
| **D:** | Docker / real Postgres (`pgvector/pgvector:pg16` testcontainer, `maxWorkers:1`) | `npm run test:integration --workspace=packages/api -- <path>` |
| **U:** | Unit — **excludes `test/integration/**`**, no Docker | `npm test --workspace=packages/api -- <path>` |
| **W:** | Web (jsdom) | `npm test --workspace=packages/web -- <path>` |
| **E:** | End-to-end | `npx playwright test <path>` |
| **S:** | Structural falsifier — a shell command whose **output is the verdict** | given inline |

Narrow to one case with `-t "<test title>"`. Paths under **D:** and **U:** are
relative to `packages/api/test/`. The integration lane requires a running Docker
daemon; **without one it does not fail, it skips** — which is its own trap, and
the reason `S:` falsifiers appear wherever a claim is load-bearing.

Rows marked ✅ *executed* were run during this audit rather than inspected —
§8.1, §8.5 and §8.6 were produced by running the Docker-gated suite (12 files,
70 tests, all passing).

#### The epics at a glance

| § | Epic | Jobs | Stories | Median rung | The one thing in the way |
|---|---|---|---|---|---|
| 8.1 | Stand up the back office | precondition | 11 | 4 | Invite emails 404 — `/accept-invitation` has no route |
| 8.2 | Answer my phone when I can't | J1, J3, J10 | 12 | 3 | Emergency detection has no real-DB proof; recording consent is mocked |
| 8.3 | Book the job without me | J2 | 12 | 4 | The customer never provably gets a confirmation |
| 8.4 | Run the day | J1, J10 | 11 | 3 | The drag→proposal guarantee is untested at the DB |
| 8.5 | Capture the work in the field | J5 | 5 | 4 | Field screens aren't pinned to the glove/daylight contract |
| 8.6 | Let me fix it by talking | J9 | 9 | 4 | No spoken-address entity — nobody can say "the house on Elm" |
| 8.7 | Draft the quote from what was said | J4, J10 | 12 | 4− | 7 of 12 overstated; the stale-revision guard has never met a real DB |
| 8.8 | Bill it and chase the money | J5, J6 | 13 | 4 | Dunning cadence idempotency is unproven — duplicate collections texts |
| 8.9 | Tell me what happened, and what you got wrong | J7, J8 | 12 | 4 | **The digest cannot be turned on by anyone** |
| §5 | Never exceed your authority | J8, J10 | 26 | 4 | The second classifier reaches 2 of 93 origins |

**123 stories. Zero at rung 6.** Nothing in this product has been observed
serving a real tenant.

#### What each rung shape actually costs to close

The rungs are not interchangeable, and the work each one needs is different:

| Gap shape | Work it needs |
|---|---|
| **0** | Build it (4.9, 4.10, 6.8, I18) |
| **2 — unreachable** | Wire it. Usually one call site (4.11, 2.12) |
| **2 — unguarded invariant** | Write the structural test (I1′, I5′, I6, I8′) |
| **3** | Write the Docker-gated test. **The code is probably fine** |
| **4−** | Swap `InMemoryAuditRepository` → `PgAuditRepository`. *One import closes four §8.7 rows* |
| **4 — unlit-able** | Ship a write path. Not a feature — a route and a toggle |
| **5** | Nothing. Get a tenant on it and earn rung 6 |

**The single highest-value item is C5 / §12.4e**, because it is the only row
where the honest fix might be to **change the commitment** rather than the code —
and that is a product decision, not an engineering one (O-9).

### 8.1 Setup — the first 15 minutes

**Epic: Stand up the back office** · **Jobs:** the precondition for every other epic

**Primary persona: T (the tech going independent), then M.** This epic is the
precondition for every other one. T has no price book and no processes; the
product has to manufacture them during onboarding or nothing downstream works.

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

| # | User story | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **1.1** | **As T**, I want an account the moment I sign up, so I never see a "setting up your workspace" screen | **Given** a Clerk signup webhook, **when** it is delivered twice, **then** exactly one tenant exists and the replay window is enforced *before* signature verification | 4 | **D:** `clerk-owner-membership.test.ts` |
| **1.2** | **As T**, I want to type my business details once and have the system remember them, so I'm not re-entering my address in four places | **Given** a valid identity payload, **when** I submit it and later resubmit, **then** the row upserts idempotently, an omitted `serviceAreaRadius` keeps its stored value while `null` clears it, and a `tenant.identity_set` audit event is written | **5** | **D:** `onboarding-identity.test.ts` ✅ *executed* |
| **1.3** | **As T**, I want a price book I didn't have to build, so I can quote on day one | **Given** I pick HVAC, **when** the pack activates twice concurrently, **then** one seeding occurs under an advisory lock and my catalog holds the pack's SKUs at the pack's prices | **4−** | **D:** `onboarding-pack.test.ts`, `onboarding-pack-seed-concurrency.test.ts` — *no audit assertion* |
| **1.4** | **As T**, I want to close the laptop mid-setup and come back to exactly where I was, so onboarding survives a service call | **Given** a partially-configured tenant, **when** I return, **then** the current step is derived from *facts about my tenant* — never a stored wizard flag — and cannot disagree with reality | 4 | **D:** `onboarding-status.test.ts` ✅ *executed* |
| **1.5** | **As T**, I want to look around before finishing setup, so I can decide if this is worth my time | **Given** identity is saved, **when** I navigate anywhere, **then** the CRM is unlocked and later steps nudge rather than hard-block | 3 | soft-gate logic; no DB-level proof |
| **1.6** | **As M**, I want my own phone number on my own subaccount, so my call records are mine | **Given** production credentials, **when** provisioning runs, **then** a subaccount, messaging service and number are created — and **without** real credentials it throws rather than faking success | 3 | **U:** provisioning unit tests. *Capped by the third-party dependency, not by neglect* |
| **1.7** | **As T**, I want a 14-day trial with no card surprises, so I can try this without commitment | **Given** a plan whose price fails live Stripe validation, **when** checkout renders, **then** that plan is **omitted, never shown at a wrong price** | 4 | **D:** subscription integration tests |
| **1.8** | **As T**, I want proof the AI works before I point my real number at it, so I'm not experimenting on customers | **Given** verification runs, **when** it passes, **then** the step completes with DB status `passed`; **when** it fails, **then** I get an `ai_verification_failed` blocker and a retry that resets to pending and re-enqueues | **4** ↑ | **D:** `onboarding-ai-check.test.ts` ✅ *executed* |
| **1.9** | **As T**, I want to set this up by talking instead of filling a form, because I'm doing it in the truck | **Given** the conversational path, **when** I complete up to 15 turns, **then** transcript, extractions and clarification counts round-trip through JSONB, RLS is ENABLE + FORCE, and cross-tenant reads are refused — with the form wizard still available as fallback and edit surface | **4−** | **D:** `onboarding-conversation.test.ts` ✅ *executed* — *no audit assertion* |
| **1.10** | **As M**, I want the AI to sound like my shop and then **stop changing**, so my customers hear one voice | **Given** six captured fields, **when** the first write lands, **then** the voice locks; every later edit is cool-down gated under a `FOR UPDATE` lock with no lost update, rollback never mutates history, and a spoken *"lock my brand voice"* can **never** set the lock | **4** ↑ | **D:** `brand-voice.integration.test.ts`, `update-brand-voice-voice-execution.test.ts` ✅ *executed* |
| **1.11** | **As M**, I want to invite Carlos and have him actually get in, so my tech can see his own day | **Given** an invite, **when** Clerk is down, **then** the local invitation row is already written so tenant intent is never lost — **and** the last owner cannot be demoted | 4 / **0** | **D:** `clerk-owner-membership.test.ts`. 🚨 **The story fails anyway: `/accept-invitation` has no route. Every invite email 404s** |

> **Epic verdict.** Strong on the parts T touches alone; **1.11 is broken end to
> end** and it is the one story in this epic with a second human in it.

### 8.2 Capture — answering the phone

**Epic: Answer my phone when I can't** · **Jobs:** J1, J3, J10

**Primary personas: M in an attic with gloves on; J at 4am.** This is the epic
the product is named for. It is also the epic with the widest gap between what
we believe and what we can prove.

**Requirement: the voice gate is a ladder, and every rung fails to voicemail.**
Subscription status, then go-live, then trial caps (60 minutes/day, 100 total, 2
concurrent). A gate that *throws* also lands on voicemail. The caller always
reaches something.

**Requirement: unknown numbers and provider errors never produce dead air.** An
unrecognized dialed number returns a spoken "not in service," a database error
returns a retryable status so the provider retries, and a handler exception
returns a graceful hangup rather than an error — because a retry would duplicate
the session.

| # | User story | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **2.1** | **As M**, I want my phone answered 24/7 in my shop's voice, so I stop losing jobs to whoever answers first | **Given** a customer dials my number, **when** the call lands, **then** the tenant is resolved from the real `phoneE164` column and the greeting is my shop's | 5 | **D:** `voice-inbound-appointment.test.ts -t "routes a dialed number"` |
| **2.2** | **As M**, I want callers told they're being recorded **before** anything is captured, so I'm not exposed in a two-party-consent state | **Given** an inbound call, **when** the greeting plays, **then** the disclosure precedes `<Start><Record>`, Media Streams consumes no audio until it has played, **and the implicit-consent ledger row is written** | **3** 🚨 | Ordering proven; **the ledger write is a `vi.fn()`** in a file that never opens a pool. **S:** `grep -c "new Pool(" …/conversation-consent-ordering.test.ts` → **0** |
| **2.3** | **As M**, I want a known customer recognised by their number and a stranger turned into a lead, so nothing falls on the floor | **Given** an inbound number, **when** it matches a stored customer in E.164, **then** they are identified — **and** a non-NANP caller sharing the last 10 digits is **not** matched | 4 | **D:** `identify-caller.test.ts`. *The voice unknown→lead leg is untested at real DB; only the SMS caller is* |
| **2.4** | **As M**, I want a stranger on the phone to be unable to reach owner-only capability, so my phone line isn't an admin console | **Given** a caller-surface session, **when** the classifier returns an off-profile intent, **then** it becomes `unknown` and is **audited**, never silently dropped | **3** 🚨 | Fixture-proven only. **S:** `grep -rln "intent_off_surface" packages/api/test/integration/` → **empty** |
| **2.5** | **As J**, I want a gas leak recognised before any AI thinks about it, so a life-safety call never waits on a model | **Given** any transcript chunk in English **or** Spanish, **when** a tier-1 phrase appears, **then** E1 is returned **with no rules loaded**, the safety script speaks first, pending bookings are revoked, and it **never books** | **3** 🚨 | **Unit only.** The nearest integration test covers the downstream handler with an in-memory audit repo. *Also: the E1 script is still a self-declared placeholder* |
| **2.6** | **As J**, I want an elderly caller on oxygen in 104°F heat to reach me personally, so vulnerability isn't handled by a queue | **Given** age + weather + critical urgency, **when** triage runs, **then** my cell is patched with a 60s dial and a non-PII preface; if I don't answer, a high-priority booking plus an owner SMS — **never a normal booking** | 3 | **U:** `vulnerability-triage-hook.test.ts`. *Its flag has no production write path either* |
| **2.7** | **As M**, I want a caller who hangs up mid-booking to get a text back, so a dropped call isn't a lost job | **Given** a call ending in `dropped`/`failed` with a usable number, **when** 60s elapse, **then** exactly one recovery SMS sends, stamped and audited, re-evaluated at send time | **4 — unlit-able** 🚨 | Pipeline **proven at real Postgres including the flag-on transition**. But `setTenantFlag` has **zero production callers** — *Mike cannot turn this on* |
| **2.8** | **As J**, I want a customer's photo of a leaking heater to become a draft quote, so I can price it from the truck | **Given** an MMS from an unknown number, **when** ingest runs, **then** a `draft_estimate` proposal persists with `tenant_id` and an audit row — and an **ambiguous sender yields a clarification, never a draft** | **4** ↑ | **D:** `mms-to-quote.int.test.ts` |
| **2.9** | **As M**, I want customers to book themselves on my website without a login, so I stop playing phone tag | **Given** the public page, **when** a customer picks a real open slot, **then** a held appointment is written pending my approval | **3** 🚨 | Route mounted, `/book` ships — **but the only test is in-memory supertest** |
| **2.10** | **As M**, I want an unclaimed text to become a thread I can answer, so SMS isn't a black hole | **Given** concurrent inbound texts from one unmatched number, **when** captured, **then** they collapse to a single open thread with no cross-tenant bleed | 4 | **D:** `inbound-sms-capture.test.ts` |
| **2.11** | **As M**, I want the AI to refuse to quote a firm price or haggle, so it never commits me to a number I'd lose money on | **Given** a price-pressure turn, **when** the guardrail fires, **then** it speaks the holding line, mints exactly one owner callback, stays in state, and is idempotent when already flagged | **3** 🚨 | **All unit.** The one integration file tests the context read, not the guardrail |
| **2.12** | **As M**, I want a property manager's call to be handled as a portfolio account, so my biggest customer isn't treated like a stranger | **Given** a caller resolving to `property_manager`, **when** the call runs, **then** the outcome is **observably different** from a residential call — prompt, priority, and proposal context | **3** | Context *is* assembled and read by one supervisor check. 🚨 **But nothing routes on it** — `buildAccountContextPromptSection` has zero production callers. **The story as written is not met** |

> **Epic verdict.** The two stories carrying the most liability — **2.2 recording
> consent** and **2.5 life-safety detection** — are the two with the weakest
> evidence. Neither is broken; both are *unproven where it counts*.

### 8.3 Book

**Epic: Book the job without me** · **Jobs:** J2

**Primary persona: J at 4am, frozen pipe, whoever answers first wins.**

| # | User story | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **3.1** | **As J**, I want a call to produce a *proposed* booking, not a booking, so the AI never puts something on my calendar I didn't agree to | **Given** a spoken booking request, **when** the pipeline runs, **then** free text → real resolver → real drafting task → approval → production executor, and **zero appointment rows exist before approval** | 5 | **D:** `voice-inbound-appointment.test.ts` |
| **3.2** | **As J**, I want offered times to respect my actual working day, so I'm not booked at 7pm | **Given** my configured hours, **when** slots are generated, **then** only in-hours slots are offered, the buffered booked window is removed, and tenant A's calendar never blocks tenant B | **4 / 3** | **D:** `dispatch-availability.test.ts`. 🚨 **DST, per-day hours, technician hours and time-off are unit-only** — the story is broader than the proof |
| **3.3** | **As T**, I want to be told when the times I'm being offered are just defaults, so I don't discover my hours were wrong after a customer books | **Given** a tenant with no configured hours, **when** availability returns, **then** hours, buffer and timezone are each labelled as defaults | **3** 🚨 | In-memory supertest only — **and the web app never calls this endpoint**; only mobile does |
| **3.4** | **As M**, I want a booking POST to be unable to take a slot the calendar wouldn't have offered, so the public page can't be gamed | **Given** an out-of-hours slot, **when** a POST attempts it, **then** the write-side twin refuses | **3** 🚨 | **Unit only** |
| **3.5** | **As J**, I want a slot held while I decide, and released if I don't, so a second prospect gets a real answer | **Given** a 24h hold, **when** it expires, **then** the reaper cancels it, clears the flag, emits audit, spares live holds, and a second sweep is a no-op — and an expired hold **stops blocking** the slot | 4 | **D:** `hold-reaper.test.ts`, `slot-conflict-checker.test.ts` |
| **3.6** | **As M**, I want it to be *impossible* to double-book Carlos, so I never send one truck to two houses | **Given** two concurrent assignments for the same tech and slot, **when** both race, **then** exactly one succeeds — enforced by a DB `EXCLUDE` constraint, not application code | 4 | **D:** `technician-double-booking-race.test.ts` — **the strongest capability row in the product** |
| **3.7** | **As M**, I want the AI to ask instead of guessing when two customers share a name, so it never books the wrong Henderson | **Given** duplicate display names, **when** resolution runs, **then** the result is an ambiguity carrying **both** candidates — never a silent pick | 5 | **D:** `entity-resolution.test.ts`, `cancel-appointment-voice.test.ts` |
| **3.8** | **As M**, I want my customer to get a confirmation when I approve, so they don't call back to check | **Given** an approved `create_appointment`, **when** it executes, **then** an `appointment_confirmation` dispatch row is written | **3** 🚨 | **No test proves the dispatch row.** The default is a **no-op notifier**, and the class whose doc-comment claims to be the live path is never instantiated. *This story most likely fails in production and nothing would tell us* |
| **3.9** | **As J**, I want customers reminded the day before, so I stop eating no-shows | **Given** an appointment 24h out, **when** the sweep runs, **then** exactly one reminder sends, durably idempotent | **3 / 4** | The **owner push** is real-DB with durable idempotency; **the customer reminder is not** |
| **3.10** | **As M**, I want to book, move and cancel by talking, so I can do it between attics | **Given** any of the three spoken intents, **when** approved and executed, **then** the real row changes and **exactly one** audit event is emitted per action | **5** ↑ | **D:** `voice-inbound-appointment.test.ts`, `reschedule-appointment-voice.test.ts`, `cancel-appointment-voice.test.ts` |
| **3.11** | **As M**, I want stale schedule proposals to expire, so I'm not approving yesterday's plan | **Given** an unactioned schedule proposal, **when** the TTL passes, **then** it expires and can be re-proposed | 3 | **U:** only. 🚨 **Two TTL regimes coexist** — 48h in the worker, 24h default and 4h for `create_appointment` in the guardrail |
| **3.12** | **As M**, I want to be warned when back-to-back jobs aren't drivable, so I stop promising times Carlos can't make | **Given** a proposed move, **when** drive time is checked, **then** infeasibility surfaces — flagged as unverified when the fallback is great-circle | 3 | 🚨 **The three booking-*creation* paths call `createAppointment` with no feasibility check at all.** Only dispatch-side moves are checked |

### 8.4 Dispatch

**Epic: Run the day** · **Jobs:** J1, J10

**Primary persona: M as dispatcher, which is the job title he never wanted.**

**Requirement: the tech-out cascade is per-appointment, never bulk.** Each
affected customer is a separate proposal with its own drafted message, because
the owner may want to handle one differently. Three or more offers batch
approval.

| # | User story | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **4.1** | **As M**, I want one board showing today, so I stop reconstructing the day from texts | **Given** a date, **when** the board loads, **then** it returns that day's work and **refuses cross-tenant access** | 5 | **D:** `dispatch.test.ts` |
| **4.2** | **As M**, I want dragging a card to *propose* a change, not make one, so a slip of the thumb can't move a customer's appointment | **Given** a drag, **when** it lands, **then** a proposal is created and **the appointment is not mutated** | **3** 🚨 | `createSchedulingProposal` has **zero** integration coverage. The UI is reachable; the guarantee is not proven |
| **4.3** | **As M**, I want to see when someone else is dragging the same card, so my wife and I don't fight over the board Saturday morning | **Given** two users, **when** both act, **then** revision tokens order the writes and presence shows who holds which card | **3** | Presence is in-memory/Redis — **structurally incapable** of a real-Postgres proof. Score it honestly and stop calling it 4 |
| **4.4** | **As Carlos (M's tech)**, I want my own day view and nobody else's, so I see my work and not the shop's books | **Given** a technician session, **when** the day loads, **then** a 23:00-local appointment lands on the tenant date and a tech of tenant B is not submittable by tenant A | 4 | **D:** `dispatch-technician-day-window.test.ts`, `technician-location-authz.test.ts` |
| **4.5** | **As Carlos**, I want "on my way" to work the same whether I tap, speak, or text it, so I don't have to remember which app | **Given** any of the four entry points, **when** fired, **then** one audited act with a TECH actor plus a customer ETA dispatch row | **4 / 3** | Voice, phone and chat legs proven. 🚨 **The SMS-keyword leg is unit-only** — the story claims four legs and proves three |
| **4.6** | **As Carlos**, I want to tell the customer I'm running late in one tap with gloves on, so I don't pull over to type | **Given** the chip row, **when** I tap 10/20/30, **then** **the chip row *is* the confirm** — no second dialog — and a delay notice is written | **3** 🚨 | In-memory supertest plus a jsdom test that the chip hits the right endpoint; **no real-DB write proof** |
| **4.7** | **As M**, I want lateness detected from where the truck actually is, so I hear it before the customer does | **Given** geofence/dwell signals, **when** evaluated, **then** a lateness state with a confidence breakdown | 3 | 🚨 The server module's **only importer uses it as a type-only import** — the evaluator has no runtime caller in `packages/api` |
| **4.8** | **As M**, I want one tech texting OUT to produce one proposal **per affected customer**, so I can handle the difficult one differently | **Given** a verified tech OUT, **when** processed, **then** an unavailable block, a reschedule proposal **per appointment** each carrying a brand-voiced message, and an audit row — idempotent same-day, and **an OUT from an unregistered number is not actioned** | 4 | **D:** `tech-status-sms.test.ts` |
| **4.9** | **As M**, I want the closest certified tech assigned automatically, so I stop doing routing math in my head | **Given** a job needing a skill, **when** assignment runs, **then** only qualified techs are offered | **0** | The whole file is nine lines returning `[]`. 🚨 **And it is wired into `checkFeasibility`, so the empty skill list reads as "always feasible"** rather than as a visible gap |
| **4.10** | **As M**, I want my day sequenced to cut windshield time, so I fit one more call in | — | **0** | Absent. No module, no test |
| **4.11** | **As Carlos**, I want to be told when I'm assigned to something new, so I'm not surprised at 7am | **Given** an assignment change, **when** it commits, **then** the technician is notified | **2** 🚨 | `setTechnicianAssignmentNotifier` has **zero callers**. Every production assignment fires a **silent no-op** — while the module's doc-comment says *"app.ts registers one notifier."* **Carlos is never notified** |

### 8.5 Execute — the field

**Epic: Capture the work in the field** · **Jobs:** J5

**Primary persona: Carlos, and M when he's the tech. Gloves, daylight, one hand.**

**Requirement: the durable artifact is deleted only on confirmed flush.** The
offline queue removes local audio only after the server acknowledges, and never
attaches credentials on public paths.

| # | User story | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **5.1** | **As Carlos**, I want to use this with gloves on in the sun, so I don't take them off forty times a day | **Given** any field screen, **when** rendered at 320px, **then** every tap target is ≥44px and nothing overflows horizontally | **3** | The jsdom + Playwright contract exists for **estimate approval and review response**; 🚨 **field screens are not pinned the same way** |
| **5.2** | **As M**, I want before/after photos attached to the job, so I can defend the invoice | **Given** a captured photo, **when** stored, **then** category and before/after pairing survive the round trip | 4 | **D:** job-photo integration tests |
| **5.3** | **As Carlos**, I want to log my hours by talking, so paperwork never follows me home | **Given** a spoken duration, **when** executed, **then** a `time_entries` row lands with the resolved `jobId`, **exactly one** audit event, tenant-scoped — **and it is counted by the job-profit query** | **4** ↑ | **D:** `log-time-entry-execution.test.ts` ✅ *executed* |
| **5.4** | **As J**, I want a note dictated in a basement with no signal to survive and arrive later, so I never lose work to dead zones | **Given** an offline capture, **when** connectivity returns, **then** the journal flushes, the same key twice yields **one** row and one effective job, a create-then-crash replay re-enqueues, and **local audio is deleted only on confirmed flush** | **4** ↓ | **D:** `voice-idempotency.test.ts` ✅ *executed* · **U:** mobile `queue/flush/audioRelocation`. *Rung 5 needs a device-level proof of the reconnect edge; none exists* |
| **5.5** | **As J**, I want to take a card on the doorstep, so I get paid before I drive away | **Given** an active Connect account, **when** I tap to pay, **then** the charge completes — **and without one, a clean 409, never a silent failure** | 3 | **U:** `stripe-terminal.test.ts`. 🚨 **No Docker-gated test** |

### 8.6 Narrate — the owner's spoken command line

**Epic: Let me fix it by talking** · **Jobs:** J9

**Primary persona: M driving to the next job.** This epic is the product's
actual interface thesis — *voice directs, SMS approves* (D-030).

| # | User story | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **6.1** | **As M**, I want to talk to it from any screen without hunting for a button, so speaking is always the fastest path | **Given** any authenticated screen, **when** I press to talk, **then** a session opens with an SSE event stream | 5 | **W:** `useVoiceRecorder.test.ts` |
| **6.2** | **As M**, I want what I say to become a typed, validated proposal, so a mumble can't become a malformed invoice | **Given** a spoken sentence, **when** classified, **then** a Zod-validated proposal of the mapped type is drafted with vertical context | 5 | **U:** `operator-voice-golden-path.test.ts` · **D:** `voice-inbound-appointment.test.ts` |
| **6.3** | **As M**, I want to say "the Henderson job" and have it find the right one, so I don't have to know IDs | **Given** a free-text reference across nine entity kinds, **when** resolved, **then** a real row is found — or an ambiguity carrying **both** candidates | 4 | **D:** `entity-resolution.test.ts`, `chat-entity-resolution.test.ts` |
| **6.4** | **As M**, I want to ask where a job stands and get an answer, not a proposal, so a question doesn't create work | **Given** a status question, **when** dispatched, **then** a spoken answer and **no proposal minted** | 5 | **D:** `update-job-execution.test.ts` |
| **6.5** | **As M**, I want to add a line to an existing quote by talking, so I don't reopen a laptop for two hours of labor | **Given** *"add two hours of labor to the Garcia estimate"*, **when** executed, **then** the line persists at qty 2 / unit hour and totals recompute in integer cents on the real row | **4** ↑ | **D:** `update-estimate-execution.test.ts` |
| **6.6** | **As Carlos**, I want notes, expenses, mileage, materials and time to all work by voice, so the truck *is* the back office | **Given** *"$40 in parts for the Henderson job"*, **when** executed, **then** the expense carries `job_id` and **counts in job P&L**; two Henderson jobs **clarify**; no job mention logs **unlinked** and P&L does not count it. A dictated note persists with **exactly one** audit event | **4** ↑ | **D:** `add-note-voice-execution.test.ts`, `log-expense-job-link.test.ts` ✅ *executed* |
| **6.7** | **As M**, I want to ask for my numbers out loud and hear them, so I don't open a dashboard at a red light | **Given** a lookup, **when** answered, **then** a two-phase contract (`completed` + `pending`, then answered), **write-once** against a redelivered stamp, `failed` stays retryable, tenant-isolated, out-of-enum refused by a DB CHECK | 4 | **D:** `voice-lookup-answer.test.ts` ✅ *executed* |
| **6.8** | **As M**, I want to say "the house on Elm" and have it resolve, because that's how I think about jobs | **Given** a spoken address, **when** resolved, **then** it matches a service location | **0** | 🚨 **No `place` entity kind exists anywhere in the product** |
| **6.9** | **As Carlos**, I want to say "three-quarter copper, twenty feet" and have both number and unit stick, so the parts list is usable | **Given** quantity and unit, **when** stored, **then** both round-trip; `listPending` scopes by job, orders by `needed_by`, excludes NULL bounds, and breaks ties on insertion order | 3 | **D:** `material-items.test.ts` ✅ *executed*. **Correction to the PRD:** a job-level parts domain **does** exist (`material_items`, migration 272) |

### 8.7 Quote

**Epic: Draft the quote from what was already said** · **Jobs:** J4, J10

**Primary persona: M at 6:15am making lunches one-handed.** **This epic has the
heaviest concentration of overstatement in the product — 7 of 12 rows.** It is
also the epic where a wrong number becomes a price a customer is legally bound
to.

**Requirement: a locked estimate is cloned, never edited.** Acceptance, or any
paid deposit, locks the document. The escape hatch is an explicit clone, so the
record the customer approved is never rewritten underneath them.

**Requirement: grounding is all-or-nothing.** If *any* priced line is ambiguous,
uncatalogued, or missing a pricing source, the estimate is not grounded and the
voice agent speaks **no numbers at all** — rather than reading out the subset it
happens to trust.

| # | User story | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **7.1** | **As M**, I want a quote drafted from the call that already happened, so I'm not re-typing what the customer told the AI | **Given** a spoken description **or** a customer photo, **when** drafted, **then** a real estimate/proposal row persists **plus** its audit event | **5** ↑ | **D:** `draft-estimate-execution.test.ts`, `mms-to-quote.int.test.ts` |
| **7.2** | **As M**, I want every price to come from *my* price book, and anything it can't find flagged, so the AI never invents a number | **Given** a drafted line, **when** grounded, **then** the catalog price is stamped into JSONB and `missingFields` cleared — **and any uncatalogued line caps confidence below the auto-approve floor** | **4 / 3** 🚨 | Grounding proven. 🚨 **The confidence cap is not** — *the half that protects M from quoting a number he can't defend* |
| **7.3** | **As M**, I want doubt shown on the specific line that earned it, so I know where to look | **Given** a mixed document, **when** rendered, **then** each line carries its own `pricingSource`, an invalid one is refused by a DB CHECK on a raw UPDATE, and a badge renders per line | 5 | **D:** `estimates.test.ts -t "pricing_source"` · **W:** `AIProposalCard.test.tsx` |
| **7.4** | **As M**, I want good/better/best tiers, so I stop leaving money on the table | **Given** three tiers with add-ons, **when** persisted, **then** all tier rows and the accepted selection survive | **4−** 🚨 | Write proven; **audit leg is `InMemoryAuditRepository`** |
| **7.5** | **As M**, I want the headline price to be the option I recommended, not the sum of all three, so the customer isn't scared off by a number I never quoted | **Given** tiers, **when** the total renders, **then** it equals the **default selection**, strictly less than the sum of all tiers | **4−** 🚨 | Shares its single assertion with 7.4 |
| **7.6** | **As M**, I want the customer to approve and sign from a link with no login, so approval isn't blocked by a password reset | **Given** a token link, **when** the customer approves with a signature, **then** acceptance and the signature both persist | **4− / 2** 🚨 | Token approval proven. 🚨 **The signature is not** — the only integration reference *sets it as fixture data* and never asserts the round trip |
| **7.7** | **As M**, I want a customer who approves an old version to be stopped, so nobody holds me to a price I already revised | **Given** a revised estimate, **when** approval arrives with the stale version, **then** it is **rejected** and the status stays `sent`; with the current version it is accepted | **3** 🚨🚨 | **A guard deciding which price M is legally bound to has never touched a real database** |
| **7.8** | **As M**, I want exactly one accepted estimate per job, so I can't accidentally have two live prices | **Given** two concurrent approvals on one job, **when** they race, **then** exactly one is accepted — **and the loser gets a clean conflict, not a 500** | **4− / 3** | The race **is** genuinely tested against the real partial unique index. 🚨 **The conflict mapping is not** — the test never inspects the rejected settlement |
| **7.9** | **As J**, I want a deposit before I order parts, so I'm not financing the customer | **Given** `before_approval` and an unpaid deposit, **when** the customer approves, **then** it is **blocked** and the estimate stays `sent` | **4− / 3** 🚨 | `after_approval` proven. 🚨 **The `before_approval` block and the fixed-amount rule are in-memory only** |
| **7.10** | **As M**, I want unviewed quotes chased automatically, so my pipeline doesn't die of silence | **Given** concurrent nudges for one estimate, **when** dispatched, **then** exactly one send, cadence advances once, audit rows written, a 48h cooldown respected, and a crash mid-send recovers | **5** ↑ | **D:** `estimate-nudge.test.ts` — *nine real-DB tests* |
| **7.11** | **As M**, I want a second pair of eyes on a quote before it goes out, so an obvious pricing mistake gets caught | **Given** any quote reaching an owner-facing dispatch, **when** it does, **then** exactly one supervisor review exists first | 3 | Annotations persist with a real `ai_run_id` FK. 🚨 **But the gate reaches 2 of 93 origins and cannot hold a pricing anomaly in any mode — see E10.18** |
| **7.12** | **As M**, I want the AI to refuse to negotiate and hand it to me instead, so it never discounts my work | **Given** a discount request, **when** handled, **then** a capture-class owner callback in `ready_for_review` with **zero** customer-facing dispatch and no concession | **3** 🚨 | **All in-memory.** The one integration file tests the context read, not the guardrail |

### 8.8 Bill

**Epic: Bill it and chase the money** · **Jobs:** J5, J6

**Primary personas: J walking out of the job; M 30 days later with $12K
outstanding.** The money surface is the best-evidenced area in the product and
also holds its single largest overclaim.

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

| # | User story | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **8.1** | **As J**, I want to invoice by saying one sentence, so I bill before I drive away | **Given** a spoken invoice, **when** approved and executed, **then** a real invoice row with integer-cent totals and **exactly one** `invoice.created` audit event | **5** ↑ | **D:** `draft-invoice-execution.test.ts` |
| **8.2** | **As M**, I want the invoice to bill exactly the tier the customer chose, so I don't bill for options they declined | **Given** a tiered accepted estimate, **when** converted, **then** the invoice lines equal `accepted_selection` **only** | 3 | Linkage and idempotency proven at real DB. 🚨 **Selection fidelity — the actual story — is in-memory only** |
| **8.3** | **As M**, I want a completed job to offer me an invoice, so nothing ages unbilled | **Given** a job transitioning to completed, **when** it commits, **then** `completed_at` is stamped **and** completion effects auto-draft an invoice proposal | **4** ↑ | **D:** `update-job-execution.test.ts` |
| **8.4** | **As M**, I want the customer to pay from a link on their phone, so I stop chasing checks | **Given** a payable invoice, **when** a link is issued, **then** it persists only on a payable, unchanged, link-free invoice — and a signed `checkout.session.completed` flips it to paid | **4 / 3** | **D:** `payment-credit-guards.test.ts`, `invoice-webhook-paid.test.ts`. *Embedded elements are jsdom-only* |
| **8.5** | **As M**, I want ACH, cards on file and card-present all to settle correctly, including when they fail later | **Given** an ACH `processing → succeeded`, **then** one completed payment + paid invoice + audit chain; **given** `processing → payment_failed`, **then** the in-flight credit reverses and the invoice reopens; **given** a duplicate delivery, **then** no double-credit | **4 / 3 / 2–3** 🚨 | ACH is strong in all three directions. 🚨 **Card-present has no Docker-gated test; charging a stored card off-session has none at all** — storage round-trips, nothing proves money lands |
| **8.6** | **As M**, I want two payments arriving at once to both count, so my balance is never wrong | **Given** a $100 cash entry racing a $150 ACH webhook, **when** both commit, **then** both credit with no lost update; two concurrent full-balance payments credit **exactly once**; the SQL cap rejects a credit that no longer fits | 4 | **D:** five Docker-gated files, nine tests — **the best-evidenced row in the money surface** |
| **8.7** | **As M**, I want voiding an invoice to kill its payment link immediately, so nobody pays an invoice I cancelled | **Given** a void, **when** it commits, **then** `stripe_payment_link_id`/`_url` are NULL on the persisted row, in-flight intents are cancelled, and a `payment_link.deactivated` audit event is written | **3** 🚨 | The *consequences* of void are proven at real DB (a voided invoice takes no credit). 🚨 **The deactivation itself is proven only against a mock provider — the exact scenario this story exists to prevent** |
| **8.8** | **As M**, I want a refund to adjust the record without lying about what happened, so my books stay honest | **Given** two concurrent deliveries of one `stripe_refund_id`, **when** processed, **then** `amount_refunded_cents` increments **exactly once**, one claim row exists, and the status is **never flipped** | 4 | **D:** `payment-refunds.test.ts` — *interleave, stranded-claim, RLS and migration-backfill all covered* |
| **8.9** | **As M**, I want overdue invoices chased on a schedule **and never chased twice**, so I don't damage a relationship over a duplicate text | **Given** an invoice 15 days past due, **when** swept twice, **then** exactly **three** dunning rows exist with `step_key IN ('3:sms','7:sms','14:sms')` and a duplicate insert of `'7:sms'` raises 23505 | **3** 🚨🚨 | **Every cadence test uses an in-memory ledger.** The only real-DB dunning test keys on `manual:<proposalId>`. **Nothing proves the cadence key has ever met the real `UNIQUE` index** — and a duplicate sweep double-texting a customer about money is exactly the failure this story exists to prevent. **The largest single overclaim in the product** |
| **8.10** | **As M**, I want late fees applied consistently and capped, so I'm firm without being punitive | **Given** a re-executed `apply_late_fee`, **when** it runs again, **then** no second fee line appears on the real invoice; **and** a fee exceeding the cap is clamped | **5 / 3** ↑ | **D:** `late-fee-idempotency.test.ts`, `voice-collections-execution.test.ts`. *The cap is unit-only* |
| **8.11** | **As M**, I want to bill a big job in stages, so cash flow matches the work | **Given** a 3-milestone schedule on a total that doesn't divide evenly, **when** split, **then** Σ milestones === total, with the remainder milestone absorbing every stray cent | 3 | **Unit only** |
| **8.12** | **As M**, I want memberships to renew and bill themselves, so recurring revenue is actually recurring | **Given** a lapsed auto-renew agreement, **when** the sweep runs, **then** `ends_on` advances, `renewal_count` bumps, member pricing applies to a document, and dues collect | 3 | 🚨 **Every integration test here proves a *column*, not a *behaviour*.** No renewal sweep, no member price applied, no priority in dispatch, no dues charge. *Generous at 3* |
| **8.13** | **As M**, I want the arithmetic to be exactly right, every time, so I never have to explain a penny | **Given** ≥1000 randomized documents, **when** totalled, **then** every money field is an integer and totals never go negative | **4** 🚨 | The 4000-iteration suite is a **seeded PRNG fuzz, not a property-based test** (its own header says so), lives **outside the Docker lane**, and never crosses the DB boundary. 🚨 **And the reconciliation sweep *expects* rounding mismatches in live data and reports them as informational** |

> **Separately tracked, not a story:** the discount/tax defect — the full
> discount is subtracted from **both** the tax base and the subtotal,
> systematically under-taxing mixed invoices. See PRD §12.3. *Q12 (fail closed,
> alert loudly, or leave it) is still unanswered and blocks that fix.*

### 8.9 Close

**Epic: Tell me what happened, and what you got wrong** · **Jobs:** J7, J8

**Primary personas: M at 9:30pm with the kids in bed; S doing the books Saturday
morning.** This epic is the trust pillar and the product's stated thesis that
**the digest is the dashboard.**

**Requirement: the review classifier degrades to the safer label.** Below a
confidence floor, an ambiguous review is treated as a *vague* complaint rather
than guessed into a specific one — the product would rather under-claim
understanding than put words in a customer's mouth.

**Requirement: an over-cap service credit is omitted, not zeroed.** Proposing
"$0 credit" is worse than proposing no credit.

| # | User story | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **9.1** | **As M**, I want a customer thanked 2h after the job, so the last thing they remember is courtesy | **Given** two concurrent sweeps over one eligible job, **when** they run, **then** exactly one send and one `notification.thank_you_sms.sent` audit row — and a "sent" claim with a NULL stamp is **reconciled, not resent** | 4 | **D:** `thank-you-sms-worker.test.ts` |
| **9.2** | **As M**, I want a review asked for automatically, so my rating grows without me thinking about it | **Given** a completed job 24h old, **when** swept twice, **then** one `feedback_send` enqueued, with the setting defaulting **on** at the column level | **4−** | **D:** `review-request-sweep.test.ts` — *no audit assertion* |
| **9.3** | **As M**, I want an unhappy customer routed to me privately and a happy one to Google, so a bad day doesn't become a permanent 2★ | **Given** `rating: 3`, **when** submitted, **then** the response persists and **no** review links return; **given** `rating: 5`, **then** the configured link returns | **3** 🚨🚨 | Proven only by a mocked-repo route test. **This is the row deciding whether a 2★ experience becomes a public Google review, and it has no real-DB proof** |
| **9.4** | **As M**, I want new Google reviews found and a response drafted for my approval, so I reply within a day without watching for them | **Given** a connected tenant, **when** a sweep runs, **then** new reviews persist, the cursor advances, a re-sweep persists nothing new, a 429 stamps backoff, and reviews are RLS-invisible cross-tenant — with a PII-redacted draft response awaiting approval | **4 / 3** ↑ | **D:** `google-reviews-worker.test.ts`. *Classification and drafting are unit-only* |
| **9.5** | **As M**, I want to make a bad experience right without over-giving, so goodwill doesn't become a leak | **Given** $80 already issued in 12 months and a $50 tier proposed, **when** the cap applies, **then** the credit is **omitted, not zeroed** — because proposing "$0 credit" is worse than proposing none | 3 | 🚨 The existing test calls itself a *smoke test that stubs `pool.connect()`* |
| **9.6** | **As M**, I want one text at the end of the day telling me what happened, so I never open a dashboard | **Given** a tenant at its local digest time, **when** the sweep runs, **then** a digest sends once — not duplicated, not re-sent — carrying **"what I wasn't sure about"** and **"what I learned today"** | **4 — unlit-able** 🚨🚨 | The write **and both named sections** are proven at real Postgres. 🚨 **`digest_enabled` defaults false and *nothing in web or mobile writes it*. Mike cannot turn on the product's central promise without someone running SQL against production** |
| **9.7** | **As S**, I want a weekly summary I can read Saturday morning, including how often it repeated a mistake, so I can see whether it's learning | **Given** a week of corrections, **when** summarised, **then** total / repeats / rate come from the real corrections table, and the field is **omitted at zero**; the send ledger is idempotent and a failed send leaves **no** row so the week retries | **4** ↑ | **D:** `weekly-feedback-builder.test.ts`, `hfcr-weekly-send-worker.test.ts` |
| **9.8** | **As M**, I want a correction I make once to stick, so I never fix the same thing twice | **Given** a labor-rate correction, **when** executed, **then** the config changes so the **next same-day draft reflects it**, it appears in the day's applied lessons, and `correction_lesson.applied` is written | 5 | **D:** `correction-loop.test.ts` |
| **9.9** | **As M**, I want to undo a lesson it learned wrong, so teaching it is not a one-way door | **Given** an applied lesson, **when** undone, **then** the prior value is restored **exactly**, `correction_lesson.reverted` is emitted **exactly once**, a second undo is a no-op, and it drops from the day | 5 | **D:** `correction-loop.test.ts` — *asserts both audit ends with `PgAuditRepository`; the best-evidenced row in the lifecycle sections* |
| **9.10** | **As M**, I want a mistake I've corrected three times to become a permanent fix I approve, so the system stops needing me for it | **Given** a third same-target correction, **when** it lands, **then** a meta-proposal is minted that, once approved, updates the real catalog **through the production registry and executor** | 4 | **D:** `correction-repetition-meta-proposal.test.ts` |
| **9.11** | **As S**, I want paid invoices to reach QuickBooks without me re-keying them, so Saturday is shorter | **Given** already-synced paid invoices, **when** swept again, **then** **zero** QuickBooks calls and zero new `sync_log` rows; pagination syncs **every** paid invoice, not one page; `sync_log` is RLS-isolated | **4** ↑ | **D:** `accounting-sync.test.ts`. *Rung 5 is blocked on a live OAuth connection, not on code* |
| **9.12** | **As M**, I want one inbox for every channel with a reply drafted for me, and **nothing sent without my hand on it** | **Given** a thread, **when** I ask for a suggestion, **then** a draft returns and **zero** dispatch rows are written; **given** a DNC number, **then** a reply writes **no** dispatch row at all | **4 / 3** 🚨 | Inbox and guarded send proven — including the DNC refusal, which is the "never auto-sent" half. 🚨 **The AI-suggestion leg has no integration test at all** |

### 8.10 The fourteen founding commitments

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

**The standard is met unevenly, and that is now measured rather than assumed.**
An audit on 2026-09-11 derived every §8 rung from the suite instead of from the
source. Eleven of eighteen invariants clear the real-Postgres bar; so do the
strongest capability rows — RLS isolation, DB-level double-booking exclusion,
payment concurrency, refund idempotency and the correction loop. But five rows
rested on files in `test/integration/` that never open a pool, and eleven more
rested on a mocked dependency. **The bar was right; the accounting against it was
not.**

### 11.0a The audit scorecard

| Section | Rows | Overclaimed | Underclaimed | Confirmed |
|---|---|---|---|---|
| Invariants I1–I18 (§5) | 18 + 6 sub-clauses | 6 sub-clauses unproven, 1 invariant unenforced | — | 11 at PROVEN-REAL-DB or STRUCTURAL |
| §8.1 Setup | 11 | 1 | 2 | 8 |
| §8.2 Capture | 12 | 5 | 2 | 5 |
| §8.3 Book | 12 | 4 | 1 | 7 |
| §8.4 Dispatch | 11 | 3 | — | 8 |
| §8.5 Execute | 5 | 1 | 1 | 3 |
| §8.6 Narrate | 9 | — | 3 | 6 |
| §8.7 Quote | 12 | **7** | 2 | 3 |
| §8.8 Bill | 13 | 5 | 2 | 6 |
| §8.9 Close | 12 | 2 | 3 | 7 |
| §8.10 Founding commitments | 14 | 1 not kept · 3 dark · 2 partial · 2 unproven | — | 6 |

**Net: 28 rows overclaimed, 16 underclaimed.** The corrected picture is not
worse, it is **differently shaped**. Overclaims concentrate in quoting,
collections cadence and review gating. Several capabilities were undersold:
MMS-to-quote, estimate nudges, voice invoicing, voice book/move/cancel, the
correction loop and QuickBooks sync.

### 11.0b The five strongest things in the product

Ranked by evidence, not by ambition:

1. **RLS isolation (I11)** — every `tenant_id` table proven enabled-and-forced at
   runtime, exemptions pinned to exactly two, boot refusal proven.
2. **Double-booking exclusion (8.3.6)** — a real concurrent race against a real
   `EXCLUDE` constraint.
3. **Payment concurrency (8.8.6)** — five Docker-gated files, nine
   lost-update/overpay/clamp tests.
4. **The correction loop (8.9.8–8.9.9)** — apply, cascade, report and undo, all
   proven on real Postgres with audit rows on both ends.
5. **The negotiation guardrail (I7)** — a type-level impossibility proof.

**The first edition called emergency detection "the strongest thing in the
product." That is the inverse of true** — it is unit-tested only, with no
Docker-gated proof and a self-declared placeholder script. It was the single
largest overclaim in the document.

### 11.0c The eight tests that would close the most ground

In the order they should be written:

1. `test/ai/supervisor/review-coverage.test.ts` — the §12.4e finding. Highest
   value; **the only one that changes an architecture decision rather than a
   score.**
2. Dunning cadence at real Postgres — `'3:sms' | '7:sms' | '14:sms'` against the
   real `UNIQUE` index. Closes the largest money overclaim.
3. Review gating at real Postgres — a 3★ returns no links, a 5★ does.
4. Swap `InMemoryAuditRepository` → `PgAuditRepository` in
   `estimate-phases.test.ts`. **One import; moves four §8.7 rows from 4− to 4.**
5. Stale-revision guard at real Postgres — `expectedVersion` 1 vs 2.
6. Emergency classification at real Postgres, with its audit event.
7. Void → link deactivation + intent cancellation at real Postgres.
8. Uncatalogued line → confidence capped below the auto-approve floor, on disk.

**A ninth, added 2026-09-12 and arguably first — now partly landed:**
`listAllTenantIds(pool)` is extracted and proven against real Postgres, and the
fan-out harness proves the digest sweep's per-tenant contract. **Six sweeps still
stub their enumerators** and need one entry each in
`test/integration/sweep-tenant-fanout.test.ts` — see §11.0e.

### 11.0d Keeping this document honest

This document has the same failure mode as every document it replaces: it is
prose, and prose drifts. Two defences:

1. **Every rung carries its command.** A claim you cannot run is a claim you
   should not trust — including the claims here.
2. **The `S:` falsifiers are the load-bearing ones.** They are single shell
   commands whose *output is the verdict*. When one starts returning something
   different, the row is stale. The natural next step is a script that runs them
   as a batch and diffs against the expectations recorded here — the same trick
   `voice-action-catalog.contract.test.ts` plays on the capability catalog.

Until that script exists, §5, §8 and §12 are a **snapshot with a decay rate, not
a standing truth.** They were accurate on 2026-09-11.

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

### 11.0e The tenant-grade baseline, measured

The tenant grade (§8.0) is a new bar, so it is stated here with what the suite
actually meets today rather than as an aspiration. Measured 2026-09-12 over
`packages/api/test/integration/`:

| Measure | Count | Share of real-DB files |
|---|---|---|
| Integration files | 217 | — |
| …that open a real pool | 214 | — |
| …that never open a pool | **3** | — |
| Provision **≥2 tenants** | 140 | 65% |
| Carry a **cross-tenant assertion** | 120 | 56% |
| **Both** — a genuine multi-tenant proof (**T1 or better**) | **113** | **52%** |
| Assert audit through `PgAuditRepository` | 68 | 32% |

**About half the Docker-gated suite has never met a second tenant.** That is not
a claim that those capabilities leak — most are tenant-scoped by RLS, which is
itself the best-evidenced invariant in the product (I11). It is a claim about
*proof*: for ~48% of the suite, tenant correctness rests on the boundary being
right in general rather than on this capability having been watched with a
neighbour present.

#### The sharpest finding: sweeps stub the thing under test

Seven integration files inject the tenant enumerator. **Six pass exactly one
tenant id**; only `money-reconciliation.test.ts` passes two.

```
daily-digest-worker.test.ts                     listTenantIds: async () => [tenant.tenantId]
appointment-reminder-owner-push.integration.ts  listTenantIds: async () => [tenant.tenantId]
hold-reaper.test.ts                             listTenantIds: async () => [tenant.tenantId]
hfcr-weekly-send-worker.test.ts                 listTenantIds: async () => [tenantA.tenantId]
estimate-phases.test.ts                         listTenantIds: async () => [tenant.tenantId]
google-reviews-worker.test.ts                   listTenantIds: async () => [tenantA.tenantId]
money-reconciliation.test.ts                    listTenantIds: async () => [tenantA, tenantB]   ← the only one
```

In production `app.ts` supplies the real thing at **ten call sites**, each an
inlined copy of the same literal:

```js
listTenantIds: async () => {
  if (!pool) return [];
  const r = await pool.query('SELECT id FROM tenants');
  return r.rows.map((row) => row.id);
},
```

**No test exercises that selector.** This is the same shape as the defect
CLAUDE.md already records — *the entity resolver shipped with nonexistent column
names because its `Pool` was mocked* — except here what is mocked away is
multi-tenancy itself.

`daily-digest-worker.test.ts` shows the trap concretely. It creates **one**
tenant, stubs the enumerator to that id, and its *"skips a tenant whose
`digest_enabled` is false"* test toggles the flag on **the same tenant** and
re-runs. Nothing proves the sweep sends A's digest to A and B's to B, continues
to B when A throws, or honours two different `digest_time` values in one pass.

**Consequently, under §8.0's capping rules, every tenant-iterating sweep is
capped at rung 4 until T4 is earned**, and the digest (9.6), thank-you SMS (9.1),
review request (9.2), hold reaper (3.5), estimate nudge (7.10), Google review
monitoring (9.4) and weekly summary (9.7) rows are **T0 sweeps** regardless of
the rung printed beside them.

#### The fix, landed 2026-09-12

**Step 1 is done.** The fifteen inlined copies (not ten — the first count came
from a truncated listing) are now one exported, tested function,
`src/tenants/list-tenant-ids.ts`:

| Site | Was |
|---|---|
| 13 sweeps | `if (!pool) return []` + the `SELECT` + the `.map` |
| weekly-feedback | the same against its own `weeklyFeedbackPool` |
| hold reaper | an IIFE resolving once and feeding two sweeps |

All fifteen now call `listAllTenantIds(...)`; `app.ts` lost 58 lines net, with no
behaviour change, `tsc --project tsconfig.build.json` clean and the file's lint
count unchanged at 57 problems / 20 errors (all pre-existing).

`test/integration/list-all-tenant-ids.test.ts` runs the **production selector**
against real Postgres: three seeded tenants all returned, ids unique and
UUID-shaped, a tenant created between two calls visible to the second (no
caching), and no pool yielding `[]` rather than a throw. It asserts a **superset**
rather than a count — the shared container carries every other file's tenants,
and asserting a count would couple this test to unrelated files.

**Step 2 is done for the digest sweep.**
`test/integration/sweep-tenant-fanout.test.ts` drives `runDailyDigestSweep`
through the real enumerator against three divergently-configured tenants and
proves both halves of the sweep contract:

- **T3 — each tenant on its own clock.** `2026-06-11T23:05Z` is *simultaneously*
  18:05 in Chicago (CDT) and 16:05 in Phoenix (MST, no DST). A Chicago tenant at
  `digest_time 18:00` and a Phoenix tenant at `16:00` are therefore both due at
  one instant, and a third tenant with `digest_enabled = false` is not. A sweep
  assuming one shared timezone serves at most one of them — the Phoenix bug (I10)
  in sweep form.
- **T4 — one tenant's failure does not abort the rest.** With compute reads
  throwing for one tenant, that tenant gets no digest and the other two still do.
  `daily-digest-worker.ts:250` carries the comment *"Failure isolation: one
  tenant's failure never breaks the sweep"* — implemented, commented, and until
  now never proven.

**Both assertions were mutation-tested**, because a test that passes for the
wrong reason is worse than no test:

| Mutation | Result |
|---|---|
| Delete the per-tenant `catch` so the throw escapes the loop | failure-isolation test **fails** ✓ |
| Hard-code `localMinutesOfDay` to one shared timezone | **both** tests fail ✓ |

**All seven sweeps now carry fan-out coverage** — 16 tests in
`sweep-tenant-fanout.test.ts`. They are not all proven to the same depth, and
the difference matters:

| Sweep | Shape | What is proven |
|---|---|---|
| Daily digest (9.6) | enumerator | **T3 + T4** — two tenants due simultaneously on different timezones *and* different digest times, a third opted out, and a throw isolated |
| Weekly feedback (9.7) | enumerator | **T3 + T4** — each enabled tenant emailed at **its own address**, the opted-out one skipped, and a throw isolated |
| Hold reaper (3.5) | enumerator | **T4** — every tenant reached through the real selector; a throw isolated |
| Estimate nudge (7.10) | enumerator | **T4** — same |
| HFCR weekly send | enumerator | **T4** — same |
| Google reviews (9.4) | enumerator | **T4** — same |
| Thank-you SMS (9.1) | cross-tenant query | **T4** — a multi-tenant result set grouped per tenant, each handled under its own settings, a throw isolated |
| Review request (9.2) | cross-tenant query | **T4** — enqueues across tenants from one query; a throwing row does not stop the rest |

**Two sweep shapes, not one.** Thank-you SMS and review request take **no
enumerator at all** — they run one cross-tenant `SELECT`, group by tenant, and
loop. They are multi-tenant by construction, but that construction had never
been exercised with more than one tenant's rows in the result set, so nothing
proved the grouping kept tenants apart. T4 for that shape reads differently and
the tests say so.

**The four T4-only sweeps are driven through their first per-tenant seam** —
`findExpiredHolds`, `findByTenant`, `findByWeek`, `getPollState` — rather than
through fully seeded business data. That is deliberate: each sweep's own
integration test already proves what it *does* for a tenant; these prove *which
tenants it reaches*, on the real enumerator, which no other test covered. The
enumerator is never stubbed, because the enumerator is the thing under test.

**Every isolation assertion was mutation-tested.** Deleting the per-tenant
`catch` in the digest, hold-reaper, thank-you-SMS and review-request workers
each made the corresponding test fail; hard-coding a shared timezone failed both
digest tests. A fan-out test that cannot fail is worse than no fan-out test.

**Two fixture hazards the tests had to handle**, both from the shared container:

- Both cross-tenant queries select `ORDER BY completed_at ASC LIMIT 500`, so
  fixtures are dated to 2020 to sort first and stay inside the limit
  deterministically in a full-suite run.
- Those fixtures stay eligible forever unless stamped, and would leak into
  `thank-you-sms-worker.test.ts` and `review-request-sweep.test.ts`. An
  `afterAll` stamps both columns. Verified: the eleven affected integration
  files run green together, 77 tests.

#### The original argument for the fix

The inlined copies should be one exported, tested function —
`listAllTenantIds(pool)` — used at every sweep site. That converts an untested
duplicated literal into a single function a test can cover, and it is the
precondition for any T4 proof: a sweep test cannot run the production selector
while the production selector exists only as anonymous closures inside
`app.ts`. *(The original count of "ten" was itself wrong — it came from a
truncated listing. There were fifteen.)*

Order of work:

1. ~~**Extract `listAllTenantIds(pool)`**~~ — **done**, fifteen sites.
2. ~~**One shared sweep harness test**~~ — **done for all seven sweeps**, 16
   tests, every isolation assertion mutation-tested.
3. **Grade the remaining rows.** §5 and §8 carry rungs; they do not yet carry
   T-grades per row. The aggregate above is measured; the per-row grading is not
   done, and should not be asserted until it is.

> **Deliberately not claimed.** Per-row T-grades are absent from §5 and §8 on
> purpose. Publishing a grade per row without running the falsifier for that row
> would repeat the exact error this edition exists to correct — see §12.4d.

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
- **The single-shot onboarding orchestrator** — a separate, earlier extraction
  pipeline from the conversational one; zero non-test importers, and the task
  types file calls it "the dormant single-shot orchestrator" in its own comment.
  *(An earlier draft of this document listed conversational onboarding itself as
  dormant. That was wrong — inherited from a stale audit and corrected here. The
  conversational route is mounted and has a real web client.)*
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

### 12.4c Dark by default — the largest single finding

The dormant-module list above is the *unreachable* case. This is the larger and
more actionable one: **capability that is fully built, wired, and tested, and
that no default tenant will ever experience.** A dedicated sweep found it is far
more widespread than an earlier draft of this document implied. Every item below
was verified directly against code.

**Founding commitments currently dark.** Four of the fourteen, including three
that the strategy documents treat as differentiators:

| Commitment | Mechanism | Reachable? |
|---|---|---|
| #2 Digest is the dashboard | `digest_enabled` defaults false | Accepted by `PUT /api/settings` — **but no control in web or mobile writes it**, and the `/digest` page is a registered route with no nav entry |
| #12 Brand voice configurable | `brand_voice_configurator` seeded explicitly `enabled: false` | Deliberate dark-launch (the comment says so). Platform-admin API only |
| #8 Dropped call → SMS recovery | per-tenant `dropped_call_recovery` flag | **No per-tenant flag write path exists** (below) |
| #9 B2B recognition first-class | context assembled, `session.b2bAccountContext` written once, **read nowhere** | Missing wiring, not missing capability |

**The revenue cluster.** Four money-mechanics capabilities, each fully
implemented with a live consumer, each defaulting false, and **none with a single
control in web or mobile** (verified: zero UI files reference any of them):
`auto_invoice_on_completion`, `batch_invoice_enabled`, `milestone_billing_enabled`,
`bill_labor_from_time_entries`. All four *are* accepted by `PUT /api/settings`, so
this is pure missing UI — the cheapest large win in the product.

**The flag write path — corrected.** An earlier analysis claimed no flag could
ever be enabled. That is wrong, and the distinction is operationally important:

- **Platform-wide flags CAN be set in production.** The admin router is mounted,
  and its default gate lazily builds a real platform-admin checker whenever
  `DATABASE_URL` is present; it fails closed only without a database. A row in
  `platform_admins` plus `PUT /api/admin/feature-flags/:name` works today. There
  is no UI for it, but there is a path.
- **Per-tenant overrides CANNOT be set at all.** `setTenantFlag` has **zero
  callers and no route**. So any capability gated per-tenant — dropped-call
  recovery, vulnerability triage — is all-or-nothing at the platform level, with
  no ramp mechanism. That is the real structural gap.

**Settings unreachable even by API.** `updateSettingsSchema` is `.strict()`, so
a `PUT` carrying an unknown key is *rejected*, not ignored. Four settings exist
in the repository interface but not in that schema, making them settable only by
direct SQL: `speedToLeadEnabled`, `autonomousCloseEnabled`, `brandVoiceLocked`,
`weeklyFeedbackEnabled`. The last means a tenant cannot turn *off* a recurring
email the product sends them.

**Two smaller items with outsized effect**, both one-line fixes:

- **Team invitations 404.** The invite flow redirects to
  `${appBaseUrl}/accept-invitation?invitation_id=…`; that route does not exist in
  the web router. Every invitation email lands on a dead page — which means
  multi-user tenants cannot be formed.
- **Technicians are never told they were assigned a job.** The assignment
  notifier is a module-global that `app.ts` never sets, and every producer calls
  it through `instance?.notifyChange(...)` — so the optional chain makes a
  permanent no-op completely silent.

#### "Dark by default" understates three of these — they are unlit-able

A default-off flag implies someone can turn it on. For three of the items above,
and one module not previously listed, **no product surface can**:

| Capability | The blocker |
|---|---|
| Dropped-call SMS recovery | `setTenantFlag` has **zero production callers**. No route writes `tenant_feature_flags`; no web UI references the platform-admin endpoint. The only writer is SQL by hand |
| Voice vulnerability triage | Same flag mechanism, same absence |
| End-of-day digest | `digest_enabled` defaults false. The field is in the update contract, but `grep -rn "digestEnabled" packages/api/src/routes packages/web/src packages/mobile/src` returns **nothing**. The "Weekly digest" toggle in `TemplatesPage.tsx:913` is unwired local state for a different feature |
| Technician assignment notification | `setTechnicianAssignmentNotifier` has **zero callers**. The accessor is `await instance?.notifyChange(change)`, so every production assignment fires a silent no-op — while the module's own doc-comment says *"app.ts registers one notifier"* and *"Called once in app.ts."* |

Each of these is fully built and, in three cases, proven at real Postgres. What
they need is a write path, not a feature. Together they are roughly a day of
work, and they light four of the capabilities the strategy documents cite most.

The last row is also the clearest instance of §12.4d's first rule: **a
doc-comment claiming a module is wired is a claim, not a wiring.**

#### Stories that pass their rung and fail their user

Worth stating as its own list, because it is invisible in any engineering-only
view. These are rows where **the engineering is done and the user is not
served** — a different backlog from the test-writing one, much cheaper, and the
one a customer would notice first:

| Story | Rung | Why it still fails |
|---|---|---|
| **9.6** End-of-day digest | 4 | No route or UI writes `digest_enabled`. **The product's central promise cannot be switched on** |
| **2.7** Dropped-call recovery | 4 | `setTenantFlag` has zero production callers |
| **1.11** Team invites | 4 | The invite row is written perfectly and the email 404s — `/accept-invitation` has no route |
| **4.11** Technician assignment notice | 2 | Silent no-op on every assignment; doc-comment says otherwise |
| **2.12** B2B recognition | 3 | Recognised, assembled, and **never routed on** |

**Five stories where a passing rung hides a failing story.** Together they are
roughly a day of work and they light four of the capabilities the strategy
documents cite most.

### 12.4d A note on method — how four of these were got wrong

Two claims in earlier drafts of this document were false, and both failed the
same way: **they were inherited from the July state audit and repeated without
re-verification.** The review-response approval UI was said not to exist; it
does, and is rendered in the inbox. Conversational onboarding was said to have
zero clients; the route is mounted unconditionally and has a real web client.

Both were true when Part E was written. Neither was true when this document
repeated them. That is precisely the failure mode §0 claims this reconstruction
exists to prevent, and it happened anyway — which is worth stating plainly,
because it sets the correct expectation for §12 as a whole: **the gap register
is a snapshot with a decay rate, not a standing truth.** Anything in it older
than a sprint should be re-verified before it is acted on or quoted.

**Two more failed differently, and the acceptance audit caught them.** Both were
errors of *evidence*, not of currency:

- **Directory location was treated as proof.** Five rungs rested on files in
  `packages/api/test/integration/` — including a rung-5 claim on a consent write
  that is a `vi.fn()` in a file whose own header says it *"does not touch
  Postgres."* Three files in that directory never open a pool. The falsifier is
  one line:

  ```bash
  for f in packages/api/test/integration/*.test.ts; do
    grep -q "getSharedTestDb\|TEST_DB_URL\|new Pool(\|withTestDb\|testDb" "$f" || echo "NO-DB: $f"
  done
  ```

- **A mocked dependency was read as a proven one.** CLAUDE.md already states the
  rule — *"tests that mock the DB are never the only proof a query works"* — and
  it is exactly what demoted the dunning cadence, the review-gating threshold and
  the service-credit cap. The entity resolver shipped with nonexistent column
  names for this reason once already.

The general lesson is narrower than "be careful." It is that **a rung is a claim
about evidence, so it must be derived from the evidence and never from reading
the source.** Every rung in §5 and §8 now carries the command that confirms it;
a number without one should be treated as a prediction.

### 12.4e The supervisor gate is not dark — it is structurally incomplete

This is the one finding from the acceptance audit that changes a decision rather
than a score, and it is a different failure mode from §12.4c. The dark items are
built things waiting for a switch. This is a built thing that was never connected
to most of what it claims to cover.

Founding commitment #5 reads: *"a second classifier reviews **every** booking and
quote."* Three limits stack against it.

**1. Two call sites, both in one file.**

```
grep -rn "getSupervisorReviewGate()" packages/api/src
  → ai/supervisor/review-gate.ts:53      (the definition)
  → workers/voice-action-router.ts:2098  (chain head, unconditional)
  → workers/voice-action-router.ts:2490  (single action, IF status === 'ready_for_review')
```

There are **93 `createProposal(` call sites across 44 files.** Quotes minted by
MMS photo intake, by chat, by REST, by redraft and by autonomous-close are never
reviewed.

**2. The conditional site excludes the proposals that most need review.** A
low-confidence quote lands in `draft`, not `ready_for_review` — so it is skipped
*precisely because* the drafting agent was unsure.

**3. Neither mode can hold a pricing anomaly.** `DEFAULT_SUPERVISOR_REVIEW_MODE`
is `'shadow'`, where `const hold = mode === 'enforce' && harmCritical` is always
false. And `CUSTOMER_HARM_CHECKS` is `['missed_urgency', 'account_routing']` — so
even in `enforce`, a pricing anomaly on a quote **cannot hold**. That is the
exact clause the commitment names.

**Do not confuse the two supervisors.** `proposals/supervisor/hook.ts` *does* run
on every `createProposal` and is default-ON. It is an autonomy-budget policy
engine; it checks neither urgency nor pricing. Only
`ai/supervisor/review-gate.ts` is the "second classifier."

The missing proof is one test — `test/ai/supervisor/review-coverage.test.ts`,
*"every owner-dispatch chokepoint consults the supervisor review gate"* — and it
would fail today. That is the point of writing it.

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
| ~~The review-response approval UI does not exist~~ | **This was stale and is now false.** `ReviewResponseReview.tsx` is rendered in the inbox with per-component include/exclude toggles. The claim came from a July audit and this document repeated it without re-verifying — see §12.4c |
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

> **That sentence is the product's central claim, and the product cannot
> currently produce it.** An earlier draft of this section said "the product
> measures this itself." That was wrong, and the correction matters more than any
> other in this document. The north star decomposes into three parts, and **none
> of the three is instrumented**:
>
> | Part | State |
> |---|---|
> | **The baseline** (the denominator) | **Absent.** No code anywhere captures a pre-product time-diary. Onboarding captures `hourlyRateCents` — the *price* of an owner hour, not a *count* of admin hours. There is no field, no column, and no path to acquire one. |
> | **Week-8 progression and "median pilot"** | **Absent.** Nothing knows what a tenant's week 8 is; there is no tenure concept, no cohort table, and no cross-tenant aggregation of any value metric. The only trend math in the product is month-over-month job counts. |
> | **The numerator** | **A model, not a measurement.** See below. |

**What does exist** is a **time-given-back** report: a versioned lookup table of
minutes-per-action multiplied by counts of executed proposals and handled calls
— 12 minutes for a drafted estimate, 8 for a drafted invoice, 5 for a booking,
3 for a recorded payment, **0 for a clarification** — converted to dollars using
the tenant's hourly rate, returning null rather than guessing when the rate is
unset. The only measured quantities are the event counts. The hours are
`count × constant`.

Publishing the version and the credit table is therefore a requirement, not a
courtesy: **the number is a model, and a model you can't inspect is a marketing
claim.** Two limits belong with it:

- **The table covers 24 of 53 proposal types.** The other 29 silently take a
  blanket 3-minute default, including `send_estimate`, `batch_invoice`,
  `convert_lead`, `create_change_order`, and `send_payment_reminder`. More than
  half the action space is uncalibrated by construction.
- **It is never persisted.** The report is computed live per request and
  discarded. There is no weekly ledger, so a tenant's week-1 figure cannot be
  recovered later — and because the credit table is versioned and can change,
  replaying history would not reproduce it either.

**What it would take** to make the headline claim true: capture a baseline at
onboarding; persist a weekly rollup stamped with the credit version (mirroring
the pattern the hands-free-revenue metric already uses); add tenant tenure and
cohort aggregation; and close the credit-table coverage gap. Until then the
honest statement of the north star is *"a modeled estimate of hours saved,
per tenant, point-in-time"* — which is a real and useful number, and is not the
one §13 promises. See §14, O-8.

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
| **O-9** | **Does "a second classifier reviews every booking and quote" still hold, or does the commitment change?** | §12.4e: the gate reaches 2 of 93 proposal-creation sites, skips low-confidence drafts by construction, and cannot hold a pricing anomaly in any mode. Two honest resolutions exist — wire the gate at every owner-dispatch chokepoint and move `pricing_anomaly` into the harm set, or amend the commitment to name the surfaces it actually covers. **Continuing to state it as written is the one option that is not available** |
| **O-8** | **How do we measure the north star before the first pilot starts?** | §13: the baseline, the week-8 progression, and the cohort median are all absent, and the modeled numerator is never persisted. A pilot that runs without this instrumented cannot be analysed afterwards — the data simply won't exist. This is the one open decision with a **deadline attached to it**: it must be answered before a tenant goes live, not after |

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

The thirty-two recorded decisions, in one table, because the *shape* of this
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
| D-029 | A gate on an entity id must have a resolver behind it | Live — **but see §5.0a: I6 has no evidence and a test pins the opposite** |
| D-030 | Voice directs, SMS approves; v5 is canonical | Live |
| D-031 | A rung is derived from evidence, never from reading the source | Live, method |
| D-032 | Definition of done is two-dimensional — evidence class **and** tenant grade | Live, method |

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
