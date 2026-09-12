# Rivet — User stories, acceptance criteria, and verified state

**Companion to [`docs/PRD-v5-as-built.md`](PRD-v5-as-built.md) and
[`docs/PRD-v5-acceptance.md`](PRD-v5-acceptance.md). Created 2026-09-12.**

## Why this view exists

The acceptance register proves things about *code*. This document asks the prior
question: **whose problem is this, what did they ask for, and would they accept
it?**

Same evidence, three columns of context added. Each row is a user story in a
named persona's voice, an acceptance criterion written as
Given / When / Then from **that persona's** point of view, and the rung that
says how far we can actually confirm it.

The translation matters because a rung is not a verdict on value. **Rung 4
means the code is proven; it does not mean Mike would accept the story.** Two
rows below are rung 4 and would still fail their acceptance criterion, because
the criterion includes "and Mike can turn it on," which he cannot.

### The personas, in one line each

| | Persona | The shape of their problem |
|---|---|---|
| **M** | **Mike Rivera** — HVAC, Phoenix, 2 trucks, ~$680K | Dispatcher, CSR, estimator, bookkeeper and tech. Peak season is 102°F and the phone never stops |
| **J** | **Jenna Walsh** — plumbing, Cleveland, solo, ~$340K | Single-threaded by choice. Frozen-pipe season at 4am. Wants her life back, not a fleet |
| **T** | **The tech going independent** | No systems, no price book, no processes. Rivet is the first software they buy |
| **S** | **The owner's spouse, doing the books Saturday morning** | The unseen second user. The digest and the weekly summary are their whole product |

### The rung scale, as an acceptance question

| Rung | What we can confirm |
|---|---|
| **0** | Nothing implements it |
| **1** | Designed, not built |
| **2** | Built, but **nobody can reach it** — zero production callers, or no test at all |
| **3** | Works against mocks. *We believe it; we have not seen it survive a real database* |
| **4−** | The row lands in real Postgres. **The audit trail is not proven** |
| **4** | The row **and its audit event** land in real Postgres |
| **5** | Rung 4, **and the persona can actually get to it** — no SQL, no admin, no env var |
| **6** | A real tenant has used it in production. **Empty across the entire product** |

**The honest reading of the scale:** below 4, the story is a belief. At 4, it is
proven but may be unreachable. Only at 5 has the persona been served, and only
at 6 have we watched them be served.

---

## Summary by epic

| Epic | Job | Stories | Median rung | The one thing in the way |
|---|---|---|---|---|
| **E1 Stand up the back office** | precondition | 11 | 4 | Invite emails 404 — `/accept-invitation` has no route |
| **E2 Answer my phone when I can't** | J1, J3, J10 | 12 | 3 | Emergency detection has no real-DB proof; recording consent is mocked |
| **E3 Book the job without me** | J2 | 12 | 4 | Customer never provably gets a confirmation |
| **E4 Run the day** | J1, J10 | 11 | 3 | The drag→proposal guarantee is untested at the DB |
| **E5 Capture the work in the field** | J5 | 5 | 4 | Field screens aren't pinned to the glove/daylight contract |
| **E6 Let me fix it by talking** | J9 | 9 | 4 | No spoken-address entity; owner can't say "the house on Elm" |
| **E7 Draft the quote from what was said** | J4, J10 | 12 | 4− | 7 of 12 overstated; the stale-revision guard has never met a real DB |
| **E8 Bill it and chase the money** | J5, J6 | 13 | 4 | Dunning cadence idempotency is unproven — duplicate collections texts |
| **E9 Tell me what happened and what you got wrong** | J7, J8 | 12 | 4 | **The digest cannot be turned on by anyone** |
| **E10 Never exceed your authority** | J8, J10 | 20 | 4 | The second classifier reaches 2 of 93 origins |

**117 stories. Zero at rung 6.** Nothing in this product has been observed
serving a real tenant.

---

## E1 — Stand up the back office

**Primary persona: T (the tech going independent), then M.** This epic is the
precondition for every other one. T has no price book and no processes; the
product has to manufacture them during onboarding or nothing downstream works.

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

---

## E2 — Answer my phone when I can't (J1, J3, J10)

**Primary personas: M in an attic with gloves on; J at 4am.** This is the epic
the product is named for. It is also the epic with the widest gap between what
we believe and what we can prove.

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

---

## E3 — Book the job without me (J2)

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

---

## E4 — Run the day (J1, J10)

**Primary persona: M as dispatcher, which is the job title he never wanted.**

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

---

## E5 — Capture the work in the field (J5)

**Primary persona: Carlos, and M when he's the tech. Gloves, daylight, one hand.**

