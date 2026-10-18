---
title: "The first conversation: UX spec for voice-first onboarding"
date: 2026-10-18
status: UX design spec (screen-by-screen; pairs with the clickable canvas)
prototype: https://claude.ai/artifact/9z7PNaRXpD7c8Rk4ptKnXz (private canvas, 10 phone screens, tap the primary button to advance)
companions:
  - docs/strategy/onboarding-redesign-service-first-2026-10-18.md (the why: jobs, principles, decisions)
  - docs/research/voice-onboarding-ux-patterns-2026-10-18.md (the evidence: voice UI and onboarding best practice)
  - docs/research/competitive-onboarding-narrative-2026-10-18.md (what competitors do)
  - docs/strategy/scenario-interview-onboarding.md (Act 2 mechanism)
tags: [onboarding, ux-spec, voice-first, conversation-design, mobile]
---

# The first conversation

This spec describes the onboarding experience from first principles. It does not start from the
March Figma export. That design had the right instinct (a conversation, not a wizard) and the
wrong questions: it asked the owner what they call "the work itself" and offered a list of
automations to toggle. Those are software questions. A new owner does not have opinions about
automations; they have a phone that rings and bills they don't know how to send. So the
conversation here is built from the owner's situations, from how voice interfaces are known to
succeed on phones, and from the environment a tradesperson is actually in: a truck cab, gloves,
one hand, noise.

## 1. The stance

- **Rivet is the office manager on their first day.** It introduces itself by doing the job
  (answering a call) and then asks the questions a good hire would ask: who are you, what do
  you do, when do you want jobs booked, who do I call when it's urgent, what do I say about
  price. It never asks about settings.
- **One surface, not seven steps.** The whole of onboarding is one conversational screen whose
  content changes. There is no sidebar, no step list, no "Verify AI". A thin progress line and
  "about N minutes left" are the only chrome.
- **Talk, tap, or type, always.** Every turn can be answered by voice (the large mic), by a tap
  (chips, when the answer set is finite), or by typing (a small link). Nothing requires voice to
  progress. Nothing requires a form.
- **Show what was heard. Save only on "That's right".** The live transcript is visible while the
  owner speaks. After each stage Rivet reads back what it understood as plain sentences. The
  owner's confirmation is the approval; the proposal and audit rows behind it are unchanged.
- **Service vocabulary, brand tokens.** Paper, ink, one blue. Bricolage Grotesque for what Rivet
  says, Hanken Grotesk for everything else. No "AI", "agent", "proposal", "provisioning",
  "dashboard" anywhere in the flow.

## 2. Anatomy of the surface

Phone-first at 390 px; the same layout centred at a max width of 480 px on desktop. Top to
bottom:

| Zone | Content | Rules |
|---|---|---|
| Header | "About 6 minutes left" (left); escape hatch (right): "Show me the form" during Act 1, "Skip" during Act 2, "I'll test later" at the test call | Time estimate is per remaining turns, rounded to the minute. The escape hatch is always present and always saves progress. |
| Progress | 3 px line, blue fill | Monotonic. Never resets on back. |
| Speaker line | Blue dot + "Rivet", with "Replay" when Rivet has spoken | Replay re-speaks the heading. |
| Heading | What Rivet is saying, verbatim, first person, Bricolage 28 to 34 px | Under 20 words (the one-breath test). Carries the implicit confirmation of the last answer ("Got it, Walsh Plumbing in Cleveland. When should I…"). |
| Support line | One sentence, Hanken 16 px, muted ink | Says why Rivet is asking or what it will do regardless ("I'll answer every call at any hour either way"). |
| Body | Depends on the turn: live transcript card (free speech), option rows (finite answers), read-back list, scenario bubbles, number card | Option rows are 52 to 56 px tall, full width, one selected state (blue border, pale blue fill, check). A dashed "Something else" row always ends a finite set. |
| Answer bar | Left: "Type instead". Centre: 76 px mic with a soft halo. Right: "Skip for now" or "Next" | The mic sits in the lower centre for one-handed reach. The halo pulses while listening (motion-reduced: static). |
| Footnote | One line, 13 px | Reassurance or the rule in play ("Nothing's saved until you say so"). |

### States of a turn

| State | What the owner sees and hears | Timing |
|---|---|---|
| Speaking | Heading types in as Rivet speaks it; speaker line shows a small sound mark; mic is live (barge-in: the owner can start talking and Rivet stops within 200 ms) | TTS length |
| Listening | Green "Listening" label with level bars; transcript card fills word by word with the interim transcript; mic halo pulses | Until 1.2 s of silence after speech, or a mic tap |
| Heard | Transcript card settles; for finite answers the matching option row highlights with "Heard: '…'" beneath | Immediate |
| Thinking | Speaker line shows three dots; nothing else moves | Anything over 1 s shows this; over 4 s adds "Still with you" |
| Read-back | Rivet speaks the confirmation inside the next question (implicit), or shows a read-back list (end of stage) | |
| No match | Rivet re-asks in fewer words with an example ("Which days? For example, Monday to Friday.") | 1st miss: short reprompt. 2nd: example reprompt plus chips. 3rd: "Want to type it?" with the keyboard open |
| No input | Rivet waits 6 s, then: "Take your time. Tap the mic when you're ready." No repeat prompt | Silence is not an error |
| Interrupted | Phone call, app backgrounded: progress is saved per answered turn; return lands on the same turn with "Welcome back. We were on…" | |

