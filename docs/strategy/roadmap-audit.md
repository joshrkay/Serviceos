# Roadmap Audit — 14 Decisions × 20 Phases

**Purpose**: Map the current 20-phase roadmap against the 14 locked product
decisions from `day-in-the-life.md`. Identify what to cut, defer, pull
forward, and add — so the build matches the pitch.

**TL;DR — the headline finding**

The roadmap is built around a frame the strategy doc has moved past:
*"A modern small-business CRM with AI assist."* The strategy doc commits to a
different product: *"AI runs the back office; the owner uses SMS and a 30-
second-a-day digest."* Under that frame, roughly **30–40% of the roadmap's
UI surface area (dispatch board, customer portal, conversation thread UI,
inline-proposal views) becomes optional or post-MVP.** And four of the 14
locked decisions have no story at all in the current roadmap.

Two changes will close most of the gap:

1. **Make SMS a first-class approval surface** (not just a comms channel) —
   today every proposal assumes a web/UI approval flow.
2. **Add four missing stories** — end-of-day digest, supervisor-agent review
   pass, dropped-call SMS recovery, and Google review monitoring.

The rest is re-sequencing, not rebuilding.

---

## The 14 × 20 alignment matrix

Legend: ✅ aligned · 🟡 partial / needs sharpening · ❌ missing · ⚠️ misaligned (built for the wrong frame)

| # | Locked decision | Current roadmap home | Status |
|---|------------------|----------------------|--------|
| 1 | SMS is the primary interface | P3 conversation UI, P7-001..004 (Twilio), P11-006..008 (compose) | ⚠️ Roadmap treats SMS as a channel, not the *approval surface*. Approvals assume web UI. |
| 2 | End-of-day digest is the dashboard | — | ❌ No story. P10-002 is an executive dashboard (wrong artifact). |
| 3 | One-tap approvals with dictation edits | P2 (typed proposals + execution), P3-002 (voice capture) | 🟡 Approval mechanics exist; SMS-tap + voice-dictation channel does not. |
| 4 | Confidence is surfaced, not hidden | P2 guardrails, P4 templates, P18 acceptance criteria | 🟡 Confidence scored internally; not surfaced to the owner in the approval UX. |
| 5 | Supervisor-agent review of every booking/quote | — | ❌ No story. Closest neighbor is P18 acceptance-criteria tests (offline QA, not runtime). |
| 6 | Emergency intent overrides automation | P8 calling agent (escalate skill) | 🟡 Generic escalation exists; vulnerability-aware triage (age + weather + medical) does not. |
| 7 | Never discounts or promises scope changes | P2 typed contracts (implicit) | 🟡 Implicit guardrail — no story making "negotiation pushback → human" explicit. |
| 8 | Dropped calls trigger automatic SMS recovery | — | ❌ No story. P8 covers the call; not the recovery. |
| 9 | B2B account recognition is first-class | P9-001 lead pipeline, P13 multi-location | ⚠️ Sequenced post-launch (P13); needs to be in P1/P3. |
| 10 | Vertical packs (HVAC + plumbing) | P4 (full vertical pack family) | 🟡 Strong bones. Missing: MMS-to-quote, severity-aware plumbing triage, HVAC equipment-history awareness. |
| 11 | Google review monitoring + draft response | — | ❌ No story. P10-003 is outbound *requests*, not inbound monitoring. |
| 12 | Brand voice configurable, then locked | P4 templates (implicit) | 🟡 Implicit in vertical packs; not specced as a configurable, locked surface. |
| 13 | Every AI mistake is a learning event | P0-015..018 AI run logging | 🟡 Logging exists; corrections-update-system loop and "what I learned" digest UX do not. |
| 14 | No feature ships that adds admin work | — (principle) | ⚠️ P6 dispatch board, P10-001 portal, P3 conversation UI all add owner-operator admin surface area. |

**Score**: 0 fully aligned · 7 partial · 4 missing · 3 misaligned (frame).

---

## What this means by category

### ❌ The four missing stories (must add)

These exist in the strategy but have no roadmap home. Each is a small, well-
bounded piece of work that the strategy doc treats as table stakes.

| Story | Where it lives | Effort estimate |
|-------|----------------|-----------------|
| **End-of-day digest** — 6–9pm SMS summary with a "what I wasn't sure about today" section, sourced from the day's proposal log + confidence flags. One-tap "Looks good" reply. | New: P5 or P2 extension | S — 1–2 weeks |
| **Supervisor-agent review pass** — A cheaper classifier reviews every booking and quote post-hoc for missed urgency, pricing anomalies, out-of-pattern decisions. Surfaces flags via SMS within minutes. | New: P2 extension or new P2.5 | M — 2–3 weeks |
| **Dropped-call → SMS recovery** — Voice session ends without resolution → automatic SMS within 60s with partial transcript context. | New: P8 sibling story | S — 1 week |
| **Google review monitoring + draft response** — Polls Google Business Profile, flags new reviews, drafts a public response + private apology + optional service credit for owner approval. | New: P7 (integrations) sibling | M — 2 weeks |

