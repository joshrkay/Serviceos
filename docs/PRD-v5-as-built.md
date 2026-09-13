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

**A rung alone is not the definition of done.** It answers *"is this proven?"*
for one tenant. Rivet is a multi-tenant product whose isolation boundary is the
database, so the definition of done now also **requires a tenant grade T0–T4**
saying how many tenants the proof has actually met, and **the tenant grade caps
the rung** (D-032). §8.0 defines both and the capping rules.

**Where those grades stand today, stated precisely because the distinction is
the whole point of this edition:**

- The grade is **required of any new or revised requirement** — that is the
  standard from here.
- It is **measured in aggregate** for the existing suite (§11.0e), by a lexical
  scan whose figures are bounds and are labelled as such: **at least 145 of 216
  real-DB files (67%) provision ≥2 tenants.** *(An earlier edition said "52%
  carry a genuine multi-tenant proof." That figure is withdrawn — §11.0e
  explains why it could not be re-derived.)*
- It is **published per row only where it was actually earned** — today the
  seven sweep-backed rows (covered by eight sweep workers), graded and
  mutation-tested in §11.0e, and **the 26 §5 rows**, graded by the 2026-09-12
  entry audit (map ticket #1005): I1, I5, I11, I14 at **T1**; I4, I10, I12, I17
  real-DB but **T0** and therefore capped at 3; the rest structural or in-memory
  (grade n/a).
  **And the 26 §8.1/§8.5/§8.6 rows** (map ticket #1006): T1 — 1.7, 1.9, 1.10, 5.3,
  5.4, 6.3–6.7, 6.9; T0 — 1.1, 1.2, 1.3, 1.4, 1.8, 1.11, 6.2 (capped at 3); two rows
  have no command at all (1.5, 5.1).
  **And the 24 §8.2/§8.3 rows** (map ticket #1007): T2 — 3.2; T4 — 3.5; T1 — 2.7,
  2.10, 3.7, 3.10 (move/cancel); T0 — 2.1, 2.3, 2.8, 3.1, 3.6, 3.9, 3.10 (book).
  **And the 23 §8.4/§8.7 rows** (map ticket #1008): T1 — 4.1, 4.4, 4.5, 7.1, 7.3,
  7.10 (also T4); T0 — 4.8, 7.2, 7.4, 7.5, 7.6, 7.8, 7.9.
  **And the 25 §8.8/§8.9 rows** (map ticket #1009): T3·T4 — 9.6, 9.7; T4 — 9.1,
  9.2, 9.4; T1 — 8.1, 8.3, 8.5 (ACH), 8.8, 8.9, 8.10, 9.3, 9.8, 9.9, 9.12; T0 — 8.4,
  8.6, 9.10, 9.11. **Every §5 and §8 row is now graded.**
- **Every other row in §5 and §8 is ungraded**, and its printed rung should be
  read as un-capped and therefore provisional. The scan behind the aggregate is
  a keyword heuristic: sound across the suite's 219 files, not sound row by row. Publishing
  a guessed grade would repeat the exact error this edition exists to correct
  (§12.4d), so the rows say nothing rather than something unverified.

So: **do not apply the capping rules to an ungraded row** — there is no grade to
apply yet. Grading the remainder is tracked as the open item in §11.0e.


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

**Five of eighteen clear the real-Postgres-with-a-neighbour or structural-guard bar after the 2026-09-12 entry audit (I1, I5, I11, I14, I15). Seven more were printed at 4 and sit at 3 until graded up: four real-Postgres proofs that never met a second tenant (I4, I10, I12, I17 — T0, capped by D-032), two contract tests with no negative control (I7, I16), one unit-only fuzz (I9). I3′ gained a unit pin and rose to 3. Six
sub-clauses carry a universal quantifier nothing proves. One has no enforcement
at all.**

| # | The law, and the story behind it | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **I1** | **The AI never writes to an operational entity.** It drafts a typed proposal; a deterministic handler executes after approval (D-004). · *As M, I want the AI to never write to my records directly, only propose, so nothing happens without me* | **Given** a drafted proposal, **then** **zero** rows exist in the target table; after approval, exactly one row **and** its audit event | 4 | **D:** `integration/create-job-execution.test.ts` · **G1 2026-09-12:** PROVEN-REAL-DB, **T1** (`create-job-execution.test.ts:144` "does not expose the job to another tenant"), 3/3 ✓ |
| **I1′** | *…and I want that true of **every** path, not just the ones someone tested* | **Given** any AI module, **then** it cannot call a repository write | **2** 🚨 NOT HELD — guarded | **CODE-ONLY** — no lint rule, no import guard. Per-path D-004 pins exist. *A tested behaviour, not an enforced invariant* · **G1 2026-09-12:** CODE-ONLY confirmed — no ESLint config under `packages/api`, no `no-restricted-imports`/`no-restricted-paths` rule anywhere in the repo · **#1021 2026-09-12:** STRUCTURAL guard `test/invariants/i1-no-ai-repository-writes.structural.test.ts` enumerates every repository write under `src/ai` and classifies each (AI-plane: `auditRepo`, `proposalRepo`, `aiRunRepo`, `diffRepository`, `invoiceRevisionRepo`, `sessionRepo`, `smsEventRepo`; harness: `ai/voice-quality/**`); negative control — a planted `customerRepo.create` under `src/ai` fails the build, a comment-only occurrence does not. **The universal does not hold:** five operational writes are frozen as a baseline (`find-or-create-customer.ts:116`, `find-or-create-lead.ts:122`, `patch-owner-through.ts:238`, `create-voice-turn-processor.ts:2474` and `:2639` — the E1 revoke cancels a held appointment with no proposal) and an `it.fails` states I1′ as written → issue **#1066**. `cd packages/api && npx vitest run test/invariants/i1-no-ai-repository-writes.structural.test.ts` → 6/6 ✓ + 1 expected fail. Enforced from here on (a sixth site breaks the build); the row moves to 4 the day the `it.fails` passes (PR #1063) · **#1021 rounds 2–5 (batch 3):** the guard widened (bare `repository` receivers, custom mutation verbs, read-prefixed writes) and found a **sixth** site — `ai/tasks/estimate-template.ts:97` mints a priced tenant template with no proposal (#1066). Counts are **floors**: these guards are detectors with known false-negative ceilings, not proofs of absence |
| **I2** | **No `system:` actor may ever approve a proposal** (D-019) — a structural guard in the single lifecycle transition seam, so the rule survives future callers. · *As M, I want no automated actor able to approve on my behalf, so "approved" always means a human did it* | **Given** any starting status, **when** a `system:` actor attempts `approved`, **then** it throws `ForbiddenError` | **4** ↑ (T1) | **U:** `proposals/lifecycle.test.ts`. 🚨 *In-memory objects only; **zero** integration tests attempt a `system:` approval* · **G1 2026-09-12:** PROVEN-UNIT, 28/28 ✓, T0 · **#1020 2026-09-12:** D: `integration/proposal-approval-system-actor.test.ts` — a `system:` actor attempting `approved` from all 9 `ProposalStatus` values throws `ForbiddenError` at the real `approveProposal`→`transitionProposal` seam (`proposals/actions.ts:301` → `lifecycle.ts:142`); proposal row unchanged via `PgProposalRepository.findById`, zero audit rows via `PgAuditRepository.findByEntity`; a human approval writes `proposal.approved`, read back; second tenant untouched; `ALL_STATUSES` is derived from an exhaustive `Record<ProposalStatus, true>` literal (added after Codex flagged the plain array as non-exhaustive). `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/proposal-approval-system-actor.test.ts` → 12/12 ✓ (RED first: expected 1 audit row, got 0). PROVEN-REAL-DB, T1 → **4** (PR #1049) |
| **I3** | **Approval is a human control act** (D-025). Owner voice approval on a verified owner line; money and irreversible classes additionally require a spoken challenge, capped at three failures then locked. · *As M, I want spoken approval of money to require a challenge, so a stranger with my phone can't approve a refund* | **Given** three wrong codes in one session — **including across a cancelled and restarted dialogue** — **then** the session locks for money/irreversible while capture-class still approves | **4** ↑ (T1) | **U:** `ai/tasks/proposal-approval-task.test.ts`, `telephony/voice-approval-gather.test.ts` · **G1 2026-09-12:** PROVEN-UNIT, 65/65 + 9/9 ✓, T0; rung 5 parked on O-4/O-6 · **#1020 2026-09-12:** D: `integration/i3-voice-approval-challenge-lock.test.ts` — three wrong codes lock money approval at the real `startVoiceApproval`/`continueVoiceApproval` seam; the counter is session-level so the lock holds across a cancelled-and-restarted dialogue; capture-class still approves while locked; every attempt's row (`challenge_failed` ×3 → `voice_challenge_lockout`) read back via `PgAuditRepository.findByEntity`; PIN through the WS21a hashed path in `tenant_settings`; T1 both directions (tenant A's PIN does not open tenant B's challenge). `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/i3-voice-approval-challenge-lock.test.ts` → 4/4 ✓ + 1 expected fail. PROVEN-REAL-DB, T1 → **4**; rung 5 stays parked on O-4/O-6. **Product gap, `it.fails`, issue #1051:** the lockout lives only on the in-process voice-session Map — a session rebuilt from the store re-prompts with the counter at zero although the three failures sit in `audit_events` (PR #1050) |
| **I3′** | *…and I want the readback composed from the proposal, never from what I just said* | **Given** an approval readback, **then** its text derives from the payload, not the utterance | **4** ↑ (T1) | **U:** `ai/tasks/proposal-approval-task.test.ts` — *RV-071 — readback is composed from the proposal payload* ("contains the payload customer name and amount"; "composeReadback is a pure function of payload fields"). **G1 2026-09-12:** the earlier "no provenance assertion exists" was wrong — PROVEN-UNIT, T0; 4 needs the readback asserted on a persisted proposal at real Postgres · **#1021 2026-09-12:** D: `integration/i3-readback-provenance.test.ts` — the proposal payload survives the Postgres round trip through `PgProposalRepository`, four contradicting utterances ("raman … two million for Marcus Johnson", an injection) yield ONE readback drawn from the persisted row (`Estimate for Priya Raman, 2 line items, total $425.00`), the persisted-row readback equals `composeReadback` of the row re-read from Postgres, a neighbour tenant's decoy proposal (Marcus Johnson, $2,000,000) is invisible; negative control — an utterance-echoing builder fails the same assertions. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/i3-readback-provenance.test.ts` → 7/7 ✓. PROVEN-REAL-DB + STRUCTURAL, T1 → **4** (PR #1063) |
| **I4** | **An AI-emitted price is never authoritative.** A pure, deterministic, LLM-free catalog resolver ahead of proposal creation; uncatalogued lines force review through a flag a tenant cannot override. · *As M, I want an AI-invented price to never be authoritative, so my catalog is the only source of truth* | **Given** one uncatalogued line, **then** `requiresReview === true` regardless of tenant settings or confidence, and `pricing_source` is CHECK-constrained on disk | **4** ↑ (T1) | **U:** `ai/resolution/catalog-resolver.test.ts` · **D:** `integration/invoice-pricing-source.test.ts` · **G1 2026-09-12:** 84/84 + 7/7 ✓ — PROVEN-REAL-DB by class, but `invoice-pricing-source.test.ts` never provisions a neighbour (`grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant"` → no match): **T0**, so 4 is not earned under D-032 (rung 4 requires T1). One added tenant plus one isolation assertion restores 4 · **#1020 2026-09-12:** neighbour tenant added to `invoice-pricing-source.test.ts` — its `catalog`-sourced invoice is unreachable via `PgInvoiceRepository.findById` from the first tenant and its `invoice_line_items.pricing_source` rows never appear in a tenant-scoped query. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/invoice-pricing-source.test.ts` → 8/8 ✓ (RED: expected non-null, got null). T1 restores **4** (PR #1049) |
| **I5** | **Ambiguity becomes a clarification, never a silent guess** — on every surface, in that surface's own idiom (D-029). · *As M, I want it to ask instead of guessing, so it never acts on the wrong customer* | **Given** two same-named customers, **then** **exactly one** question is asked and no id persists until a follow-up names a candidate | 4 | **D:** `integration/chat-entity-resolution.test.ts` · **G1 2026-09-12:** PROVEN-REAL-DB, **T1** (`:584` "is tenant-scoped: another tenant's lead is invisible"), 20/20 ✓ |
| **I5′** | *…through one shared matcher, so the surfaces cannot drift* | **Given** the shared disambiguation matcher and any surface gate in front of it, **then** (a) every ordinal form the matcher places, the gate accepts; (b) every answer-shaped turn the matcher places, the gate accepts; (c) every turn the matcher places and the gate rejects matches a **named, documented** request shape; and (d) every turn the gate accepts and the matcher cannot place returns `unmatched`, never a candidate. **When** a divergence appears that no named shape explains, **then** the build fails. *(Re-specced 2026-09-12 on #1021 with Fable's sign-off; was: "Given one disambiguation matcher, when surfaces diverge, then the build fails" — false as written, see the note.)* | **4** ↑ CHANGED | **FALSE AS WRITTEN.** A second, deliberately broader gate exists (`gated-reference-resolution.ts:602`) whose own comment says it *"is allowed to be slightly BROADER than the matcher behind it."* Nothing fails if they drift · **G1 2026-09-12:** the quoted comment is at `gated-reference-resolution.ts:595`, confirmed · **#1021 2026-09-12 (Fable sign-off):** *one shared matcher* is false as written and the bare containment (gate ⊇ matcher) is false too — the chat gate `gated-reference-resolution.ts:602` is deliberately **broader on answers and narrower on three named request shapes** (the hijack it closes: "Send an invoice to Johnson Plumbing for $400" contains a candidate label). The criterion is re-specced (left) as the four-clause relationship and pinned by `test/invariants/i5-disambiguation-gate-containment.structural.test.ts` over 43 utterances × 2 fixtures: C0 the two ordinal vocabularies are in step, C1 every answer the matcher places the gate accepts, C2 every divergence is one of three named hijack shapes and the set is non-empty, C3 gate-accepted/matcher-unplaced turns return `unmatched`; negative controls — a gate narrowed to drop ordinals, a matcher grown a new ordinal, a gate widened to accept requests (reproduces the hijack) all fail. `cd packages/api && npx vitest run test/invariants/i5-disambiguation-gate-containment.structural.test.ts` → 9/9 ✓. STRUCTURAL → **4**; collapsing the pair is map #962's work (PR #1063) |
| **I6** | **A gate on an entity id must have a resolver behind it** (D-029). A gate nothing can lift is a capability that can never be approved (#909). · *As M, I want every question it asks me to be answerable, so it never blocks on something I can't resolve* | **Given** any entity-id gate a proposal contract can emit, **then** it is a key of `GATED_REFERENCE_SOURCES` | **2** 🚨 NOT HELD — guarded | **NO EVIDENCE** — and a test pins the **opposite** as supported: an unresolvable gate is a legal state (`gated-reference-resolution.test.ts`, the case titled *"leaves gates it does not know how to resolve strictly alone"* — **G1 2026-09-12:** the earlier ":115" citation and its quoted phrase do not exist in the file; the pin is real, the citation was not). **Both cannot be true. The weakest invariant in the table** · **G1 2026-09-12:** NO EVIDENCE confirmed; 82/82 ✓ on the opposite · **#1021 2026-09-12 (Fable):** the contradiction is resolved — **the PRD's reading was wrong, not the code or the test.** D-029 rule 1 scopes the invariant to gates *on an entity id*; D-029's Constraints paragraph (`docs/decisions.md:820`) itself says a parsed time or a path-shaped catalog gate is *left strictly alone*; the cited test pins that scope, not "an unliftable gate is legal"; #909's remedy was to add `leadId` to the table, never to accept the stall. STRUCTURAL guard `test/invariants/i6-entity-id-gate-has-resolver.structural.test.ts` derives every emittable entity-id gate by parsing an empty payload against every schema in `PROPOSAL_TYPE_SCHEMAS` (the same computation `contractGapFields` performs) plus a `missingFields` literal sweep, decides entity-id mechanically (uuid-typed `*Id`), and requires a key of `GATED_REFERENCE_SOURCES` or a documented exception naming its lifter (`locationId` → the review card; `lineItems[].catalogItemId` and `editActions[].lineItem.catalogItemId` → the pre-draft catalog resolver); negative controls — a planted contract gate and a planted literal fail, a comment-only key does not, removing a resolver surfaces its gates. **Three gates have no lifter** (`reviewId`, `entityId`, `groundedProposalId` — system-supplied ids) → issue **#1067**; `it.fails` of I6 as written. `cd packages/api && npx vitest run test/invariants/i6-entity-id-gate-has-resolver.structural.test.ts` → 12/12 ✓ + 1 expected fail. Enforced; moves to 4 when #1067 closes (PR #1063) · **#1021 rounds 2–5 (batch 3):** a **fourth** unliftable gate — `linkedJobId` (`proposals/contracts.ts:276`), a malformed chained-booking reference the resolver cannot lift (#1067); the derivation now handles optional uuid fields and root-refinement fallbacks. Counts are floors |
| **I7** | **The AI never discounts, never commits scope, never promises a human.** Deterministic negotiation guardrail; discount policy fails closed at zero. · *As M, I want it to never give away my margin* | **Given** no configured discount policy, **then** zero concession on every ask — **and no registered proposal type can even express an AI-applied discount** | **4** ↑ | **U:** `proposals/guardrails/negotiation-invariant.test.ts`, `discount-evaluator.test.ts` — *a type-level impossibility proof, not a behaviour sample* · **G1 2026-09-12:** 3/3 + 34/34 ✓, but §8.0's STRUCTURAL requires a **negative control** and `negotiation-invariant.test.ts` plants none — it asserts the registry holds no such type, and nothing shows the assertion would fail if one were added. PROVEN-UNIT until a planted-type case exists · **#1021 2026-09-12:** the missing negative control — `discountShapedTypes(types)` extracted from the live assertion in `test/proposals/guardrails/negotiation-invariant.test.ts` and run over a registry copy carrying a planted `apply_ai_discount`, over the forbidden vocabulary (`haggle_with_customer`, `negotiate_price`, `AUTO_DISCOUNT` — case-insensitive), and over the real registry with a non-triviality floor. `npx vitest run test/proposals/guardrails/negotiation-invariant.test.ts` → ✓ (25/25 across the three I7/I16 files). STRUCTURAL with a genuine negative control → **4** (PR #1063) · **#1021 round 3 (batch 3), Fable reading:** the criterion's *no registered proposal type can express an AI-applied discount* needs one word read carefully — `apply_credit` and `record_refund` ARE registered, AI-reachable proposal types; they express AI-**proposed** concessions, money-class, gated by the human approval rail (I3, D-025). What I7 forbids is an AI-**applied** concession, and no type expresses that; the guard pins the discount/haggle/negotiate vocabulary and the money rail pins the rest. 4 stands with that reading |
| **I8** | **Safety escalation beats containment** (D-027). Deterministic emergency detection ahead of the classifier. · *As J, I want safety to beat every other consideration, so containment never wins over a life* | **Given** a tier-1 phrase, **then** E1 **with no rules loaded**, and complaint escalation fires from **every** live FSM state | **4** ↑ (T1) | **U:** `emergency-tier.test.ts`, `emergency-tier-transitions.test.ts`, `complaint-guardrail.test.ts` · **G1 2026-09-12:** PROVEN-UNIT, 57/57 + 13/13 + 5/5 ✓, T0 · **#1020 2026-09-12:** D: `integration/e1-complaint-guardrail-audit.test.ts` — `classifyCallerSafety` with no rules loaded classifies E1 and the real `VoiceTurnProcessor.executeSideEffects` (what `twilio-adapter.ts:1581` `runEmergencyScan` drives) writes `agent.calling.<state>.emergency_detected` to Postgres; complaint escalation fires the global guard from all 11 live FSM states (an exhaustive `Record<CallingAgentState, true>`-derived list, catching the `entity_confirm`/`idle`/`degraded` gap a later Codex round found in the original 8-state array), one `complaint_guardrail` row each, read back via `PgAuditRepository.findByEntity`; E1 script text untouched (O-2); second tenant's trail empty. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/e1-complaint-guardrail-audit.test.ts` → 4/4 ✓. The audit row is the invariant's only durable effect (E1 never books), so PROVEN-REAL-DB with proposal/voice-session deps left in-memory. T1 → **4** (PR #1049) |
| **I8′** | *…and I want no setting anywhere able to switch that off, so a misconfiguration can't be fatal* | **Given** any tenant configuration, **then** safety cannot be suppressed | **4** ↑ | **NO EVIDENCE.** Rests on the *absence* of a parameter, which nothing pins. A future flag would break it silently · **G1 2026-09-12:** confirmed — the tier classifier reads no `process.env`, settings or flag (two comment mentions only); the absence holds and nothing pins it · **#1021 2026-09-12:** STRUCTURAL guard `test/invariants/i8-safety-reads-no-tenant-flag.structural.test.ts` walks the import closure of the emergency-tier path (7 files, membership pinned so a new import into the safety path is itself reviewed) and forbids any settings-repository, tenant-config, feature-flag or `process.env` read except one named logging exception (`classify-urgency-tier.ts:62`, asserted to still be that line); negative controls — a planted tenant suppression switch, env switch, feature-flag read and new import all fail; a comment-only read does not. **The absence holds.** `cd packages/api && npx vitest run test/invariants/i8-safety-reads-no-tenant-flag.structural.test.ts` → 10/10 ✓. STRUCTURAL → **4** (PR #1063) |
| **I9** | **All money is integer cents**, end to end, with one shared engine and **one** percent-of-money helper so rounding cannot drift (D-003). · *As M, I want the arithmetic exactly right, so I never have to explain a penny* | **Given** ≥1000 randomized documents, **then** every money field is an integer and totals never go negative; `createInvoice` persists the server total, **discarding the client's** | **4** ↑ (T1) | **U:** `shared/billing-engine.property.test.ts`, `line-item-normalization.test.ts` · **G1 2026-09-12:** 4/4 + 7/7 ✓ — a seeded-PRNG fuzz over the pure engine in the unit lane; the "`createInvoice` persists the server total, discarding the client's" clause has no real-DB proof here (§8.8 row 8.13 says the same). PROVEN-UNIT · **#1020 2026-09-12:** D: `integration/invoice-server-total-persisted.test.ts` — `createInvoice` with the P0-2 shape (`quantity 0.5 × 29¢`, client says 14) persists **15** on `invoice_line_items.total_cents` and `invoices.total_cents`/`amount_due_cents`, read back by raw SQL and a fresh `PgInvoiceRepository`; second tenant's correct 10000 untouched. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/invoice-server-total-persisted.test.ts` → 2/2 ✓ (RED: expected 14, got 15). The create contract has no document-level client total, so the per-line discard is the whole clause; the fuzz half stays a unit proof of the pure engine. PROVEN-REAL-DB, T1 → **4** (PR #1049) |
| **I9′** | *…from one engine as the only source of totals math* | **Given** any module, **then** it cannot compute document totals itself | **2** 🚨 NOT HELD — guarded | **CODE-ONLY** — nothing forbids it · **G1 2026-09-12:** CODE-ONLY confirmed — 20+ modules outside `billing-engine` assign `totalCents` (`app.ts`, `invoices/*`, `estimates/*`, …); nothing forbids it · **#1021 2026-09-12:** STRUCTURAL guard `test/invariants/i9-one-totals-engine.structural.test.ts` sweeps four arithmetic shapes outside `shared/billing-engine.ts` and requires every hit classified (engine / harness / cross-document aggregate with reason / violation); negative controls — a planted subtotal, `quantity * unitPriceCents`, percent-of-money and document-total expression all fail, a comment-only occurrence does not. **Three second implementations exist:** `proposals/estimate-editor.ts:33` `calculateEstimateTotal` returns **14.5** for `0.5 × 29¢` (non-integer cents, proven numerically against the engine; zero callers), `proposals/execution/handlers.ts:838` duplicates `calculateLineItemTotal`, `routes/invoices.ts:178` computes the member-discount base by hand → issue **#1064**; `it.fails` of I9′ as written. `cd packages/api && npx vitest run test/invariants/i9-one-totals-engine.structural.test.ts` → 10/10 ✓ + 1 expected fail. Enforced; moves to 4 when #1064 closes (PR #1063) · **#1021 rounds 2–5 (batch 3):** the sweep now catches commuted multiplication and wrapped reducers and the floor is **≥ 9** second implementations, including two that matter to customers — the SPOKEN quote total recomputed unrounded (`ai/voice-turn/quote-readback.ts:82`, `create-voice-turn-processor.ts:432`; what the owner hears need not equal the persisted total) and `routes/estimates.ts:239`, the same member-discount subtotal as `routes/invoices.ts:178` over a **different base** (#1064). Counts are floors |
| **I10** | **All times stored UTC, rendered in the tenant's timezone.** An unset zone makes booking **refuse** — a Phoenix mis-booking postmortem removed the column default. · *As M (Phoenix), I want a missing timezone to refuse, not guess* | **Given** no configured zone, **then** the draft has no window, approval **refuses**, and **zero** appointment rows exist | **4** ↑ (T3) | **D:** `integration/live-call-booking-timezone.test.ts` · **G1 2026-09-12:** 2/2 ✓, PROVEN-REAL-DB by class, **T0** — one tenant, one zone (grep → no match). A second tenant on a different zone in the same run earns T3 and restores 4 · **#1020 2026-09-12:** `live-call-booking-timezone.test.ts` — an America/Chicago and an America/Los_Angeles tenant book the identical spoken phrase in one run and persist `2027-08-20 19:00Z` vs `21:00Z` in `appointments.scheduled_start`; neither reads the other's appointment; each execution's real `proposal.executed` audit row (from `ProposalExecutor`, already wired with a real `PgAuditRepository`) is now asserted via `PgAuditRepository.findByEntity`, and neither tenant's audit query sees the other's row — closing the write-only gap Codex flagged. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/live-call-booking-timezone.test.ts` → 3/3 ✓ (RED: expected 22:00Z, got 21:00Z; RED again on the added audit assertion: expected false, got true). Two zones in one run = T3, restores **4**; the second tenant is named `losAngeles`, the test title carries `cross-tenant` (PR #1049) |
| **I11** | **Every entity carries `tenant_id`; RLS is FORCED at the database**, under a dedicated non-bypassing role the server refuses to boot without in production. The database, not application code, is the isolation boundary. · *As M, I want my data mine at the database, so a code bug can't leak it* | **Given** every `tenant_id` table, **then** RLS is **enabled and forced** with exactly two documented exemptions — and production **refuses to boot** without the role | 4 | **D:** `integration/rls-force-catalog.test.ts`, `rls-runtime-audit.test.ts`, `rls-runtime-role.test.ts` — **the best-evidenced invariant in the product** · **G1 2026-09-12:** PROVEN-REAL-DB, **T1** (`rls-runtime-audit.test.ts:122` cross-tenant SELECT returns zero rows; `rls-runtime-role` provisions 12 tenants), 4/4 + 4/4 + 7/7 ✓ |
| **I12** | **Every mutation emits an audit event** attributable to actor id, role and channel. **Two tiers, and they are not the same strength — see §5.0b.** · *As M, I want every change to leave a trail I can audit* | **Tier 1: Given** an execution, **when** the audit insert fails, **then** the **whole unit rolls back** — no state change without its audit row | **4** ↑ (T1) | **D:** `integration/executor-audit-atomicity.test.ts` (both directions) · **G1 2026-09-12:** 3/3 ✓ both directions; three tenants provisioned but **no cross-tenant assertion** (grep → no match): **T0**. One isolation assertion restores 4 · **#1020 2026-09-12:** `executor-audit-atomicity.test.ts` — tenant A's audit-insert failure rolls back (zero customers, zero audit rows, proposal still `approved`) concurrently with tenant B's execution committing (`executed`, customer row + `proposal.executed`); neither tenant's audit query sees the other's row. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/executor-audit-atomicity.test.ts` → 4/4 ✓ (RED: expected `execution_failed`, got `executed`). T1 restores **4** (PR #1049) |
| **I12′** | *Tier 2 — handler domain audit, best-effort* | **Given** a handler whose `auditRepo.create` throws, **then** it still succeeds with its mutation committed | **4** ↑ (T1) 🚨 | **U:** `proposals/callback-handler.test.ts` — **one handler family only**, ~40 swallow sites untested, and no real-DB test of the §5.0b outage consequence · **G1 2026-09-12:** PROVEN-UNIT, 10/10 ✓ · **#1020 2026-09-12:** D: `integration/i12-prime-tier2-audit-best-effort.test.ts` — a real `PgAuditRepository` wrapped to throw only on `callback.acknowledged` (`callback-handler.ts:113`, swallow at `:123`): the execution commits (`status=executed`, idempotency record) and the tier-1 `proposal.executed` row lands while the tier-2 domain row is absent, pinned via `findByEntity` and a direct `SELECT event_type FROM audit_events`; healthy control and a healthy second tenant keep both tiers. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/i12-prime-tier2-audit-best-effort.test.ts` → 3/3 ✓. PROVEN-REAL-DB for the callback family, T1 → **4**; 🚨 kept — measured **8** handlers in `proposals/execution/` carry the swallow (not ~40), 7 remain untested at real DB and the money-handler half of the ask is open: issue #1052 (PR #1050) |
| **I13** | **Caller speech is untrusted data for its whole lifetime** — including when read back to the operator hours later. · *As M, I want nobody able to talk the AI into doing something later* | **Given** a transcript containing fence-marker lookalikes, **then** marker counts are exactly 1 each and the caller block sits in the lowest-authority slot | **4** ↑ (T1) | **U:** `ai/untrusted-content.test.ts`, `customer-calling/untrusted-content.test.ts`, `i13-provenance.test.ts` · **G1 2026-09-12:** PROVEN-UNIT, 4/4 + 19/19 + 7/7 ✓ (`ai/untrusted-content.test.ts` and the customer-calling copy are distinct files) · **#1020 2026-09-12:** D: `integration/i13-provenance-real-store.test.ts` — a transcript with an injected instruction and a forged END-marker persisted via `PgVoiceSessionRepository.markEnded`, read back through a brand-new repository instance: BEGIN/END + hardening line present, the dangerous line verbatim inside the fence, the lookalike neutralised to `[fence-marker]` (exactly one real END), `contentProvenance='untrusted'` survives; second tenant's session unstamped, cross-tenant `findById` null. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/i13-provenance-real-store.test.ts` → 2/2 ✓ (two real CHECK-constraint REDs on the fixture first — `channel`, `outcome` enums). PROVEN-REAL-DB, T1 → **4** (PR #1049) |
| **I13′** | *…in **every** operator-facing model context* | **Given** any operator-facing prompt, **then** caller text is fenced | **2** 🚨 NOT HELD — guarded | **CODE-ONLY** — the fence helper is called from a few files (`telephony/twilio-adapter.ts`, `voice/voice-session.ts` by file grep; the first edition's "exactly three" was not re-derived); a new prompt inlining a transcript passes CI · **G1 2026-09-12:** CODE-ONLY confirmed · **#1021 2026-09-12:** STRUCTURAL guard `test/invariants/i13-operator-prompt-fencing.structural.test.ts` — clause A: every prompt consumer of `recentMessages`/`retrievedChunks` outside `context-builder.ts` goes through a sanctioned renderer or the fence (holds); clause B: all 23 prompt-assembling modules naming caller text are classified with a reason (fenced / owner-authored / harness / plumbing / violation); negative controls — a planted hand-rolled thread prompt fails and passes once it uses the renderer, a planted unclassified builder fails, a comment-only mention does not. **One unfenced site:** `workers/transcription.ts:241` interpolates the raw caller transcript into a `user` message with no fence and stores the corrected output as the transcript → issue **#1065**; `it.fails` of I13′ as written. Scope limit stated: a prompt built in one module and sent by another (`app.ts` → `classifyTurnSentiment`) needs a data-flow pass. `cd packages/api && npx vitest run test/invariants/i13-operator-prompt-fencing.structural.test.ts` → 10/10 ✓ + 1 expected fail. Enforced; moves to 4 when #1065 closes (PR #1063) · **#1021 rounds 2–5 (batch 3):** the guard now also catches an imported-but-unused renderer and one-of-two channels; the floor stays at 1 unfenced site (#1065); a prompt built in one module and sent by another still needs a data-flow pass |
| **I14** | **A revocation of contact consent blocks every channel; a grant never crosses channels** (D-017), on an append-only ledger behind both outbound gates. · *As a customer, I want "STOP" to stop everything* | **Given** an SMS `STOP`, **then** an outbound **call** is blocked even while `consent_status` reads granted; **given** `START`, **then** SMS restores and the voice rollup stays revoked | 4 | **D:** `integration/consent-cross-channel.test.ts`, `stop-reply-unify.test.ts` · **G1 2026-09-12:** PROVEN-REAL-DB, **T1** (`stop-reply-unify.test.ts:102` "does not roll up consent onto another tenant sharing the number"), 6/6 + 3/3 ✓ |
| **I15** | **All LLM calls route through one gateway** (D-005). No module outside it may import a provider SDK. · *As M, I want every AI call through one place, so cost, retries and the audit trail can't be bypassed* | **Given** the clean tree, **then** the guard exits 0; **given** a planted offending file, **then** it exits non-zero | 4 | **STRUCTURAL with a genuine negative control.** **U:** `ai/gateway-ci-guard.test.ts`. *Scope caveat: OpenAI-specific — an `@anthropic-ai/sdk` import would pass it* · **G1 2026-09-12:** STRUCTURAL confirmed — planted `new OpenAI(` and `client.chat.completions.create` files make the guard exit non-zero, 4/4 ✓ · **#1021 2026-09-12:** scope caveat reproduced then closed — the shell guard passed a planted `@anthropic-ai/sdk` import (its patterns are three OpenAI strings); `test/ai/gateway-ci-guard.test.ts` now also carries a vitest structural guard over 22 provider SDK specifiers, per-vendor client shapes and direct provider HTTP endpoints; negative controls — planted `@anthropic-ai/sdk`, every listed vendor, an SDK-free `fetch` to a provider endpoint all fail; a relative `../ai/…` import is not mistaken for the `ai` package. Speech (`/v1/audio/`) is excluded by path — three call sites pinned by name — pending the decision whether TTS/STT spend rides the gateway rail → issue **#1068**. `npx vitest run test/ai/gateway-ci-guard.test.ts` → 13/13 ✓. 4 holds, caveat closed (PR #1063) |
| **I16** | **A capability's surface coverage is declared, not accidental.** Undeclared (capability × surface) cells fail a structural test; refusals happen on purpose and silence is impossible. · *As M, I want behaviour on each surface declared, so nothing is silently missing* | **Given** 11 families × 4 surfaces, **then** every cell is declared with no unknown keys — **and** every handler in the shared drafting registry is reachable or in a declared exception set on both voice/memo and chat | **4** ↑ | **U:** `ai/voice-turn/coverage-table.structural.test.ts`, `proposals/drafting-surface-parity.test.ts`. *The coverage table is inert at runtime; **cite `drafting-surface-parity` when defending this*** · **G1 2026-09-12:** 3/3 + 8/8 ✓, but neither file plants a violation (the parity audit's "not vacuously green" check guards vacuity, not drift) — PROVEN-UNIT until a negative control exists · **#1021 2026-09-12:** the missing negative controls — `undeclaredCells` (coverage table) pointed at a table with a cell removed, a family dropped and a new live surface declared nowhere; `silentChatHandlers` / `intentsWithNoChatDisposition` (drafting parity) pointed at an unwired handler, a renamed map key and a new intent with no chat disposition, then shown to clear once the intent is declared. Plants go into copies of the registries, never the live ones. `npx vitest run test/ai/voice-turn/coverage-table.structural.test.ts test/proposals/drafting-surface-parity.test.ts` → ✓ (25/25 with I7). STRUCTURAL with genuine negative controls → **4** (PR #1063) |
| **I17** | **Auto-approval is a scoped, opt-in, reversible exception — never a posture** (D-015): two capture-class types, default OFF, stricter floor, kill switch, one-tap UNDO, digest visibility. · *As M, I want "AI books it" to never become "AI runs it"* | **Given** a fresh tenant, **then** the lane is off at 0.95; a raw SQL drop to 0.80 is **refused by a DB CHECK**; and the lane is ineligible for each of 19 single-gate mutations, with the platform kill switch outranking tenant opt-in | **4** ↑ (T1) | **D:** `integration/settings-autonomous-booking.test.ts` · **U:** `proposals/autonomous-lane.test.ts`, `one-tap-undo.test.ts` · **G1 2026-09-12:** 4/4 + 33/33 + 9/9 ✓; `settings-autonomous-booking.test.ts` is single-tenant (grep → no match): **T0**; one neighbour restores 4 · **#1020 2026-09-12:** `settings-autonomous-booking.test.ts` — "Neighbour Co" stays `enabled=f, threshold=0.95` while "Opted-In Co" opts in at 0.98, pinned via `PgSettingsRepository.findByTenant` and the raw `tenant_settings` columns. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/settings-autonomous-booking.test.ts` → 5/5 ✓. Harness note: a raw `pool.connect()` client bypasses RLS unless it `SET ROLE rls_app_runtime`, so the isolation assertion runs through the repository's tenant-scoped query, not raw row-invisibility. T1 restores **4** (PR #1049) |
| **I18** | **No feature ships that adds admin work to the owner's day** — the litmus test, and the reason seven planned v1 phases were cut (D-011). · *As M, this is the entire reason I bought this* | **Given** any owner-role action required on a normal day, **then** it is reachable by SMS, one-tap or voice — or is in a reviewed exemption list | **4** ↑ STRUCTURAL | **STRUCTURAL with genuine negative controls** — see the lane entry below. Was rung 0 (no enforcement of any kind, and no test; the founding promise was the only invariant with nothing behind it) until 2026-09-12; §5.0c records why this mechanism was chosen · **G1 2026-09-12:** confirmed 0; Josh (2026-09-12, map ticket #1001): build §5.0c (a)+(b) — target 4 · **I18 lane (Fable gate) 2026-09-12:** §5.0c (a)+(b) built — `docs/reference/owner-daily-actions.md` pins every owner-only route the BOOTED app serves (guards executed for owner/dispatcher/technician, not grepped: **54** routes; 2 `daily`, 6 `onboarding`, **46** `occasional`), each tagged `sms_reachable` and resolved against the live channels (voice intents ∩ `INTENT_TO_PROPOSAL_TYPE`, the booted SMS keyword registry, the mounted one-tap routes); `test/invariants/i18-owner-daily-actions.contract.test.ts` fails on divergence in either direction, requires an `exemption_reason` on every unreachable required row, and carries the budgets `ownerRequiredDailyWebActions = 1` (`POST /api/attachments/:id/visibility`) and `ownerRequiredOnboardingWebActions = 6`; negative controls (a planted owner-only route is caught, a comment-only guard is not counted, a shared-role route is not counted, a route made owner-only by the CHAIN is counted, a channel claim nothing reaches fails, `lookup_*` intents never count as reaching an action, two rows cannot claim one channel, a second in-handler check cannot hide behind its neighbour, an aliased or double-quoted gate is still seen, and every mount of an in-handler route is derived). `cd packages/api && npx vitest run test/invariants/i18-owner-daily-actions.contract.test.ts` → 27/27 ✓ (every assertion RED first). Hardened across nine review rounds on PR #1073 — the derivation now has two arms (executed guards, plus declared in-handler checks the walker cannot see, e.g. the owner-only `PATCH /api/entity-aliases/:id/deactivate`) and boots WITH a pool, since ~20 routers mount only when one exists. STRUCTURAL with negative controls → **4** (Josh's target on #1001). **Stated ceiling:** the derived set is owner-*only* routes, a lower bound on what the owner actually does in a 1–3-truck shop; widening to owner-performed mutations is the next rung. **Channel gap now visible:** all four reachable rows are voice — no owner-only route is reachable by SMS keyword or one-tap. **Second ceiling:** a channel claim is checked for existence and uniqueness, not for performing that row's action — no route → action → channel map exists to derive that from, so the per-row binding is human-reviewed (PR #1073) |
| **C5** | *(not an invariant — founding commitment #5, listed here because it reads like one)* **A second classifier reviews every booking and quote.** · *As M, I want a second pair of eyes before a quote reaches a customer* | **Given** any booking/quote reaching an owner-facing dispatch — **any** origin, **any** status — **then** exactly one supervisor review exists first | **2** 🚨🚨 | **NOT KEPT — see §12.4e.** The gate has **2 call sites against 93 proposal-creation sites**; one is conditional on `ready_for_review` so **low-confidence quotes are skipped precisely because the agent was unsure**; default mode is `shadow` where nothing ever holds; and `pricing_anomaly` is not a harm check, so **it cannot hold even in `enforce`**. **Raised as O-9** · **G1 2026-09-12:** 2 call sites + the definition confirmed (`voice-action-router.ts:2098`, `:2490`); `grep -rn "createProposal(" packages/api/src | wc -l` → 94 lines = **93 call sites + the definition** at `proposals/proposal.ts:1168` — the count holds |

**#1020 2026-09-12 — rung-5 reading for invariants (ratified at G7, per #1020's resolution):** an invariant names every surface, so its in-repo ceiling is **4 with a tenant grade**. Rung 5 is claimed for a §5 row only where a surface-parity test (`drafting-surface-parity`, `coverage-table.structural`) shows the invariant enforced on every declared surface; rung 6 needs live traffic from two tenants like any other row. Applied to every §5 row printed at 4: **hold at 4, grade as measured.** Ten rows moved to 4 today (I2, I3, I8, I12′, I13 from 3; I4, I10, I12, I17 back from the T0 demotion; I9) — PRs #1049 and #1050; open follow-ups #1051 (I3 lockout durability) and #1052 (I12′ money handler).

### 5.0a The six sub-clauses whose universal quantifier is unproven

I1′, I3′, I5′, I8′, I9′ and I13′ — **six**, which is what this list has always
enumerated — share one shape: **the instance is proven and the universal is
not.** *(The heading and the §5 summary both said "five" until 2026-09-12,
against their own six-item list and against §11.0b's scorecard, which said six.
Caught in review.)* "The AI never writes" is proven for the paths someone
thought to test; nothing stops the next path. That is the difference between a
tested behaviour and an enforced invariant, and it matters when someone adds the
next code path.

**I6 is the weakest**, because a test pins the opposite behaviour as supported.
I6's text says an unresolvable gate "is a capability that can never be approved."
The test says such a gate is a legal state. Both cannot be true.

**#1021 2026-09-12 correction (Fable):** both *are* true, because they quantify over different sets — D-029 rule 1 scopes I6 to gates *on an entity id*, and D-029's own Constraints paragraph (`docs/decisions.md:820`) says a parsed time or a path-shaped catalog gate is *left strictly alone*; the cited test pins that scope, not the legality of an unliftable entity-id gate (#909's remedy was to add `leadId` to the table). I6 is now guarded structurally (`test/invariants/i6-entity-id-gate-has-resolver.structural.test.ts`); what remains open is three system-supplied gates with no lifter (#1067). Of the six sub-clauses, I3′, I5′ (re-specced) and I8′ now hold under a guard; I1′, I9′ and I13′ are guarded but **do not hold** (#1066, #1064, #1065) — their rows say so.

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
  (dropped-call recovery) are proven at real Postgres and **no control Mike can
  reach turns either on** — the digest's switch is tenant-API-only with no UI,
  dropped-call recovery's is platform-admin-only (§12.4). Both have a switch;
  neither has one *Mike* has. 4.11 is worse: Carlos is never notified of an
  assignment, and the module's own doc-comment claims otherwise.
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
daemon **or** `EXTERNAL_TEST_DB_URL`; with neither, **it fails — it does not
skip.** `test/integration/global-setup.ts` awaits `new
PostgreSqlContainer(…).start()` with no catch and no skip path, so Vitest exits
non-zero before collecting a single test.

*An earlier draft of this line said the opposite — that the lane silently skips
— and that error is worth keeping visible, because believing it is the trap.* A
reader who has been told the lane skips without Docker will read a hard
globalSetup failure as the documented harmless case and move on, when what
actually happened is that **the confirmation never ran at all**. Neither a green
nor a red from this lane means anything until you know the daemon was up. That
is the reason `S:` falsifiers appear wherever a claim is load-bearing: a shell
command that needs no container cannot fail this way.

Rows marked ✅ *executed* were run during this audit rather than inspected —
§8.1, §8.5 and §8.6 were produced by running the Docker-gated suite (12 files,
70 tests, all passing).

#### The epics at a glance

| § | Epic | Jobs | Stories | Median rung | The one thing in the way |
|---|---|---|---|---|---|
| 8.1 | Stand up the back office | precondition | 11 | 3 | Invite emails 404 — `/accept-invitation` has no route; six of eleven real-DB proofs are single-tenant (T0) |
| 8.2 | Answer my phone when I can't | J1, J3, J10 | 12 | 3 | Emergency detection has no real-DB proof; every phone proof is single-tenant (T0) |
| 8.3 | Book the job without me | J2 | 12 | 3 | The customer confirmation path is a no-op notifier (3.8 → 2); the booking leg is single-tenant |
| 8.4 | Run the day | J1, J10 | 11 | 3 | The drag→proposal guarantee is untested at the DB; the lateness evaluator is dormant (4.7 → 2) |
| 8.5 | Capture the work in the field | J5 | 5 | 3 | Field screens aren't pinned to the glove/daylight contract; the photo row has no real-DB proof |
| 8.6 | Let me fix it by talking | J9 | 10 | 4− | No spoken-address entity — 6.8 parked (map #1001); most rows prove the write but not the audit event |
| 8.7 | Draft the quote from what was said | J4, J10 | 12 | 4 | After #1012 (2026-09-12): 7.4–7.9 and 7.12 at real Postgres with `PgAuditRepository` and a second tenant (T1; 7.9 T3); 7.2 cap proven unit; 7.11 parked on O-9. Rung 5 needs the public-estimate Playwright reachability at T2
| 8.8 | Bill it and chase the money | J5, J6 | 13 | 3 | Dunning cadence idempotency is unproven; the payment-concurrency cluster is single-tenant with no audit assertions |
| 8.9 | Tell me what happened, and what you got wrong | J7, J8 | 12 | 4− | No shipped surface turns the digest on (the API does — §12.4); no sweep row asserts its audit event |
| §5 | Never exceed your authority | J8, J10 | 26 | 3 | The second classifier reaches 2 of 93 origins; four real-DB proofs are single-tenant (T0) |

**124 stories. Zero at rung 6.** Nothing in this product has been observed
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
| **4 — admin-API only** | The write path exists (platform flag + `tenantIds`); ship an owner-facing control (2.7, 2.6) |
| **4 — no client control** | The write path exists; ship the toggle only (9.6) |
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
| **1.1** | **As T**, I want an account the moment I sign up, so I never see a "setting up your workspace" screen | **Given** a Clerk signup webhook, **when** it is delivered twice, **then** exactly one tenant exists and the replay window is enforced *before* signature verification | **4** ↑ (T1) | **D:** `clerk-owner-membership.test.ts` · **G1 2026-09-12:** 1/1 ✓ at real Postgres, but `clerk-owner-membership.test.ts` provisions one tenant and asserts no audit event — **T0**, write-only: 3 until a neighbour and the audit leg are asserted · **second-tenant lane (Fable gate) 2026-09-12:** `clerk-owner-membership.test.ts` — a genuinely re-delivered signup (two distinct svix ids, same Clerk user) through the real `/webhooks/clerk` router still yields one tenant and one owner row (`bootstrapTenant`'s `findByOwner` guard, not just event-id dedup); `tenant.signup.bootstrap.completed` read back via `PgAuditRepository.findByEntity`; a neighbour tenant provisioned first is byte-for-byte unchanged; a webhook signed 600 s stale is refused 400 before signature verification (`SVIX_TOLERANCE_SECONDS = 300`) and creates no row. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/clerk-owner-membership.test.ts` → 6/6 ✓ (RED: expected 2 tenants, got 1). PROVEN-REAL-DB with audit, T1 → **4**. Observation → #1075: the re-delivery writes a second `bootstrap.completed` audit row (the block is not gated on `result.created`) (PR #1074) |
| **1.2** | **As T**, I want to type my business details once and have the system remember them, so I'm not re-entering my address in four places | **Given** a valid identity payload, **when** I submit it and later resubmit, **then** the row upserts idempotently, an omitted `serviceAreaRadius` keeps its stored value while `null` clears it, and a `tenant.identity_set` audit event is written | **5** ↑ (T3) | **D:** `onboarding-identity.test.ts` ✅ *executed* · **G1 2026-09-12:** 5/5 ✓ incl. the `tenant.identity_set` audit event — PROVEN-REAL-DB by class, **T0** (no neighbour), and rung 5 had no reachability run behind it. One neighbour → 4; a hermetic Playwright run (#1025) → 5 · **second-tenant lane (Fable gate) 2026-09-12:** `onboarding-identity.test.ts` — tenant B upserts its identity twice through the real `PUT /api/onboarding/identity` (once with `serviceAreaRadius: 99`, once with `null`) and tenant A's `tenant_settings` row keeps `'Tenant A Co'` / `40`; `tenant.identity_set` rows are per tenant (A: 1, B: 2) via `findByEntity`. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/onboarding-identity.test.ts` → 6/6 ✓ (RED: expected 'Tenant B Co'). T1 restores 4 at the integration seam · **owner-surfaces lane (Fable gate) 2026-09-12:** rung-5 reachability — `e2e/journeys/onboarding-identity.spec.ts` drives the real `/onboarding` identity form in the browser (business name, hourly rate, 42-mile radius) → `tenant_settings` row and `tenant.identity_set` audit row polled from real Postgres; the omit-tri-state (#874) driven at the same live `PUT /api/onboarding/identity` the form posts to (the form never omits the field) keeps 42; tenant B seeded first with different values (9900¢, 99 mi, America/Denver) is re-read unchanged at the end — two differently-configured tenants each correct in one run (T3). `CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=<testcontainer> E2E_USE_TEST_DB=true VITE_CLERK_PUBLISHABLE_KEY=pk_test_… npx playwright test <spec> --project=chromium --retries=0` → `onboarding-identity` 1 passed (twice). → **5** (PR #1085) |
| **1.3** | **As T**, I want a price book I didn't have to build, so I can quote on day one | **Given** I pick HVAC, **when** the pack activates twice concurrently, **then** one seeding occurs under an advisory lock and my catalog holds the pack's SKUs at the pack's prices | **4** ↑ (T1·T3) | **D:** `onboarding-pack.test.ts`, `onboarding-pack-seed-concurrency.test.ts` — *no audit assertion* · **G1 2026-09-12:** 3/3 + 1/1 ✓ (the #976 flake did not reproduce); `PgAuditRepository` is wired but no audit event is asserted (4− class); **T0** → 3 · **#1016 2026-09-12:** `InMemoryAuditRepository` swapped for `PgAuditRepository` in `onboarding-pack.test.ts` + `onboarding-pack-seed-concurrency.test.ts`; `tenant.pack_activated` row read back; T1 (a second tenant neither sees nor is seen); T3 (two tenants, two DIFFERENT packs, two price books in one run — 6 HVAC vs 6 plumbing catalog rows, zero overlap). `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/onboarding-pack.test.ts test/integration/onboarding-ai-check.test.ts test/integration/onboarding-conversation-concurrent-turns.test.ts test/integration/onboarding-conversation.test.ts test/integration/onboarding-pack-seed-concurrency.test.ts test/integration/onboarding-status-derived-gate.test.ts test/integration/onboarding-vapi.test.ts` → 7 files, 29/29 ✓ at real Postgres, audit rows read back through `PgAuditRepository`. PROVEN-REAL-DB → 4; rung 5 = the hermetic onboarding journey (separate lane) |
| **1.4** | **As T**, I want to close the laptop mid-setup and come back to exactly where I was, so onboarding survives a service call | **Given** a partially-configured tenant, **when** I return, **then** the current step is derived from *facts about my tenant* — never a stored wizard flag — and cannot disagree with reality | **4** ↑ (T1) | **D:** `onboarding-status.test.ts` ✅ *executed* · **G1 2026-09-12:** 3/3 ✓; no audit event asserted (4− class); **T0** → 3 · **second-tenant lane (Fable gate) 2026-09-12:** `onboarding-status.test.ts` — a neighbour tenant driven to full completion (settings + pack + AI check + Twilio integration + subscription + a voice session) leaves tenant A's `GET /status` at `currentStep: 'identity'`, `isComplete: false`. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/onboarding-status.test.ts` → 4/4 ✓ (RED: expected null). The derivation is a read over real rows; there is no write to audit, so the 4− class does not apply — T1 → **4** (Fable's reading) (PR #1074) |
| **1.5** | **As T**, I want to look around before finishing setup, so I can decide if this is worth my time | **Given** identity is saved, **when** I navigate anywhere, **then** the CRM is unlocked and later steps nudge rather than hard-block | **4** ↑ (T1) | soft-gate logic; no DB-level proof · **G1 2026-09-12:** **NO-COMMAND** — no test targets the soft gate; 10 adjacent onboarding-gate unit files pass 67/67. Rung provisional · **#1016 2026-09-12:** new `test/integration/onboarding-status-derived-gate.test.ts` — a brand-new tenant can look around (GET /status 200 with the real incomplete state, never a "finish setup first" block); completing pack BEFORE identity still derives correctly (status reads facts, not a stored wizard pointer); `PUT /identity` lands `tenant.identity_set` through `PgAuditRepository` and the next /status reflects it; T1 (a second tenant looking around sees none of the first's partial setup or audit trail). `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/onboarding-pack.test.ts test/integration/onboarding-ai-check.test.ts test/integration/onboarding-conversation-concurrent-turns.test.ts test/integration/onboarding-conversation.test.ts test/integration/onboarding-pack-seed-concurrency.test.ts test/integration/onboarding-status-derived-gate.test.ts test/integration/onboarding-vapi.test.ts` → 7 files, 29/29 ✓ at real Postgres, audit rows read back through `PgAuditRepository` → 4 |
| **1.6** | **As M**, I want my own phone number on my own subaccount, so my call records are mine | **Given** production credentials, **when** provisioning runs, **then** a subaccount, messaging service and number are created — and **without** real credentials it throws rather than faking success | 3 | **U:** provisioning unit tests. *Capped by the third-party dependency, not by neglect* · **G1 2026-09-12:** PROVEN-UNIT — 8 subaccount unit files (incl. `test/integrations/twilio-provisioning.test.ts`) 85/85 ✓, T0 |
| **1.7** | **As T**, I want a 14-day trial with no card surprises, so I can try this without commitment | **Given** a plan whose price fails live Stripe validation, **when** checkout renders, **then** that plan is **omitted, never shown at a wrong price** | 4 | **D:** subscription integration tests · **G1 2026-09-12:** the proofs are `integration/billing-trial.test.ts` (6/6 ✓, T0) and `integration/trial-provisioning-first-value.test.ts` (6/6 ✓, **T1** — "cross-tenant isolated", `otherTenant` at :658) |
| **1.8** | **As T**, I want proof the AI works before I point my real number at it, so I'm not experimenting on customers | **Given** verification runs, **when** it passes, **then** the step completes with DB status `passed`; **when** it fails, **then** I get an `ai_verification_failed` blocker and a retry that resets to pending and re-enqueues | **4** ↑ (T1) | **D:** `onboarding-ai-check.test.ts` ✅ *executed* · **G1 2026-09-12:** 3/3 ✓ but the audit leg is `InMemoryAuditRepository` (×3) — 4− class — and **T0** → 3 · **#1016 2026-09-12:** `onboarding-ai-check.test.ts` now reads `tenant.ai_verified` / `ai_verification_failed` / `ai_verification_retry` back through `PgAuditRepository` with a T1 negative (tenant A's entity id under tenant B's scope → empty). PROVEN-REAL-DB (the AI-check write + its audit row at real Postgres) with T1 → 4 |
| **1.9** | **As T**, I want to set this up by talking instead of filling a form, because I'm doing it in the truck | **Given** the conversational path, **when** I complete up to 15 turns, **then** transcript, extractions and clarification counts round-trip through JSONB, RLS is ENABLE + FORCE, and cross-tenant reads are refused — with the form wizard still available as fallback and edit surface | **4** ↑ (T1) | **D:** `onboarding-conversation.test.ts` ✅ *executed* — *no audit assertion* · **G1 2026-09-12:** 6/6 ✓, **T1** (`secondTenant` :35/:54); no audit event asserted at all — 4− holds; the audit leg, not a neighbour, stands between it and 4 · **#1016 2026-09-12:** conversation turns audited at real Postgres (`agent.onboarding.advanced` / `extractor_called` / `review_confirmed` rows read back through `PgAuditRepository`), invisible under a second tenant (T1); the Vapi activation leg likewise (`onboarding-vapi.test.ts`). `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/onboarding-pack.test.ts test/integration/onboarding-ai-check.test.ts test/integration/onboarding-conversation-concurrent-turns.test.ts test/integration/onboarding-conversation.test.ts test/integration/onboarding-pack-seed-concurrency.test.ts test/integration/onboarding-status-derived-gate.test.ts test/integration/onboarding-vapi.test.ts` → 7 files, 29/29 ✓ at real Postgres, audit rows read back through `PgAuditRepository` → 4 |
| **1.10** | **As M**, I want the AI to sound like my shop and then **stop changing**, so my customers hear one voice | **Given** six captured fields, **when** the first write lands, **then** the voice locks; every later edit is cool-down gated under a `FOR UPDATE` lock with no lost update, rollback never mutates history, and a spoken *"lock my brand voice"* can **never** set the lock | **4** ↑ | **D:** `brand-voice.integration.test.ts`, `update-brand-voice-voice-execution.test.ts` ✅ *executed* · **G1 2026-09-12:** 5/5 + 6/6 ✓, **T1** (`brand-voice.integration.test.ts:264` "does not expose the brand voice to another tenant") |
| **1.11** | **As M**, I want to invite Carlos and have him actually get in, so my tech can see his own day | **Given** an invite, **when** Clerk is down, **then** the local invitation row is already written so tenant intent is never lost — **and** the last owner cannot be demoted | **5** ↑ (T2) / **5** ↑ (T2) — #1092 fixed (PR #1093) | **D:** `clerk-owner-membership.test.ts`. 🚨 **The story fails anyway: `/accept-invitation` has no route. Every invite email 404s** · **G1 2026-09-12:** see 1.1 — same file, same T0, no audit leg; the 404 stands · **#1010 2026-09-12:** `/accept-invitation` route added (`packages/web/src/routes.ts`; `AcceptInvitationPage`); `e2e/journeys/accept-invitation.spec.ts` — an invited technician follows the invite link and lands on their own day view; an unauthenticated visit does not — `CLERK_DEV_HMAC_TOKENS=true E2E_USE_TEST_DB=true DB_SSL=false DATABASE_URL=<testcontainer> npx playwright test accept-invitation digest-toggle revenue-cluster-toggles --project=chromium` → 4 passed (48.1s), real Postgres, chromium project. REAL-DB write (webhook join) with no audit assertion, **T0** → route rung 3; rung 4 needs T1, rung 5 needs T2 (§8.1 move ticket). Note: `CLERK_DEV_HMAC_TOKENS` is a test-auth shim (prod-refused in `shared/config.ts` + `auth/clerk.ts`), needed because DEV_AUTH_BYPASS can only resolve a subject to a tenant it owns · **second-tenant lane (Fable gate) 2026-09-12:** invitation half at real Postgres through the real `createUsersRouter` — with the outbound Clerk `fetch` stubbed to throw, `POST /api/users/invitations` still writes the local `pending_invitations` row and its `user.invited` audit row (read back via `findByEntity`); `PATCH /api/users/:id` demoting the only owner is refused 400 by the real `PgUserRepository` guard and the role is unchanged (SAME-tenant case only — see below); tenant B's invitation never appears under tenant A (route and repository). Same file → 6/6 ✓. Invitation half PROVEN-REAL-DB, T1 → 4; the `/accept-invitation` route half keeps its 3 (T0) until the owner-surfaces browser lane's T2 leg · **owner-surfaces lane (Fable gate) 2026-09-12:** invite half — `e2e/journeys/accept-invitation.spec.ts` re-run at real Postgres (a pre-existing `blockExternalHosts` gap fixed in its first test): the invited technician follows the link and lands on his own day view; tenant B's real invitation token with a forged `tenant_id` claim joins tenant B, never A — two tenants' invitations resolve correctly in one run (T2) → **5**. Last-owner half — the SAME-tenant sole-owner demotion is refused in the real `/settings` → Team members dialog ("Cannot demote the only owner"), `PATCH /api/users/:id` 400, `/api/me` unchanged: reached; but a NEW CROSS-tenant leg found the same endpoint is NOT tenant-scoped — tenant A's owner PATCHing tenant B's owner id returned 200 and changed B's role (`PgUserRepository.update` has no tenant predicate, unlike the second-tenant lane's same-tenant guard path above): **SECURITY #1092**, fix lane launched, pinned as `test.fail()`. Isolation failed, so the last-owner half holds at 3 until the fix merges (then 4, T1). `CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=<testcontainer> E2E_USE_TEST_DB=true VITE_CLERK_PUBLISHABLE_KEY=pk_test_… npx playwright test <spec> --project=chromium --retries=0` → `accept-invitation` 4 passed + 1 expected fail (PR #1085) · **second-tenant lane (Fable gate) 2026-09-12:** invitation half at real Postgres through the real `createUsersRouter` — with the outbound Clerk `fetch` stubbed to throw, `POST /api/users/invitations` still writes the local `pending_invitations` row and its `user.invited` audit row (read back via `findByEntity`); `PATCH /api/users/:id` demoting the only owner is refused 400 by the real `PgUserRepository` guard and the role is unchanged; tenant B's invitation never appears under tenant A (route and repository). Same file → 6/6 ✓. Invitation half PROVEN-REAL-DB, T1 → **4**; the `/accept-invitation` route half keeps its 3 (T0) until the owner-surfaces browser lane adds its T2 leg (PR #1074) · **Correction (Codex review, PR #1074) 2026-09-12:** the 🚨 line above and the immediately-following G1 note ("the 404 stands") are STALE as of this cell's own later `#1010` entry — re-verified against the current tree: `packages/web/src/routes.ts:286` registers `/accept-invitation`, `AcceptInvitationPage` implements it, `e2e/journeys/accept-invitation.spec.ts` exists and passes per #1010's run above. No route 404 remains; kept for audit-trail history only, not as current product state · **Fable re-gate 2026-09-13 02:08Z — #1092 closed by PR #1093 (merged 22:29Z, 07d67a1e6):** last-owner half at the merged content (abd202eaa = the PR head; product delta since the gated 41d025305 = 0 files) — `users-update-tenant-predicate.test.ts` at real Postgres: tenant A's owner PATCHing tenant B's owner → 404 and B's row unchanged in both RLS modes, `PgUserRepository.update(A, userOfB)` returns null and changes nothing, control 200 with exactly one `user.updated` under A, same-tenant sole-owner demotion still 400 → 6/6 ✓ (+ `clerk-owner-membership` 6/6); `accept-invitation.spec.ts` with the T1 leg un-pinned (415f62e3d) → 5 passed (47.4s) at real Postgres, including the members-page UI refusal (T2) and the cross-tenant PATCH 404 (T1); /verify runtime drive of the API at real Postgres: cross-tenant PATCH 404 (row unchanged), control 200, symmetry 404, unknown id 404, sole-owner demote 400, name-only cross-tenant 404 → PASS. Reached + T1 + T2 → the last-owner half joins the invite half at **5**. Residual from the same sweep: #1095 (`pack_activations` update unscoped, Opus lane) and #1096 (non-UUID id → 500, Opus lane) |

> **Epic verdict.** Strong on the parts T touches alone; **1.11 is broken end to
> end** and it is the one story in this epic with a second human in it.
> **Update (Codex review, PR #1074) 2026-09-12:** stale as of #1010 —
> `/accept-invitation` has a route, `AcceptInvitationPage`, and a passing
> e2e spec (`e2e/journeys/accept-invitation.spec.ts`); 1.11's remaining gap
> is only the invitation-half rung noted in its row above, not an
> end-to-end break.

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
| **2.1** | **As M**, I want my phone answered 24/7 in my shop's voice, so I stop losing jobs to whoever answers first | **Given** a customer dials my number, **when** the call lands, **then** the tenant is resolved from the real `phoneE164` column and the greeting is my shop's | **4** ↑ (T2) | **D:** `voice-inbound-appointment.test.ts -t "routes a dialed number"` · **G1 2026-09-12:** `voice-inbound-appointment.test.ts` 3/3 ✓ with audit events (the `-t` title is a substring of "routes a dialed number to its tenant via the real phoneE164 column"); its only neighbour mentions are comments — **T0** — and no reachability run backs 5 → 3 · **#1014-A 2026-09-12:** `voice-inbound-appointment.test.ts` gains T2 — tenant B runs its own complete inbound-call flow (own DID, customer, location, job, booking) through the same production path without touching tenant A's rows or availability; audit rows (`appointment.created`, `proposal.executed`) read back. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 32/32 ✓ at real Postgres → 4 (T2) |
| **2.2** | **As M**, I want callers told they're being recorded **before** anything is captured, so I'm not exposed in a two-party-consent state | **Given** an inbound call, **when** the greeting plays, **then** the disclosure precedes `<Start><Record>`, Media Streams consumes no audio until it has played, **and the implicit-consent ledger row is written** | **4−** ↑ (T1) | Ordering proven; **the ledger write is a `vi.fn()`** in a file that never opens a pool. **S:** `grep -c "new Pool(" …/conversation-consent-ordering.test.ts` → **0** · **G1 2026-09-12:** 13/13 ✓ — but only under the integration config (`vitest.config.ts` excludes `test/integration/**`, and the file opens no pool): PROVEN-UNIT, 3 stands · **#1014-A 2026-09-12:** `conversation-consent-ordering.test.ts` now opens the real pool (its 13 adapter-ordering assertions moved verbatim to `test/telephony/media-streams/`, so the NO-DB baseline SHRANK by one — G3): the `consent_events` row is written at the disclosure-PLAYED point, strictly before any caller audio is captured; a fail-closed disclosure writes no row; T1 (tenant B's consent never satisfies tenant A's gate for the same number). No `audit_events` emission exists on this path (`consent_events` is the append-only ledger per its docstring) → REAL-DB-WRITE-ONLY 4− (issue filed); phone-surface reachability is lane C. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 32/32 ✓ at real Postgres |
| **2.3** | **As M**, I want a known customer recognised by their number and a stranger turned into a lead, so nothing falls on the floor | **Given** an inbound number, **when** it matches a stored customer in E.164, **then** they are identified — **and** a non-NANP caller sharing the last 10 digits is **not** matched | **4** ↑ (T1) | **D:** `identify-caller.test.ts`. *The voice unknown→lead leg is untested at real DB; only the SMS caller is* · **G1 2026-09-12:** `identify-caller.test.ts` 4/4 ✓, single tenant, no audit event asserted → 3 · **#1014-A 2026-09-12:** the voice unknown→lead leg at real Postgres: a stranger's call creates the `leads` row with `lead.created` audit read back through `PgAuditRepository`; a known number resolves the customer; T1 (a number known to tenant B is a stranger to tenant A). `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 32/32 ✓ at real Postgres → 4 |
| **2.4** | **As M**, I want a stranger on the phone to be unable to reach owner-only capability, so my phone line isn't an admin console | **Given** a caller-surface session, **when** the classifier returns an off-profile intent, **then** it becomes `unknown` and is **audited**, never silently dropped | **4** ↑ (T1) | Fixture-proven only. **S:** `grep -rln "intent_off_surface" packages/api/test/integration/` → **empty** · **G1 2026-09-12:** `intent_off_surface` in 0 integration files, 9 unit/src files — fixture-proven, 3 stands · **#1014-B 2026-09-12:** D: `integration/stranger-owner-capability.test.ts` (new) — driven as Twilio drives it (`handleInbound` → `ask_caller` turn → classifying turn) with real `PgUserRepository`/`PgSettingsRepository`/`PgAuditRepository`/`PgProposalRepository` and the real membership loader; only the LLM gateway is scripted: an unmatched caller-ID resolves no actor and lands on the `caller` profile (`phone-actor.ts:62`, `twilio-adapter.ts:1162`); a spoken `send_invoice` from that stranger is intercepted to `unknown`/`intent_off_surface` **before routing** (`intent-classifier.ts:655`, applied at `:2875`) with the audit row `voice.intent_off_surface {intent: send_invoice, profile: caller, confidence: 0.96}` read back via `findByEntity`, and **zero** proposals; **positive control** — the same intent on the tenant's own owner line is not intercepted; an owner-grade lookup from the stranger is refused by the D-026 RBAC (`phone-lookup-surface.ts:168`), a different layer. T1 two ways: tenant B's `owner_phone` and its owner's mobile are both strangers to tenant A while both resolve on B's own line. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/stranger-owner-capability.test.ts` → 5/5 ✓ (four RED rounds first). `phone-lookups-shared-dispatch.test.ts` already proved the lookup-RBAC legs — the printed *prose only* was wrong. 🚨 closed; PROVEN-REAL-DB, T1 → **4**; the phone-surface leg cannot be hermetic (the classification needs a live model) (PR #1054) |
| **2.5** | **As J**, I want a gas leak recognised before any AI thinks about it, so a life-safety call never waits on a model | **Given** any transcript chunk in English **or** Spanish, **when** a tier-1 phrase appears, **then** E1 is returned **with no rules loaded**, the safety script speaks first, pending bookings are revoked, and it **never books** | **4** ↑ (T1) — Spanish clause NOT MET (#1056); 5 withheld | **Unit only.** The nearest integration test covers the downstream handler with an in-memory audit repo. *Also: the E1 script is still a self-declared placeholder* · **G1 2026-09-12:** PROVEN-UNIT — emergency-detector/tier/tier-transitions + complaint-guardrail 107/107 ✓ · **#1014-B 2026-09-12:** D: `integration/e1-life-safety-handler.test.ts` (new) — with the LLM gateway `mockRejectedValue`d, "smell gas" still terminates on the life-safety path (`runDeterministicSafetyScan` `twilio-adapter.ts:1557` → `classifyCallerSafety` `emergency-tier.ts:213`), the audit row carries `{tier: E1, reason: life_safety_e1}`, the call speaks 911 + `<Hangup/>` with no `<Gather>`, and **zero** `intent_classified` rows exist; **it never books** — a `create_appointment` drafted earlier in the same real call moves to `rejected / life_safety_emergency` with its own `agent.calling.e1_booking_revoked` row and `appointments` holds 0 rows; tenant B's E1 revokes only tenant B's booking. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/e1-life-safety-handler.test.ts` → 4/4 ✓ + 1 expected fail. **Phone-surface leg (hermetic, #1004 definition):** `e2e/telephony-e1-signed-webhook.spec.ts` — a Playwright `request` (no browser, no live Twilio) self-signs Twilio-shaped webhooks with each tenant's own encrypted token from `tenant_integrations` and POSTs through the real `/api/telephony/voice` + `/gather`: unsigned → 403, signed → the E1 TwiML and the `tier=E1` row under the right tenant, tenant B's token lands only in B. **Withdrawn at the gate (2026-09-12 19:20Z):** the earlier claim *A's token cannot sign for B's DID* was vacuous (it signed `AccountSid=B` with A's token, which 403s by construction); the real check is missing — a tenant's own credential with `To=<victim DID>` is accepted and the session lands under the victim → **SECURITY #1072**, pinned as a `test.fail()` in the spec. `DATABASE_URL=<provisioned> DB_SSL=false E2E_DEV_AUTH=0 TWILIO_ACCOUNT_SID=… TWILIO_AUTH_TOKEN=… TWILIO_FROM_NUMBER=… TWILIO_DEFAULT_TENANT_ID=… TENANT_ENCRYPTION_KEY=<64 hex> PUBLIC_API_URL=http://localhost:3000 npx playwright test --project=chromium telephony-e1-signed-webhook` → 4 passed (25 s). **The criterion's Spanish clause fails:** "fuga de gas" classifies **E2** (`emergency-tier.ts:265` folds the Spanish backstop in at E2, `E1_HAZARD_PHRASES` `:75` is English-only) — the caller is bridged to the dispatcher, never told to evacuate, and the drafted booking stays live; pinned as a characterization test + `it.fails` → **#1056**, owner parked on #1000. English path PROVEN-REAL-DB and reachable → **4** (T1); **5 withheld** until the Spanish clause holds; launch still waits on O-2 (PR #1054) · the lane's own re-run of the FINAL spec (with the `test.fail()` pin for #1072): 6 passed, 5 green + the pin · **#1072 fixed — PR #1082 merged 2026-09-12 22:25Z (4a7cffa0b):** inbound webhooks are now verified with the credential of the tenant that OWNS the dialled number (`twilio-webhook-credential.ts`), the recording/voicemail/status callbacks are bound to the session's tenant, and the whisper leg reads AccountSid from the query; the `test.fail()` pin in `telephony-e1-signed-webhook.spec.ts` flipped to a passing refusal (305784d76). Fable gate ×5 at real Postgres + a structural guard (ordering, not presence) + /verify runtime drive: own calls 200, the attack 403, no-AccountSid 403, session hijack 403, unsigned 403, deployment-token forge 403 → PASS. Cell unchanged: the Spanish clause (#1056) still holds 5 back; follow-ups #1084 (dev seam, secondary token, whisper escalationId) and #1061 (DID uniqueness, Opus lane) |
| **2.6** | **As J**, I want an elderly caller on oxygen in 104°F heat to reach me personally, so vulnerability isn't handled by a queue | **Given** age + weather + critical urgency, **when** triage runs, **then** my cell is patched with a 60s dial and a non-PII preface; if I don't answer, a high-priority booking plus an owner SMS — **never a normal booking** | **4−** ↑ (T3) | **U:** `vulnerability-triage-hook.test.ts`. *Its dedicated flag writer (`setTenantFlag`) is unwired, but a platform admin can scope the platform flag by `tenantIds` — admin-API-only, not unreachable (§12.4)* · **G1 2026-09-12:** `vulnerability-triage-hook.test.ts` 13/13 ✓ · **#1014-A 2026-09-12:** new `vulnerability-triage-hook.test.ts` drives the real hook with `PgTenantFeatureFlagRepository` + `PgTriageEventRepository`: tenant A (flag ON via `setTenantFlag`) writes a real `triage_events` row, tenant B (OFF) writes nothing, in one run — T3. No `audit_events` emission on this path (`triage_events` is the structured record) → 4−; the owner control for the flag lands with #1011 PR-2. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 32/32 ✓ at real Postgres · **#1011 2026-09-12:** owner-facing control lit — `voice_vulnerability_triage` ("Extra care for callers in distress") now writes through PR-2's `PUT/GET /api/settings/capabilities[/:key]` from Settings › Capabilities, not just the platform-admin `tenantIds` ramp. `e2e/journeys/capabilities-toggle.spec.ts`: `DB_SSL=false DATABASE_URL=<testcontainer> E2E_USE_TEST_DB=true VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== npx playwright test capabilities-toggle.spec.ts --project=chromium --reporter=line` → 1 passed (real Postgres testcontainer, chromium). Owner flips the switch ON; `tenant_feature_flags` row confirmed (`enabled=t, updated_by=<user>`) with a `feature_flag.tenant_updated` audit row; a second tenant bootstrapped in the same run (T3) still reads `enabled:false` for this key — no cross-tenant bleed. Evidence class D, T3. Rung unchanged (Fable states rungs) · **#1011 PR-3 gate (Fable) 2026-09-12:** control reachability confirmed locally (`capabilities-toggle.spec.ts` 1 passed, T3). Rung unchanged at 4− (T3): the triage path itself still writes no `audit_events` (#1044) and the phone-surface leg is unproven; the control is lit, the row is not (PR #1062) |
| **2.7** | **As M**, I want a caller who hangs up mid-booking to get a text back, so a dropped call isn't a lost job | **Given** a call ending in `dropped`/`failed` with a usable number, **when** 60s elapse, **then** exactly one recovery SMS sends, stamped and audited, re-evaluated at send time | **4** ↑ (T3·T4) | Pipeline **proven at real Postgres including the flag-on transition**. `setTenantFlag` has **zero production callers**, but the capability is still ramp-able: a platform admin can scope the platform flag with `tenantIds` (§12.4). *Mike cannot turn it on; someone with platform-admin can turn it on for Mike* · **G1 2026-09-12:** `dropped-call-worker.test.ts` 22/22 ✓, audit ✓, **T1** (`:362` "a single cross-tenant sweep stamps each row under its own tenant", `tenantB`); the flag-on transition is live in the test. 4 at T1 confirmed; 5 remains admin-API only · **#1011 2026-09-12:** two gaps closed. (1) C6 — `sweep-tenant-fanout.test.ts` gained a dropped-call-recovery entry (this worker takes no `listTenantIds` dependency; its repo's `findDueTenantIds` runs one cross-tenant `SELECT DISTINCT tenant_id` query, same shape as thank-you-SMS/review-request): `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/sweep-tenant-fanout.test.ts` → 22/22 ✓ (19 pre-existing + 3 new — real cross-tenant selector reaches all 3 seeded tenants; one tenant's synthetic send failure does not stop the other two; a 4th tenant with nothing scheduled stays untouched in the same pass). Red-first: inverted assertions failed for the claimed reason before being corrected. Evidence class D, T4. (2) Owner-facing reachability — `dropped_call_recovery` ("Text back callers who hang up") now also writes through PR-2's `PUT/GET /api/settings/capabilities[/:key]`, not just the platform-admin ramp: `e2e/journeys/capabilities-toggle.spec.ts` → 1 passed (same command as row 2.6's note); `tenant_feature_flags` row confirmed (`enabled=t`) with a `feature_flag.tenant_updated` audit row; T3 (second tenant untouched); the closed allowlist refuses an unlisted key (`PUT .../supervisor_gate` → `400 UNKNOWN_CAPABILITY`) via the browser's own API client. Evidence class D, T3. Rung unchanged (Fable states rungs; §7 asks whether 2.7 can claim rung 5 without a live Twilio line — parked as E7 in blocked-on-josh.md) · **#1011 PR-3 gate (Fable) 2026-09-12:** re-run locally — `sweep-tenant-fanout.test.ts` 22/22 ✓ at a kept Postgres (seven `dropped_call_recovery.sent` audit rows, one per reached tenant), `capabilities-toggle.spec.ts` + `weekly-feedback-toggle.spec.ts` 2 passed (58 s) at a real Postgres testcontainer with rows polled during the run (tenant A: two `tenant_feature_flags` rows `enabled=t` + two `feature_flag.tenant_updated`; tenant B: no flag row). *4 — admin-API only* 🚨 closed: the owner-facing control exists and is reached in a browser (T3), the sweep has its T4 entry. Stays **4**: rung 5 needs the phone-surface leg (a signed dropped-call webhook → recovery SMS, #1004's definition) — parked as E7 on #1000 (PR #1062) |
| **2.8** | **As J**, I want a customer's photo of a leaking heater to become a draft quote, so I can price it from the truck | **Given** an MMS from an unknown number, **when** ingest runs, **then** a `draft_estimate` proposal persists with `tenant_id` and an audit row — and an **ambiguous sender yields a clarification, never a draft** | **4** ↑ (T1) | **D:** `mms-to-quote.int.test.ts` · **G1 2026-09-12:** `mms-to-quote.int.test.ts` 3/3 ✓ with audit, single tenant → 3 · **#1014-A 2026-09-12:** `mms-to-quote.int.test.ts` gains T1 — tenant B's catalog price and customer set never leak into tenant A's MMS quote (`customer_mms.estimate_drafted` / `clarification_raised` audit rows read back). `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 32/32 ✓ at real Postgres → 4 |
| **2.9** | **As M**, I want customers to book themselves on my website without a login, so I stop playing phone tag | **Given** the public page, **when** a customer picks a real open slot, **then** a held appointment is written pending my approval | **5** ↑ (T3) | Route mounted, `/book` ships — **but the only test is in-memory supertest** · **G1 2026-09-12:** `public-booking.route.test.ts` 18/18 ✓ (in-memory supertest) · **#1014-A 2026-09-12:** new `public-booking.test.ts` — the public booking route at real Postgres creates the appointment/job/location rows with `appointment.booking_requested` audit read back; T1 (tenant B's availability/config never affects tenant A's public booking). `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 32/32 ✓ at real Postgres → 4 · **public-surfaces lane (Fable gate) 2026-09-12:** rung-5 reachability — `e2e/journeys/public-self-booking.spec.ts`: two tenants with different owner-set business hours (A Mon–Fri 08–17, B Sat/Sun 09–13, both America/Chicago); tenant A's `/book?t=` page in a real browser loads real availability, the prospect picks an open slot and submits, the real `POST /api/public/booking/:tenantId` returns 201, `GET /api/appointments/:id` shows `scheduled` + `holdPendingApproval` + a real `holdExpiryAt`, `appointment.booking_requested` lands with the proposal id, and the owner's reloaded `/inbox` shows the `create_booking` proposal; tenant B's disjoint weekend slots and its own held booking proven through the same public endpoints the page calls (the public booking router is rate-limited to 5/min per IP, so B is driven via `request` rather than a second page load) — two differently-configured tenants each correct in one run (T3); each inbox shows only its own booking. `DB_SSL=false DATABASE_URL=<testcontainer> E2E_USE_TEST_DB=true VITE_CLERK_PUBLISHABLE_KEY=pk_test_… npx playwright test <spec> --project=chromium --retries=0` → `public-self-booking` 1 passed ×2 here (held appointments for both tenants on different days polled from Postgres). The `dropped-call-worker` idle-in-transaction crash surfaced during this run is #1090. → **5** (PR #1087) |
| **2.10** | **As M**, I want an unclaimed text to become a thread I can answer, so SMS isn't a black hole | **Given** concurrent inbound texts from one unmatched number, **when** captured, **then** they collapse to a single open thread with no cross-tenant bleed | **4** ↑ (T1) | **D:** `inbound-sms-capture.test.ts` · **G1 2026-09-12:** `inbound-sms-capture.test.ts` 7/7 ✓, **T1** ("does not bleed a captured thread across tenants" — phrasing the falsifier's token list misses), no audit event asserted → 4− · **#1014-A 2026-09-12:** `inbound-sms-capture.test.ts` now reads `sms.inbound.captured` back through `PgAuditRepository` (T1 kept). `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 32/32 ✓ at real Postgres → 4 |
| **2.11** | **As M**, I want the AI to refuse to quote a firm price or haggle, so it never commits me to a number I'd lose money on | **Given** a price-pressure turn, **when** the guardrail fires, **then** it speaks the holding line, mints exactly one owner callback, stays in state, and is idempotent when already flagged | **4** ↑ (T1) | **All unit.** The one integration file tests the context read, not the guardrail · **G1 2026-09-12:** negotiation-invariant + discount-evaluator + negotiation-guardrail 59/59 ✓ (all in-memory) · **#1014-A 2026-09-12:** the REFUSE branch at real Postgres (`negotiation-guardrail.test.ts`, lane-authored): an out-of-policy ask is refused and routed to the owner with `negotiation_guardrail.sms_routed` audit rows read back; T1. The ALLOW branch is proven by #1012 (PR #1035, same file name — merged at rebase). `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 32/32 ✓ at real Postgres → 4; pricing code untouched |
| **2.12** | **As M**, I want a property manager's call to be handled as a portfolio account, so my biggest customer isn't treated like a stranger | **Given** a caller resolving to `property_manager`, **when** the call runs, **then** the outcome is **observably different** from a residential call — prompt, priority, and proposal context | **4** ↑ (T3) | 🚨 **Assembled and read nowhere.** `session.b2bAccountContext` is written once (`twilio-adapter.ts:953`) and has **no reader**; `buildAccountContextPromptSection` has **zero production callers**. Nothing routes on `ctx.priority`, so the criterion's "observably different" is not delivered by anything — which is rung 2's definition, not 3's. *An earlier draft said the context is "read by one supervisor check." It is not: the supervisor's `resolveAccountType` (app.ts:6858) re-reads `customer.accountType` from the customer row via the proposal's `customerId`. That path is real but independent — it would behave identically if call-time B2B recognition did not exist, so it is not evidence that this is wired.* **S:** `grep -rn "buildAccountContextPromptSection" packages/api/src` → **definition only** · **G1 2026-09-12:** confirmed — `b2bAccountContext` writer 1 / reader 0; `buildAccountContextPromptSection` callers 0 · **#1010 2026-09-12:** wired — `create-voice-turn-processor.ts` resolves `session.b2bAccountContext` → `buildAccountContextPromptSection` → `classifyIntent({ b2bAccountPromptSection })` (separate labelled system message ahead of the transcript). `npx vitest run test/ai/orchestration/intent-classifier-b2b-account-wire.test.ts test/ai/voice-turn/voice-turn-processor.test.ts` → 2/2 + 62/62 ✓. PROVEN-UNIT → 3; the phone surface has no hermetic Playwright path, so 5 needs the §8.2 move ticket · **#1014-A 2026-09-12:** `b2b-account-context-voice.test.ts` — with customers in real Postgres, a `property_manager` caller's session gets the PRIORITY classify-prompt section naming its managed properties, the same tenant's residential caller gets none, and tenant B (no B2B account) gets none — T3; the log line "inbound call: B2B account context assembled" confirms the assembly ran. Read-side proof (no mutation to audit). `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 32/32 ✓ at real Postgres → 4 |

> **Epic verdict.** The two stories carrying the most liability — **2.2 recording
> consent** and **2.5 life-safety detection** — are the two with the weakest
> evidence. Neither is broken; both are *unproven where it counts*.

### 8.3 Book

**Epic: Book the job without me** · **Jobs:** J2

**Primary persona: J at 4am, frozen pipe, whoever answers first wins.**

| # | User story | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **3.1** | **As J**, I want a call to produce a *proposed* booking, not a booking, so the AI never puts something on my calendar I didn't agree to | **Given** a spoken booking request, **when** the pipeline runs, **then** free text → real resolver → real drafting task → approval → production executor, and **zero appointment rows exist before approval** | **4** ↑ (T1) | **D:** `voice-inbound-appointment.test.ts` · **G1 2026-09-12:** same file as 2.1 — T0, no reachability run → 3 · **#1015 2026-09-12:** `voice-inbound-appointment.test.ts` gains a genuine T1 (tenant B's booking never blocks tenant A's availability; lane A of #1014 added T2 in the same file). `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 47 passed + 1 expected fail at real Postgres → 4 |
| **3.2** | **As J**, I want offered times to respect my actual working day, so I'm not booked at 7pm | **Given** my configured hours, **when** slots are generated, **then** only in-hours slots are offered, the buffered booked window is removed, and tenant A's calendar never blocks tenant B | **4** (T2) | **D:** `dispatch-availability.test.ts`. 🚨 **DST, per-day hours, technician hours and time-off are unit-only** — the story is broader than the proof · **G1 2026-09-12:** `dispatch-availability.test.ts` 3/3 ✓ — **T2**: "does not let tenant A's appointment block tenant B's availability" (`tenantA`/`tenantB` both seeded); read-only, no mutation to audit. The unit-only half stays 3 · **#1015 2026-09-12:** the V17 business-hours/buffer unit half moved to real Postgres in `dispatch-availability.test.ts`; T2 kept. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 47 passed + 1 expected fail at real Postgres — 4 (T2) confirmed |
| **3.3** | **As T**, I want to be told when the times I'm being offered are just defaults, so I don't discover my hours were wrong after a customer books | **Given** a tenant with no configured hours, **when** availability returns, **then** hours, buffer and timezone are each labelled as defaults | **4** ↑ (T1) | In-memory supertest only — **and the web app never calls this endpoint**; only mobile does · **G1 2026-09-12:** `availability-route.test.ts` 9/9 ✓ (in-memory supertest); web never calls the endpoint — mobile only · **#1015 2026-09-12:** new `dispatch-availability-stale-defaults.integration.test.ts` — the stale-defaults disclosure is proven at real Postgres with T1. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 47 passed + 1 expected fail at real Postgres → 4 |
| **3.4** | **As M**, I want a booking POST to be unable to take a slot the calendar wouldn't have offered, so the public page can't be gamed | **Given** an out-of-hours slot, **when** a POST attempts it, **then** the write-side twin refuses | **4** ↑ (T1) | **Unit only** · **G1 2026-09-12:** `booking-availability.test.ts` 22/22 + `portal-booking.test.ts` 30/30 ✓ (unit) · **#1015 2026-09-12:** new `public-booking-held-slot.integration.test.ts` drives the real `createPublicBookingRouter` + `PgTenantTransactionRunner`: a real hold row blocks a second booking POST for the same tenant with an audited winner; a neighbour tenant's hold on the identical instant does not block this tenant (T1). `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 47 passed + 1 expected fail at real Postgres → 4 |
| **3.5** | **As J**, I want a slot held while I decide, and released if I don't, so a second prospect gets a real answer | **Given** a 24h hold, **when** it expires, **then** the reaper cancels it, clears the flag, emits audit, spares live holds, and a second sweep is a no-op — and an expired hold **stops blocking** the slot | 4 | **D:** `hold-reaper.test.ts`, `slot-conflict-checker.test.ts` · **G1 2026-09-12:** `hold-reaper.test.ts` 2/2 ✓ (audit ✓) + `slot-conflict-checker.test.ts` 4/4 ✓; **T4** via the `hold-reaper sweep` entry in `sweep-tenant-fanout.test.ts`. 4 confirmed · **#1015 2026-09-12:** `hold-reaper.test.ts` gains the T2 hold-visibility assertion (a reaped hold in tenant A never frees or hides a slot in tenant B); T4 entry cited. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 47 passed + 1 expected fail at real Postgres — 4 (T2·T4) confirmed |
| **3.6** | **As M**, I want it to be *impossible* to double-book Carlos, so I never send one truck to two houses | **Given** two concurrent assignments for the same tech and slot, **when** both race, **then** exactly one succeeds — enforced by a DB `EXCLUDE` constraint, not application code | **4** ↑ (T1) | **D:** `technician-double-booking-race.test.ts` — **the strongest capability row in the product** · **G1 2026-09-12:** `technician-double-booking-race.test.ts` 5/5 ✓ — the real `EXCLUDE` race, proven for one tenant with no audit event asserted → 3 until a neighbour and the audit leg are asserted · **#1015 2026-09-12:** `technician-double-booking-race.test.ts` gains the audit read-back and a neighbour tenant (a neighbour's technician is not the one being double-booked — T1). `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 47 passed + 1 expected fail at real Postgres → 4 |
| **3.7** | **As M**, I want the AI to ask instead of guessing when two customers share a name, so it never books the wrong Henderson | **Given** duplicate display names, **when** resolution runs, **then** the result is an ambiguity carrying **both** candidates — never a silent pick | **4** ↓ (T1) | **D:** `entity-resolution.test.ts`, `cancel-appointment-voice.test.ts` · **G1 2026-09-12:** `entity-resolution.test.ts` 94/94 ✓ (**T1** — eight "across tenants" cases) + `cancel-appointment-voice.test.ts` 4/4 ✓ (audit ✓, **T1** `:268`); rung 5 had no reachability run → 4 |
| **3.8** | **As M**, I want my customer to get a confirmation when I approve, so they don't call back to check | **Given** an approved `create_appointment`, **when** it executes, **then** an `appointment_confirmation` dispatch row is written | **4** ↑ (T1) — holds only where the tenant has not set `autoSendAppointmentReminders = false` **and** the customer is reachable on at least one channel that is both credentialed at boot and enabled | **No test proves the dispatch row.** The default is a **no-op notifier**, and the class whose doc-comment claims to be the live path is never instantiated. *This story most likely fails in production and nothing would tell us* · **G1 2026-09-12:** the only live instantiation is the no-op notifier; `AppointmentConfirmationNotifier` is never constructed and no test proves a customer confirmation is dispatched — built and dormant, 2 · **dormant-rows lane (Fable gate) 2026-09-12:** the G1 reading was half wrong — `AppointmentConfirmationNotifier` is indeed never constructed, but `TransactionalCommsService.enqueue` (`transactional-comms-service.ts:95` → `sendAppointmentNotice(…, 'appointment_confirmation')`) implements the same interface and IS wired as `schedulingNotifier` at `app.ts:1910`. D: `integration/appointment-confirmation-dispatch-3-8.test.ts` (new) — through the production execution registry at real Postgres: with a delivery provider wired the way `app.ts` wires it, an approved `create_appointment` writes sms + email `appointment_confirmation` rows to `message_dispatches`; the dormant class, constructed as `app.ts` would have to, writes the same rows; a neighbour tenant writes only its own; `appointment.created` reads back via `findByEntity`. **The criterion is conditional three ways, found in review (PR #1076, Codex).** (i) delivery mode `'none'` — no provider at all; (ii) the tenant setting below; (iii) the reachable-channel condition: `createMessageDeliveryProvider` keeps the SMS and email credential legs INDEPENDENT (`delivery-provider-factory.ts:212-240`), so prod/staging with Twilio credentials and no SendGrid boots a NON-NULL provider whose email leg throws at send time and is swallowed per channel — a customer reachable only by email then gets no confirmation at all, proven at real Postgres. A customer missing a contact method is skipped on that channel for the same reason. **Second silent skip, found in review (PR #1076, Codex):** a configured provider is NOT sufficient — `sendAppointmentNotice` returns early when the tenant has `autoSendAppointmentReminders === false` (`transactional-comms-service.ts:355`), and the dormant class carries the identical early return (`appointment-confirmation-notifier.ts:42`). Pinned as a **T3** case: the flag-off tenant gets no row while a differently-configured neighbour in the same run does. Unlike mode `'none'` this one is **owner-reachable from settings**, and one flag governs both reminders and booking confirmations. With NO provider (`createMessageDeliveryProvider` mode `'none'` — prod/staging without Twilio/SendGrid, which is **production today**) the handler falls back to `NoopSchedulingConfirmationNotifier` (`handlers.ts:381`) and writes no row, no audit event, no signal — pinned by the file's `it.fails`. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/appointment-confirmation-dispatch-3-8.test.ts` → 8/8 ✓ + 1 expected fail. PROVEN-REAL-DB, T1 → **4** on the wired path; the silent skip and the dead class → issue **#1077**, decision parked on #1000 (PR #1076) |
| **3.9** | **As J**, I want customers reminded the day before, so I stop eating no-shows | **Given** an appointment 24h out, **when** the sweep runs, **then** exactly one reminder sends, durably idempotent | **4** ↑ (T1·T3·T4) | The **owner push** is real-DB with durable idempotency; **the customer reminder is not** · **G1 2026-09-12:** `appointment-reminder-owner-push.integration.test.ts` 2/2 ✓ but **T0**, no audit event asserted, and the sweep still stubs `listTenantIds: async () => [tenant.tenantId]` (`:171`) with **no entry in `sweep-tenant-fanout.test.ts`** — a tenant-iterating sweep outside the T4 file (like accounting sync), capped at 4 regardless; customer-reminder unit 2/2 ✓ → 3 · **#1015 2026-09-12:** the appointment-reminder sweep now has its `sweep-tenant-fanout.test.ts` entry (real enumerator over 3 tenants, one throwing tenant does not abort the rest, a tenant with nothing due is untouched — T4); `appointment-reminder-owner-push.integration.test.ts` gains the second tenant (T1) and two tenants in two timezones at one instant each getting exactly their own reminder (T3), audit rows read back through `PgAuditRepository`. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 47 passed + 1 expected fail at real Postgres. PROVEN-REAL-DB → 4 (tenant-iterating row: T4 met) |
| **3.10** | **As M**, I want to book, move and cancel by talking, so I can do it between attics | **Given** any of the three spoken intents, **when** approved and executed, **then** the real row changes and **exactly one** audit event is emitted per action | **4** (T1) / **3** (T0) | **D:** `voice-inbound-appointment.test.ts`, `reschedule-appointment-voice.test.ts`, `cancel-appointment-voice.test.ts` · **G1 2026-09-12:** cancel 4/4 + reschedule 3/3 ✓ with audit, **T1** (`:268`, `:299`) → move/cancel at 4; the book leg is `voice-inbound-appointment` (T0) → 3; no reachability run backs 5 |
| **3.11** | **As M**, I want stale schedule proposals to expire, so I'm not approving yesterday's plan | **Given** an unactioned schedule proposal, **when** the TTL passes, **then** it expires and can be re-proposed | **4** ↑ (T2) | **U:** only. 🚨 **Two TTL regimes coexist** — 48h in the worker, 24h default and 4h for `create_appointment` in the guardrail · **G1 2026-09-12:** `proposal-expiry-worker.test.ts` 7/7 + `guardrails-expiration.test.ts` 9/9 ✓ — **but the 24 h / 4 h regime lives in `ai/guardrails/expiration.ts` and has zero production callers**: tested, dead code. The live TTL is the worker's 48 h; "two regimes coexist" overstates it · **dormant-rows lane (Fable gate) 2026-09-12:** D: `integration/proposal-expiry-sweep-3-11.test.ts` (new) — the WORKER's 48 h regime (`SCHEDULE_PROPOSAL_EXPIRY_MS`, `proposals/proposal.ts:109`; `runProposalExpirySweep` registered at `app.ts:6485` over the production `listAllTenantIds`) expires a 50 h-old `create_appointment` (`status = 'expired'` + `proposal.expired` audit row, actor `proposal-expiry-worker`), leaves a `draft_estimate` (no `expiresAt`) and a neighbour tenant's fresh card untouched in the same pass, and lets the operator re-propose with a fresh 48 h window; STRUCTURAL: `ai/guardrails/expiration.ts` has zero runtime importers under `src/` (scanner with a negative control that finds `app.ts` for the worker) — *two regimes* is true as source, false as behaviour. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/proposal-expiry-sweep-3-11.test.ts` → 5/5 ✓ + 1 expected fail (the desired one-regime state). PROVEN-REAL-DB + STRUCTURAL, T2 → **4**; not T4 (no failure-isolation case; the sweep has no fan-out entry) so 4 is the cap. Retire the dead module → issue **#1078** (PR #1076) |
| **3.12** | **As M**, I want to be warned when back-to-back jobs aren't drivable, so I stop promising times Carlos can't make | **Given** a proposed move, **when** drive time is checked, **then** infeasibility surfaces — flagged as unverified when the fallback is great-circle | **2** — STORY NOT MET | 🚨 **The three booking-*creation* paths call `createAppointment` with no feasibility check at all.** Only dispatch-side moves are checked · **G1 2026-09-12:** dispatch-side feasibility is tested; the production creation path `ai/scheduling/place-hold.ts:111` calls `createAppointment` with no `checkFeasibility` (which is called from `scheduling/routes.ts` and `reassignment-handler.ts` only). Gap stands, 3 · **#1015 2026-09-12:** new `place-hold-feasibility-gap.integration.test.ts`: a real-Postgres CONTROL proves `checkFeasibility` flags a real back-to-back pair as a `travel_time` warning, and an honest `it.fails` pins that the production hold path `placeAppointmentHold` (`ai/scheduling/place-hold.ts:111`) never calls it — the warning is never surfaced (issue filed; Opus wire-or-park). `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts <the 9 touched integration files>` → 9 files, 47 passed + 1 expected fail at real Postgres |

### 8.4 Dispatch

**Epic: Run the day** · **Jobs:** J1, J10

**Primary persona: M as dispatcher, which is the job title he never wanted.**

**Requirement: the tech-out cascade is per-appointment, never bulk.** Each
affected customer is a separate proposal with its own drafted message, because
the owner may want to handle one differently. Three or more offers batch
approval.

| # | User story | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **4.1** | **As M**, I want one board showing today, so I stop reconstructing the day from texts | **Given** a date, **when** the board loads, **then** it returns that day's work and **refuses cross-tenant access** | **5** ↑ (T3) | **D:** `dispatch.test.ts` · **G1 2026-09-12:** `dispatch.test.ts` 2/2 ✓, **T1** (`:95` "rejects cross-tenant access to board data"); read-only. Rung 5 had no reachability run → 4 · **owner-surfaces lane (Fable gate) 2026-09-12:** rung-5 reachability — `e2e/journeys/dispatch-board.spec.ts` drives the real `/dispatch` page for two tenants in one run: owner A (Etc/UTC) sees exactly its 2 today jobs and not tomorrow's; owner B on America/Los_Angeles with a 23:00-local job sees it on B's own board (stored 06:00Z next day) while A's board is unchanged; B's job never appears on A's board. Hermetic Playwright at a real Postgres testcontainer — jobs via the real `POST /api/jobs`, no SQL setup, no admin route, no env shortcut; rows polled during the run. `CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=<testcontainer> E2E_USE_TEST_DB=true VITE_CLERK_PUBLISHABLE_KEY=pk_test_… npx playwright test <spec> --project=chromium --retries=0` → `dispatch-board` 1 passed (twice). Reachable + T3 → **5** (PR #1085) |
| **4.2** | **As M**, I want dragging a card to *propose* a change, not make one, so a slip of the thumb can't move a customer's appointment | **Given** a drag, **when** it lands, **then** a proposal is created and **the appointment is not mutated** | **4−** ↑ (T2) reachable | `createSchedulingProposal` has **zero** integration coverage. The UI is reachable; the guarantee is not proven · **G1 2026-09-12:** `createSchedulingProposal` in 0 integration files; unit 12/12 ✓ — 3 stands · **#1017 2026-09-12:** new `test/integration/dispatch-drag-proposal.test.ts` — a drag creates a `reschedule_appointment` proposal row (status `draft`) and the appointment row is NOT mutated until approval; T1 (tenant B never sees the proposal, its own appointment untouched). REAL-DB-WRITE-ONLY: product code emits no `proposal.created` audit event for scheduling proposals (issue #1040) — the audit assertion is an `it.skip` with the gap named → 4−, 4 when #1040 lands. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/dispatch-drag-proposal.test.ts test/integration/en-route-sms-keyword.test.ts test/integration/running-late.test.ts test/integration/tech-status-sms.test.ts` → 4 files, 10 passed / 1 skipped at real Postgres · **owner-surfaces lane (Fable gate) 2026-09-12:** rung-5 reachability run — `e2e/journeys/dispatch-drag-proposal.spec.ts`: a real native drag on `/dispatch` creates a `draft` `reschedule_appointment` proposal and the `appointments` row is byte-identical before and after (polled); BOTH tenants drag in the same run, each gets exactly its own proposal in its own inbox and each appointment stays unchanged (T2). `CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=<testcontainer> E2E_USE_TEST_DB=true VITE_CLERK_PUBLISHABLE_KEY=pk_test_… npx playwright test <spec> --project=chromium --retries=0` → `dispatch-drag-proposal` 1 passed. Reachability and T2 proven; **5 withheld on the evidence class**: the product emits no `proposal.created` audit event for scheduling proposals (#1040), so the row stays REAL-DB-WRITE-ONLY 4− until that lands (PR #1085) |
| **4.3** | **As M**, I want to see when someone else is dragging the same card, so my wife and I don't fight over the board Saturday morning | **Given** two users, **when** both act, **then** revision tokens order the writes and presence shows who holds which card | **3** | Presence is in-memory/Redis — **structurally incapable** of a real-Postgres proof. Score it honestly and stop calling it 4 · **G1 2026-09-12:** `redis-presence-store.test.ts` 26/26 ✓ (in-memory/Redis); 3 is this row's ceiling unless Redis joins the Docker lane · **#1017 2026-09-12:** stays 3 by architecture — presence is `InMemoryDispatchPresenceStore` / `RedisDispatchPresenceStore` only (`dispatch/presence-store.ts:66,137-149`, `redis-presence-store.ts:53`); `grep presence db/schema.ts` → 0. No DB test written on purpose |
| **4.4** | **As Carlos (M's tech)**, I want my own day view and nobody else's, so I see my work and not the shop's books | **Given** a technician session, **when** the day loads, **then** a 23:00-local appointment lands on the tenant date and a tech of tenant B is not submittable by tenant A | 4 | **D:** `dispatch-technician-day-window.test.ts`, `technician-location-authz.test.ts` · **G1 2026-09-12:** `technician-location-authz.test.ts` 6/6 ✓, **T1** (`:76` "does not leak across tenants", 7 tenants) + `dispatch-technician-day-window.test.ts` 3/3 ✓ (T0); read/authz, 4 stands at T1 · **owner-surfaces lane (Fable gate) 2026-09-12:** rung-5 reachability NOT earned — `e2e/journeys/technician-day-view.spec.ts` proves the 23:00 America/Los_Angeles appointment lands on the tenant-local day (stored 06:00Z next day) through the owner's session, and that a technician session requesting tenant B's technician id is refused 403; but the technician's OWN day view is not reached: the hermetic api webServer forces `DEV_AUTH_BYPASS=true`, which skips the DB authorization loader, so `canonicalUserId` never resolves for an HMAC-verified technician and his own request 403s too (the page shows "Failed to load appointments"; pinned as a Playwright `test.fail()`; harness follow-up #1086). `CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=<testcontainer> E2E_USE_TEST_DB=true VITE_CLERK_PUBLISHABLE_KEY=pk_test_… npx playwright test <spec> --project=chromium --retries=0` → `technician-day-view` 1 passed + 1 expected fail. 4 (T1) stands (PR #1085) |
| **4.5** | **As Carlos**, I want "on my way" to work the same whether I tap, speak, or text it, so I don't have to remember which app | **Given** any of the four entry points, **when** fired, **then** one audited act with a TECH actor plus a customer ETA dispatch row | **4** ↑ (T1) | Voice, phone and chat legs proven. 🚨 **The SMS-keyword leg is unit-only** — the story claims four legs and proves three · **G1 2026-09-12:** `en-route-voice.test.ts` 7/7 ✓ with audit events, **T1** (`tenantB` :91/:125, cross-tenant negative) — voice/phone/chat legs at 4; the SMS-keyword leg is unit-only (141 unit tests across 9 files) → 3 · **#1017 2026-09-12:** the SMS-keyword "OMW" leg now runs at real Postgres through the real `registerEnRouteSmsKeyword` handler (`en-route-sms-keyword.test.ts`): same `appointment.en_route_triggered` audit row + `delay_notice_state` row as the app/voice/chat legs (`en-route-voice.test.ts`); T1. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/dispatch-drag-proposal.test.ts test/integration/en-route-sms-keyword.test.ts test/integration/running-late.test.ts test/integration/tech-status-sms.test.ts` → 4 files, 10 passed / 1 skipped at real Postgres → 4 |
| **4.6** | **As Carlos**, I want to tell the customer I'm running late in one tap with gloves on, so I don't pull over to type | **Given** the chip row, **when** I tap 10/20/30, **then** **the chip row *is* the confirm** — no second dialog — and a delay notice is written | **4** ↑ (T1) — CHANGED | In-memory supertest plus a jsdom test that the chip hits the right endpoint; **no real-DB write proof** · **G1 2026-09-12:** `appointments.running-late.test.ts` 9/9 + `TechnicianDayView.test.tsx` 21/21 ✓ (supertest + jsdom) — 3 stands; the grep for this row must use the hyphenated `running-late` · **#1017 2026-09-12:** `running-late.test.ts` at real Postgres: one tap writes `appointment.running_late_triggered` + a queued, consent-gated `delay_notice_state` row; T1 (a tenant-B technician cannot see or trigger it). **CHANGED (Fable):** the product sends a consent-gated notice directly, it does not raise a comms-class proposal — the acceptance criterion is re-specced to the tested behaviour; the "never auto-sent" clause holds through the consent gate, not through a proposal. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/dispatch-drag-proposal.test.ts test/integration/en-route-sms-keyword.test.ts test/integration/running-late.test.ts test/integration/tech-status-sms.test.ts` → 4 files, 10 passed / 1 skipped at real Postgres → 4 |
| **4.7** | **As M**, I want lateness detected from where the truck actually is, so I hear it before the customer does | **Given** geofence/dwell signals, **when** evaluated, **then** a lateness state with a confidence breakdown | **2** — dormant, pinned (STRUCTURAL) | 🚨 The server module's **only importer uses it as a type-only import** — the evaluator has no runtime caller in `packages/api` · **G1 2026-09-12:** lateness unit tests 24/24 ✓, but the module's only importer in `packages/api/src` is `board-query.ts` with an `import type` — no runtime caller: built and dormant, 2 (§12.4 says the same) · **dormant-rows lane (Fable gate) 2026-09-12:** confirmed and sharpened — `computeDispatchLateness` (`dispatch/lateness.ts:278`), the module's only value export, is referenced by no file under `src/` (`board-query.ts:5` binds only the result type); pinned by a scanner with a negative control in `integration/lateness-from-truck-location-4-7.test.ts` (new). What IS wired: `POST /api/technician-location` persists pings to `technician_location_pings` **and** emits `technician_location.batch_ingested` against the `technician` entity (`emitLocationBatchAudit`, `routes/technician-location.ts:106`) — both proven at real Postgres through the production router, T1, so the ingestion leg is PROVEN-REAL-DB (corrected in review, PR #1076: an earlier note here said "no audit event", which was wrong — it came from a test querying an entity type that does not exist). The audit that is genuinely absent is any lateness/delay event, on either the appointment or the technician, and `DispatchBoardItem.lateness` + the optional `getAppointmentLateness` hook (`board-query.ts:40/:91`) is a ready seam the production route never supplies — with six dwell pings on the service location the board carries `lateness === undefined` on every item. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/lateness-from-truck-location-4-7.test.ts` → 6/6 ✓ + 1 expected fail (the desired state). Stays **2**: the criterion (an evaluated lateness state) is not met; wire-or-retire is Josh's → issue **#1079**, parked on #1000 (PR #1076) |
| **4.8** | **As M**, I want one tech texting OUT to produce one proposal **per affected customer**, so I can handle the difficult one differently | **Given** a verified tech OUT, **when** processed, **then** an unavailable block, a reschedule proposal **per appointment** each carrying a brand-voiced message, and an audit row — idempotent same-day, and **an OUT from an unregistered number is not actioned** | **4** (T1) | **D:** `tech-status-sms.test.ts` · **G1 2026-09-12:** `tech-status-sms.test.ts` 3/3 ✓ with audit, single tenant → 3 · **#1017 2026-09-12:** `tech-status-sms.test.ts` gains the second-tenant assertion (tenant B's tech OUT routes to tenant B's own block + proposal) with `tech_status.recorded` / `duplicate` / `unverified_mobile` audit rows read back. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/dispatch-drag-proposal.test.ts test/integration/en-route-sms-keyword.test.ts test/integration/running-late.test.ts test/integration/tech-status-sms.test.ts` → 4 files, 10 passed / 1 skipped at real Postgres — 4 confirmed at T1 |
| **4.9** | **As M**, I want the closest certified tech assigned automatically, so I stop doing routing math in my head | **Given** a job needing a skill, **when** assignment runs, **then** only qualified techs are offered | **0** | The whole file is nine lines returning `[]`. 🚨 **And it is wired into `checkFeasibility`, so the empty skill list reads as "always feasible"** rather than as a visible gap · **G1 2026-09-12:** the nine-line stub and its `checkFeasibility` wiring confirmed; Josh (map ticket #1001): make the empty skill list an explicit audited outcome and regrade at 2 |
| **4.10** | **As M**, I want my day sequenced to cut windshield time, so I fit one more call in | — | **0** | Absent. No module, no test · **G1 2026-09-12:** out of scope (Josh, #1001; §12.7) |
| **4.11** | **As Carlos**, I want to be told when I'm assigned to something new, so I'm not surprised at 7am | **Given** an assignment change, **when** it commits, **then** the technician is notified | **4** ↑ (T1) | `setTechnicianAssignmentNotifier` has **zero production callers** (it is unit-tested — `assignment-notifications.test.ts`). Every production assignment fires a **silent no-op** — while the module's doc-comment says *"app.ts registers one notifier."* **Carlos is never notified** · **G1 2026-09-12:** `assignment-notifications.test.ts` 21/21 ✓ (unit); `setTechnicianAssignmentNotifier` has zero production callers — 2 stands · **#1010 2026-09-12:** `app.ts` now registers `TechnicianAssignmentNotifier` (push via `notifyUser`, SMS on the owner-class staff path only when a delivery provider exists). `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/assignment-notifier-wiring.test.ts` → 3/3 ✓ at real Postgres: one assignment → one push + one SMS with the `appointment.technician_assigned` audit row read back through `PgAuditRepository`; **T1** — a second tenant's technician is never notified. PROVEN-REAL-DB → 4. Review fix: `notifyUser` now honours per-user mutes like `dispatch()` (782da2f69) · **#1017 2026-09-12:** proof cited, not duplicated: `assignment-notifier-wiring.test.ts` 3/3 (PR #1029) |

### 8.5 Execute — the field

**Epic: Capture the work in the field** · **Jobs:** J5

**Primary persona: Carlos, and M when he's the tech. Gloves, daylight, one hand.**

**Requirement: the durable artifact is deleted only on confirmed flush.** The
offline queue removes local audio only after the server acknowledges, and never
attaches credentials on public paths.

| # | User story | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **5.1** | **As Carlos**, I want to use this with gloves on in the sun, so I don't take them off forty times a day | **Given** any field screen, **when** rendered at 320px, **then** every tap target is ≥44px and nothing overflows horizontally | **4** ↑ | The jsdom + Playwright contract exists for **estimate approval and review response**; 🚨 **field screens are not pinned the same way** · **G1 2026-09-12:** **NO-COMMAND** — no field-screen contract test exists; 10 adjacent tap-target/320px files pass 58/58 under Node 20 (3 fail under Node 25's localStorage stub). Rung provisional · **#1018 2026-09-12:** the field-screen contract now exists: jsdom class contracts `TechnicianDayView.layout.test.tsx` + `TechJobView.layout.test.tsx` (`cd packages/web && npx vitest run src/pages/technician/TechnicianDayView.layout.test.tsx src/components/jobs/TechJobView.layout.test.tsx` → 10/10 ✓; RED shown by flipping the class names — ≥44px `min-h-11` targets, `max-w-lg` single column, high-contrast text) and a 320px Playwright viewport spec `e2e/technician-day-mobile.spec.ts` (`npx playwright test technician-day-mobile --project=chromium-devauth` → 3 passed, 1 skipped in this run; the day view, Previous/Next, View job / On my way and the tech job screen all meet the glove target at 320px). STRUCTURAL with a negative control → 4; the browser run is `chromium-devauth` (in-memory repos), so it is a layout proof, not a rung-5 reachability claim |
| **5.2** | **As M**, I want before/after photos attached to the job, so I can defend the invoice | **Given** a captured photo, **when** stored, **then** category and before/after pairing survive the round trip | **4** ↑ (T1) | **D:** job-photo integration tests · **G1 2026-09-12:** no job-photo integration test exists under `test/integration/`; the proofs are unit — `test/jobs/job-photos.test.ts`, `test/attachments/*.test.ts`, `test/routes/attachments.route.test.ts`, 97/97 ✓ incl. "does not leak another tenant attachments" (in-memory). PROVEN-UNIT · **#1018 2026-09-12:** new `test/integration/job-photo-round-trip.test.ts` — a photo attached through the real attachment/job-photo path lands the `job_photos` row + shadow `attachments` row and the `job.photo.upload_requested` / `job.photo.attached` audit rows read back through `PgAuditRepository`; T1 — a neighbour tenant cannot list, receive, or read the photo, its rows, or its audit event. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/job-photo-round-trip.test.ts test/integration/voice-idempotency.test.ts` → 2 files, 14/14 ✓ at real Postgres. PROVEN-REAL-DB → 4 |
| **5.3** | **As Carlos**, I want to log my hours by talking, so paperwork never follows me home | **Given** a spoken duration, **when** executed, **then** a `time_entries` row lands with the resolved `jobId`, **exactly one** audit event, tenant-scoped — **and it is counted by the job-profit query** | **4** ↑ | **D:** `log-time-entry-execution.test.ts` ✅ *executed* · **G1 2026-09-12:** 4/4 ✓, **T1** (`:217` "does not expose the entry to another tenant") |
| **5.4** | **As J**, I want a note dictated in a basement with no signal to survive and arrive later, so I never lose work to dead zones | **Given** an offline capture, **when** connectivity returns, **then** the journal flushes, the same key twice yields **one** row and one effective job, a create-then-crash replay re-enqueues, and **local audio is deleted only on confirmed flush** | **4** ↑ (T1) | **D:** `voice-idempotency.test.ts` ✅ *executed* · **U:** mobile `queue/flush/audioRelocation`. *Rung 5 needs a device-level proof of the reconnect edge; none exists* · **G1 2026-09-12:** D 4/4 ✓ **T1** (`:14`, `:315`); mobile `queue/flush/audioRelocation` 35/35 ✓ — no audit event asserted: 4− class · **#1018 2026-09-12:** `voice-idempotency.test.ts` now reads the audit trail back through `PgAuditRepository` (the replay does not duplicate the create's audit rows; 6 recordings ↔ 6 distinct idempotency keys in the run). `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/job-photo-round-trip.test.ts test/integration/voice-idempotency.test.ts` → 2 files, 14/14 ✓ at real Postgres → 4 (T1). The device-level reconnect proof stays hardware-blocked (research #1002) — rung 5 parked on #1000 |
| **5.5** | **As J**, I want to take a card on the doorstep, so I get paid before I drive away | **Given** an active Connect account, **when** I tap to pay, **then** the charge completes — **and without one, a clean 409, never a silent failure** | **4** (T1) clean-409 half / **3** settlement half (T1 FAILED — #1102) · live charge parked | **U:** `stripe-terminal.test.ts`. 🚨 **No Docker-gated test** · **G1 2026-09-12:** PROVEN-UNIT 10/10 ✓ · **#1018 lane (Fable gate) 2026-09-12:** D: `integration/stripe-terminal-doorstep.test.ts` — the real `/api/terminal/connection-token` and `/api/terminal/payment-intents` routes — mounted from the real `createTerminalRouter` wired as `app.ts:5122` wires it, NOT through `createApp()` (corrected on Codex review: the production mount and its env-based Stripe configuration are therefore not covered) — at real Postgres: a tenant with no active Connect account is refused with a clean coded 409 and writes nothing (zero payments rows, zero audit rows, zero Stripe calls — the in-process Stripe REST stub records none); a neighbour's live Connect account does not satisfy the gate and its rows are byte-identical after (T1); a connected tenant's Terminal session persists the location id with its audit row; a `card_present` intent settles through the real signed `POST /webhooks/stripe` (payments row, invoice `open → paid`, `payment.recorded` + `invoice.status_changed` read back via `PgAuditRepository`), replay deduped, an unsigned delivery credits nothing, and an intent naming another tenant credits nothing (T1). Stub boundary named: only Stripe's own REST (`GET /v1/accounts/:id`, `POST /v1/terminal/locations`, `POST /v1/terminal/connection_tokens`, `POST /v1/payment_intents`); no DB and no webhook is stubbed. Negative controls as RED: the gate removed → 3 legs fail (one degrades to a 404, the silent-failure shape the story forbids); the webhook withheld → no money moves. `RLS_RUNTIME_ROLE=true EXTERNAL_TEST_DB_URL=<kept container> npx vitest run --config vitest.integration.config.ts test/integration/stripe-terminal-doorstep.test.ts` → 7/7 ✓ (with `invoice-webhook-paid.test.ts` 11/11). PROVEN-REAL-DB + STRUCTURAL, T1 → **4**. 🚨 **RUNG CONTESTED — re-grade required (Fable), raised by Codex on PR #1097 and not self-answered by this lane:** the `T1 → 4` above was stamped at `6d8f53e`, before the `it.fails` leg added at `26cdeb7` showed that **settlement is not tenant-isolated** — `event.account` is never validated (`webhooks/routes.ts:1519`), so a connected account can mark ANOTHER tenant's invoice paid (F5; a victim that never enabled Connect gets a `paid` invoice, a completed payments row and a full audit trail for money it never received). D-032 defines T1 as *"a second tenant cannot see or touch the first's rows"* and caps rung 4 on it, so the whole-row `T1 → 4` is contradicted by this commit's own test. The **409 half's T1 stands** (a neighbour's live Connect account does not satisfy this tenant's gate, its rows byte-identical after). The likely honest shape is to grade the two legs separately — the 409 half on its own evidence, the settlement half held down until the account mismatch is rejected — but **only Fable states rungs**, so the number above is left as stamped and flagged rather than rewritten by this lane. **Not proven at any rung:** a card actually presented to Stripe — `POST /v1/payment_intents` is stubbed; Stripe's server-side simulated reader (`registration_code=simulated-wpe` → `process_payment_intent` → `test_helpers/…/present_payment_method`) needs a Stripe TEST key + a Connect test account with `card_payments` → parked on #1000 (blocked-on-josh entry). Rung 5 also needs the Tap-to-Pay device leg, out of hermetic reach. Findings: a refused tap leaves no audit row (#1099); card-present settles as `credit_card` (#1098); no `stripe` npm SDK anywhere — all REST via `fetch`, no `Stripe-Version` pinned · **Fable re-grade 2026-09-13 02:30Z (answers the lane's 🚨 RUNG CONTESTED flag):** the two legs are graded separately. Clean-409 half — a neighbour's live Connect account does not satisfy this tenant's gate and its rows are byte-identical after: T1 stands → **4**. Settlement half — the lane's own `it.fails` leg (26cdeb744, on main via #1097) shows a `payment_intent.succeeded` carrying the victim's tenant + invoice on ANOTHER tenant's `event.account` marks the victim's invoice paid (F5): a second tenant can touch the first's rows, so T1 FAILS and D-032 caps the leg → **3** until the account mismatch is refused — **SECURITY #1102** (Opus fix lane, isolated branch, Josh merges); it flips back to 4 when that PR lands and the `it.fails` turns green. Note: main's copy of `stripe-terminal-doorstep.test.ts` did not parse after the #1097→#1100 merge resolution (three stale `if (url.includes(…)) {` lines beside the fail-closed matchers; `Declaration or statement expected` at 792:2) — repaired byte-for-byte to the lane head in PR #1103; at the repaired file: `stripe-terminal-doorstep` 7 ✓ + 1 expected fail (F5) with `invoice-webhook-paid` 11 ✓ at real Postgres, kept-container dump shows the never-Connected tenant's invoice `paid` / 24500 with a completed payments row and both audit rows for money it never received |

### 8.6 Narrate — the owner's spoken command line

**Epic: Let me fix it by talking** · **Jobs:** J9

**Primary persona: M driving to the next job.** This epic is the product's
actual interface thesis — *voice directs, SMS approves* (D-030).

| # | User story | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **6.1a** | **As M**, I want to talk to it from any screen without hunting for a button, so speaking is always the fastest path | **Given** any authenticated screen, **when** I press to talk, **then** the recording **uploads and is transcribed** — `POST /api/voice/recordings`, polled to completion. *Not* an SSE stream | **3** | **W:** `VoiceBar.hint.test.tsx` — proves the idle affordance renders on both variants and *"tapping the hint starts listening"*. `Shell.tsx:480,605` mounts it desktop + mobile, so "any screen" holds. 🚨 **Nothing tests the browser→upload→poll→transcript round trip** · **G1 2026-09-12:** 5/5 ✓ under Node 25 and Node 20 · **#1019 2026-09-12:** 6.1b 2 → 3: `useVoiceSession.test.ts` (7/7) and `VoiceSessionPanel.test.tsx` (8/8) now exist (`cd packages/web && npx vitest run src/hooks/useVoiceSession.test.ts src/components/assistant/VoiceSessionPanel.test.tsx` → 15/15); 6.1a stays 3 (jsdom); the `coverage-sweep` Playwright project asserts NO recorder control on any route, so the printed rung 5 was unsupported — 3 until a real-Postgres browser sweep proves push-to-talk on every authenticated screen |
| **6.1b** | **As M**, I want a live voice session when I'm working with the assistant, so I see it responding as I speak | **Given** the assistant screen, **when** a session starts, **then** an SSE event stream carries the turns | **3** ↑ | 🚨 **CODE-ONLY — zero tests.** `useVoiceSession.ts` and `VoiceSessionPanel.tsx` have none; `streamAuth.test.ts` names `useVoiceSession` only in a doc-comment. **S:** `grep -rln "useVoiceSession\|VoiceSessionPanel" packages/web/src --include=*.test.tsx --include=*.test.ts` → only `streamAuth.test.ts`, which imports neither · **G1 2026-09-12:** confirmed — `useVoiceSession` appears in no test beyond a doc-comment; `VoiceBar.tsx` has no `EventSource` · **#1019 2026-09-12:** 2 → 3 — `packages/web/src/hooks/useVoiceSession.test.ts` (7/7: `start()` posts `/api/voice/sessions` and applies session id/state/greeting; `send()` is a no-op with no active session and otherwise posts input and applies the response; `end()` resets full session-scoped state; the SSE line handler dedupes a redelivered `proposal_created` event, applies an `'ended'` event, and applies a `'transition'` event's carried `state`) and `packages/web/src/components/assistant/VoiceSessionPanel.test.tsx` (8/8) now exist; `cd packages/web && npx vitest run src/hooks/useVoiceSession.test.ts src/components/assistant/VoiceSessionPanel.test.tsx` → 15/15 ✓. **Correction (chatgpt-codex-connector, PR #1048):** all cases supply SUCCESSFUL HTTP/SSE responses only — no rejected start/send request, no auth rejection, no broken stream is exercised, so "error paths" above overstated the evidence; corrected. The `transition`-event case (added in the same review round, see the 7/7 count above) closes a separate gap the review also flagged — the original 6 cases never exercised the SSE turn contract's own `state`-carrying event, only `proposal_created`/`ended`. PROVEN-UNIT (happy-path only) → 3 |
| **6.2** | **As M**, I want what I say to become a typed, validated proposal, so a mumble can't become a malformed invoice | **Given** a spoken sentence, **when** classified, **then** a Zod-validated proposal of the mapped type is drafted with vertical context | **4** ↑ (T2) | **U:** `operator-voice-golden-path.test.ts` · **D:** `voice-inbound-appointment.test.ts` · **G1 2026-09-12:** U 7/7 ✓, D 3/3 ✓ with audit events, but `voice-inbound-appointment.test.ts` asserts no neighbour (**T0**) and no reachability run backs 5 → 3 · **#1019 2026-09-12:** `voice-inbound-appointment.test.ts`: the drafted payload passes `createAppointmentPayloadSchema`, and a low-confidence ("malformed") utterance is refused — no `create_appointment` row, only a contract-validated `voice_clarification`, isolated per tenant; golden path + audit row at real Postgres with the T2 neighbour from #1014-A. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/entity-resolution.test.ts test/integration/material-items.test.ts test/integration/update-job-execution.test.ts test/integration/voice-inbound-appointment.test.ts test/integration/voice-lookup-answer.test.ts` → 5 files, 144/144 ✓ at real Postgres → 4 |
| **6.3** | **As M**, I want to say "the Henderson job" and have it find the right one, so I don't have to know IDs | **Given** a free-text reference across nine entity kinds, **when** resolved, **then** a real row is found — or an ambiguity carrying **both** candidates | **4** (T2) | **D:** `entity-resolution.test.ts`, `chat-entity-resolution.test.ts` · **G1 2026-09-12:** 94/94 + 20/20 ✓, **T1** — six "never resolves … across tenants" cases (`:180`, `:289`, `:1658`; the falsifier's token list misses this phrasing — add `across tenants`) Read-only capability — no mutation to audit; 4 stands at T1. · **#1019 2026-09-12:** `entity-resolution.test.ts` pins that a neighbour tenant's same-named ("Henderson") job is never a resolution candidate — T1 → T2. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/entity-resolution.test.ts test/integration/material-items.test.ts test/integration/update-job-execution.test.ts test/integration/voice-inbound-appointment.test.ts test/integration/voice-lookup-answer.test.ts` → 5 files, 144/144 ✓ at real Postgres |
| **6.4** | **As M**, I want to ask where a job stands and get an answer, not a proposal, so a question doesn't create work | **Given** a status question, **when** dispatched, **then** a spoken answer and **no proposal minted** | **4** ↓ (T1) | **D:** `update-job-execution.test.ts` · **G1 2026-09-12:** 11/11 ✓, **T1** (`:228`); rung 5 had no reachability run behind it → 4 · **#1019 2026-09-12:** negative assertions added at real Postgres in `update-job-execution.test.ts` (the file the map names; the read story lives in `ai/skills/lookup-jobs.ts`): `lookupJobs()` answers with the real status, `proposals` count is 0 before AND after, the job row is byte-for-byte unchanged. **Review fix (xhawk-ai, PR #1048):** the direct `lookupJobs()` call can't catch a router-level regression (a `lookup_jobs` utterance mis-routed into the proposal-drafting path) — added a second test driving the REAL `createVoiceActionRouterWorker` with a scripted `lookup_jobs` classification and a real `PgProposalRepository`, confirming the answer lands on a real `voice_recordings` row and the proposals count still never moves. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/entity-resolution.test.ts test/integration/material-items.test.ts test/integration/update-job-execution.test.ts test/integration/voice-inbound-appointment.test.ts test/integration/voice-lookup-answer.test.ts` → 5 files, 144/144 ✓ at real Postgres — 4 (T1) confirmed |
| **6.5** | **As M**, I want to add a line to an existing quote by talking, so I don't reopen a laptop for two hours of labor | **Given** *"add two hours of labor to the Garcia estimate"*, **when** executed, **then** the line persists at qty 2 / unit hour and totals recompute in integer cents on the real row | **4** ↑ | **D:** `update-estimate-execution.test.ts` · **G1 2026-09-12:** 3/3 ✓, **T1** (`:389` cross-tenant negative) |
| **6.6** | **As Carlos**, I want notes, expenses, mileage, materials and time to all work by voice, so the truck *is* the back office | **Given** *"$40 in parts for the Henderson job"*, **when** executed, **then** the expense carries `job_id` and **counts in job P&L**; two Henderson jobs **clarify**; no job mention logs **unlinked** and P&L does not count it. A dictated note persists with **exactly one** audit event | **4** ↑ | **D:** `add-note-voice-execution.test.ts`, `log-expense-job-link.test.ts` ✅ *executed* · **G1 2026-09-12:** 3/3 + 3/3 ✓, **T1** (`add-note-voice-execution.test.ts:179`) · **#1019 2026-09-12:** grading only — `add-note-voice-execution.test.ts` carries the T1 negative; `log-expense-job-link.test.ts` has ZERO cross-tenant assertions (0 grep matches): the weakest file in the row, next candidate for a neighbour |
| **6.7** | **As M**, I want to ask for my numbers out loud and hear them, so I don't open a dashboard at a red light | **Given** a lookup, **when** answered, **then** a two-phase contract (`completed` + `pending`, then answered), **write-once** against a redelivered stamp, `failed` stays retryable, tenant-isolated, out-of-enum refused by a DB CHECK | **4** (T2) | **D:** `voice-lookup-answer.test.ts` ✅ *executed* · **G1 2026-09-12:** 6/6 ✓, **T1** (`otherTenant` :131) Read-only lookup — no mutation to audit; 4 stands at T1. · **#1019 2026-09-12:** `voice-lookup-answer.test.ts` — two tenants with different balances each hear their OWN computed figures in one run (real invoices: 4500¢ vs 999900¢) — T1 → T2. **Correction (chatgpt-codex-connector, PR #1048):** the PRD's own tenant-grade legend reserves T3 for two tenants with DIFFERENT SETTINGS, not merely different data — two tenants differing only in invoice balance is aggregate non-interference, textbook **T2**; the initial #1019 stamp of T3 overstated the evidence and is corrected here. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/entity-resolution.test.ts test/integration/material-items.test.ts test/integration/update-job-execution.test.ts test/integration/voice-inbound-appointment.test.ts test/integration/voice-lookup-answer.test.ts` → 5 files, 144/144 ✓ at real Postgres |
| **6.8** | **As M**, I want to say "the house on Elm" and have it resolve, because that's how I think about jobs | **Given** a spoken address, **when** resolved, **then** it matches a service location | **0** | 🚨 **No `place` entity kind exists anywhere in the product** · **G1 2026-09-12:** parked (Josh, map ticket #1001) |
| **6.9** | **As Carlos**, I want to say "three-quarter copper, twenty feet" and have both number and unit stick, so the parts list is usable | **Given** quantity and unit, **when** stored, **then** both round-trip; `listPending` scopes by job, orders by `needed_by`, excludes NULL bounds, and breaks ties on insertion order | **4** ↑ (T1) | **D:** `material-items.test.ts` ✅ *executed*. **Correction to the PRD:** a job-level parts domain **does** exist (`material_items`, migration 272) · **G1 2026-09-12:** 25/25 ✓, **T1** (`:368`); write proven at real Postgres, no audit event asserted → 4− (the printed 3 undersold it) · **#1019 2026-09-12:** `material-items.test.ts` now reads the `material.requested` audit row back through `PgAuditRepository` (number AND unit on the real row); T1 kept. **Review fix (chatgpt-codex-connector, PR #1048):** the drafting leg originally hand-fed `materialDescription`/`materialQuantity` straight into `AddMaterialTaskHandler`'s `existingEntities`, which cannot catch a classifier regression that drops "feet" or mis-parses "twenty" (the handler only copies those fields, never parses the transcript). Redrafted through the REAL `createVoiceActionRouterWorker` with a scripted classifier reply instead, proving the extracted entities survive `entitiesForProposal` onto the persisted payload unchanged. `EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/entity-resolution.test.ts test/integration/material-items.test.ts test/integration/update-job-execution.test.ts test/integration/voice-inbound-appointment.test.ts test/integration/voice-lookup-answer.test.ts` → 5 files, 144/144 ✓ at real Postgres → 4 |

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
| **7.1** | **As M**, I want a quote drafted from the call that already happened, so I'm not re-typing what the customer told the AI | **Given** a spoken description **or** a customer photo, **when** drafted, **then** a real estimate/proposal row persists **plus** its audit event | **4** ↓ (T1) | **D:** `draft-estimate-execution.test.ts`, `mms-to-quote.int.test.ts` · **G1 2026-09-12:** `draft-estimate-execution.test.ts` 4/4 ✓ with audit, **T1** (`:264`); `mms-to-quote.int.test.ts` 3/3 ✓ (T0). Rung 5 had no reachability run → 4 (MMS leg 3) |
| **7.2** | **As M**, I want every price to come from *my* price book, and anything it can't find flagged, so the AI never invents a number | **Given** a drafted line, **when** grounded, **then** the catalog price is stamped into JSONB and `missingFields` cleared — **and any uncatalogued line caps confidence below the auto-approve floor** | **3** (T0) / **3** | Grounding proven. 🚨 **The confidence cap is not** — *the half that protects M from quoting a number he can't defend* · **G1 2026-09-12:** grounding is proven by `invoice-pricing-source.test.ts` (I4), which is single-tenant → 3; the confidence cap has **no test at all** — every grep hit is an unrelated feature (NO-COMMAND) · **#1012 2026-09-12:** G1's "no test at all" was wrong — the cap IS tested: `npx vitest run test/ai/resolution/catalog-resolver.test.ts` → 84/84 ✓, incl. "the uncatalogued confidence cap sits below the 0.9 auto-approve threshold" and "(a) uncatalogued line forces draft even when a tenant lowers the auto-approve threshold to 0.5" (`:676`, pre-existing, PR #820). PROVEN-UNIT with the consumer wiring simulated in the test → 3; no real-DB leg exists for a pure function |
| **7.3** | **As M**, I want doubt shown on the specific line that earned it, so I know where to look | **Given** a mixed document, **when** rendered, **then** each line carries its own `pricingSource`, an invalid one is refused by a DB CHECK on a raw UPDATE, and a badge renders per line | **4** ↓ (T1) | **D:** `estimates.test.ts -t "pricing_source"` · **W:** `AIProposalCard.test.tsx` · **G1 2026-09-12:** `AIProposalCard.test.tsx` 30/30 ✓ + `integration/estimates.test.ts` 10/10 ✓, **T1** (`:254` "rejects cross-tenant access"); read-only. Rung 5 had no reachability run → 4 |
| **7.4** | **As M**, I want good/better/best tiers, so I stop leaving money on the table | **Given** three tiers with add-ons, **when** persisted, **then** all tier rows and the accepted selection survive | **4** ↑ (T1) | Write proven; **audit leg is `InMemoryAuditRepository`** · **G1 2026-09-12:** `estimate-phases.test.ts` 11/11 ✓ — `InMemoryAuditRepository` ×10, single tenant, expiry worker fed a one-element `listTenantIds` stub → 3; the audit-repo swap alone would give 4− at T0 · **#1012 2026-09-12:** `estimate-phases.test.ts` clone test now reads the `estimate.cloned` audit row back through `PgAuditRepository` and asserts cross-tenant `findById` null (T1); the auto-expiry worker is proven on the REAL tenant enumerator in `sweep-tenant-fanout.test.ts` (estimate-expiry entry: every tenant reached, one throwing tenant does not abort the rest, a tenant with nothing to expire is untouched — T4) and expires two tenants' estimates in one pass with a per-tenant `estimate.expired` audit row. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/estimate-phases.test.ts test/integration/sweep-tenant-fanout.test.ts test/integration/estimate-stale-revision.test.ts test/integration/negotiation-guardrail.test.ts` → 4 files, 36/36 ✓ at real Postgres (`PgAuditRepository` read-back). PROVEN-REAL-DB → 4 |
| **7.5** | **As M**, I want the headline price to be the option I recommended, not the sum of all three, so the customer isn't scared off by a number I never quoted | **Given** tiers, **when** the total renders, **then** it equals the **default selection**, strictly less than the sum of all tiers | **4** ↑ (T1) | Shares its single assertion with 7.4 · **G1 2026-09-12:** same file, same assertion → 3 · **#1012 2026-09-12:** accepted total recomputed from the selection and `accepted_selection` persisted on the real row, `public_estimate.approved` audit row read back, and the accepted estimate + its audit rows invisible under a second tenant (T1). `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/estimate-phases.test.ts test/integration/sweep-tenant-fanout.test.ts test/integration/estimate-stale-revision.test.ts test/integration/negotiation-guardrail.test.ts` → 4 files, 36/36 ✓ at real Postgres (`PgAuditRepository` read-back) → 4. The headline-over-default-selection half stays unit (`billing-engine.test.ts:181-199`) |
| **7.6** | **As M**, I want the customer to approve and sign from a link with no login, so approval isn't blocked by a password reset | **Given** a token link, **when** the customer approves with a signature, **then** acceptance and the signature both persist | **5** ↑ (T2) / **5** ↑ (T2) | Token approval proven. 🚨 **The signature is not** — the only integration reference *sets it as fixture data* and never asserts the round trip · **G1 2026-09-12:** same file — token approval at real Postgres, single tenant, audit in memory → 3; no test names "signature" — the round trip is still fixture data → 2 · **#1012 2026-09-12:** no longer fixture data — the public approval path is driven with `acceptedByName`/`signatureData`/`ip`/`userAgent` and all four are read back from the real `estimates` row (`accepted_by_name`, `accepted_by_ip`, `accepted_user_agent`, `accepted_signature_data`) with its audit row; invisible under a second tenant (T1). Service layer, HTTP hop not exercised. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/estimate-phases.test.ts test/integration/sweep-tenant-fanout.test.ts test/integration/estimate-stale-revision.test.ts test/integration/negotiation-guardrail.test.ts` → 4 files, 36/36 ✓ at real Postgres (`PgAuditRepository` read-back) → 4 · **public-surfaces lane (Fable gate) 2026-09-12:** rung-5 reachability — `e2e/journeys/public-estimate-approve-sign.spec.ts` at a real Postgres testcontainer through the real API: the owner creates and sends a tiered estimate, the customer opens `/e/:token` in a real 390×844 browser, picks Premium, draws a signature on the canvas and submits; acceptance, `acceptedByName`, `acceptedSignatureData` (a real PNG data URL), IP and user agent persist and `public_estimate.approved` lands in `audit_events`; the owner's `convert-to-invoice` then writes `estimate.converted`; a stale-revision submit is refused 409 and the row stays `sent`; tenant B's token opens only tenant B's estimate (T2). `DB_SSL=false DATABASE_URL=<testcontainer> E2E_USE_TEST_DB=true VITE_CLERK_PUBLISHABLE_KEY=pk_test_… npx playwright test <spec> --project=chromium --retries=0` → `public-estimate-approve-sign` 1 passed here after the lane replaced the retried mouse stroke with dispatched pointer events (it had failed twice here at the canvas step). → **5** both halves (PR #1087) |
| **7.7** | **As M**, I want a customer who approves an old version to be stopped, so nobody holds me to a price I already revised | **Given** a revised estimate, **when** approval arrives with the stale version, **then** it is **rejected** and the status stays `sent`; with the current version it is accepted | **4** ↑ (T1) | **A guard deciding which price M is legally bound to has never touched a real database** · **G1 2026-09-12:** PROVEN-UNIT — `estimate-revise-lock`, `public-estimate-service`, `line-item-normalization`, `estimate-reminder-worker` 80/80 ✓ · **#1012 2026-09-12:** new `test/integration/estimate-stale-revision.test.ts` — production `reviseEstimate` bumps `version`; a stale `expectedVersion` accept is refused with the mapped `ConflictError`, no state change, no phantom accept audit alongside the genuine `estimate.revised` row; enforced independently for a second, wholly separate tenant with cross-reads null both ways (T1). `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/estimate-phases.test.ts test/integration/sweep-tenant-fanout.test.ts test/integration/estimate-stale-revision.test.ts test/integration/negotiation-guardrail.test.ts` → 4 files, 36/36 ✓ at real Postgres (`PgAuditRepository` read-back) → 4 |
| **7.8** | **As M**, I want exactly one accepted estimate per job, so I can't accidentally have two live prices | **Given** two concurrent approvals on one job, **when** they race, **then** exactly one is accepted — **and the loser gets a clean conflict, not a 500** | **4** ↑ (T1) | The race **is** genuinely tested against the real partial unique index. 🚨 **The conflict mapping is not** — the test never inspects the rejected settlement · **G1 2026-09-12:** same file — the partial-unique-index race is real but single-tenant with an in-memory audit leg; no test inspects the rejected settlement → 3 · **#1012 2026-09-12:** the concurrent-approval test now inspects the rejected settlement (`ConflictError` matching `/already.*accepted/i`), asserts exactly one `public_estimate.approved` audit row, and that the other tenant's `findByJob` is empty (T1). `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/estimate-phases.test.ts test/integration/sweep-tenant-fanout.test.ts test/integration/estimate-stale-revision.test.ts test/integration/negotiation-guardrail.test.ts` → 4 files, 36/36 ✓ at real Postgres (`PgAuditRepository` read-back) → 4 |
| **7.9** | **As J**, I want a deposit before I order parts, so I'm not financing the customer | **Given** `before_approval` and an unpaid deposit, **when** the customer approves, **then** it is **blocked** and the estimate stays `sent` | **4** ↑ (T1·T3) | `after_approval` proven. 🚨 **The `before_approval` block and the fixed-amount rule are in-memory only** · **G1 2026-09-12:** same file — `after_approval` at real Postgres, single tenant, audit in memory → 3; `before_approval` and the fixed-amount rule remain unit-only · **#1012 2026-09-12:** `before_approval` refuses acceptance until the deposit is paid, then allows (mapped `ConflictError`), and the fixed-amount rule caps the required deposit at the estimate total — both end-to-end through `PublicEstimateService.approve` at real Postgres; a second tenant with NO deposit rule accepts in the same run (T1·T3). No pricing/deposit defect found. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/estimate-phases.test.ts test/integration/sweep-tenant-fanout.test.ts test/integration/estimate-stale-revision.test.ts test/integration/negotiation-guardrail.test.ts` → 4 files, 36/36 ✓ at real Postgres (`PgAuditRepository` read-back) → 4 |
| **7.10** | **As M**, I want unviewed quotes chased automatically, so my pipeline doesn't die of silence | **Given** concurrent nudges for one estimate, **when** dispatched, **then** exactly one send, cadence advances once, audit rows written, a 48h cooldown respected, and a crash mid-send recovers | **4** ↓ (T1·T4) | **D:** `estimate-nudge.test.ts` — *nine real-DB tests* · **G1 2026-09-12:** `estimate-nudge.test.ts` **16** tests ✓ (not nine), audit assertions ×6 with two residual `InMemoryAuditRepository` refs, **T1** (`:682`, `:763`), **T4** via the `estimate-reminder sweep` fan-out entry. Rung 5 had no reachability run → 4 |
| **7.11** | **As M**, I want a second pair of eyes on a quote before it goes out, so an obvious pricing mistake gets caught | **Given** any quote reaching an owner-facing dispatch, **when** it does, **then** exactly one supervisor review exists first | 3 | Annotations persist with a real `ai_run_id` FK. 🚨 **But the gate reaches 2 of 93 origins and cannot hold a pricing anomaly in any mode — see E10.18** · **G1 2026-09-12:** `getSupervisorReviewGate()` → definition + 2 call sites confirmed; `integration/supervisor-reviews.test.ts` exists for the annotations. 3 stands; parked on O-9 |
| **7.12** | **As M**, I want the AI to refuse to negotiate and hand it to me instead, so it never discounts my work | **Given** a discount request, **when** handled, **then** a capture-class owner callback in `ready_for_review` with **zero** customer-facing dispatch and no concession | **4** ↑ (T1) | **All in-memory.** The one integration file tests the context read, not the guardrail · **G1 2026-09-12:** `negotiation-invariant.test.ts` 3/3 ✓ (in-memory) — 3 stands · **#1012 2026-09-12:** new `test/integration/negotiation-guardrail.test.ts` — the settings-driven ALLOW decision (floor 15000¢, quoted 25000¢, 800 bps) and its `negotiation.discount_evaluated` audit row land at real Postgres and are invisible under a second tenant (T1). Caveat: the callback proposal row itself is test-authored and only the ALLOW branch is covered — the REFUSE branch stays unit (`negotiation-invariant.test.ts`). `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/estimate-phases.test.ts test/integration/sweep-tenant-fanout.test.ts test/integration/estimate-stale-revision.test.ts test/integration/negotiation-guardrail.test.ts` → 4 files, 36/36 ✓ at real Postgres (`PgAuditRepository` read-back) → 4 for decision + audit |

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
| **8.1** | **As J**, I want to invoice by saying one sentence, so I bill before I drive away | **Given** a spoken invoice, **when** approved and executed, **then** a real invoice row with integer-cent totals and **exactly one** `invoice.created` audit event | **4** ↓ (T1) | **D:** `draft-invoice-execution.test.ts` · **G1 2026-09-12:** `draft-invoice-execution.test.ts` 9/9 ✓ with audit events, **T1** (`:197`); rung 5 had no reachability run → 4 · **#1023 2026-09-12 (grading):** `grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" test/integration/draft-invoice-execution.test.ts` → one match, `:197` a scoped-read refusal — **T1** confirmed, short of T2; 4 stands, 5 waits on the browser lane (#1025) |
| **8.2** | **As M**, I want the invoice to bill exactly the tier the customer chose, so I don't bill for options they declined | **Given** a tiered accepted estimate, **when** converted, **then** the invoice lines equal `accepted_selection` **only** | **4** ↑ (T1) | Linkage and idempotency proven at real DB. 🚨 **Selection fidelity — the actual story — is in-memory only** · **G1 2026-09-12:** PROVEN-UNIT — convert-estimate, estimate-lifecycle, estimate, public-estimate-service 100/100 ✓ (all in-memory) · **#1023 2026-09-12:** D: `integration/tier-billed-exactly.test.ts` (new) — a good/better/best estimate accepted through the real `PublicEstimateService.approve` and converted through `convert-estimate.ts:67`: the upgrade case bills 32500 and the declined tiers are absent **as rows** in `invoice_line_items`, with one `estimate.converted` row carrying `totalCents: 32500`; the down-tier case bills 15000 and not the declined add-on; two tenants pick Best and Good in one run and each invoice bills its own choice. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/tier-billed-exactly.test.ts` → 3/3 ✓. Selection fidelity is now PROVEN-REAL-DB, T1 → **4** (PR #1053) |
| **8.3** | **As M**, I want a completed job to offer me an invoice, so nothing ages unbilled | **Given** a job transitioning to completed, **when** it commits, **then** `completed_at` is stamped **and** completion effects auto-draft an invoice proposal | **4** ↑ | **D:** `update-job-execution.test.ts` · **G1 2026-09-12:** `update-job-execution.test.ts` 11/11 ✓ with audit, **T1** (`:228`) — 4 stands; note the completed-transition test logs *auto-invoice completion effects SKIPPED as not wired* (`auto_invoice_on_completion` defaults false; its control is map ticket #1010) · **#1010 2026-09-12:** control lit — `auto_invoice_on_completion` (with `bill_labor_from_time_entries`, `batch_invoice_enabled`, `milestone_billing_enabled`) is a toggle in Settings › Payments & billing writing `PUT /api/settings`; `e2e/journeys/revenue-cluster-toggles.spec.ts` — `CLERK_DEV_HMAC_TOKENS=true E2E_USE_TEST_DB=true DB_SSL=false DATABASE_URL=<testcontainer> npx playwright test accept-invitation digest-toggle revenue-cluster-toggles --project=chromium` → 4 passed (48.1s), real Postgres, chromium project. Rung unchanged at 4 (T1): the toggle→complete-job→draft-invoice-proposal loop is the §8.8 move ticket's reachability proof · **#1023 2026-09-12 (grading):** `update-job-execution.test.ts` grep → `:228` (cross-tenant write attempt refused, row untouched) and `:759` (borrowed jobId stays gated on the voice path) — **T1** confirmed, a refusal rather than two tenants served in one pass; 4 (T1) stands |
| **8.4** | **As M**, I want the customer to pay from a link on their phone, so I stop chasing checks | **Given** a payable invoice, **when** a link is issued, **then** it persists only on a payable, unchanged, link-free invoice — and a signed `checkout.session.completed` flips it to paid | **5** ↑ (T2) — webhook settlement; Elements UI unreachable hermetically | **D:** `payment-credit-guards.test.ts`, `invoice-webhook-paid.test.ts`. *Embedded elements are jsdom-only* · **G1 2026-09-12:** `payment-credit-guards.test.ts` 8/8 + `invoice-webhook-paid.test.ts` 3/3 ✓ — single tenant, no audit event asserted → 3; the embedded-elements half stays jsdom · **public-surfaces lane (Fable gate) 2026-09-12:** rung-5 reachability — `e2e/journeys/public-invoice-pay-link.spec.ts`: the owner issues, sends and mints a payment link (idempotent re-mint returns the same URL), the customer opens `/pay/:token` in a real browser, a signed `checkout.session.completed` posted to the real `/webhooks/stripe` settles it, the reloaded page reads Paid; rows polled here during the run: tenant A `INV-0001` → `paid`, `amount_due_cents 0`, `payment.recorded` + `invoice.status_changed` + `invoice.payment_link_deactivated` once each; a post-paid re-mint is refused 409; tenant B's `INV-0001` stays `open` (T2). Honest boundary: the embedded Stripe `<PaymentElement>` cannot render without `STRIPE_SECRET_KEY` (server 503s `STRIPE_NOT_CONFIGURED`), so the page's "Online payment is temporarily unavailable" state is what the browser leg asserts; settlement is proven the way the story's own wording anticipates. `DB_SSL=false DATABASE_URL=<testcontainer> E2E_USE_TEST_DB=true VITE_CLERK_PUBLISHABLE_KEY=pk_test_… npx playwright test <spec> --project=chromium --retries=0` (+ `STRIPE_WEBHOOK_SECRET`) → `public-invoice-pay-link` 1 passed ×3 here. → **5** (PR #1087) · **#1022 2026-09-12:** `invoice-webhook-paid.test.ts` — the real signed `checkout.session.completed` branch (`webhooks/routes.ts:1170` → `recordPayment` `:1308`) now reads back the settlement's `payment.recorded` and the single `open → paid` `invoice.status_changed`; a replay leaves ONE `payment.recorded`; **negative control:** an event naming a neighbour tenant with this tenant's invoice id credits nothing, writes no row under either tenant, and is not ACKed (HTTP 500, `webhook_events` `failed`, so Stripe retries — observation #1060); each tenant's own event credits only its own invoice. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/invoice-webhook-paid.test.ts` → 4/4 ✓. PROVEN-REAL-DB with audit, T1 → **4**; rung 5 is the hermetic public-pay browser journey (separate lane); embedded elements stay jsdom (PR #1055) |
| **8.5** | **As M**, I want ACH, cards on file and card-present all to settle correctly, including when they fail later | **Given** an ACH `processing → succeeded`, **then** one completed payment + paid invoice + audit chain; **given** `processing → payment_failed`, **then** the in-flight credit reverses and the invoice reopens; **given** a duplicate delivery, **then** no double-credit | **4** (ACH, T1) / **4−** (card on file, T1) / **3** (off-session) / **3** (card-present) | ACH is strong in all three directions. 🚨 **Card-present has no Docker-gated test; charging a stored card off-session has none at all** — storage round-trips, nothing proves money lands · **G1 2026-09-12:** ACH: `ach-webhook.test.ts` 4/4 ✓ with audit, **T1** (`:244`, cross-tenant/RLS) — 4 holds. Stored card: `customer-payment-methods.test.ts` 5/5 ✓ (**T1** `:77`, no audit event) proves storage at 4−; charging off-session is unit-only against a mocked `fetch` (`stripe-saved-card.test.ts`) → 3. Card-present: `stripe-terminal.test.ts` 10/10 ✓, mocked → 3 · **#1022 2026-09-12:** ACH re-run unchanged (`ach-webhook.test.ts` 4/4 ✓, audit chain via `findByCorrelation`, T1 `:244`) — 4 confirmed. **Card on file cannot take its audit read-back: saving a card emits no audit event anywhere** (`webhooks/routes.ts:1074-1139` logs with `logger.info` only; no `payment_method.*` event type, no `entityType: 'payment_method'` in `src`) — a money-code change, issue **#1057**; stays 4− (T1). Off-session (`stripe-saved-card.ts:184`, stubbed `fetch`) and card-present (`stripe-terminal.ts:236`, stubbed `fetch`; hardware) stay 3 — no Stripe test-mode key and no cassettes in the repo (the record/replay layer is LLM-only); parked on #1000 (PR #1055) |
| **8.6** | **As M**, I want two payments arriving at once to both count, so my balance is never wrong | **Given** a $100 cash entry racing a $150 ACH webhook, **when** both commit, **then** both credit with no lost update; two concurrent full-balance payments credit **exactly once**; the SQL cap rejects a credit that no longer fits | **4** ↑ (T1) | **D:** five Docker-gated files, nine tests — **the best-evidenced row in the money surface** · **G1 2026-09-12:** the concurrency cluster found by name is three files / seven tests (`payment-concurrent-credit` 1, `payment-duplicate-race` 3, `payment-reversal-concurrent` 3 — the "five files, nine tests" was not re-derived), all ✓, all single-tenant with no audit event asserted → 3 · **#1022 2026-09-12:** the three-file cluster now reads its audit leg back and meets a neighbour — `payment-concurrent-credit.test.ts`: both racing credits carry `PgAuditRepository`, one `payment.recorded` per credit matched to its `payments` row, a neighbour tenant races its own payment in the same `Promise.all` and never lands on this balance; `payment-duplicate-race.test.ts`: a replayed intent leaves exactly ONE `payment.recorded` and the SAME provider reference in a neighbour credits only that tenant (the partial unique index is `(tenant_id, reference_number)`); `payment-reversal-concurrent.test.ts`: `payment.reversed` read back beside the raced credit's row, and a neighbour can neither reverse this tenant's payment nor appear on its trail. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/payment-concurrent-credit.test.ts payment-duplicate-race.test.ts payment-reversal-concurrent.test.ts` → 2/2 + 4/4 + 4/4 ✓. PROVEN-REAL-DB with audit, T1 → **4** (PR #1055) |
| **8.7** | **As M**, I want voiding an invoice to kill its payment link immediately, so nobody pays an invoice I cancelled | **Given** a void, **when** it commits, **then** `stripe_payment_link_id`/`_url` are NULL on the persisted row, in-flight intents are cancelled, and a `payment_link.deactivated` audit event is written | **4** ↑ (T1) | The *consequences* of void are proven at real DB (a voided invoice takes no credit). 🚨 **The deactivation itself is proven only against a mock provider — the exact scenario this story exists to prevent** · **G1 2026-09-12:** PROVEN-UNIT — invoice-payment-link, payment, invoice-payment-intent-cancel, P5-010D 67/67 ✓ (fake provider) · **#1022 2026-09-12:** D: `integration/invoice-void-payment-link.test.ts` (new) — the production `transitionInvoiceStatus` (`invoice.ts:583/599`) at real Postgres: `stripe_payment_link_id`/`_url` go NULL on the persisted row as `status` becomes `void`, `invoice.payment_link_deactivated` carries the link id + `reason: 'voided'`, `invoice.payment_intent_canceled` carries `pi_live_secret` only (the terminal `succeeded` intent is skipped), the `*_failed` events are asserted absent, a neighbour's live link survives and its void cannot be driven cross-tenant. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/invoice-void-payment-link.test.ts` → 3/3 ✓. Persistence + audit legs PROVEN-REAL-DB, T1 → **4**; **the Stripe-side call is recorded against the in-repo `MockPaymentLinkProvider` (+ a test-local intent-capable fake), not proven** — the real deactivation needs a test-mode key (#1000) (PR #1055) |
| **8.8** | **As M**, I want a refund to adjust the record without lying about what happened, so my books stay honest | **Given** two concurrent deliveries of one `stripe_refund_id`, **when** processed, **then** `amount_refunded_cents` increments **exactly once**, one claim row exists, and the status is **never flipped** | **4** ↑ (T1) | **D:** `payment-refunds.test.ts` — *interleave, stranded-claim, RLS and migration-backfill all covered* · **G1 2026-09-12:** `payment-refunds.test.ts` 5/5 ✓, **T1** (`:210` "refund claims are invisible to another tenant"), no audit event asserted → 4− · **#1022 2026-09-12:** `payment-refunds.test.ts` — the P0-4 interleave reads back exactly TWO `payment.refunded` rows for two applied refunds (`3000/3000`, `2000/5000`, correlated by refund id; the deduped redelivery returns before the audit write); the raw `payments` row keeps `amount_cents = 10000` and `status = completed` — only `refunded_amount_cents` moves; the neighbour's rejected attempt writes neither a claim row nor an audit row. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/payment-refunds.test.ts` → 5/5 ✓. Audit leg closed: PROVEN-REAL-DB, T1 → **4** (PR #1055) |
| **8.9** | **As M**, I want overdue invoices chased on a schedule **and never chased twice**, so I don't damage a relationship over a duplicate text | **Given** an invoice 15 days past due, **when** swept twice, **then** exactly **three** dunning rows exist with `step_key IN ('3:sms','7:sms','14:sms')` and a duplicate insert of `'7:sms'` raises 23505 | **4** ↑ (T1·T4) | **Every cadence test uses an in-memory ledger.** The only real-DB dunning test keys on `manual:<proposalId>`. **Nothing proves the cadence key has ever met the real `UNIQUE` index** — and a duplicate sweep double-texting a customer about money is exactly the failure this story exists to prevent. **The largest single overclaim in the product** · **G1 2026-09-12:** `payment-reminder-dedup.test.ts` 5/5 ✓ (**T1** `:250`) keys on `manualReminderStepKey(proposalId)`; the cadence key (`3:sms`…) is tested only in memory (dunning-config, late-fee, estimate-nudge 37/37, with a hand-coded `23505`) — 3 stands, overclaim confirmed · **#1023 2026-09-12:** D: `integration/dunning-cadence.test.ts` (new) — an invoice **15 days past due, swept twice** (the criterion verbatim) on a 3/7/14-SMS cadence yields ledger rows `3:sms`/`7:sms`/`14:sms` in `invoice_dunning_events` at the real `UNIQUE (tenant_id, invoice_id, kind, step_key)`, three `send_payment_reminder` proposals and three `invoice.dunning_proposed` rows via `PgAuditRepository.findByEntity`; the duplicate `7:sms` — the key the criterion names — is a **raw INSERT on a pool client** refused with `23505` by the index itself (no repository, no hand-coded error); three sweeps leave two rows; a boundary pair pins the step's offset day in both directions (13 days past due → only `3:sms`/`7:sms`; exactly 14 → all three), guarding `elapsed < step.offsetDays` at dunning-schedule.ts:56; a second tenant on a 5-day-email cadence is chased on its own steps and cannot read the first's ledger. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/dunning-cadence.test.ts` → 5/5 ✓ (RED first on every assertion). T4: `sweep-tenant-fanout.test.ts` gains an `overdue-invoice (dunning) sweep` entry (real enumerator, failure isolation, a not-yet-due neighbour untouched) → 27/27 ✓. PROVEN-REAL-DB, T1·T4 → **4**; the overclaim is closed. Rung 5 needs the owner-facing cadence control reached in a browser (PR #1053) |
| **8.10** | **As M**, I want late fees applied consistently and capped, so I'm firm without being punitive | **Given** a re-executed `apply_late_fee`, **when** it runs again, **then** no second fee line appears on the real invoice; **and** a fee exceeding the cap is clamped | **4** ↑ (T1) | **D:** `late-fee-idempotency.test.ts`, `voice-collections-execution.test.ts`. *The cap is unit-only* · **G1 2026-09-12:** `voice-collections-execution.test.ts` 3/3 ✓ with audit, **T1** (`:295`) → 4; `late-fee-idempotency.test.ts` 1/1 ✓ single tenant, no audit event → 3; the cap is unit-only; rung 5 had no reachability run · **#1023 2026-09-12:** `late-fee-idempotency.test.ts` extended — the re-execution now reads back exactly one `invoice.late_fee_applied` (`{stepKey:'initial', feeCents:2500, newAmountDueCents:17500}`); a second tenant takes its own fee (84000) while a foreign proposal is refused *not found in this tenant*; **the cap half is now at real DB through the real sweep** (`overdue-invoice-worker.ts:352` → `late-fee.ts:70-71`): flat 5000 with cap 2000 leaves one 2000 `Late fee` line and `amount_due_cents = 102000`, a re-sweep and a re-execution add nothing. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/late-fee-idempotency.test.ts` → 3/3 ✓. Both halves PROVEN-REAL-DB, T1 → **4** whole; the voice-collections leg keeps G1's T1 (PR #1053) |
| **8.11** | **As M**, I want to bill a big job in stages, so cash flow matches the work | **Given** a 3-milestone schedule on a total that doesn't divide evenly, **when** split, **then** Σ milestones === total, with the remainder milestone absorbing every stray cent | **4** ↑ (T1) | **Unit only** · **G1 2026-09-12:** PROVEN-UNIT — 7 files 77/77 ✓ (`buildInvoiceSchedule` + in-memory repo) · **#1010 2026-09-12:** control lit — Milestone billing toggle (same spec as 8.3, 4 passed); copy corrected on review: milestones are drafted directly as numbered invoices, no approval step (`schedule-completion.ts`; 58121c872). Rung unchanged at 3 (unit) · **#1023 2026-09-12:** D: `integration/milestone-billing.test.ts` (new) — a 100.00 schedule split 3333/3333/remainder mints three persisted invoices at `milestone_index` 0/1/2 carrying 3333, 3333, **3334**; the sum read out of `invoices` equals `invoice_schedules.total_amount_cents`; the completion path (`schedule-completion.ts:79`) writes numbered drafts (`INV0001`…, never a `PENDING-` placeholder) with one labelled line, linked by `schedule_id`, one `invoice.milestone_minted` row each, idempotent on retry; with `milestoneBillingEnabled=false` only the deposit exists; a second tenant mints its own three and neither reads the other's schedule, invoices or audit rows. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/milestone-billing.test.ts` → 4/4 ✓. PROVEN-REAL-DB, T1 → **4** (PR #1053) |
| **8.12** | **As M**, I want memberships to renew and bill themselves, so recurring revenue is actually recurring | **Given** a lapsed auto-renew agreement, **when** the sweep runs, **then** `ends_on` advances, `renewal_count` bumps, member pricing applies to a document, and dues collect | **3** STORY NOT MET | 🚨 **Every integration test here proves a *column*, not a *behaviour*.** No renewal sweep, no member price applied, no priority in dispatch, no dues charge. *Generous at 3* · **G1 2026-09-12:** **a renewal sweep does exist and is wired** — `runRecurringAgreementsSweep` (`workers/recurring-agreements-worker.ts`, registered at `app.ts:5751`); the earlier "no renewal sweep" was wrong. It is untested at the behaviour level (the 60 unit hits are unrelated "membership" matches) and, as a tenant-iterating sweep, has no `sweep-tenant-fanout.test.ts` entry. 3 stands · **#1023 2026-09-12:** D: `integration/membership-renewal-sweep.test.ts` (new) — what the wired sweep DOES is proven on real rows: `ends_on` rolls forward with three missed terms caught up in one pass (`renewal_count = 3`), `service_agreement.renewed` audited; the due cycle lands a job, an invoice and a `service_agreement_runs` row with `next_run_at` advanced and no double-bill on re-sweep; member pricing resolves the best *effective* discount at `getCustomerMemberDiscountBps`; two tenants renewed and billed on their own memberships. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/membership-renewal-sweep.test.ts` → 12/12 ✓ (9 behaviour + 3 gap-pinning, no expected-fails); T4 entry `recurring-agreements (membership) sweep` in `sweep-tenant-fanout.test.ts` (reach, BOTH failure phases — renewal and billing are separate catches — and a not-due neighbour unbilled) → 27/27 ✓. **The criterion's last clauses are met only on the CONFIGURED path** (corrected on review, PR #1053 — an earlier revision of this cell stated the gap as universal): *dues collect* — with `autoCollectDues`, a saved default card and a Stripe key, `app.ts:5760-5766` issues the dues invoice with a **30-day due date before charging**, so a success is `paid` with the payment recorded and a **decline leaves an open, dunnable invoice** — proven at real Postgres with only the Stripe HTTPS call injected at the `stripeFetch` seam (a 402 card_error body; the decline metadata `declineCode`/`paymentIntentId` survives to the audit row), and the real overdue sweep run 10 days past that due date records `3:sms` against it. **The gap is the DEFAULT path** — `autoCollectDues` defaults to false in `createAgreement`, and an opted-in member with no saved card hits `no_card` before issuance (`dues-collector.ts:85`) — where the invoice is written `draft` (`agreement-service.ts:402` → `invoice.ts:336`), never issued, has **no due date** (`app.ts:5689-5710`) so the overdue sweep can never select it. Numbering as `AGREEMENT-<epoch ms>` outside the tenant sequence (`app.ts:5693`) holds on **both** paths. *member pricing applies to a document* is proven only at the resolver, not at `routes/invoices.ts:175`. The three default-path gaps are pinned by ordinary tests asserting the current wrong value (not `it.fails`, which two reviewers showed would mask a setup regression) → issue **#1058** (its "never collectable" framing now too strong — see the correction comment there); the worker's missing tenant-failure counter → #1059. Stays **3** until the memberships decision on #1000 (PR #1053) |
| **8.13** | **As M**, I want the arithmetic to be exactly right, every time, so I never have to explain a penny | **Given** ≥1000 randomized documents, **when** totalled, **then** every money field is an integer and totals never go negative | **4** ↑ (T1) | The 4000-iteration suite is a **seeded PRNG fuzz, not a property-based test** (its own header says so), lives **outside the Docker lane**, and never crosses the DB boundary. 🚨 **And the reconciliation sweep *expects* rounding mismatches in live data and reports them as informational** · **G1 2026-09-12:** `billing-engine.property.test.ts` 4/4 ✓ — seeded-PRNG fuzz in the unit lane, no DB leg (as I9): PROVEN-UNIT · **#1022 2026-09-12:** D: `integration/invoice-arithmetic-crosses-db.test.ts` (new; renamed from the lane's `invoice-server-total-persisted` to keep #1020's I9 file) — 1000 seeded-PRNG documents through the production `createInvoice` (`invoice.ts:322` `normalizeLineItemTotals`) and `PgInvoiceRepository.create`, read back by RAW SQL: every money column an integer, `total_cents`/`amount_due_cents` non-negative, each equal to the engine's own number, every line total `round(qty × unit)` never the client's claim (claims cycle `-1`, `0.5`, `999999999`, `7`); the P0-2 case `0.5 × 29¢` persists **15**; a neighbour's identical payload persists its own totals. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/invoice-arithmetic-crosses-db.test.ts` → 3/3 ✓ (~3.3 s). The property now crosses the DB boundary: PROVEN-REAL-DB, T1 → **4**. Still a seeded fuzz, not property-based; 18 of 1000 persist `total_cents = 0` under an over-discount (the engine's documented clamp) — noted, Q12 untouched (PR #1055) |

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
| **9.1** | **As M**, I want a customer thanked 2h after the job, so the last thing they remember is courtesy | **Given** two concurrent sweeps over one eligible job, **when** they run, **then** exactly one send and one `notification.thank_you_sms.sent` audit row — and a "sent" claim with a NULL stamp is **reconciled, not resent**; **and** the send survives the central consent gate in `block` mode | 4 | **D:** `thank-you-sms-worker.test.ts` · **U:** `workers/thank-you-sms-worker.test.ts` — *the gated-chain case; see §12.2, this row was **unsendable in production** until 2026-09-12* · **G1 2026-09-12:** D 8/8 ✓ (audit ✓) + U 17/17 ✓; **T4** via the `thank-you-SMS sweep` fan-out entry — 4 stands · **#1013 2026-09-12 (grading):** the literal G4 grep on `thank-you-sms-worker.test.ts` is 0 by design (single-tenant unit file); the T4 evidence is `sweep-tenant-fanout.test.ts` → `thank-you-SMS sweep` (two real tenants, each SENT under its own scope, one throwing does not stop the other) — 4 (T4) stands |
| **9.2** | **As M**, I want a review asked for automatically, so my rating grows without me thinking about it | **Given** a completed job 24h old, **when** swept twice, **then** one `feedback_send` enqueued, with the setting defaulting **on** at the column level | **4** ↑ (T1·T4) | **D:** `review-request-sweep.test.ts` — *no audit assertion* · **G1 2026-09-12:** `review-request-sweep.test.ts` 2/2 ✓, **T4** via fan-out; no audit event asserted (the file no longer uses `InMemoryAuditRepository` — the 4− now rests on the missing assertion) · **#1013 2026-09-12:** `review-request-sweep.test.ts` — the sweep's `feedback_send` is now driven through the REAL `createFeedbackSendWorker` with `PgCustomerRepository`/`PgSettingsRepository`/`PgFeedbackRequestRepository`/`PgDncRepository` and `GatedMessageDelivery` on `PgAuditRepository` (`enforcement: 'block'`): a no-consent customer yields `SmsSuppressedError('no_consent')` and the `sms.suppressed` row is read back via `findByEntity(tenantId, 'sms_message', customerId)` (the sweep itself never audits — the gate does, one hop downstream at `gated-message-delivery.ts`). `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/review-request-sweep.test.ts` → 3/3 ✓ (RED: expected `dnc`, got `no_consent`). T4 cited: `sweep-tenant-fanout.test.ts` review-request entry. Audit leg closed: PROVEN-REAL-DB, T1·T4 → **4** (PR #1070) |
| **9.3** | **As M**, I want an unhappy customer routed to me privately and a happy one to Google, so a bad day doesn't become a permanent 2★ | **Given** `rating: 3`, **when** submitted, **then** the response persists and **no** review links return; **given** `rating: 5`, **then** the configured link returns | **4** ↑ (T1) | Proven only by a mocked-repo route test. **This is the row deciding whether a 2★ experience becomes a public Google review, and it has no real-DB proof** · **G1 2026-09-12:** `feedback.test.ts` 5/5 ✓ (**T1** `:83`) but no rating-gate case; the unit route test enforces a "4★+" boundary, not the 3★-vs-5★ split this row words — 3 stands, and the row's wording should follow the code · **#1013 2026-09-12:** D: `integration/feedback-review-gating.test.ts` (new) — the real `POST /public/feedback/:token` (`routes/public-feedback.ts:137`, the `rating >= 4` boundary the code actually has): a 3★ response persists with **no** `reviewUrls` and its `feedback_response.submitted` row reads back; a 5★ returns the configured links; a second tenant with no review URLs gets none on a 5★ (the first tenant's URLs never leak). `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/feedback-review-gating.test.ts` → 3/3 ✓ + 1 expected fail. Criterion PROVEN-REAL-DB, T1 → **4**; 🚨🚨 closed. **Story half not in the criterion — *routed to me privately* — has no code path** (no push/SMS/email to the owner on a low rating; only the authenticated `GET /api/feedback`): pinned by the lane's `it.fails`, issue **#1071**. Harness note: `PgSettingsRepository.create()` does not insert the review-URL columns — set them via `update()` (PR #1070) |
| **9.4** | **As M**, I want new Google reviews found and a response drafted for my approval, so I reply within a day without watching for them | **Given** a connected tenant, **when** a sweep runs, **then** new reviews persist, the cursor advances, a re-sweep persists nothing new, a 429 stamps backoff, and reviews are RLS-invisible cross-tenant — with a PII-redacted draft response awaiting approval | **4−** (T4) / **4** ↑ (T1) | **D:** `google-reviews-worker.test.ts`. *Classification and drafting are unit-only* · **G1 2026-09-12:** `google-reviews-worker.test.ts` 7/7 ✓, **T4** via fan-out, no audit event asserted → 4−; classification/drafting unit-only → 3 · **#1013 2026-09-12:** D: `integration/google-reviews-matching.test.ts` (new) — the pipeline's one DB-touching step, `PgCustomerLoader.findRecentCustomersWithName` (`reputation/match-customer.ts:181`, customers ⋈ jobs ⋈ appointments), at real Postgres: the 60-day recency window excludes a 90-day-old visitor, an identically named customer in a neighbour tenant never surfaces, `matchReviewerToCustomer` driven by the real loader resolves a confident match, and `buildReviewResponseProposal` keys the private follow-up + service credit to the REAL matched customer (only the two LLM draft calls are faked; `classifyReview` is pure). `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/google-reviews-matching.test.ts` → 5/5 ✓ (RED: expected 1, got 10000). Classification/matching half PROVEN-REAL-DB, T1 → **4**; the sweep half keeps G1's 4− (T4, no audit event); rung 5 needs a connected Google Business Profile (#1000) (PR #1070) |
| **9.5** | **As M**, I want to make a bad experience right without over-giving, so goodwill doesn't become a leak | **Given** $80 already issued in 12 months and a $50 tier proposed, **when** the cap applies, **then** the credit is **omitted, not zeroed** — because proposing "$0 credit" is worse than proposing none | **4** ↑ (T1) | 🚨 The existing test calls itself a *smoke test that stubs `pool.connect()`* · **G1 2026-09-12:** no integration file exists; unit 23/23 ✓ incl. `pg-service-credit.test.ts`, which stubs `pool.connect()` as its header says — 3 stands · **dormant-rows lane (Fable gate) 2026-09-12:** D: `integration/service-credit-cap-9-5.test.ts` (new; replaces the `pool.connect()` stub smoke test as the row's proof) — at real Postgres `PgServiceCreditRepository.sumIssuedInLast12Months` returns exactly $80 with $30 + $50 inside the window and $80 seeded 13 months outside it; `buildReviewResponseProposal` with a $50 tier OMITS the credit (`serviceCredit: null`, no `"amountCents":0` anywhere in the payload) and leaves the ledger byte-identical; a neighbour tenant's $80 is uncounted and unreadable; executing the capped proposal through the production registry issues nothing and `review_response.executed` reads back. Cap math (`applyCreditCap`, `CREDIT_CAP_CENTS_PER_12_MONTHS = 10000`) asserted, never changed. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/service-credit-cap-9-5.test.ts` → 7/7 ✓ + 1 expected fail. Criterion PROVEN-REAL-DB, T1 → **4**. **Money defect surfaced:** the cap is enforced at draft time only — `executeServiceCredit` (`review-response-handler.ts:334-356`) inserts the payload amount with no re-read, so a $50 approved after another $50 landed executes to $140 against the $100 cap (the `it.fails`, visible in `service_credits`) → issue **#1080** (PR #1076) |
| **9.6** | **As M**, I want one text at the end of the day telling me what happened, so I never open a dashboard | **Given** a tenant at its local digest time, **when** the sweep runs, **then** a digest sends once — not duplicated, not re-sent — carrying **"what I wasn't sure about"** and **"what I learned today"** | **4−** (T3·T4) | The write **and both named sections** are proven at real Postgres. 🚨 **`digest_enabled` defaults false and *nothing in web or mobile writes it*.** `PUT /api/settings` does accept `digestEnabled` behind `settings:update`, so this is reachable by API — but Mike cannot turn the product's central promise on from any shipped surface · **G1 2026-09-12:** `daily-digest-worker.test.ts` 3/3 ✓ stubs compute deps empty and does **not** prove the two sections — that proof is `digest-reflection.test.ts` 5/5 ✓; **T3·T4** via the digest fan-out entry; no audit event asserted in either file → 4− · **#1010 2026-09-12:** client control lit — "Daily digest" toggle in Settings › Quick settings writes `PUT /api/settings {digestEnabled}`; `/digest` gains a supervisor-sidebar nav entry (`Shell-mode.test.tsx` 14/14 ✓). `e2e/journeys/digest-toggle.spec.ts` — `CLERK_DEV_HMAC_TOKENS=true E2E_USE_TEST_DB=true DB_SSL=false DATABASE_URL=<testcontainer> npx playwright test accept-invitation digest-toggle revenue-cluster-toggles --project=chromium` → 4 passed (48.1s), real Postgres, chromium project. Rung unchanged at 4− (no audit event asserted in the worker tests — §8.9 move ticket) |
| **9.7** | **As S**, I want a weekly summary I can read Saturday morning, including how often it repeated a mistake, so I can see whether it's learning | **Given** a week of corrections, **when** summarised, **then** total / repeats / rate come from the real corrections table, and the field is **omitted at zero**; the send ledger is idempotent and a failed send leaves **no** row so the week retries | **4** ↑ (T3·T4) | **D:** `weekly-feedback-builder.test.ts`, `hfcr-weekly-send-worker.test.ts`, `sweep-tenant-fanout.test.ts` (per-tenant recipient / greeting / opt-out, through the production resolvers) · **G1 2026-09-12:** `weekly-feedback-builder.test.ts` 5/5 + `hfcr-weekly-send-worker.test.ts` 6/6 + `sweep-tenant-fanout.test.ts` 16/16 ✓ (production resolvers, **T3·T4**); no audit event asserted → 4− · **#1011 2026-09-12:** owner-facing reachability lit for the row's "cannot turn it off" gap. `e2e/journeys/weekly-feedback-toggle.spec.ts`: `DB_SSL=false DATABASE_URL=<testcontainer> E2E_USE_TEST_DB=true VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== npx playwright test weekly-feedback-toggle.spec.ts --project=chromium --reporter=line` → 1 passed (real Postgres testcontainer, chromium). Owner flips "Weekly summary email" OFF in Settings › Quick settings; `PUT /api/settings {weeklyFeedbackEnabled:false}` persists, read back via `GET /api/settings` after a full page reload; `tenant_settings.weekly_feedback_enabled` row confirmed `f` with a `settings.tenant.updated` audit row. Evidence class D, T1 (single tenant here; cross-tenant scoping for this worker is already T3 via `sweep-tenant-fanout.test.ts`'s weekly-feedback entry). Rung unchanged (Fable states rungs) · **#1011 PR-3 gate (Fable) 2026-09-12:** re-run locally — `weekly-feedback-toggle.spec.ts` 1 passed at a real Postgres testcontainer, `tenant_settings.weekly_feedback_enabled = f` and its `settings.tenant.updated` row polled during the run. The *cannot turn it off* gap that held this row at 4− is closed by an owner-facing control reached in a browser → **4** (T3·T4 from the sweep entry; the browser leg itself is T1). Rung 5 needs the email leg captured hermetically (a sink for the Saturday send), not just the switch (PR #1062) |
| **9.8** | **As M**, I want a correction I make once to stick, so I never fix the same thing twice | **Given** a labor-rate correction, **when** executed, **then** the config changes so the **next same-day draft reflects it**, it appears in the day's applied lessons, and `correction_lesson.applied` is written | **4** ↓ (T1) | **D:** `correction-loop.test.ts` · **G1 2026-09-12:** `correction-loop.test.ts` 4/4 ✓ with audit, **T1** (`:145` FORCE RLS across tenants); rung 5 had no reachability run → 4 · **#1013 2026-09-12 (grading):** `correction-loop.test.ts:145` `FORCE RLS isolates correction_lessons across tenants` — a real second tenant, `findById`/`findAppliedForDay` empty from the other side: T1 confirmed, 4 stands |
| **9.9** | **As M**, I want to undo a lesson it learned wrong, so teaching it is not a one-way door | **Given** an applied lesson, **when** undone, **then** the prior value is restored **exactly**, `correction_lesson.reverted` is emitted **exactly once**, a second undo is a no-op, and it drops from the day | **4** (T1) | **D:** `correction-loop.test.ts` — *asserts both audit ends with `PgAuditRepository`; the best-evidenced row in the lifecycle sections* · **G1 2026-09-12:** same file — but "a second undo is a no-op" has **no test**; the idempotent-revert clause is unproven → 4 with that gap · **#1013 2026-09-12 (grading):** same file/assertion as 9.8 — T1 confirmed, 4 stands; the *second undo is a no-op* clause still has no test · **second-tenant lane (Fable gate) 2026-09-12:** the missing clause is proven — after a first undo (price back to 9000) and an operator edit to 9999, a SECOND undo of the same lesson is a no-op (`undoCorrectionLesson`'s `status === 'reverted'` short-circuit): price stays 9999 and exactly one `correction_lesson.reverted` row exists. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/correction-loop.test.ts` → 5/5 ✓ (RED: expected 9000, got 9999). Criterion now whole at 4 (T1) (PR #1074) |
| **9.10** | **As M**, I want a mistake I've corrected three times to become a permanent fix I approve, so the system stops needing me for it | **Given** a third same-target correction, **when** it lands, **then** a meta-proposal is minted that, once approved, updates the real catalog **through the production registry and executor** | **4** ↑ (T1) | **D:** `correction-repetition-meta-proposal.test.ts` · **G1 2026-09-12:** `correction-repetition-meta-proposal.test.ts` 2/2 ✓ with audit, single tenant → 3 · **#1013 2026-09-12 (grading):** `createTestTenant` is called once in `correction-repetition-meta-proposal.test.ts` (line 72) and no cross-tenant assertion exists — single tenant, T0 confirmed, 3 stands · **second-tenant lane (Fable gate) 2026-09-12:** `correction-repetition-meta-proposal.test.ts` — tenant B's two same-target corrections mint no meta-proposal while tenant A's third mints exactly one `update_catalog_item`; tenant B cannot read it (`findByCorrectionTarget`, `findById` null) and `findByEntity` under B is empty; `correction_repetition.proposed` read back under A. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/correction-repetition-meta-proposal.test.ts` → 3/3 ✓ (RED: expected 1 proposal for B, got 0). T1 → **4** (PR #1074) |
| **9.11** | **As S**, I want paid invoices to reach QuickBooks without me re-keying them, so Saturday is shorter | **Given** already-synced paid invoices, **when** swept again, **then** **zero** QuickBooks calls and zero new `sync_log` rows; pagination syncs **every** paid invoice, not one page; `sync_log` is RLS-isolated | **3** ↓ (T0) | **D:** `accounting-sync.test.ts`. *Rung 5 is blocked on a live OAuth connection, not on code* · **G1 2026-09-12:** `accounting-sync.test.ts` 6/6 ✓, single tenant, no audit event; the sweep iterates via `findAllActive()` with no fan-out entry → 3; rung 5 also needs one human Intuit consent click (parked) |
| **9.12** | **As M**, I want one inbox for every channel with a reply drafted for me, and **nothing sent without my hand on it** | **Given** a thread, **when** I ask for a suggestion, **then** a draft returns and **zero** dispatch rows are written; **given** a DNC number, **then** a reply writes **no** dispatch row at all | **4−** (T1) / 3 | Inbox and guarded send proven — including the DNC refusal, which is the "never auto-sent" half. 🚨 **The AI-suggestion leg has no integration test at all** · **G1 2026-09-12:** `conversation-inbox.test.ts` 2/2 ✓ (**T1** `:182`) + `conversation-reply-send.test.ts` 2/2 ✓ (incl. the DNC refusal); no audit event asserted → 4−; the AI-suggestion leg is unit-only (51/51) → 3 · **#1013 2026-09-12:** `conversation-inbox.test.ts` — the file's T1 was vacuous (a neighbour with nothing seeded, `.every` over an empty list); replaced by a real fixture: a neighbour tenant's unanswered thread surfaces in its own listing and never in the first tenant's. `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/conversation-inbox.test.ts` → 2/2 ✓ (RED: flipped to `.toContain`). T1 is now real; the cell holds — the reply-send audit leg (`conversation-reply-send.test.ts`) was not touched (4− stands) and the AI-suggestion leg (`POST /api/conversations/:id/suggest-reply`, `SuggestReplyTask`, on demand — not a stored draft) stays unit-only (3). The lane's expected-fail test asserting a stored `replyDraft` field was removed at the gate as mis-specified (PR #1070) |

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
| 8 | Dropped calls trigger SMS recovery | **KEPT-BUT-DARK** | A normally-provisioned tenant receives a recovery SMS 60 s after a dropped inbound call. The pipeline is proven at real Postgres **including the flag-on transition**. `setTenantFlag` has **zero production callers** and no route writes `tenant_feature_flags` — but a platform admin *can* scope the platform flag to chosen tenants (§12.4), so this is admin-API-only rather than unreachable. For a normally-provisioned tenant with nobody intervening, rows are scheduled and expire unsent. | **S:** `grep -rn "setTenantFlag" packages/api/src packages/web/src` → **definition only** — which is true and, on its own, does **not** establish that the capability cannot be ramped |
| 9 | B2B account recognition is first-class | **KEPT-BUT-DARK** | Two identical calls — one from a `property_manager`, one residential — produce **observably different** outcomes. The context is assembled onto the session and **read nowhere** — `session.b2bAccountContext` is written once at `twilio-adapter.ts:953` with no consumer, **`buildAccountContextPromptSection` has zero production callers**, and nothing routes on `ctx.priority`. Recognition is implemented and tested; *routed differently* is not implemented. *(An earlier draft credited "one supervisor check" here. The supervisor's `resolveAccountType` reloads `customer.accountType` from the customer row, not from this call context — a separate path that is unaffected by whether the call recognised a portfolio account.)* | **S:** `grep -rn "buildAccountContextPromptSection" packages/api/src` → **definition only** |
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
source. Five of eighteen invariants clear the real-Postgres-with-a-neighbour **or structural-guard** bar after the 2026-09-12 entry audit; seven printed at 4 sit at 3 until graded up (§5, §11.0a). So do
the
strongest capability rows — RLS isolation, DB-level double-booking exclusion,
payment concurrency, refund idempotency and the correction loop. But five rows
rested on files in `test/integration/` that never open a pool, and eleven more
rested on a mocked dependency. **The bar was right; the accounting against it was
not.**

### 11.0a The audit scorecard

| Section | Rows | Overclaimed | Underclaimed | Confirmed |
|---|---|---|---|---|
| Invariants I1–I18 (§5) | 18 + 6 sub-clauses + C5 | 2026-09-12 entry audit: **7** (I4, I10, I12, I17 → 3 at T0; I7, I16 → 3, no negative control; I9 → 3, unit fuzz); 6 sub-clauses unproven, 1 invariant unenforced | 1 (I3′ → 3) | 5 at PROVEN-REAL-DB + T1 or STRUCTURAL (I1, I5, I11, I14, I15) |
| §8.1 Setup | 11 | 6 (2026-09-12 G1: 1.1, 1.2, 1.3, 1.4, 1.8, 1.11 → 3 — single-tenant and/or no audit leg) | 0 | 4 (+1 NO-COMMAND: 1.5) |
| §8.2 Capture | 12 | 4 (2026-09-12 G1: 2.1, 2.3, 2.8 → 3 at T0; 2.10 → 4−) | 0 | 8 |
| §8.3 Book | 12 | 6 (3.1, 3.6, 3.9 → 3 at T0; 3.7, 3.10 → 4, no reachability run; 3.8 → 2, no-op notifier) | 0 | 6 (3.2 at **T2**, 3.5 at T4) |
| §8.4 Dispatch | 11 | 3 (2026-09-12 G1: 4.1 → 4, no reachability run; 4.7 → 2, dormant; 4.8 → 3 at T0) | 0 | 8 |
| §8.5 Execute | 5 | 1 (5.2 — no D: file exists; unit only) | 0 | 3 (+1 NO-COMMAND: 5.1) |
| §8.6 Narrate | 10 | 2 (6.2 → 3 at T0; 6.4 → 4, no reachability run) | 1 (6.9 → 4−) | 7 |
| §8.7 Quote | 12 | 9 (2026-09-12 G1: 7.1, 7.3, 7.10 → 4, no reachability run; 7.2, 7.4, 7.5, 7.6, 7.8, 7.9 → 3 — single tenant, audit leg in memory) | 0 | 3 |
| §8.8 Bill | 13 | 7 (2026-09-12 G1: 8.1, 8.10 → 4, no reachability run; 8.4, 8.6, 8.13 → 3; 8.8 → 4−) | 0 | 6 (8.5's ACH leg at **T1**) |
| §8.9 Close | 12 | 8 (9.8, 9.9 → 4, no reachability run; 9.4, 9.6, 9.7, 9.12 → 4−, no audit event; 9.10, 9.11 → 3 at T0) | 0 | 4 |
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
5. **The negotiation guardrail (I7)** — a type-level impossibility proof. *(2026-09-12: graded 3 pending a negative control — see the I7 row.)*

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
   `estimate-phases.test.ts`. **One import; moves four §8.7 rows from 4− to 4.** *(G1 2026-09-12: the file is also single-tenant, so the swap alone reaches 4− at T0 — a neighbour tenant is needed for 4.)*
5. Stale-revision guard at real Postgres — `expectedVersion` 1 vs 2.
6. Emergency classification at real Postgres, with its audit event.
7. Void → link deactivation + intent cancellation at real Postgres.
8. Uncatalogued line → confidence capped below the auto-approve floor, on disk.

~~**A ninth, added 2026-09-12 and arguably first:**~~ **done the same day, and
no longer part of this backlog.** `listAllTenantIds(pool)` is extracted and
proven against real Postgres, and `test/integration/sweep-tenant-fanout.test.ts`
now carries **all eight sweeps** in 16 tests, every isolation assertion
mutation-tested. Do not write these — see §11.0e for the per-sweep depth.

*Left in place, struck through, rather than deleted: this list is the backlog's
record of what was open and when, and an item that vanishes tells a later reader
nothing about whether it was done or dropped. Items 1–8 above are still open.*

### 11.0d Keeping this document honest

This document has the same failure mode as every document it replaces: it is
prose, and prose drifts. Three defences:

1. **Every rung carries its command.** A claim you cannot run is a claim you
   should not trust — including the claims here.
2. **The `S:` falsifiers are the load-bearing ones.** They are single shell
   commands whose *output is the verdict*. When one starts returning something
   different, the row is stale. The natural next step is a script that runs them
   as a batch and diffs against the expectations recorded here — the same trick
   `voice-action-catalog.contract.test.ts` plays on the capability catalog.
3. **A status change is never one edit.** This document states the same fact in
   four to six places — §0, the §5/§8 row, §11.0c, §11.0e, §12, and often a
   D-NNN entry in `docs/decisions.md`. Every single status correction on this
   PR has had to be applied more than once, and **five were caught only because
   a reviewer found the copy I missed**: D-032's consequences after its first
   clause was fixed, §11.0c's backlog after §11.0e's was, the T0 verdict after
   the grades that retired it were published, the §8 epic table after the
   digest's reachability was corrected in four other places, and D-030's
   *"a capability with no switch cannot have been staged"* after the clause it
   rests on was corrected **two lines above it, in the same paragraph.** So when a status
   changes, the edit is not done until this returns nothing unexpected:

   ```bash
   # grep the SUBJECT, not the wording — the claim is restated, not quoted
   grep -rn "digest" docs/            # not "digestEnabled"
   grep -rn "sweep" docs/             # not "seven sweeps"
   ```

   **Grep the subject, not the token.** The rule above is stated this way
   because its first outing failed: the digest claim was corrected in four
   places by grepping `digestEnabled\|digest_enabled`, and the fifth copy —
   *"the digest cannot be turned on by anyone"*, in the §8 epic table —
   contained neither string. A restatement in plain English is invisible to a
   grep for the identifier, and a summary table is exactly where a claim gets
   restated in plain English.

   **Re-read the paragraph, not the line.** The fifth case above is the one no
   grep would have caught: the sentence that contradicted the fix sat two lines
   below it, and the edit that introduced the contradiction *was the correction
   itself.* A fix dropped in as a parenthetical leaves every sentence
   downstream of it still asserting the premise it just withdrew. A correction
   is therefore not applied to a line, it is applied to the argument: read
   forward to the end of the claim and ask what else was resting on what you
   just changed.

   Fixing the line a reviewer pointed at is the *start* of the fix. **An
   incomplete correction is worse than none: it leaves two statements that
   disagree, and the reader cannot tell which one is current.**

Until that script exists, §5, §8 and §12 are a **snapshot with a decay rate, not
a standing truth.** They were accurate on 2026-09-12.

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
actually meets rather than as an aspiration — and, since this branch itself adds
two integration files, **both before and after**, from one published script:

**These are lexical counts, and the labels say so.** Every row below counts
*occurrences of a string in a file*. That is a bound on the behaviour it stands
for, never a measurement of it — see the correction beneath the table, where
both bounds were caught being read as measurements.

```bash
# run from packages/api/test/integration/
POOL='getSharedTestDb|TEST_DB_URL|new Pool\(|withTestDb|testDb'
files=$(ls *.test.ts | wc -l)
pool=$(grep -lE "$POOL" *.test.ts | wc -l)
# ≥2 LITERAL createTestTenant( call sites. A lower bound on multi-tenant files:
# a file that seeds two tenants through one helper counts as zero.
multi_lit=$(for f in *.test.ts; do [ "$(grep -c 'createTestTenant(' "$f")" -ge 2 ] && echo "$f"; done | wc -l)
# Widened to conventionally-named seeding helpers. Still lexical, still a bound.
multi=$(for f in *.test.ts; do [ "$(grep -cE 'createTestTenant\(|seed[A-Za-z]*Tenant\(' "$f")" -ge 2 ] && echo "$f"; done | wc -l)
# Files that IMPORT PgAuditRepository. NOT files that assert a persisted audit
# row — an upper bound, and a loose one.
audit_import=$(grep -l 'PgAuditRepository' *.test.ts | wc -l)
printf 'files=%s pool=%s no-pool=%s multi(lit)=%s multi(helpers)=%s audit-import=%s\n' \
  "$files" "$pool" "$((files-pool))" "$multi_lit" "$multi" "$audit_import"
```

| Measure | Before (merge-base) | After (this branch) |
|---|---|---|
| Integration files | 217 | **219** |
| …that open a real pool | 214 | **216** |
| …that never open a pool | 3 | 3 |
| ≥2 **literal** `createTestTenant(` sites | 138 (64%) | **140 (65%)** |
| …widened to `seed*Tenant(` helpers | 143 (66%) | **145 (67%)** |
| **Import** `PgAuditRepository` | 68 | **69** |

> ⚠️ **Two figures from the first edition of this table are withdrawn, and one
> is corrected.** That edition reported *"140 provision ≥2 tenants, 120 carry a
> cross-tenant assertion, 113 (52%) both."* Re-measuring found:
>
> - **Four of five checkable figures reproduce exactly** (217, 214, 3, 68) — so
>   the scan behind them was sound.
> - **≥2 tenants was 138, not 140**, at the merge-base. 140 is the figure *after*
>   this branch adds two multi-tenant files, so the original number appears to
>   have been read off a working tree that already had them.
> - **"Cross-tenant assertion" (120) and "both" (113 / 52%) cannot be
>   reproduced**, because no command for them was ever published and the
>   keyword heuristic behind them is not recoverable. They are withdrawn rather
>   than restated: a figure this document cannot re-derive is exactly what
>   §12.4d says not to publish, and **52% was cited in §0 and D-032 as if it
>   were checkable.**
>
> Caught in review (Codex P2) as a staleness problem — the table predated the
> two files this branch adds. Re-running it turned a stale number into a
> reproducible one and found an unreproducible pair underneath.

> ⚠️ **Third edition: the surviving figures were reproducible and still
> mislabelled.** Caught in review (Codex P2) one round later. Both defects are
> demonstrated by a file this document already cites:
>
> - **False negative.** `Provision ≥2 tenants` counted ≥2 *literal*
>   `createTestTenant(` call sites. `chat-entity-resolution.test.ts` seeds
>   `mine` and `theirs` through a single `seedTenant()` helper — one literal
>   call site — and was therefore excluded from a count of multi-tenant files
>   *despite being one of the genuinely cross-tenant tests in the suite.* The
>   widened row above recovers five such files (138→143, 140→145) and is still
>   only a bound.
> - **False positive, and this branch is the culprit.** `Assert audit through
>   PgAuditRepository` counted files that **import** it.
>   `sweep-tenant-fanout.test.ts` — added by this PR — imports it, constructs
>   one, hands it to the sweeps, and **asserts nothing about any persisted
>   audit row.** It incremented 68→69 on no evidence at all.
>
> **The obvious refinement is also wrong, which is why none is published.**
> Narrowing the audit row to files that import `PgAuditRepository` *and* mention
> `findByEntity|audit_events|eventType` gives 49→50 — and it counts
> `sweep-tenant-fanout.test.ts` too, because line 510 stubs
> `{ findByEntity: async () => [] }`. A grep for an assertion is satisfied by a
> stub that asserts nothing. A real measure has to run the suite and observe
> which files touch `audit_events`; until something does, the import count
> stands with the label it has earned.

**At most a third of the Docker-gated suite never provisions a second tenant**
— at most 71 of 216 real-DB files, on the widened count; the true figure is
lower, because even the widened count is a string match and cannot see an
unconventionally-named helper. That is not a claim that those capabilities leak: most are
tenant-scoped by RLS, itself the best-evidenced invariant in the product (I11).
It is a claim about *proof* — for those files, tenant correctness rests on the
boundary being right in general rather than on this capability having been
watched with a neighbour present.

*This paragraph previously read "about half … for ~48% of the suite," resting on
the withdrawn 52% figure above. **Provisioning two tenants is a weaker bar than
the one that figure claimed to measure**, so the honest restatement is also a
smaller number: **at most 33%** never provision a second tenant, where the
withdrawn measure asserted 48% lack a genuine multi-tenant proof. (The first
restatement said a flat 35%, off the literal-call-site count, before that count
was found to be a lower bound rather than a measure.) The stricter count is
probably the more useful one and is exactly what nobody can now re-derive —
which is the argument for writing the scan before quoting the number, not
after.*

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

**That was the finding, as measured on 2026-09-12 before the fix below.** Under
§8.0's capping rules it made every tenant-iterating sweep capped at rung 4 until
T4 was earned, and the digest (9.6), thank-you SMS (9.1), review request (9.2),
hold reaper (3.5), estimate nudge (7.10), Google review monitoring (9.4) and
weekly summary (9.7) rows **T0 sweeps** regardless of the rung printed beside
them.

> ⚠️ **This verdict no longer governs those rows.** The fix landed the same day:
> all seven now carry published T-grades — digest and weekly feedback at
> **T3+T4**, the rest at **T4** — and those grades cap their rungs. The
> measurement above is kept in the present tense of its own moment because the
> diagnosis is what justifies the harness; do not read it as the current state.
> **§11.0e's "Graded so far" list is authoritative for that.**

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
| Swallow the error **and `break`** out of the tenant loop — all six enumerator sweeps | all six isolation tests **fail** ✓ |

**The last row is the one that had to be earned twice, and it is the clearest
warning in this section about what a fan-out test is worth.** Every isolation
test here seeds a doomed tenant and asserts the others were still served —
which only proves anything if the failure happened **first**. Two separate
mechanisms decided that ordering and neither was controlled:

| Sweep shape | Ordering | Pre-fix result under the `break` mutation |
|---|---|---|
| cross-tenant query | `ORDER BY completed_at ASC`, all fixtures sharing one instant | caught it in **2 runs of 6** — an actively broken detector |
| enumerator | `SELECT id FROM tenants`, no `ORDER BY` | caught it in **6 runs of 6** — but only because the heap happened to return insertion order |

The second row is a **latent** defect, not an active one, and saying so
precisely matters: the pre-fix enumerator tests did catch the regression every
time it was run. Re-seeding so the doomed tenant is enumerated **last** — the
order Postgres is free to choose after any `UPDATE`, `VACUUM`, page reuse or
plan change — flips **four of the six to passing against a live regression.**

Both are fixed by removing the dependency rather than pinning the order:
fixtures get distinct `completed_at` values, and the enumerator seams now throw
for **whichever of the test's tenants the sweep reaches first**, so "the failure
preceded the surviving work" is true by construction. Caught in review (Codex
P2, twice — the first fix addressed only the cross-query half).

**All eight sweeps now carry fan-out coverage** *(G1 2026-09-12: eight of at least eleven — the appointment-reminder, accounting-sync and recurring-agreements sweeps iterate tenants and have no entry; see "Graded so far")* — 16 tests in
`sweep-tenant-fanout.test.ts`. Eight sweep *workers*, seven requirement *rows*:
weekly feedback and HFCR weekly send are two separate sweeps both serving 9.7,
whose evidence line cites both. Earlier drafts said "seven sweeps" throughout,
which left it ambiguous whether a worker had been left out of the T4 claim.
None was. They are not all proven to the same depth, and
the difference matters:

| Sweep | Shape | What is proven |
|---|---|---|
| Daily digest (9.6) | enumerator | **T3 + T4** — two tenants due simultaneously on different timezones *and* different digest times, a third opted out, and a throw isolated |
| Weekly feedback (9.7) | enumerator | **T3 + T4** — each enabled tenant emailed at **its own stored address** and greeted with **its own business name**, the tenant whose own `weekly_feedback_enabled` is false skipped, and a throw isolated. All three read through the **production** resolvers (`digest/weekly-feedback-config.ts`), not test substitutes |
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
2. ~~**One shared sweep harness test**~~ — **done for all eight sweeps**
   (seven rows), 16 tests, every isolation assertion mutation-tested.
3. **Grade the remaining rows.** §5 and §8 carry rungs; they do not yet carry
   T-grades per row. The aggregate above is measured; the per-row grading is not
   done, and should not be asserted until it is.

#### Graded so far, and what remains

**§5, all 26 rows — graded 2026-09-12 by the entry audit (map ticket #1005), every Confirm cell now carrying its run and grade.** T1: I1, I5, I11, I14. T0 (real-Postgres, single tenant — capped at 3 by D-032): I4, I10, I12, I17. Structural or in-memory, grade not applicable: the rest. Raw runs: `docs/audit/g1/2026-09-12-s5-unit.md` (21 files, 421 tests) and `docs/audit/g1/2026-09-12-s5-docker.md` (11 files, 63 tests), all green.

**§8.1, §8.5, §8.6, all 26 rows — graded 2026-09-12 (map ticket #1006).** T1: 1.7, 1.9, 1.10, 5.3, 5.4, 6.3, 6.4, 6.5, 6.6, 6.7, 6.9. T0 (capped at 3): 1.1, 1.2, 1.3, 1.4, 1.8, 1.11, 6.2. NO-COMMAND: 1.5, 5.1. Printed rungs 5 on 1.2, 6.2 and 6.4 had no reachability run behind them. Raw runs: `docs/audit/g1/2026-09-12-b-unit.md`, `docs/audit/g1/2026-09-12-b-docker.md` (21 files, 191 tests, all green).

**§8.2, §8.3, all 24 rows — graded 2026-09-12 (map ticket #1007).** T2: 3.2 (the availability non-interference case). T4: 3.5. T1: 2.7, 2.10, 3.7, 3.10 (move/cancel legs). T0 (capped at 3): 2.1, 2.3, 2.8, 3.1, 3.6, 3.9, 3.10 (book leg). 3.8 fell to 2 — the live confirmation notifier is a no-op. **Two more tenant-iterating sweeps sit outside `sweep-tenant-fanout.test.ts`:** the appointment-reminder sweep (3.9, enumerator still stubbed at `appointment-reminder-owner-push.integration.test.ts:171`) and the accounting-sync sweep (9.11, `findAllActive()`); both cap at 4 until they get an entry. Raw runs: `docs/audit/g1/2026-09-12-c-unit.md`, `docs/audit/g1/2026-09-12-c-docker.md` (13 files, 161 tests, all green).

**§8.4, §8.7, all 23 rows — graded 2026-09-12 (map ticket #1008).** T1: 4.1, 4.4, 4.5, 7.1, 7.3, 7.10 (T4 too). T0 (capped at 3): 4.8 and every `estimate-phases` row (7.4, 7.5, 7.6, 7.8, 7.9), plus 7.2's grounding half. 4.7 is dormant (2). Three printed rung-5 rows (7.1, 7.3, 7.10) and 4.1 had no reachability run. Raw runs: `docs/audit/g1/2026-09-12-d-unit.md`, `docs/audit/g1/2026-09-12-d-docker.md` (12 files, 71 tests, all green). **#1012 (2026-09-12):** §8.7 moved — 7.4, 7.5, 7.6, 7.7, 7.8, 7.12 → 4 (T1), 7.9 → 4 (T1·T3), 7.2 cap half → 3 (unit); estimate-expiry joins the T4 sweep suite. Raw run in the PR.

**§8.8, §8.9, all 25 rows — graded 2026-09-12 (map ticket #1009).** T3·T4: 9.6, 9.7. T4: 9.1, 9.2, 9.4. T1: 8.1, 8.3, 8.5 (ACH), 8.8, 8.9, 8.10, 9.3, 9.8, 9.9, 9.12. T0 (capped at 3): 8.4, 8.6, 9.10, 9.11. Most sweep rows prove their write but assert no audit event (4−). A **renewal sweep exists and is wired** (`runRecurringAgreementsSweep`, `app.ts:5751`) — a third tenant-iterating sweep outside the fan-out file, with appointment-reminder and accounting-sync. Raw runs: `docs/audit/g1/2026-09-12-e-unit.md`, `docs/audit/g1/2026-09-12-e-docker.md` (26 files, 134 tests, all green).

**With this section, all 124 rows carry a run, an evidence class and a grade.**

**Earned and published (7 rows, 8 sweeps):** the sweeps in the table above —
digest (9.6) and weekly feedback (9.7) at **T3+T4**, hold reaper (3.5),
estimate nudge (7.10), HFCR weekly send (also 9.7), Google reviews (9.4),
thank-you SMS (9.1) and review request (9.2) at **T4**. Each was proven against **its own
production fan-out path** and mutation-tested — which is not the same path for all of them, and
saying "the real enumerator" for all eight was wrong:

| Sweeps | Proven against |
|---|---|
| digest, weekly feedback, hold reaper, estimate nudge, HFCR weekly send, Google reviews | the real enumerator — `listAllTenantIds`, not a stub |
| **thank-you SMS, review request** | their **production cross-tenant query** — these take no enumerator at all (see the two-shapes note above) |

The distinction is the one this section spends a page establishing, so
flattening it in the summary sentence undoes the point. Caught in review.

**Ungraded (everything in §8 except the sweep rows).** Their printed rungs are
**un-capped and therefore provisional** — §0 says so, so a reader does not try
to apply a capping rule to a row that has no grade.

> **Deliberately not claimed.** Per-row T-grades are absent from the remaining
> rows on purpose. The scan behind the aggregate above is a keyword heuristic —
> sound across the suite's 219 files, not sound row by row — and publishing a guessed grade
> would repeat the exact error this edition exists to correct (§12.4d). An
> unstated grade costs a reader one lookup; a wrong one costs them the trust
> that makes the whole document worth reading.

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

**FIXED 2026-09-12 — the thank-you SMS could not send in production at all.**
Kept here rather than deleted, because the way it hid is the point.

`runThankYouSmsSweep` called its dispatcher with `{ to, body }`. That dispatcher
is `MessageDeliveryFeedbackDispatcher`, which tags every send **customer-class**
and wraps the single `GatedMessageDelivery` object. The gate's first two checks
are `if (!message.consent) return 'missing_consent_context'` and, for the
per-tenant DNC and ledger lookups, `if (!message.tenantId)` — the same reason
again. `TCPA_CONSENT_ENFORCEMENT` has a zod default of `'off'`, **but
`shared/config.ts:216` resolves it to `'block'` in prod and staging whenever an
operator has not set it explicitly.** So in production every thank-you SMS threw
`SmsSuppressedError('missing_consent_context')` — and, before this fix, that
throw was caught as a *transient* failure, leaving `thank_you_sms_sent_at` null
so the sweep re-selected the same job on every tick, forever.

The worker had **already** checked `customer.smsConsent !== true` and
`dncRepo.isOnDnc` before dispatching. It knew both answers and did not pass them
on. Its sibling, `feedback-send.ts:69`, passes both.

Nothing in the suite could see it: every unit test injected a bare
`{ send: vi.fn() }`, the fan-out integration test did the same, and the one
assertion that checked the payload asserted `{ to, body }` **exactly** — an
exact-match on the defect. §12.4d files this as the sharpest instance of a
mocked dependency capping a claim at the mock: the substitute could not fail,
so the rung-4 row above described a capability that had never sent a message in
production. Fixed by forwarding `tenantId` + `consent`, treating a **permanent
consent verdict** as terminal, and adding unit tests that compose the **real**
adapter over the **real** gate in `block` mode. Caught in review (Codex P1).

**And the first fix for it was itself wrong, caught the same way one round
later (Codex P1 again).** It caught `SmsSuppressedError` wholesale — but the
gate throws that same type with reason `channel_disabled` for the operator kill
switch (`TELEPHONY_ENABLED=false`), **ahead of the owner bypass and of any
consent evaluation**, off an env var read per send. So a ten-minute
incident-response shutdown would have stamped every thank-you it touched and
discarded them permanently: they would never send once telephony came back.

The reason set is now an **allowlist** — `no_consent`, `dnc`, `revoked` are
terminal; everything else, including a `missing_consent_context` that could now
only mean a wiring regression, stays retryable. An allowlist because the
failure directions are not symmetric: a wrongly-retried job is a log line, a
wrongly-stamped one is a customer who is never thanked, so a reason added later
must default to retry.

The general form is worth more than the fix: **one error type carried both a
permanent verdict about a customer and a temporary statement about the
operator's own infrastructure.** Any handler that branches on the type rather
than the reason gets one of the two wrong, and which one it gets wrong is
invisible until an incident.

### 12.3 Money — correctness defects

| Gap | Effect |
|---|---|
| **Discount is not proportionally allocated** across taxable and non-taxable lines; the full discount is subtracted from the tax base *and* in full from the subtotal | Systematic **under-taxing** on any mixed-taxability invoice carrying a discount |
| **`taxExempt` is a phantom** — referenced in supervisor logic, no column exists | A B2B signal that cannot be recorded |
| Single flat document-level tax rate; no jurisdiction engine, no per-line rates, no exemption certificates | Stated as a v1 decision; becomes a real constraint at multi-jurisdiction scale |
| Currency hard-coded; no currency column | Single-market by construction |
| **E-signature is a name, IP, user-agent, and a canvas image** | No document hash, no certificate, no ESIGN/UETA artifact. This is a legal claim the data cannot currently support |
| **No ledger or double-entry layer.** Money state is invoices, payments, and two denormalized counters | The reconciliation sweep *detects* drift across five invariants and writes audit events — but **never repairs**, by design |
| **Stripe settlement never validates `event.account`** (#1102, found 2026-09-12 by the §8.5 lane's F5) — every branch that settles from `pi.metadata.tenant_id`/`invoice_id` trusts the metadata alone | A tenant with a connected account can mark ANOTHER tenant's invoice paid with a genuine, correctly-signed Stripe event; the victim gets a `paid` invoice, a completed payments row and a full audit trail for money that sits in the attacker's balance. Fix lane open (Opus, isolated branch); 5.5's settlement half held at 3 until it lands |

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
  **wired, and structurally unreachable.** `classifyUrgencyTier` *is* imported and
  called in production, by `classifyCallerSafety`
  (`emergency-tier.ts:224`) — but only `if (rules)`, and the one live call site
  passes none: `twilio-adapter.ts:1620` calls `classifyCallerSafety(speechResult, {})`
  with two arguments. So the engine, its amplifiers and `triage-rules.json` are
  never consulted on a real call. **The gap is a missing argument, not a missing
  caller** — which makes it cheaper to close than the rest of this list and a
  mistake to delete. *(Corrected 2026-09-12; this bullet said "zero production
  callers", which a grep for the symbol disproves on its second hit.)*
- **A lateness computation** with geofence, dwell, and a confidence breakdown —
  complete, unit-tested, **no worker or route invokes it.**
- **The single-shot onboarding orchestrator** — a separate, earlier extraction
  pipeline from the conversational one; zero non-test importers, and the task
  types file calls it "the dormant single-shot orchestrator" in its own comment.
  *(An earlier draft of this document listed conversational onboarding itself as
  dormant. That was wrong — inherited from a stale audit and corrected here. The
  conversational route is mounted and has a real web client.)*
- **A workflow-trigger subsystem** with modes and configuration — **zero
  production callers**, but **unit-tested**: `test/ai/orchestration/triggers.test.ts`
  exercises `shouldAutoTrigger`, `evaluateTrigger`, `getTriggerConfig` and
  `validateTriggerInput` across ten cases. Unwired, not unproven — deleting it
  discards behaviour that is currently pinned.
- **A guardrail expiration module** (`ai/guardrails/expiration.ts`) — superseded
  by the worker, **zero production importers**, and likewise unit-tested by
  `test/ai/guardrails-expiration.test.ts`.
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

> **Two entries above said "zero callers" where the evidence only supported
> "zero *production* callers"** *(corrected 2026-09-12, Codex review)*. The
> workflow-trigger bullet went further and said *"not even tests"* — which no
> `src`-scoped grep can establish, and which is false. Both modules are
> unit-tested.
>
> **A claim may not be wider than the command that supports it.** The evidence
> here was `grep -rn "<symbol>" packages/api/src`; that command can say
> something about `src` and nothing at all about `test`. This is mechanically
> checkable in a way most of §12.4d is not — compare the paths a claim ranges
> over against the paths its command searched — and the other three bullets in
> this same list get it right (*"zero **production** callers"*, *"no worker or
> route invokes it"*, *"zero **non-test** importers"*), so the correct phrasing
> was three lines away.
>
> The consequence is not cosmetic: this list is read as a delete-or-wire
> backlog, and *"not even tests"* invites deleting a module whose behaviour is
> pinned. The document already had the right category for it two bullets down —
> *"Two AI skills … tests only."*

> **RAG retrieval was on this list and has been removed** *(corrected
> 2026-09-12, Codex review)*. It does not belong here: it has **production
> writers and a real reader**, both gated, and is therefore a staged rollout —
> see §12.4c. The claim as published read *"the code says plainly that no caller
> in main reads or writes today,"* and that phrasing is the tell: **the evidence
> was a doc-comment**, `transcript-ingestion-worker.ts:47`, which says *"Until
> 4a-2 lands the reader…"*. Phase 4a-2 has landed —
> `app.ts:2107` builds the adapter and `app.ts:5362` hands it to the mounted
> conversations router. The comment was true when written and stale when quoted,
> which is the **first** shape §12.4d lists (*documentation is never evidence*),
> making its third appearance on this PR.

### 12.4b Schema debt

Three tables are **fully dead** — zero references anywhere outside the schema
file: `weather_cache` (whose consumer field `vulnerability_signals.weather_unavailable`
exists, so the reader was designed and the cache never wired),
`tenant_provisioning_costs` (a per-tenant Twilio/SendGrid cost-attribution model
never connected to provisioning), and `digest_entries` — which has its own RLS
policy and is superseded by `daily_digests`.

**Six are schema-only**, superseded by a later design but never removed:
`prompt_versions` (with `ai_runs.prompt_version_id` pointing at it *without a
foreign key*), `llm_cache`, `provider_health`, `estimate_provenance`,
`evaluation_snapshots`, `wording_preferences`.

> 🚨 **Two were on that list and are live APIs. Do not remove them.** This
> section reads as a cleanup backlog, so naming a live table here is an
> instruction to delete a working endpoint — the second time on this PR that a
> remediation, not a description, was the wrong part (§12.4d's seventh entry was
> the first).
>
> | Table | Repository | Mounted at |
> |---|---|---|
> | `service_bundles` | `PgServiceBundleRepository` (`verticals/pg-bundles.ts`) | `app.use('/api/bundles', …)` — **app.ts:5407**, authenticated GET ×2 / POST ×2 / PUT |
> | `quality_metrics` | `PgQualityMetricsRepository` (`quality/pg-metrics.ts`) | `app.use('/api/quality', …)` — **app.ts:5408** |
>
> Codex caught `service_bundles`; `quality_metrics` came from sweeping the
> other seven rather than fixing only the flagged one. They are mounted on
> **adjacent lines**. The real gap for both is the familiar one — an API with no
> client — not a dead table.
>
> **S:** the check that separates the two cases, per table:
> ```bash
> grep -rln "<table>" packages/api/src --include=*.ts | grep -v db/schema.ts
> ```
> → empty for all six above; returns a repository for both rows in this box.
> *The grep that produced the original list must have searched `src/routes/`,
> where none of these table names appear — routes name the repository, not the
> table. Same mis-scoping as the digest falsifier (§12.4d).*

And two concepts are **modeled twice**: `job_photos` alongside `attachments`
(the newer migration explicitly keeps both for back-compatibility), and
`daily_digests` alongside `digest_entries`.

> **A third entry here was wrong and has been removed** *(corrected 2026-09-12,
> Codex review)*. It read: *"the vertical pack registry — whose DB `CHECK` still
> permits only HVAC and plumbing while the code registry carries four
> verticals."* Migration `032_create_vertical_packs` does declare
> `CHECK (type IN ('hvac', 'plumbing'))`, but migration
> `089_drop_vertical_packs_type_check` **drops it** (`db/schema.ts:2424-2431`),
> precisely so canonical pack ids like `electrical-v1` can persist.
>
> **In a replay-in-full migration model, no single migration is the schema** —
> the schema is the fold over all 277 of them, in order (§9). Reading a
> `CREATE TABLE` and stopping reads an intermediate state as the final one, and
> nothing about the source makes that visible: migration 032 looks exactly as
> authoritative on line 823 as migration 089 does on line 2424. The check that
> would have caught it is one line — `grep -n "vertical_packs" db/schema.ts` and
> read **every** hit, not the first.
>
> Migration 089's own comment records why it exists: the stale `CHECK` had been
> making `seedCanonicalVerticalPacks` fail **silently in production**, *"errors
> swallowed by `.catch()`."* Both halves are now fixed — the constraint is
> dropped, and each `.catch()` writes the failure to stderr
> (`shared/canonical-vertical-packs.ts:50-65`). What remains is milder and worth
> one line rather than a backlog entry: those writes go to stderr rather than
> the structured logger, and `app.ts:1232` calls the function without `await`,
> so a seed failure is visible in boot output and nowhere else.
>
> *(That sentence originally read "the constraint is gone; the swallowing is
> not" — written without opening the file, in the same edit that recorded the
> rule about not stopping at the first hit. Caught before publishing, by
> applying it.)*

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

**Staged rather than dark by accident: RAG retrieval.** The one item here whose
gating reads as a deliberate rollout rather than an omission, and the reason it
is filed under *dark* and not *unreachable*:

| Half | Gate | State |
|---|---|---|
| **Writers** (`transcript-ingestion`, `proposal-correction` workers) | registered `if (embeddingProvider)` — `app.ts:1580`, `app.ts:2083` | Both `insert` into `knowledge_chunks` whenever an embedder is configured |
| **Reader** (`createRetrieveAdapter`) | `RAG_RETRIEVAL_ENABLED === 'true'` **and** an embedder — `app.ts:2106` | Passed to the mounted conversations router (`app.ts:5362`); `conversations.ts:342` feeds it into `buildSourceContext` for suggest-reply drafts |

Corpus first, reader second, on an explicit flag — which is what the wiring
comment says it is doing, and what a staged rollout looks like when it is
genuine. Nothing here needs building; the open question is only whether the flag
has ever been turned on for a tenant, which no code check can answer.

**Founding commitments currently dark.** Four of the fourteen, including three
that the strategy documents treat as differentiators:

| Commitment | Mechanism | Reachable? |
|---|---|---|
| #2 Digest is the dashboard | `digest_enabled` defaults false | Accepted by `PUT /api/settings` — **but no control in web or mobile writes it**, and the `/digest` page is a registered route with no nav entry · **#1010 2026-09-12:** lit — Settings toggle + `/digest` nav entry (PR on `feat/light-dark-capabilities`), proven at real Postgres by `digest-toggle.spec.ts` |
| #12 Brand voice configurable | `brand_voice_configurator` seeded explicitly `enabled: false` | Deliberate dark-launch (the comment says so). Platform-admin API only |
| #8 Dropped call → SMS recovery | per-tenant `dropped_call_recovery` flag | **Platform-admin API only** — the dedicated per-tenant writer (`setTenantFlag`) is unwired, but an admin can ramp it by `tenantIds` (below) |
| #9 B2B recognition first-class | context assembled, `session.b2bAccountContext` written once, **read nowhere** | Missing wiring, not missing capability · **#1010 2026-09-12:** wired — the voice-turn processor now reads `session.b2bAccountContext` into the classify prompt (2.12) |

**The revenue cluster.** Four money-mechanics capabilities, each fully
implemented with a live consumer, each defaulting false, and **none with a single
control in web or mobile** (verified: zero UI files reference any of them):
`auto_invoice_on_completion`, `batch_invoice_enabled`, `milestone_billing_enabled`,
`bill_labor_from_time_entries`. All four *are* accepted by `PUT /api/settings`, so
this is pure missing UI — the cheapest large win in the product.

**#1010 2026-09-12:** all four now have a control in Settings › Payments & billing (`SettingsPage.tsx`), each writing its own key through `PUT /api/settings`, proven at real Postgres by `e2e/journeys/revenue-cluster-toggles.spec.ts`; Opus review corrected the milestone-billing copy (no approval step).

**The flag write path — corrected.** An earlier analysis claimed no flag could
ever be enabled. That is wrong, and the distinction is operationally important:

- **Platform-wide flags CAN be set in production.** The admin router is mounted,
  and its default gate lazily builds a real platform-admin checker whenever
  `DATABASE_URL` is present; it fails closed only without a database. A row in
  `platform_admins` plus `PUT /api/admin/feature-flags/:name` works today. There
  is no UI for it, but there is a path.
- **`setTenantFlag` has zero *production* callers and no route** — true (four test files do call it), and that is where an
  earlier draft stopped. **The conclusion drawn from it was wrong.**

  Per-tenant ramping *is* reachable, through a different mechanism:
  `PUT /api/admin/feature-flags/:name` persists a `tenantIds` array
  (`routes/feature-flags.ts:99`), and `PgTenantFeatureFlagRepository._resolve`
  falls back to the platform flag **evaluated for the current tenant** — its own
  comment says it "honours environments and tenantIds scoping, not just the raw
  enabled bit." `isFeatureEnabled` enforces it: a non-empty `tenantIds` returns
  false for any tenant not in the list (`flags/feature-flags.ts:58`).

  Both capabilities resolve through that path — dropped-call recovery via
  `dropped-call-worker.ts:148` and vulnerability triage via
  `vulnerability-triage-hook.ts:113`, both calling `isEnabledForTenant`.

  So the gap is **an admin-API-only control**, not "all-or-nothing" and not a
  missing ramp. A platform admin can enable either capability for a chosen set
  of tenants today; nobody else can, and no UI exposes it. *Caught in review
  (Codex P2) — the unwritten `setTenantFlag` was real, and reading "therefore no
  ramp exists" off it was an inference, not a measurement.*

**Settings unreachable even by API — and the failure is silent.**
`updateSettingsSchema` is a plain `z.object(…).superRefine(…)`. It is **not**
`.strict()` — an earlier draft of this document said it was, which got the
consequence exactly backwards. Zod's default is to **strip** unrecognized keys,
so a `PUT` carrying one returns **200 with the key silently discarded**. That is
worse than the rejection this document claimed, because the caller is told the
write succeeded.

**Twelve** settings are in `PgSettingsRepository`'s write column map but not in
that schema. Earlier drafts of this paragraph said four, then three, and both
were hand-written lists — which is why this one is **computed**, and the command
that computes it is published below rather than its output being retyped.

**Eight have no write path at all** (direct SQL only):

| Setting | What a tenant cannot do |
|---|---|
| `sendThankYouSms` | **Stop the post-job thank-you SMS.** Live gate (`thank-you-sms-worker.ts:186`), column default `TRUE` |
| `sendReviewRequest` | **Stop the post-job review request.** Live gate in SQL (`review-request-worker.ts:74`), column default `TRUE` |
| `weeklyFeedbackEnabled` | Turn off a recurring email the product sends them |
| `speedToLeadEnabled`, `speedToLeadTemplate` | Configure or disable speed-to-lead |
| `autonomousCloseEnabled`, `autonomousCloseMaxCents` | Set or bound the autonomous-close lane (D-018) |
| `e1ReviewedScript` | Clear the E1 script-review flag |

**Three have a dedicated writer and are not user-settable** — a different thing:

| Setting | Written by |
|---|---|
| `laborRateCentsPerHour` | The **correction loop**: a learned rate cascades into tenant config through `ConfigPorts.setLaborRateCents` (`app.ts:1271`). An owner cannot set it; the product learns it |
| `nextEstimateNumber`, `nextInvoiceNumber` | `PgSettingsRepository.incrementEstimateNumber` / `incrementInvoiceNumber`, on **every allocation**. Seeded at onboarding, then written constantly |

*An earlier draft of this table filed all three as "written once at onboarding
and never again," and `laborRateCentsPerHour` as direct-SQL-only. Both were
wrong, and wrong in the way the note under the command warns about — which was
already written, one paragraph below, when I made the mistake. Reading a key's
absence from the generic schema as absence of any writer is the same error as
the `brandVoiceLocked` one earlier in this section, made a third time.*

`aiModel` is the genuine write-once case: `activate-pack-with-seed.ts:115` sets
it from `resolveBootstrapAiModel()` at provisioning and nothing else writes it.
(`updatedAt` is bookkeeping, not a setting.)

The first two rows are the ones that matter most and neither earlier draft
named them: **both post-job customer-facing SMS toggles default ON and cannot
be switched off through any API.** A tenant who asks to stop texting their
customers after every job gets a 200 and keeps texting them.

*An earlier draft listed a fourth, `brandVoiceLocked`, and was wrong about it.*
It appears in `pg-settings.ts` only as a **read projection** (row → object); it
is **not** in the write column map, because it has a dedicated write path:
`PgBrandVoiceRepository.bumpVersion`, behind the mounted
`PUT /api/settings/brand-voice` (app.ts:5399). `bumpVersion` takes
`SELECT … FOR UPDATE` on the settings row and makes three things atomic with the
write: the 15-minute cool-down check (`BRAND_VOICE_COOLDOWN_MS`, checked under
the lock as an explicit TOCTOU fix), the `brand_voice_versions` history insert,
and the `tenant_settings` update.

The audit is **not** in that transaction — `bumpVersion` contains no audit
reference at all. `brand-voice-service.ts` builds the event and the router
persists it after the bump returns, and only `if (auditRepo)`. That is Tier 2
by §5.0b, not Tier 1, and the router's own doc-comment — *"the lock + cool-down
+ version-bump + audit"* — reads as though it were Tier 1. *(This document
asserted the same thing one draft ago, from the same doc-comment. §12.4d's first
rule caught it: a doc-comment claiming a module is wired is a claim, not a
wiring.)*

Adding `brandVoiceLocked` to the generic settings `PUT` would either stay a
silent no-op or — with a column mapping added — bypass the lock, the cool-down
and the version history, and emit **no brand-voice audit at all**. Its write
path is correct as it stands.

Blanket `.strict()` is **not** the remediation. The schema relies on strip
semantics deliberately: `voice_approval_pin_hash` is omitted **on purpose** so a
raw hash can never be injected through the generic settings `PUT`, and the
schema says exactly that in its own comment. Going strict would convert that
designed-silent drop into a 400 and newly reject every client that sends an
extra key. The narrow fix is to add the **eight** genuinely unreachable keys to
the schema with the same route-boundary validation their siblings already get,
starting with `sendThankYouSms` and `sendReviewRequest` — and to leave
`brandVoiceLocked`, `laborRateCentsPerHour` and the two numbering counters on
their dedicated writers, which are correct as they stand. Whether `aiModel`
should be editable after provisioning is a product question, not an omission.

> **S:** `awk '/^export const updateSettingsSchema/,/^\}\)\.superRefine/' packages/api/src/shared/contracts.ts | grep -c 'strict()'`
> → **1**, and that one is the nested `autoApproveThreshold` object, not the
> settings schema itself.
>
> **S:** the stripped set, computed rather than listed — run from `packages/api/`:
> ```bash
> comm -23 \
>   <(awk '/const fieldMap: Record<string, string> = \{/,/^ *\};/' src/settings/pg-settings.ts \
>       | sed -n "s/^ *\([a-zA-Z][a-zA-Z0-9]*\): '.*/\1/p" | sort -u) \
>   <(awk '/^export const updateSettingsSchema/,/^\}\)\.superRefine/' src/shared/contracts.ts \
>       | sed -n 's/^  \([a-zA-Z][a-zA-Z0-9]*\):.*/\1/p' | sort -u)
> ```
> → **13 lines** (the twelve above plus `updatedAt`). If this returns a
> different set, the table above is stale — which is the point of publishing the
> command instead of the list. Note it answers *"absent from the generic
> schema,"* **not** *"unreachable"*: `brandVoiceLocked` is absent from the write
> map entirely and has its own endpoint, so always check for a dedicated route
> before calling a key unreachable.

**#1011 2026-09-12:** five of the thirteen are now in the schema, so the
falsifier's answer has moved and the paragraph above is history rather than
current state. Re-run from `packages/api/`:

```bash
comm -23 \
  <(awk '/const fieldMap: Record<string, string> = \{/,/^ *\};/' src/settings/pg-settings.ts \
      | sed -n "s/^ *\([a-zA-Z][a-zA-Z0-9]*\): '.*/\1/p" | sort -u) \
  <(awk '/^export const updateSettingsSchema/,/^\}\)\.superRefine/' src/shared/contracts.ts \
      | sed -n 's/^  \([a-zA-Z][a-zA-Z0-9]*\):.*/\1/p' | sort -u)
```

→ **13 lines BEFORE** (`aiModel`, `autonomousCloseEnabled`,
`autonomousCloseMaxCents`, `e1ReviewedScript`, `laborRateCentsPerHour`,
`nextEstimateNumber`, `nextInvoiceNumber`, `sendReviewRequest`,
`sendThankYouSms`, `speedToLeadEnabled`, `speedToLeadTemplate`, `updatedAt`,
`weeklyFeedbackEnabled`) → **8 lines AFTER** (`aiModel`, `e1ReviewedScript`,
`laborRateCentsPerHour`, `nextEstimateNumber`, `nextInvoiceNumber`,
`speedToLeadEnabled`, `speedToLeadTemplate`, `updatedAt`).

The companion falsifier is unchanged and must stay unchanged —
`awk '/^export const updateSettingsSchema/,/^\}\)\.superRefine/' src/shared/contracts.ts | grep -c 'strict()'`
→ **1**, still the nested `autoApproveThreshold` object. Blanket strict mode was
not the remediation and was not applied.

What the remaining eight are, and why each stayed out:

| Key | Why it is still absent from the generic PUT |
|---|---|
| `e1ReviewedScript` | It is the literal script spoken to a caller in a life-safety E1 emergency (`telephony/twilio-adapter.ts:1631-1632`). Owner-settable through the generic PUT would mean life-safety copy rewritten with no review, no version history, no cool-down, and no audit beyond `changedKeys`. If it is ever owner-editable it needs the D-023 brand-voice shape plus an attestation — **Josh's call**, filed in `docs/audit/blocked-on-josh.md` |
| `speedToLeadEnabled`, `speedToLeadTemplate` | **Reclassified.** This section filed them under *"no write path at all,"* implying the schema was the gap. It is not: **speed-to-lead has zero production callers.** `git grep -rn "sendSpeedToLeadResponse\|shouldSendSpeedToLead" -- packages/api/src packages/api/test` returns the module's own definitions plus its unit test, and nothing imports `leads/speed-to-lead`. Adding the keys would hand an owner a switch that turns on nothing — the §12.4d failure mode in product form. It belongs in the *unlit-able* table above, not here |
| `laborRateCentsPerHour`, `nextEstimateNumber`, `nextInvoiceNumber` | Dedicated writers, as the table below already says. Unchanged |
| `aiModel` | Still the open product question. Unchanged |
| `updatedAt` | Bookkeeping, not a setting. Unchanged |

The five that were added — `sendThankYouSms`, `sendReviewRequest`,
`weeklyFeedbackEnabled`, `autonomousCloseEnabled`, `autonomousCloseMaxCents` —
carry route-boundary validation matching their siblings, a cross-field refine
rejecting the one payload that enables the close lane while clearing its spend
bound, an integration test reading the raw `tenant_settings` columns back at
real Postgres with its audit row through `PgAuditRepository` (T1 + T3), and
owner controls in `SettingsPage.tsx`. `autonomousCloseEnabled`'s control is
labelled for what D-019 left it doing — deciding whether a phone-confirmed
quote is staged as one owner-approval chain — not for the autonomous close
D-019 revoked.

**Two smaller items with outsized effect**, both one-line fixes:

- **Team invitations 404.** The invite flow redirects to
  `${appBaseUrl}/accept-invitation?invitation_id=…`; that route does not exist in
  the web router. Every invitation email lands on a dead page — which means
  multi-user tenants cannot be formed.
- **Technicians are never told they were assigned a job.** The assignment
  notifier is a module-global that `app.ts` never sets, and every producer calls
  it through `instance?.notifyChange(...)` — so the optional chain makes a
  permanent no-op completely silent.

#### "Dark by default" understates one of these — it is unlit-able

A default-off flag implies someone can turn it on. For **one** module, not
previously listed, **no surface can** — not even an admin API:

| Capability | The blocker |
|---|---|
| Technician assignment notification | `setTechnicianAssignmentNotifier` has **zero production callers** (unit-tested, never wired). The accessor is `await instance?.notifyChange(change)`, so every production assignment fires a silent no-op — while the module's own doc-comment says *"app.ts registers one notifier"* and *"Called once in app.ts."* |

It is rung 2 — built, never called — and what it needs is one wiring line, not a
feature.

**This table began with four rows and has lost three of them to review**, which
is the more useful finding:

| Was listed as unlit-able | Actually |
|---|---|
| End-of-day digest | `PUT /api/settings` accepts `digestEnabled` — missing a **client control** |
| Dropped-call SMS recovery | platform-admin can scope the flag by `tenantIds` — missing an **owner-facing control** |
| Voice vulnerability triage | same mechanism, same correction |

Three of four "no surface can enable this" claims were wrong, each for the same
reason: **a grep proving one specific writer is unwired was read as proving no
writer exists.** `setTenantFlag` really does have zero production callers; that fact is
true and the conclusion drawn from it was not. Only the technician-assignment
notifier survives, and it survives because nothing anywhere calls it.

On the digest specifically, the falsifier deserves its own note: `PUT /api/settings` already accepts `digestEnabled`,
`digestTime` and `digestChannel` behind `settings:update`, and
`PgSettingsRepository` maps all three to their columns — so an owner with the
permission can switch the digest on through the API today. What is missing is a
**client control**, not a write path. The falsifier published in an earlier
draft, `grep -rn "digestEnabled" packages/api/src/routes packages/web/src packages/mobile/src`,
does return nothing — but only because the key lives in `src/shared/contracts.ts`,
which the route imports. It was scoped where it could not see the thing it was
meant to test (§12.4d).

All four are roughly a day of work between them — one wiring line, two
owner-facing controls, one client toggle — and they light four of the
capabilities the strategy documents cite most. **Three of the four need a
control, not a write path**, which is a materially cheaper backlog than this
section claimed for most of its life.

The last row is also the clearest instance of §12.4d's first rule: **a
doc-comment claiming a module is wired is a claim, not a wiring.**

#### Stories that pass their rung and fail their user

Worth stating as its own list, because it is invisible in any engineering-only
view. These are rows where **the engineering is done and the user is not
served** — a different backlog from the test-writing one, much cheaper, and the
one a customer would notice first:

| Story | Rung | Why it still fails |
|---|---|---|
| **9.6** End-of-day digest | 4 | `PUT /api/settings` accepts `digestEnabled` today; **no web or mobile control sends it**. The product's central promise ships off, with no switch an owner can reach |
| **2.7** Dropped-call recovery | 4 | Enable-able by a platform admin via `PUT /api/admin/feature-flags/:name` with `tenantIds`; **no owner-facing surface exposes it** · **#1011 2026-09-12:** an owner-facing surface now exists — `PUT/GET /api/settings/capabilities/dropped_call_recovery` from Settings › Capabilities, proven at real Postgres by `capabilities-toggle.spec.ts` (see row 2.7's note) |
| **1.11** Team invites | 4 | The invite row is written perfectly and the email 404s — `/accept-invitation` has no route · **#1010 2026-09-12:** the route now exists (`packages/web/src/routes.ts:286`, `AcceptInvitationPage`) with a passing e2e spec — this row is stale; kept for audit-trail history |
| **4.11** Technician assignment notice | 2 | Silent no-op on every assignment; doc-comment says otherwise |
| **2.12** B2B recognition | 2 | Recognised, assembled, and **never routed on** — no reader anywhere |

**Five stories where a passing rung hides a failing story.** Together they are
roughly a day of work and they light four of the capabilities the strategy
documents cite most.

### 12.4d A note on method — how nineteen of these were got wrong

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

**A third instance, caught in review, and the decay was two phases rather than
two months.** §12.4 filed **RAG retrieval** as unreachable on the words *"the
code says plainly that no caller in main reads or writes today."* Those words
are a `transcript-ingestion-worker.ts` doc-comment — *"Until 4a-2 lands the
reader…"* — and 4a-2 had landed: two registered workers write `knowledge_chunks`
whenever an embedder is configured, and `createRetrieveAdapter` feeds the mounted
conversations router's suggest-reply path behind `RAG_RETRIEVAL_ENABLED`.
Reclassified as staged (§12.4c). **This document quotes source comments as
evidence in the one section whose entire subject is that source comments are not
evidence** — and did it three times. A comment describing *future* work
("until X lands") has a shorter half-life than any other kind, because the
sentence that falsifies it is a commit somebody else writes.

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

**Two more failed a third way, and PR review caught them.** Both concerned the
settings surface, and neither was a stale fact — both were wrong on the day they
were written:

- **A claim was stated backwards from reading the source.**
  `updateSettingsSchema` was described as `.strict()`, so unknown keys were said
  to be *rejected*. The schema is a plain `z.object`, which **strips** them — the
  opposite consequence, and the worse one, because the caller gets a 200 for a
  write that did not happen. The `.strict()` I saw was on the nested
  `autoApproveThreshold` object and I attributed it to the enclosing one. No
  command was ever run against the claim.

- **A falsifier was scoped where it could not see what it tested.** The digest
  was filed as having no write path on the strength of
  `grep -rn "digestEnabled" packages/api/src/routes …` returning nothing. It does
  return nothing — the key lives in `src/shared/contracts.ts`, which the route
  imports. `PUT /api/settings` has accepted `digestEnabled` the whole time.

The second is the more dangerous of the two, and it is worth separating from
plain carelessness: **a falsifier that searches the wrong place does not fail
loudly — it passes, and launders a guess into evidence.** The other rungs in this
document rest on commands of exactly that shape. A command is only as good as
its scope, so a falsifier's *search path* is part of the claim and has to be
justified like one.

The document also already contained the right answer. §12.4's own flag table
says the digest is *"accepted by `PUT /api/settings` — but no control in web or
mobile writes it,"* which is correct, while the table three pages later said no
route writes it at all. **An internal contradiction is a free falsifier and this
edition did not run one.** A `grep` for each capability's name across this file,
reading every hit together, would have caught it — as it later caught the
tenant-grade contradiction in §0 and D-032.

**The seventh is the only one that would have done damage if believed**, and it
deserves its own line. `brandVoiceLocked` was listed among the settings
"settable only by direct SQL," with the prescribed fix being to add all of them
to the generic settings `PUT`. It has a dedicated write path —
`PgBrandVoiceRepository.bumpVersion`, behind `PUT /api/settings/brand-voice`,
which under a row lock makes the cool-down check, the version-history insert and
the settings update atomic. Wiring it into the generic settings path as this
document instructed would have **bypassed all three**, and emitted no
brand-voice audit at all.

The mistake underneath was small and mechanical: `brandVoiceLocked` appears in
`pg-settings.ts` once, and I read that single hit as membership in the write
column map. It is in the row-to-object **read projection**. A field's presence
in a repository file says nothing about which direction it travels — and
`settings.ts` says so in a comment, calling those fields projections, which I
had already read.

The correction to that correction is worth recording too, because it happened in
the same sitting. Writing this up, I described `bumpVersion` as committing its
audit event in the same transaction — taking it from the router's doc-comment,
*"the lock + cool-down + version-bump + audit"*. `bumpVersion` contains no audit
reference; the router writes the event afterwards and only when an `auditRepo`
was passed. I caught it by grepping the function instead of trusting the
sentence above it, which is the only reason it is not the eighth entry in this
list. **The first finding on this PR was this same Tier-1-versus-Tier-2 audit
confusion (§5.0b), and I made it again nine commits later** — a documented
lesson does not transfer on its own.

Every other entry here is a wrong *description*, which costs a reader their
trust. This one was a wrong *instruction*, which would have cost a tenant their
audit trail. **A document that grades its own claims owes a higher standard to
the sentences that tell someone what to change than to the ones that tell them
what is true.** The remediations in §12 have had no falsifier of any kind
attached to them; the rungs at least have commands.

**The eighth is the worst one in this document, and it was the highest rung it
claimed.** Story 6.1 asserted that pressing the global control on any screen
opens *"a session with an SSE event stream,"* graded **5**, confirmed by
`useVoiceRecorder.test.ts`.

Three things were wrong at once. The global control (`VoiceBar`, mounted by
`Shell`) **uploads and polls** — `POST /api/voice/recordings`, then
`GET /api/voice/recordings/:id` until done; there is no `EventSource` in it. The
SSE path is real but lives in `useVoiceSession`, imported by exactly one
component, `VoiceSessionPanel`, on the assistant screen. And **the cited test
file does not exist** — there is `useVoiceRecorder.ts` (the hook, untested) and
`VoiceRecorder.test.tsx` (a different file, presentational callbacks only).

The row is now split: 6.1a at **3** for the upload path, 6.1b at **2** for the
SSE session, which has **no test at all**. Rung 5 became 3 and 2.

A wrong rung is ordinary. **A rung whose confirming command cannot be run is a
different failure**, because this document's entire proposition is that every
number has a runnable command beneath it — §11.0d's first defence, stated twice
more in §0 and D-031. A citation nobody executed is indistinguishable from an
invented one, and it sat on the highest rung claimed anywhere here. The cheapest
possible guard would have caught it:

```bash
# every W:/U:/D: file cited in §5 and §8 exists
grep -oE '`[a-zA-Z0-9./-]+\.test\.tsx?`' docs/PRD-v5-as-built.md | tr -d '`' | sort -u |
  while read -r f; do find packages -name "$(basename "$f")" -print -quit | grep -q . || echo "MISSING: $f"; done
```

That is the falsifier-runner §11.0d keeps calling future work, in its smallest
useful form — and it would have failed this PR before review did.

**Run against this edition it prints exactly two lines, both expected:**

| Line | Why it is not a defect |
|---|---|
| `test/ai/supervisor/review-coverage.test.ts` | Cited only as work to do — §11.0c item 1 and §12.4e's *"the missing proof is one test."* Never in a `Confirm` column |
| `useVoiceRecorder.test.ts` | Named in this section as the citation that didn't exist. No row cites it any more |

**A third line is a real defect.** 114 distinct test files are cited across §5
and §8; 112 of them exist and 2 are deliberate. That is the baseline this
command is worth running against.

**The ninth is the cleanest specimen of the recurring shape**, and the reason
this section should stop growing by hand. Story 2.12 and founding commitment #9
both credited the B2B call context as *"read by one supervisor check."* It is
read by nothing: `session.b2bAccountContext` is written once and has no
consumer, and `buildAccountContextPromptSection` has zero production callers.
The supervisor's `resolveAccountType` reloads `customer.accountType` from the
customer row — a path that behaves identically whether or not the call
recognised a portfolio account. An unrelated path's evidence had been borrowed.

What makes it the specimen is the distribution:

| Said "read nowhere" — correct | Said "read by one supervisor check" — wrong |
|---|---|
| §12.4's flag table | §8 row 2.12 |
| D-030 in `docs/decisions.md` | the founding-commitments table |

**Two and two, and the correct version was already there before this edition.**
That is the shape of **ten** of the findings raised on this PR — one claim,
two or more places, opposite verdicts, the truth usually already present
somewhere in the repo — and it is the most common single defect in this
reconstruction. §11.0d's third defence asks a human to grep the subject on
every status change, and a human forgetting is precisely what it cannot
prevent, as this row proves after two review passes over the same section.

**The tenth is the one that beat every defence, including the ones written to
stop it.** D-030 argued that the four dark commitments were drift rather than a
staged rollout, on the evidence that one of them *had no switch at all*. That
argument has now been wrong three times, in the same way, about a different
capability each time:

| Edition | Cited as the capability with no switch | Why it was wrong |
|---|---|---|
| Original | The digest | `PUT /api/settings` accepts `digestEnabled` |
| Corrected 2026-09-12 (1st) | Dropped-call recovery | A platform admin can ramp it by `tenantIds` |
| Corrected 2026-09-12 (2nd) | — | **The test cannot work**: three of the four *have* flags |

The second correction is the instructive one, for two reasons. First, the
contradiction it fixed was **two lines below the clause the first correction
edited, inside the same paragraph** — no grep was needed or would have helped,
because the correction itself created it: a parenthetical was inserted and the
sentences resting on the withdrawn premise were left standing. That failure
mode is now §11.0d's *"re-read the paragraph, not the line."*

Second, and more useful: the defect was never in any one citation, it was in
the **test**. "A capability with no switch cannot have been staged for a
rollout" cannot distinguish drift from staging for anything that has a flag,
and three of the four do. It only ever identified the one capability with no
flag at all — B2B account context, which has none because there is nothing to
ramp *to*. Two editions of this document searched for a better example instead
of noticing that the question was unanswerable as posed. **A claim that has to
change its evidence twice is usually not short of evidence; it is the wrong
claim.**

**So the honest conclusion of this section is that it should not exist as
prose.** Every entry above is a check a machine could run: does a cited file
exist (published, §12.4d), does a cited test open a pool, does a claim appear
twice with opposite verdicts. The first is now one line of shell. The third is
the one that would have caught the most, and it is still unwritten.

**The eleventh and twelfth were both raised against the harness this PR added
to fix the others**, which is the most useful thing in this section: the
instrument built to stop overclaiming was itself overclaiming, in the two ways
an instrument can.

- **It proved the loop and substituted the configuration.** The weekly-feedback
  fan-out test handed the sweep the real enumerator — the whole point of the
  file — and then handed it `isFeedbackEnabled` and `resolveOwnerEmail` as a
  hand-built array and map, while every seeded tenant carried the *identical*
  `owner_email` that `createTestTenant` writes. So it proved the worker forwards
  each tenant id, and proved nothing about the resolvers production actually
  runs, which were inlined closures in `app.ts` with no test of any kind. This
  is §11.0e's own finding one layer down: the tenant *selector* had been
  extracted and tested (`tenants/list-tenant-ids.ts`) while the tenant
  *configuration* was still inline. Fixed the same way — extracted to
  `digest/weekly-feedback-config.ts`, wired at the one call site, and exercised
  against three tenants with distinct stored emails, business names and opt-out
  flags. Each of the three assertions was mutation-tested: an owner-email
  resolver that drops its `WHERE id = $1`, an opt-out gate that ignores the
  stored flag, and a business-name resolver that reads a fixed tenant each kill
  the test.
- **It counted itself as evidence it had not produced.** §11.0e's audit figure
  counts files that *import* `PgAuditRepository`; this file imports one,
  constructs one, passes it to the sweeps and asserts nothing about any
  persisted audit row — incrementing the published count 68→69 on nothing. The
  same table's multi-tenant figure erred the other way, excluding a genuinely
  cross-tenant file because its two tenants come from one helper call site. Both
  rows are now labelled as the string counts they are, and the refinement that
  looks obvious — also grep for an audit assertion — is shown in §11.0e to count
  this very file, because its stub object contains the word `findByEntity`.

**A harness is not exempt from the standard it enforces.** Both of these passed
review twice before someone read what the assertions could not fail on.

**The fourteenth is the only one that was a live production defect, and it is
shape 3 at full strength.** Story 9.1 — the post-job thank-you SMS — was filed
at rung 4 on a Docker-gated test. In production it could not send a single
message: the worker passed `{ to, body }` to a dispatcher whose gate fails
closed without `tenantId` and a consent snapshot, and `TCPA_CONSENT_ENFORCEMENT`
resolves to `block` in prod and staging when unset (§12.2 has the full chain).

What makes it the strongest specimen in this section is the *shape of the
evidence*, not the size of the bug:

| The proof that existed | Why it could not fail |
|---|---|
| `test/workers/thank-you-sms-worker.test.ts` | injected `{ send: vi.fn() }` |
| `test/integration/thank-you-sms-worker.test.ts` (Docker-gated, rung 4) | same substitute |
| `test/integration/sweep-tenant-fanout.test.ts` (added by this PR) | same substitute |
| the one assertion on the payload | `toHaveBeenCalledWith({ to, body })` — an **exact match on the defect** |

Three independent test files, one of them real-Postgres, and the thing they all
replaced was the thing that was broken. **A rung measures the distance between a
test and production, and every one of these was measuring zero because the
substitute sat exactly where production's gate does.** The fix adds the case
that was missing: compose the real adapter over the real gate in `block` mode
and assert the bytes reach the base provider. Reverting the two forwarded
arguments fails it.

The rule that generalises: **when a dependency is a policy gate, a mock of it is
not a mock of a collaborator — it is a deletion of the policy.** The other
substitutes in this suite (repos, clocks, providers) stand in for things that
say *yes*. This one stood in for the thing whose job is to say *no*.

**The fifteenth was raised against the fourteenth's fix, one round later**, and
it is the second time on this PR that a correction created the next finding
(§11.0d records the first). The fix caught `SmsSuppressedError` wholesale and
stamped the job. But the gate throws that same type with reason
`channel_disabled` for the operator kill switch — **before** the owner bypass
and before any consent evaluation — so a temporary `TELEPHONY_ENABLED=false`
would have permanently discarded every thank-you processed during the outage.

The two findings are the same mistake at two altitudes, which is why they belong
together:

| | What was treated as equivalent | Consequence |
|---|---|---|
| Fourteenth | a mock of the gate ≡ the gate | the policy was deleted from three test files |
| Fifteenth | the error *type* ≡ the error *reason* | a permanent customer verdict and a temporary operator action took the same branch |

**A type is not a verdict.** `SmsSuppressedError` carries a machine-readable
`reason` precisely because its instances mean different things, and its own
doc-comment says so — *"so callers that report suppression can branch on it
rather than string-matching."* The fix branched on the type anyway. The reason
set is now an allowlist rather than a denylist, because the failure directions
are asymmetric: a wrongly-retried job costs a log line, a wrongly-stamped one
costs a customer message that no later run will send, so anything unrecognised
must default to retry.

**The sixteenth names a shape this document had not caught before, and it is
specific to how this repo stores schema.** §12.4b listed the vertical-pack
registry as schema debt because migration `032_create_vertical_packs` declares
`CHECK (type IN ('hvac', 'plumbing'))`. Migration
`089_drop_vertical_packs_type_check` drops it, 1,600 lines later in the same
file.

**In a replay-in-full migration model, no single migration is the schema.**
§9 already says the schema is *"277 migrations replayed in full on every
boot"* — so the schema is the fold over all of them, and any one of them is an
intermediate state. Nothing in the source distinguishes the two: migration 032
looks exactly as authoritative on line 823 as 089 does on line 2424, and a
reader who finds the first hit has no signal that a later one reverses it. This
is the same failure as *directory location is not evidence* and *a grep proving
one writer is unwired does not prove no writer exists* — **a true observation
about one location, read as a fact about the system** — but the migration file
is its most dangerous host, because the convention that makes it safe for
Postgres (idempotent, replayed, append-only) is exactly what makes single-hit
reading unsafe for a human. The check is one line: `grep -n "<table>"
db/schema.ts`, and read **every** hit.

The correction to that entry then reproduced the error inside itself — a claim
that the swallowed-`.catch()` the migration's comment blames was still present,
written without opening the file. It is not; the catches write to stderr. Caught
before publishing only by running the rule the same paragraph had just stated,
which is the strongest argument in this section for **mechanising** these checks
rather than adding another one to the list.

**The seventeenth is the one shape here a machine could check today**, and it is
the inverse of every other entry in this section. The others are claims that
*under-read* the evidence — one file, one migration, one grep, taken for the
whole. This one **over-read** it: §12.4 said the workflow-trigger subsystem had
*"zero callers anywhere, not even tests."* Production callers: zero, correct.
Tests: `test/ai/orchestration/triggers.test.ts` exercises four exports across
ten cases. The same overreach sat in the next bullet, for the guardrail
expiration module.

**The eighteenth broke the rule above by obeying it.** One round after that
scope rule was published, §12.4's first bullet was found to say the urgency-tier
classifier has *"zero production callers."* It has one: `classifyCallerSafety`
imports and calls `classifyUrgencyTier` at `emergency-tier.ts:224`. A
`packages/api/src`-scoped grep — exactly the right scope — returns that hit
second. **The scope was never the problem; the reading was.** A rule that
compares paths cannot help someone who stopped at the first line of output, and
it is worth saying plainly that the rule published in the previous entry would
not have caught the very next finding.

What the bullet should have said is a category the dormant list did not have.
`classifyUrgencyTier` runs only `if (rules)`, and the one live call site passes
none — `twilio-adapter.ts:1620` calls `classifyCallerSafety(speechResult, {})`.
So it is **wired and structurally unreachable**: the gap is a missing argument,
not a missing caller, which makes it cheaper to close than anything else in the
list and a mistake to delete. That is the same shape as §12.4e's supervisor gate
— *not dark, structurally incomplete* — and the list had only two buckets
(wired / unwired) when the interesting cases live in a third.

**The nineteenth is the third finding against the fan-out harness itself**, and
the most specific: the thank-you-SMS block recorded only `input.to`, so it would
have passed had every message been dispatched under the **first** tenant's id,
with the production consent-ledger and DNC lookups running in the wrong scope on
a real call. **Recipient identity is not tenant identity.** The test now captures
the whole dispatch input and asserts each message's `tenantId` and
`consent.customerId` against the tenant that owns the recipient; a mutation that
forwards one tenant's id for every send fails both cases.

Three findings against the instrument built to catch overclaiming is worth
stating as its own result: **a harness earns its authority the same way a
capability does — by evidence, round after round — and it started with none.**

**Applying the scope rule to the rest of the document found three more**, none of
them raised in review: story 4.11 and §12.4c both said `setTechnicianAssignmentNotifier`
has *"zero callers"* (it has an `assignment-notifications.test.ts`), and §12.4's
own flag analysis said `setTenantFlag` has *"zero callers"* — **four** test files
call it, three of them Docker-gated. All now read *production* callers. That the
sweep found three more on the first pass is the argument for the rule; that none
of them needed judgement to find is the argument for automating it.

**A claim may not be wider than the command that supports it.** The evidence was
a `packages/api/src`-scoped grep, which can say something about `src` and
nothing whatever about `test`. Unlike *"is this rung earned"* or *"does this
claim contradict another"*, this one needs no judgement at all — compare the
paths a claim ranges over with the paths its command searched — and it is the
first entry in this section that could be a lint rule rather than a habit.

Two details make it worse than a wording slip. First, **the correct phrasing was
three lines away**: the other three bullets in the same list are scoped
precisely (*"zero **production** callers"*, *"no worker or route invokes it"*,
*"zero **non-test** importers"*), and the document already had the right
category two bullets down — *"Two AI skills … tests only."* Second, the
consequence runs the wrong way. Everywhere else in §12, an overclaim inflates
what the product can do; here it **erases evidence that exists**, in a list read
as a delete-or-wire backlog. *"Not even tests"* is an invitation to delete a
module whose behaviour is currently pinned.

The general lesson is narrower than "be careful." It is that **a rung is a claim
about evidence, so it must be derived from the evidence and never from reading
the source.** Every rung in §5 and §8 now carries the command that confirms it;
a number without one should be treated as a prediction — and a number *with* one
should be treated as a prediction until someone has checked that the command
looks where the claim lives.

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