Explicit confirmation ("Did you say…?") is used only for the business name, the owner's cell,
addresses and any price the owner states. Everything else confirms implicitly in the next
heading.

## 3. The screens

Each screen below names what Rivet says, how the owner can answer, what is written when they
confirm, and the default if they skip. Settings keys name existing columns where they exist
and mark new ones.

### 0. Hear it answer (before signup)

Rivet: *"Hear your phone get answered. Before you sign up for anything."* Inputs: cell number,
"What should I answer as?", trade chips. CTA "Call me now"; secondary "Skip the call, just get
me set up". Rivet places a 60-second outbound demo call in the chosen trade's voice, role-plays
a customer with a prepared script, books a sample job, and texts the signup link. The screen
shows the live transcript and the job card as it would land ("Waiting for your OK"). Writes:
nothing (a lead record only). Rate limit: one call per number per day, consent line spoken at
the top of the call.

### 1. The demo call

Rivet: *"Pick up. You're the customer."* Transcript bubbles stream in. At the end the job card
appears with the "Waiting for your OK" badge, which is the first time the owner sees the
approval posture. CTA "Make it mine" leads to account creation (Clerk, unchanged) and then
straight into screen 2. Footnote: "About ten minutes of talking. No forms."

### 2. Tell me about your business (free speech)

Rivet: *"Tell me about your business. Who you are, where you work, and what kind of work."*
Support: "Say it the way you'd tell a customer. I'll sort it into the right places." The owner
talks; the transcript card fills. Over-answers are kept: if they mention hours or that they are
solo, those turns are skipped later. Extractors: the existing business profile, category and
team extractors behind the talk-through orchestrator. Written on read-back: business name,
city, service radius (default 25 miles when unstated), services offered, services not offered
(`tenant_business_answers.services_not_offered`), trade pack activation, team size. Skip: Rivet
asks the three facts it cannot default (name, city, trade) one at a time with chips for trade.

### 3. When should I book jobs (finite answer)

Rivet: *"Got it, Walsh Plumbing in Cleveland. When should I put jobs on your calendar?"*
Support: "I'll answer every call at any hour either way; this is just when I can book."
Options: Weekdays 7 to 5 · Monday to Saturday 7 to 5 · Any time · Something else. A spoken
answer highlights the matching row with "Heard: '…'". Writes: business hours, `after_hours_voice_mode`
= answer-and-book (default). Skip default: weekdays 7 to 5, answering all hours.

Other finite turns in Act 1 use the same screen: "Is it just you, or do you have help?" (solo /
one or two others / a crew); "Do you already have a business number people call?" (yes / no).
The second decides the day-one branch: "no" removes forwarding entirely.

### 4. Here's what I've got (read-back and approval)