**Combined**: roughly 6–8 weeks of work. None of this is in any phase today.

---

### ⚠️ The frame mismatches (must rethink, not just build)

These aren't missing — they're built around the wrong assumption. The
strategy doc says *"if the owner has to open the app to do their job, we
failed."* The roadmap routinely assumes the owner opens the app.

**1. SMS as primary interface (decision #1)**
- The roadmap treats SMS as a channel (inbound/outbound messages). The
  strategy treats SMS as the **approval surface for every proposal**.
- *Fix*: Add a story under P2 — `P2-XXX: SMS approval transport`. Every
  proposal type already wired for web UI must be dispatchable as a
  formatted SMS with **Approve / Edit / Reject** affordances, accepting
  voice-dictated edits as replies.
- *Implication*: The "inline proposal" UX in P3 conversation thread becomes
  secondary, used by dispatchers and back-office users, not by owner-
  operator ICPs.

**2. B2B account recognition (decision #9)**
- Today it lives in P13 (multi-location, team hierarchies). That's the wrong
  scope and the wrong timeline.
- *Fix*: A minimal `account_type` field (residential vs. commercial vs.
  property-manager) on the customer entity in P1, plus an account-aware
  routing rule in P3/P8. **Jenna's Greenfield moment doesn't work without
  this.**
- *Effort*: Days, not weeks. Pull forward.

**3. The "no admin work" litmus test (decision #14)**
- Three current roadmap items create owner-facing admin work that the
  strategy says we shouldn't add:
  - **P6 Dispatch Board (visual day-view, drag-to-schedule)** — owner-
    operators don't dispatch; they *are* the schedule. Defer for the 3+-
    truck segment.
  - **P10-001 Customer Portal** — service customers do not want a portal,
    they want to text. Defer indefinitely or kill.
  - **P3 Conversation Thread UI** — useful for dispatcher persona; owner-
    operator approves via SMS digest. Keep, but de-prioritize for ICP.
- *Implication*: P6 and P10 should not block GA for the owner-operator
  segment. They can ship later for larger shops, or never.

---

### 🟡 The seven partials (sharpen the spec)

These have the right bones but the strategy adds specificity that isn't in
the story yet.

| # | What to add to the existing story |
|---|------------------------------------|
| 3 | Add SMS+dictation as a first-class approval transport (see frame fix above). |
| 4 | Add a confidence-surfacing UX spec: where confidence shows up (parts, prices, urgency, model numbers), what threshold flags it, what the user sees. Not "every line gets a %". |
| 6 | Extend P8 escalation skill with a **vulnerability signal**: age (>65), weather (>100°F or <20°F), medical mention. Vulnerability + urgency = voice patch to owner, not booking. |
| 7 | Add an explicit guardrail story: *"AI never discounts, never commits to scope changes, never promises a person."* These intents route to owner with a recommendation. |
| 10 | Three additions to P4: **(a)** MMS-to-quote for plumbing (photo + customer history → draft quote), **(b)** severity classifier for plumbing ("active leak > frozen no leak"), **(c)** HVAC equipment-history awareness (model number, last service, age). |
| 12 | Add a brand-voice config story: configurable tone (formal/casual), opening lines, sign-off, banned phrases — locked after onboarding. Applied to every utterance (call, SMS, invoice, review response). |
| 13 | Build the **correction-loop UX**: when the owner edits a proposal, the system extracts the lesson (e.g., "labor rate is $145, not $122") and applies it forward. End-of-day digest reports back: *"things I learned today."* |

---

## What to cut, defer, pull forward, and add

A re-sequencing proposal, organized by action.

### Cut (or indefinitely defer for the owner-operator ICP)

- **P10-001 — Customer portal**. Service customers don't want it. They want
  to text. Kill or repurpose the effort as a "links shared via SMS" pattern.
- **P10-002 — Executive dashboard**. The end-of-day digest *is* the
  dashboard. Don't build a second one.
- **P14 — Inventory + parts** (full system). The owner-operator carries
  parts in the truck; doesn't run inventory. Keep a thin "parts on
  estimates/invoices" surface, defer the rest until enterprise tier.
- **P16 — Lifecycle marketing / churn prediction**. Out of scope for V1.

### Defer (post-MVP, post-PMF)

- **P6 Dispatch Board** — useful for shops with 3+ trucks. Owner-operator
  schedule fits in the SMS digest. Defer until the ICP expands.
- **P9 — Lead pipeline + service agreements**. Useful, but not in the day-
  in-the-life. Validate ICP demand before building.
- **P12 — Field operations (route optimization, offline support)**. Real,
  but post-PMF.
- **P13 — Multi-location rollup**. Defer; pull only the `account_type`
  field forward.
- **P15–P19** — Premium / hardening / "supervisor mode" phases. All post-
  PMF.

### Pull forward (move earlier than current sequencing)

- **B2B `account_type` field + routing** — from P13 into **P1**.
- **MMS-to-quote (photo flow) for plumbing** — into **P4** vertical pack.
- **Severity-aware plumbing triage** — into **P4** vertical pack.
- **Brand-voice config** — into **P2** or **P4** (before the first AI
  utterance ships to a real customer).

### Add (new stories — the four missing + supporting work)

- **P2-XXX: SMS approval transport** (S)
- **P2-XXY: Confidence-surfacing spec for proposals** (S)
- **P2-XXZ: Negotiation / scope-change guardrail handler** (S)
- **P2.5 (new): Supervisor agent review pass** (M)
- **P5-XXX: End-of-day digest generator + "what I learned today" section** (M)
- **P7-XXX: Google Business review monitoring + draft response** (M)
- **P8-XXX: Dropped-call SMS recovery** (S)
- **P8-XXY: Vulnerability-aware emergency triage** (S)
- **P2/P4: Correction-loop UX** (M)

**Estimated combined work for the new stories**: 10–14 weeks of focused
effort. Roughly equivalent to deferring P6 alone.

---

## Suggested re-sequenced roadmap for the owner-operator ICP

Compressed view: what to build, in what order, to ship the day-in-the-life
to Mike and Jenna.

**Wave 1 — Foundation (already underway, finish as planned)**
- P0 platform foundation, P1 core entities (+ `account_type` pulled in),
  P2 proposal engine (+ SMS transport, confidence-surfacing,
  guardrail handler).

**Wave 2 — AI back office MVP** (the new heart of the product)
- P4 vertical packs (HVAC + plumbing, with MMS-to-quote, severity, equipment
  history, brand voice config).
- P5 invoice intelligence + payments + **end-of-day digest** + correction-
  loop UX.
- P7 integrations slimmed: Twilio SMS, Stripe, **Google review monitoring**.
  Defer QuickBooks deep sync to Wave 4.
- **P2.5 supervisor-agent review pass.**
- P8 inbound calling agent + **dropped-call recovery** + **vulnerability
  triage**.

**Wave 3 — Beta hardening and launch**
- P11 voice/UI parity slimmed to: Spanish, lookup skills. Defer UI compose
  forms.
- P18 acceptance-criteria tests.
- Launch readiness checklist (subset of P7).

**Wave 4 — Post-PMF expansion**
- P3 conversation thread UI (for dispatcher persona).
- P6 dispatch board (for 3+-truck shops).
- P9 leads + agreements.
- P10 portal (if ever).
- P12–P19 in priority order based on customer signal.

---

## The big reframes (the non-obvious takeaways)

**1. The product isn't a CRM with an AI button. It's an AI back office with
a thin CRM under it.** This changes how to prioritize UI surface area. Every
screen has to justify its existence against *"could SMS do this?"*

**2. The supervisor-agent pattern (decision #5) is currently nowhere in the
roadmap, and it's the single biggest trust differentiator.** It's what makes
the "bad Tuesday" story work. Building it later means trust failures in
early customers.

**3. The end-of-day digest (decision #2) is the pricing artifact.** It's
what the customer experiences when they think "what am I paying for?" — not
a dashboard, not a settings page. If the digest is great, retention is
great. There's currently no story for it.

**4. Vertical packs (P4) are stronger in the roadmap than in most
competitors — keep this lead.** But the strategy says they need MMS,
severity, and equipment history. These are the moats. Spec them now.

**5. Half a dozen "obvious modern SaaS features" (portal, executive
dashboard, dispatch board, lifecycle marketing) are listed as roadmap items
but actively undermine the pitch.** They add admin work to the owner's day.
Cutting them is a positioning decision, not a scoping decision.

---

## How to use this document

- **Engineering planning**: Use the matrix as the ticket source. Every ❌
  row needs a story written. Every 🟡 row needs an existing story amended.
  Every ⚠️ row needs a working-session to re-frame.
- **Phase reviews**: When a phase is up for review, check it against the 14
  decisions before approving its stories. If it doesn't move a row toward
  ✅, ask why it's in the phase.
- **Sales / GTM**: Wave 2 is the shippable product. Don't sell against
  Wave 4 features (portal, dispatch board) — they're not coming first, and
  they're not the pitch.
- **This document is versioned alongside `day-in-the-life.md`.** When
  either changes, the other gets a re-audit.
