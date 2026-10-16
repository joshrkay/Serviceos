---
title: "Onboarding as a scenario interview — the owner tells the agent how to behave by reacting to calls, not by filling forms"
date: 2026-10-16
status: product design (feeds U9 in docs/plans/2026-10-16-001-feat-voice-parity-bland-avoca-plan.md)
companion: docs/research/voice-parity-deep-dive-2026-10-16/
tags: [onboarding, voice-ai, product, scenario-library, corpus, learning-loop]
---

# Onboarding as a scenario interview

## The idea in one paragraph

Today the owner configures the agent by filling in forms (identity, pack, voice, hours) and
then calls a number to see what happens. The proposal here is to invert that: the agent plays
the owner a short series of real calls ("A caller says: *my AC's out, it's 104 in here and my
mom's on oxygen.* Here's what I'd do…"), asks "is that right, or would you rather I…?", and
turns every answer into a typed setting. The owner hears the agent handle the twelve situations
that matter for their trade, corrects the ones they'd handle differently, adds the situations we
did not think of, and then places the test call themselves. Setup stops being configuration and
becomes the first conversation between an owner and their new front desk.

Everything this needs already exists in some form in the repo; the design is mostly about
pointing those parts at the owner instead of at CI.

## Why this is the right shape for Rivet specifically

1. **The example library already exists.** The voice-quality corpus is 89 golden scripts in 12
   buckets (`packages/api/src/ai/voice-quality/corpus/scripts/`). Each one is a caller
   utterance, the expected intent and slots, the expected spoken answer, and whether it
   escalates. That is exactly the "here's our 50 examples" the owner should react to. Today
   only CI reads them.
2. **The agent's behaviour menu is finite.** Because the phone speaks no LLM prose and every
   outcome is an FSM effect (book, hold for the owner, transfer now, take a message, decline
   politely, ask one clarifying question, run the emergency script, send to voicemail), the
   question "how would you like me to handle it?" has an enumerable answer set. That is what
   makes the owner's answer typeable instead of a prompt fragment.
3. **The conversational setup surface exists.** The talk-through orchestrator
   (`ai/agents/onboarding/transitions.ts`) already walks profile → services → pricing → team →
   schedule → tools, extracts structured fields, and mints `onboarding_*` proposals into the
   inbox. The scenario interview is one more act in that conversation, not a new surface.
4. **Corrections already become lessons.** `corrections` (per-field edit log) and
   `correction_lessons` (cascading config lessons with undo) mean "no, I'd do it this way"
   during onboarding is the same mechanism as "you got that wrong" on day 30. Onboarding seeds
   the learning loop instead of running beside it.
5. **The owner can hear it.** U6's preview mode runs the real caller FSM in the browser with
   the owner's chosen voice. A scenario is not a card to read; it is 20 seconds of the agent
   talking, followed by "sound right?".

## What the interview asks, by scenario family

The twelve corpus buckets map onto the decisions a shop actually has to make. Each family is
one to three scenarios; each scenario is under 45 seconds; the whole second act is 12 to 15
scenarios for a typical shop and fits in about ten minutes.

| Family (bucket) | The scenario the owner hears | The decision it elicits | Where the answer lands (typed) |
|---|---|---|---|
| Booking (02) | Known customer wants Tuesday 2 pm for a repair | Book it on the call, or hold it for you? What must I collect first (what's wrong, address, access)? | `autonomous_booking_enabled/threshold`, new `booking_required_fields` (defaults to problem description + address), `job_buffer_minutes` |
| New caller (03) | Unknown number, "do you do water heaters, how much?" | Collect what? Quote never / ranges from your price book / exact from price book? | `quote_policy` (new), `services_offered`, `services_not_offered` (new) |
| Returning customer (01, 04) | "What do I owe you?" from a number that matches two customers | Read balances back after I confirm who they are? How should I confirm? | identity-check posture flags, existing lookup allowlist (no new free text) |
| Emergency (12, 05) | 104°F, elderly caller, no AC (HVAC) / active leak (plumbing) | What counts as an emergency for you? Who do I page, in what order, how fast? | `e1_reviewed_script`, per-tenant emergency terms (today platform-only; this is the motivation to open it), `transfer_targets.emergency`, page ladder |
| After hours (05) | Same call at 9 pm | Answer and book, or voicemail? Different number after hours? | `after_hours_voice_mode`, `transfer_targets.after_hours` |
| Out of area / scope (05, 07) | ZIP outside the radius; "do you do ductwork?" | Decline, refer out, or take a message? What do we not do? | `service_area_zips/radius`, `services_not_offered`, decline copy choice |
| Questions about the business (new 13) | "Do you charge a trip fee? Is it credited?" | The structured business answers, one at a time, each read back in the agent's words | `tenant_business_answers` (U4) |
| Complaint / negotiation (07) | "Your guy was late and I want a discount" | Hand to you immediately, or take a message? (The agent never negotiates; this is shown, not asked) | `escalation_settings.trigger_*`, `transfer_targets.open` |
| Unsure (08) | Mumbled name, accent, two intents in one sentence | When I'm not sure, ask one question or hand off? | `trigger_low_confidence`, clarification posture |
| Spanish (11) | Caller switches to Spanish | Serve them in Spanish? Who takes Spanish transfers? | `supported_languages`, `spanish_dispatcher_user_ids` |
| Dropped call (06) | Caller hangs up mid-booking | Text them back? | `dropped_call_recovery` flag, consent copy shown |
| Spam / adversarial (10) | Robocall, "ignore your instructions" | Nothing to decide. Shown once as "here's how I protect you" | none; this is the trust demo |

Two scenario kinds are deliberately not questions. Emergency safety rails and the negotiation
refusal are shown and explained but not configurable below the platform floor; the owner can
make them stricter, never looser. That is the same posture as the action-class ladder.

## The interaction, act by act

**Act 1 — "Tell me about you" (exists).** The current talk-through: name, where, trade,
services, pricing, team, hours. Five minutes. Produces the pack activation and the price book
seed. Nothing changes here except that its outputs now select which scenarios Act 2 plays
(HVAC gets no-cool; plumbing gets active-leak; a solo operator skips the team-routing
scenarios).

**Act 2 — "Here's how I'd handle it" (new).** For each selected scenario:

1. The agent speaks the caller line in a second voice, then its own handling in the owner's
   chosen voice (preview mode, real FSM, the tenant's own name and fees substituted into the
   script fixtures).
2. The screen shows three to four handling options, the agent's current choice highlighted,
   plus "something else". Options are FSM effects, so the set is fixed per scenario family.
3. The owner taps or says the answer. A tap writes the setting directly. Speech goes through
   the existing extractor; an ambiguous answer gets one clarifying question, the same way a
   caller's ambiguous reference does.
4. "Anything else I should know about calls like this?" Free text here becomes either a FAQ
   entry (spoken verbatim later), a standing instruction candidate (bounded, inbox-approved),
   or a *white-space note* when it asks for something the agent cannot do yet ("offer 10 % if
   they book today"). The agent says so plainly: "I can't do that yet. I've noted it for you."
5. After the family's scenarios: "Want me to play one more like this, or move on?"

Every answer is a typed write with an audit event and shows up in the inbox as a reviewable
summary ("Here's what you told me"), so the owner can change anything later from Settings, and
a "Something's wrong" tap during the interview is a correction, not a restart.

**Act 3 — "Now you call me" (U6).** The verified test booking, but now the owner is testing
the behaviour they just chose. The wizard names the scenario to run ("call and ask for a
repair next Tuesday; say you're not sure what's wrong") and the appointment card lands on
screen. "That's right" sets `test_booking_verified_at`; "Something's wrong" is a correction.

**Closing — "Anything I haven't asked?"** Open capture, bounded to five items, each routed as
in step 4. Then go-live.

## What is genuinely new in code

Most of this is composition. The new parts are small and each has a natural home.

- **Scenario library module** (`packages/api/src/onboarding/scenarios/`): reads corpus scripts,
  renders them as owner-facing scenario cards (caller line, the agent's handling, the option
  set, the setting each option writes), substitutes the tenant's fixtures, and tags each with
  the pack and persona conditions that select it. The corpus stays the single source; a script
  gains an optional `ownerFacing` block (family, options, settingKey) rather than a second
  copy.
- **Preview replay** (U6's preview mode): run a scenario through the caller FSM with the
  tenant's settings and speak it. The same call later becomes *regression replay*: "you changed
  your after-hours policy; here are the three scenarios it affects, listen."
- **Typed setting keys the interview needs and the product lacks:** `booking_required_fields`,
  `quote_policy`, `services_not_offered`, `transfer_targets` (U7), per-tenant emergency terms.
  Each is a column with a Zod shape, not a prompt string.
- **White-space log** (`onboarding_whitespace_notes`): the asks the agent could not satisfy,
  per tenant, with the scenario they arose in. This is the demand signal for the roadmap and
  it is free.
- **Daily "did I handle this right?"** After go-live, one real call a day is rendered as the
  same scenario card (transcript, the handling taken, the options) for a thumbs-up or "should
  have…", which writes a correction and, where it cascades, a lesson. Avoca's Coach loop,
  operated by the owner in thirty seconds.

## Positions worth arguing about

**Twelve scenarios, not fifty.** The library can be large; the interview must not be. The
owner is on a phone between jobs. Twelve core scenarios selected by trade, with "play another
like this" as the expansion path, keeps Act 2 under ten minutes. The other seventy-odd scripts
are the regression set and the "another like this" pool.

**Never let an answer become prompt text.** This is the line that keeps the floor criteria
provable and the cassette hashes stable. If an owner's answer cannot be typed, the agent says
it cannot do that yet and logs it. The temptation to add a "custom instructions" box is
exactly the thing Bland and Avoca sell and exactly the thing that makes their agents make
things up.

**Show the rails, don't ask about them.** Emergency handling, the negotiation refusal, and
spam protection are shown as "here's what I'll always do", with a one-tap "make it stricter".
Asking "should I negotiate?" invites the wrong answer and undermines the pitch.

**Replay is the product, the interview is the on-ramp.** The interview seeds the tenant's
expectations; replay is what lets the owner trust a settings change without placing a call.
Bland's Standards and Testbed are developer tools; this is the same mechanism with the owner
as the author of expectations.

**Default to "hold and tell me" for anything the owner skips.** An owner who taps through in
four minutes should end up with a safe agent (hold bookings, transfer on uncertainty, voicemail
after hours off, no quotes), not a blank one. Every scenario has a default that is the
conservative FSM behaviour.

## What could go wrong

- **Interview fatigue.** Mitigation: per-trade selection, a hard stop at twelve, skip always
  available with a visible default, resume from anywhere.
- **Owners describing behaviour the FSM cannot produce.** Mitigation: the white-space note and
  an honest "not yet"; measure its volume, it is the roadmap.
- **Answers that conflict** ("book everything on the call" and "never book without asking
  me"). Mitigation: the extractor's clarification question, and the inbox summary shows the
  final state in plain words.
- **Voice preview latency on the browser surface** differs from the phone. Mitigation: the
  wizard labels preview as a content test; Act 3 is the line test.
- **Scope creep into a workflow builder.** Mitigation: options are FSM effects only; no
  branching authored by the owner; new behaviours ship as code with corpus scripts.

## How we would know it worked

- Share of tenants completing Act 2 (target: most self-serve signups).
- Scenarios answered per tenant and the skip rate per scenario (tells us which questions are
  wrong).
- White-space notes per tenant per week (demand signal; also a fatigue signal if it spikes).
- Booking rate and transfer rate in the first 30 days, interview cohort vs form cohort.
- Corrections in the first week per tenant (should fall).
- "Did I handle this right?" response rate and the thumbs-up share over time.

## Relationship to the parity plan

This absorbs U4's wizard step (the business-answers form becomes the "questions about the
business" family of the interview; the U4 schema and settings sheet stay), uses U3's voice and
U6's preview and verified test booking, and adds one unit, U9, for the scenario library,
replay, the new typed keys, the white-space log and the daily review card. The plan's onboarding
order becomes `signup → identity → pack → voice_preview → scenario_interview → billing →
phone → test_booking → go_live`, with `scenario_interview` complete when the twelve core
scenarios are answered or explicitly skipped.