| # | User story | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **5.1** | **As Carlos**, I want to use this with gloves on in the sun, so I don't take them off forty times a day | **Given** any field screen, **when** rendered at 320px, **then** every tap target is ≥44px and nothing overflows horizontally | **3** | The jsdom + Playwright contract exists for **estimate approval and review response**; 🚨 **field screens are not pinned the same way** |
| **5.2** | **As M**, I want before/after photos attached to the job, so I can defend the invoice | **Given** a captured photo, **when** stored, **then** category and before/after pairing survive the round trip | 4 | **D:** job-photo integration tests |
| **5.3** | **As Carlos**, I want to log my hours by talking, so paperwork never follows me home | **Given** a spoken duration, **when** executed, **then** a `time_entries` row lands with the resolved `jobId`, **exactly one** audit event, tenant-scoped — **and it is counted by the job-profit query** | **4** ↑ | **D:** `log-time-entry-execution.test.ts` ✅ *executed* |
| **5.4** | **As J**, I want a note dictated in a basement with no signal to survive and arrive later, so I never lose work to dead zones | **Given** an offline capture, **when** connectivity returns, **then** the journal flushes, the same key twice yields **one** row and one effective job, a create-then-crash replay re-enqueues, and **local audio is deleted only on confirmed flush** | **4** ↓ | **D:** `voice-idempotency.test.ts` ✅ *executed* · **U:** mobile `queue/flush/audioRelocation`. *Rung 5 needs a device-level proof of the reconnect edge; none exists* |
| **5.5** | **As J**, I want to take a card on the doorstep, so I get paid before I drive away | **Given** an active Connect account, **when** I tap to pay, **then** the charge completes — **and without one, a clean 409, never a silent failure** | 3 | **U:** `stripe-terminal.test.ts`. 🚨 **No Docker-gated test** |

---

## E6 — Let me fix it by talking (J9)

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

---

## E7 — Draft the quote from what was already said (J4, J10)

**Primary persona: M at 6:15am making lunches one-handed.** **This epic has the
heaviest concentration of overstatement in the product — 7 of 12 rows.** It is
also the epic where a wrong number becomes a price a customer is legally bound
to.

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

---

## E8 — Bill it and chase the money (J5, J6)

**Primary personas: J walking out of the job; M 30 days later with $12K
outstanding.** The money surface is the best-evidenced area in the product and
also holds its single largest overclaim.

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

---

## E9 — Tell me what happened, and what you got wrong (J7, J8)

**Primary personas: M at 9:30pm with the kids in bed; S doing the books Saturday
morning.** This epic is the trust pillar and the product's stated thesis that
**the digest is the dashboard.**

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

---

## E10 — Never exceed your authority (J8, J10)

**Every persona, all the time.** These are the *negative* stories — the ones
whose acceptance criterion is that something never happens. They map to
invariants I1–I18 and they are the trust contract the product sells. An
anti-persona is defined against them: *"the owner who wants AI fully
unsupervised"* is explicitly not the customer, and §5 shows the refusal is
structural rather than policy.