Rivet: *"Here's what I've got. Tap anything to change it."* A single white card lists seven
rows in plain words: Business, Where, The work, Not doing, Booking, Team, Prices. Prices come
from the trade pack with a one-line explanation ("Typical for Cleveland plumbers. Most new
owners start here and adjust after a few jobs."). Tapping a row opens a one-turn correction
("What should it say?") by voice or keyboard. CTA "That's right" approves the pending
`onboarding_*` proposals in one call and writes the settings. Secondary: "Tell me what to
change" (mic). Footnote: "'That's right' is the only thing that saves it." Header right reads
"Nothing saved yet".

This screen replaces "Check your inbox to review and approve the proposals". The proposals
still exist; they are approved here.

### 5. A call at 9pm (the scenario opener)

Rivet: *"Let me show you a call. It's 9pm, you're at dinner."* Caller bubble (second voice,
grey) and Rivet bubble (owner's chosen voice, blue), then a card showing the whisper the owner
would hear on their own phone. "Hear it, 22 seconds" plays the real caller FSM in preview mode.
Statement: "That part I'll always do: safety first, then a person. Here's the part that's
yours." One question: "Who do I ring first?" Options: your cell every time · your cell then
text · someone else first. Writes: `transfer_targets.emergency` and the page ladder. Skip
default: the owner's cell. The safety line and hand-off are shown, never asked.

### 6. Someone asks what it costs

Rivet: *"Someone new asks what it costs."* Caller: "Do you guys do water heaters? What would
that run me?" Rivet quotes a range from the pack list and offers to book. Question: "When they
ask for a price, what should I say?" Options: a range from your list · no prices, book a visit ·
exact prices from your list. Card: "I only ever say a number that's on your list. If it isn't
there, I say you'll confirm it, and I never haggle." Writes: `quote_policy` (new typed key).
Skip default: no prices, book a visit. Secondary link: "Play me another one like this."

The day-one owner hears five scenarios: emergency, price, booking, after hours, out of area.
An established shop hears the twelve from the scenario-interview design. Each is the same
screen with different bubbles and options.

### 7. How I'll sound, and your number

Rivet: *"You've been hearing me in this voice. Want a different one?"* Three voice rows with
play buttons; the current one is marked "The one you've heard so far". Then: *"And here's your
number."* A local number is already held: "(216) 555-0180. Yours the moment you tap 'That
works'." Secondary: "Different area code", "I have a number already". The last opens the
forwarding path for established shops: Rivet texts a tap-to-dial link that dials the carrier
code, and the owner can say "later", which leaves a visible "calls still ring your cell" badge
on the first-day screen rather than a warning. Writes: voice preset, `voice_preview_at`,
provisioned number. Trial and card: one sentence on this screen's footnote or the next,
consistent with the landing page (decision pending in the brief).

### 8. Now you call me

Rivet: *"Now you call me."* Support names the scenario: "Say you've got a slow drain and
you're not sure what's wrong. Ask for next Tuesday." The number card is tappable. When the
call ends, the job card lands: date, time, problem description, caller, estimated price from
the list, "Listen back to the call". Statement: "Every job I book lands like this. One tap to
confirm, one tap to undo, and you can always hear the call." CTA "That's right. Open for
business." writes `test_booking_verified_at` and `voice_agent_live_at`. "Something's wrong"
opens a correction turn and routes back to the relevant scenario. "I'll test later" saves
progress and opens the first-day screen with a visible "not yet tested" badge.

### 9. Your first day

Not a dashboard. Header: business name and an "Open · answering calls" pill. Rivet speaks
first: *"You're open, Jenna. When your phone rings I answer as Walsh Plumbing, book the job,
and text you."* Then three rows: tell me about a customer you already have · send your first
estimate · connect your bank so customers can pay by card ("About 2 minutes. Needed before
your first bill."). Below, two muted cards state what will appear: Today ("No jobs yet. Your
first booked job shows up here, with the call that booked it.") and Money ("Your first paid
bill lands here…"). The conversation bar with a mic sits at the bottom and is the same
component the home screen already has. The stat tiles and KPI cards from today's home stay
hidden until they have data.

Just-in-time asks live here, not in onboarding: Stripe Connect when the first bill is about to
go out, calendar connection when the first job is booked, accounting sync when the first month
closes, team members when a second name is mentioned.

## 4. Copy rules

- Rivet speaks in the first person and addresses the owner by first name once per screen at
  most.
- Every heading is under 20 words. Every support line is one sentence.
- Say the rule, not the mechanism: "I only ever say a number that's on your list," not
  "prices are catalog-grounded."
- Options are written as the owner would say them: "Your cell, every time," not "Primary
  transfer target: owner."
- The three words that never appear: AI, agent, dashboard. The three that appear often: you,
  your phone, your customers.

## 5. What this reuses and what is new

Reused as-is: the talk-through orchestrator and its six extractors, `onboarding_*` proposal
contracts and handlers, trade packs, the voice picker and preview (parity plan U3), the
verified test booking and owner UNDO (U6), the scenario library design (U9), the home
conversation panel, the brand tokens and fonts, the funnel events.

New: the conversational shell as the only onboarding surface (today's `OnboardingShell`
sidebar and step components retire); the read-back card with inline approval of pending
proposals; the demo-call endpoint and its script; forwarding by tap-to-dial text; the
day-one branch; `quote_policy` and `booking_required_fields` typed keys; the first-day home
state and value-stating empty states; the vocabulary pass.

## 6. Measurement

Keep the twelve funnel events. Add: `time_to_first_heard` (signup to first Rivet speech, target
under 60 s), `answer_mode` per turn (voice / tap / type), `readback_edit_count` per tenant
(how often "Here's what I've got" needed a correction; the extractor quality signal),
`conversation_completion` (finished Act 1 without "Show me the form"), `first_day_action`
within 24 hours.

## 7. Open questions for the founder

1. Trial and card: where the one sentence about the trial goes, and whether a card is asked for
   at all before the first live call.
2. Demo call before signup: ship it, or start with the in-app "hear it" on screen 7 and add
   the pre-signup call once cost per lead is known.
3. Named voices: the prototype labels voices by character ("Warm and steady"). Jobber, Workiz
   and Broccoli name theirs (Jessica, Amy). A name makes it feel like staff; it also invites
   "is that a real person" on calls. Recommendation: character labels in setup, the business
   name on calls, no human name.