| # | User story | Acceptance criterion | Rung | Confirm |
|---|---|---|---|---|
| **10.1** | **As M**, I want the AI to never write to my business records directly, only propose, so nothing happens without me | **Given** a drafted proposal, **when** it exists, **then** **zero** rows exist in the target table; after approval, exactly one row **and** its audit event | 4 | **D:** `create-job-execution.test.ts` |
| **10.2** | **As M**, I want that to be true of *every* path, not just the ones someone tested | **Given** any AI module, **when** it runs, **then** it cannot call a repository write | **2** 🚨 | **CODE-ONLY** — no lint rule, no import guard. *A tested behaviour, not an enforced invariant* |
| **10.3** | **As M**, I want no automated actor to ever be able to approve on my behalf, so "approved" always means a human did it | **Given** any starting status, **when** a `system:` actor attempts `approved`, **then** it throws | 3 | **U:** `lifecycle.test.ts`. 🚨 *In-memory objects only; **zero** integration tests attempt a `system:` approval* |
| **10.4** | **As M**, I want spoken approval of money to require a challenge and lock out after three failures, so a stranger with my phone can't approve a refund | **Given** three wrong codes in one session — **including across a cancelled and restarted dialogue** — **then** the session locks for money/irreversible classes while capture-class still approves | 3 | **U:** `proposal-approval-task.test.ts`, `voice-approval-gather.test.ts`. *The "readback comes from the payload, never my utterance" clause has **no** provenance test* |
| **10.5** | **As M**, I want an AI-invented price to never be authoritative, so my catalog is the only source of truth | **Given** one uncatalogued line, **when** drafted, **then** `requiresReview === true` regardless of tenant settings or confidence, and `pricing_source` is CHECK-constrained on disk | 4 | **U:** `catalog-resolver.test.ts` · **D:** `invoice-pricing-source.test.ts` |
| **10.6** | **As M**, I want it to ask instead of guessing, on every surface, so it never acts on the wrong customer | **Given** two same-named customers, **when** drafting, **then** **exactly one** question is asked and no id persists until a follow-up names a candidate | 4 | **D:** `chat-entity-resolution.test.ts` |
| **10.7** | **As M**, I want the surfaces to ask the same way, so behaviour doesn't depend on which one I used | **Given** one shared disambiguation matcher, **when** surfaces diverge, **then** the build fails | **2** 🚨 | **FALSE AS WRITTEN.** A second, deliberately broader gate exists whose own comment says it *"is allowed to be slightly BROADER."* Nothing fails if they drift |
| **10.8** | **As M**, I want every question it asks me to be answerable, so it never blocks on something I can't resolve | **Given** any entity-id gate a proposal can emit, **when** raised, **then** a resolver exists behind it | **2** 🚨 | **NO EVIDENCE** — and a test pins the **opposite** as supported: an unresolvable gate is a legal state. The invariant says such a gate "can never be approved" (#909). **Both cannot be true** |
| **10.9** | **As M**, I want it to never discount, never commit scope, and never promise a human will call, so it can't give away my margin | **Given** no configured discount policy, **when** any ask arrives, **then** zero concession — **and no registered proposal type can even express an AI-applied discount** | 4 | **U:** `negotiation-invariant.test.ts`, `discount-evaluator.test.ts` — *a type-level impossibility proof, not a behaviour sample* |
| **10.10** | **As J**, I want safety to beat every other consideration, so containment never wins over a life | **Given** a tier-1 phrase, **when** detected, **then** E1 with **no rules loaded**, and complaint escalation fires from **every** live state | 3 | **U:** emergency + complaint tests |
| **10.11** | **As J**, I want no setting anywhere to be able to switch that off, so a misconfiguration can't be fatal | **Given** any tenant configuration, **when** safety fires, **then** it cannot be suppressed | **2** 🚨 | **NO EVIDENCE.** Rests on the *absence* of a parameter, which nothing pins. A future flag would break it silently |
| **10.12** | **As M**, I want money to be integer cents everywhere, so rounding never drifts | **Given** ≥1000 randomized documents, **when** totalled, **then** every field is an integer and totals never go negative; the server recomputes and **discards the client's number** | 4 | **U:** `billing-engine.property.test.ts`, `line-item-normalization.test.ts`. *"One engine as the only source of totals math" is unguarded* |
| **10.13** | **As M (Phoenix)**, I want a missing timezone to make it **refuse**, not guess, so I never get a 2pm booking at the wrong 2pm | **Given** no configured zone, **when** a booking is spoken, **then** the draft has no window, approval **refuses**, and **zero** appointment rows exist | 4 | **D:** `live-call-booking-timezone.test.ts` — *the column default was dropped after a real Phoenix mis-booking* |
| **10.14** | **As M**, I want my data to be mine at the database, not by application convention, so a code bug can't leak it | **Given** every `tenant_id` table, **when** checked at runtime, **then** RLS is **enabled and forced** with exactly two documented exemptions — and production **refuses to boot** without the non-bypassing role | 4 | **D:** `rls-force-catalog.test.ts`, `rls-runtime-audit.test.ts`, `rls-runtime-role.test.ts` — **the best-evidenced invariant in the product** |
| **10.15** | **As M**, I want every change to leave a trail I can audit, so I can always find out what happened | **Given** an execution, **when** the audit insert fails, **then** the **whole unit rolls back** — no state change without its audit row | 4 | **D:** `executor-audit-atomicity.test.ts` (both directions). 🚨 **Tier 2 caveat: handler domain audit is best-effort and a failure is swallowed. During an audit-store outage, operational state can be created without its domain audit row** — unit-proven for **one** handler family, ~40 untested |
| **10.16** | **As M**, I want what a caller says to be treated as data forever, so nobody can talk the AI into doing something later | **Given** a transcript containing fence-marker lookalikes, **when** read back hours later, **then** marker counts are exactly 1 each and the caller block sits in the lowest-authority slot | 3 | **U:** untrusted-content tests. 🚨 *"Every operator-facing context" is unguarded — exactly three call sites; a new prompt inlining a transcript passes CI* |
| **10.17** | **As a customer**, I want "STOP" to stop everything, so one revocation doesn't leak across channels | **Given** an SMS `STOP`, **when** an outbound **call** is attempted, **then** it is blocked even while `consent_status` still reads granted; **given** `START`, **then** SMS restores and the voice rollup stays revoked | 4 | **D:** `consent-cross-channel.test.ts`, `stop-reply-unify.test.ts` |
| **10.18** | **As M**, I want a second classifier checking **every** booking and quote, so an obvious mistake is caught before it reaches a customer | **Given** any booking/quote reaching an owner-facing dispatch — **any** origin, **any** status — **then** exactly one supervisor review exists first | **2** 🚨🚨 | **NOT KEPT.** The gate has **2 call sites against 93 proposal-creation sites**; one is conditional on `ready_for_review` so **low-confidence quotes are skipped precisely because the agent was unsure**; default mode is `shadow` where nothing ever holds; and `pricing_anomaly` is not a harm check, so **a pricing anomaly cannot hold even in `enforce`** — the exact clause the commitment names. **Raised as O-9** |
| **10.19** | **As M**, I want auto-approval to stay a narrow, reversible exception, so "AI books it" never becomes "AI runs it" | **Given** a fresh tenant, **then** the lane is **off** at 0.95; a raw SQL drop to 0.80 is **refused by a DB CHECK**; and the lane returns ineligible for each of 19 single-gate mutations, with the platform kill switch outranking tenant opt-in | 4 | **D:** `settings-autonomous-booking.test.ts` · **U:** `autonomous-lane.test.ts`, `one-tap-undo.test.ts` |
| **10.20** | **As M**, I want no feature to ever add work to my day, because that is the entire reason I bought this | **Given** any owner-role action required on a normal day, **when** enumerated, **then** it is reachable by SMS, one-tap or voice — or is in a reviewed exemption list | **0** 🚨 | **No enforcement of any kind, and no test.** The product's founding promise is the only invariant with nothing behind it. Three ways to make it falsifiable are in `PRD-v5-acceptance.md` §A.6 |

---

## How to use this table

**In refinement.** A story is not ready until its acceptance criterion is one
falsifiable sentence with a persona in it. Several rows above were rewritten
during this exercise because "booking works" is not a criterion — *"zero
appointment rows exist before approval"* is.

**In review.** The rung is the answer to *"can we confirm this?"* — not
*"is this good?"* The two come apart in both directions:

- **Rung 4 and the story still fails.** 9.6 (digest) and 2.7 (dropped-call
  recovery) are proven at real Postgres and **Mike cannot turn either on**.
  4.11 is worse: Carlos is never notified of an assignment, and the module's own
  doc-comment claims otherwise.
- **Rung 3 and the story is probably fine.** 2.5 (emergency detection) is
  thoroughly unit-tested with a bilingual corpus and an upward-only bias. It is
  very likely correct. We simply cannot *confirm* it survives a real database,
  and for a life-safety path that gap is the finding.

**In planning.** The rung tells you what kind of work closes the gap, and they
are not interchangeable:

| Gap shape | Work it needs |
|---|---|
| **0** | Build it (4.9, 4.10, 6.8, 10.20) |
| **2 — unreachable** | Wire it. Usually one call site (4.11, 2.12) |
| **2 — unguarded invariant** | Write the structural test (10.2, 10.7, 10.8, 10.11) |
| **3** | Write the Docker-gated test. **The code is probably fine** |
| **4−** | Swap `InMemoryAuditRepository` → `PgAuditRepository`. *One import closes four §7 rows* |
| **4 — unlit-able** | Ship a write path. Not a feature — a route and a toggle |
| **5** | Nothing. Get a tenant on it and earn rung 6 |

**The single highest-value item is 10.18**, because it is the only row where the
honest fix might be to **change the commitment** rather than the code — and that
is a product decision, not an engineering one (O-9).

### Stories that pass their rung and fail their user

Worth stating plainly, because these are invisible in any engineering-only view:

| # | Story | Rung | Why it still fails |
|---|---|---|---|
| **9.6** | End-of-day digest | 4 | No route or UI writes `digest_enabled`. **The product's central promise cannot be switched on** |
| **2.7** | Dropped-call recovery | 4 | `setTenantFlag` has zero production callers |
| **4.11** | Technician assignment notice | 2 | Silent no-op on every assignment; doc-comment says otherwise |
| **1.11** | Team invites | 4 | The invite is written perfectly and the email 404s |
| **2.12** | B2B recognition | 3 | Recognised, assembled, and **never routed on** |

Five stories where the engineering is done and **the user is not served**. That
is a different backlog from the test-writing one, it is much cheaper, and it is
the one a customer would notice first.
