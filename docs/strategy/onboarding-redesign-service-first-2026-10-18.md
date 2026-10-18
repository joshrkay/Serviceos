---
title: "Service-first onboarding: the owner talks, Rivet sets up the business"
date: 2026-10-18
status: product design brief (decision artifact; feeds a plan, not code)
companions:
  - docs/strategy/day-in-the-life.md (the persona spine)
  - docs/strategy/scenario-interview-onboarding.md (Act 2 below)
  - docs/research/competitive-onboarding-narrative-2026-10-18.md (the competitor evidence)
  - figma-export/imports/design-vision-brief.md (the March design vision, never built for onboarding)
tags: [onboarding, jobs-to-be-done, voice-first, design-language, narrative, competitive]
---

# Service-first onboarding

## The problem in one paragraph

The landing page promises *"You learned the trade. We'll run the business."* Then setup hands
the owner seven screens of software. The identity step alone is eleven fields plus a 21-control
hours grid, comma-separated ZIP codes and a "travel buffer in minutes". The phone step shows
carrier codes like `**21*1…#`. Headings say "Verify your AI", "short test prompt", "Choose your
agent's voice"; error text says "Twilio" and "provisioning". The one path that matches the
promise, "Talk it through instead", is a small sidebar toggle on two of the seven steps, and it
ends with "check your inbox to review and approve the proposals". The landing page says "no
card required"; the billing step holds a card. The site says ServiceOS; the app says Rivet.
The wizard hard-codes a white and slate look that ignores the warm paper-and-ink tokens the
rest of the product defines. And the first screen after setup is a dashboard of empty cards
("Voice ROI", "Hands-free collected") with no next step. Every one of those is a moment where a
person who wanted a front desk is reminded they bought software.

Audit with file references: see "What exists today" at the end.

## Who this is for

The PRD's ICP is the established owner-operator (Mike, two trucks, $680K; Jenna, solo, $340K).
This brief adds the person the founder asked about: **the owner on day one.** They just left a
bigger outfit or finished their apprenticeship, they have a truck, a license and a cell phone,
and they have never sent an invoice, taken a card, or set up a business line. They do not know
what "net 30" means and should not have to. For them the back office is not a chore to offload;
it is a thing they have never done and are afraid of getting wrong.

That person is the cleanest test of the whole design. If a day-one plumber can get a working
front desk by talking for ten minutes, Mike and Jenna can too. Designing for the day-one owner
also removes the hardest step for everyone: they have no existing business number, so there is
nothing to forward. Rivet *is* their number from the start.

> **Decision for the founder.** The PRD lists the "hobbyist / side-hustle plumber" as an
> anti-persona because the revenue does not justify $300-500/mo. The day-one owner is not a
> hobbyist, but they are pre-revenue for a few months. This brief assumes we want them (they
> grow into Jenna) and that pricing has a ramp for them. If not, the flow below still holds; only
> the landing framing narrows back to "already running a shop".

## The jobs the owner is hiring us for

Jobs-to-be-done, stated the way the owner would, each tied to the day-in-the-life row it moves
and to the setup moment that must exist for Rivet to do it. Setup is organised around these
jobs, not around settings tables.

| # | When… I want… so I can… | Day-in-the-life row | What setup must learn |
|---|---|---|---|
| J1 | When the phone rings and I'm under a sink, I want it answered and the job booked, so I stop losing work to whoever picks up. | 6:30am, 8:00am, 11:15am | hours, service area, what we do and don't do, book-on-call posture |
| J2 | When I finish a job, I want the customer billed and paid before I'm out of the driveway, so I never do paperwork at 10pm. | 7:30pm, 10:30pm | how you want to get paid; nothing else up front (see just-in-time) |
| J3 | When a customer asks "how much", I want a price I won't regret, so I sound like a pro even on my first week. | 9:30am, 12:30pm | trade pack prices accepted or adjusted; quote posture (never / range / exact) |
| J4 | When it's a real emergency, I want it to reach me, so nobody with a flooded basement gets voicemail. | 4:30pm | who to reach first, then who; after-hours posture |
| J5 | When the day ends, I want to know what happened in thirty seconds, so I can be a parent and not a dispatcher. | 7:30pm digest | the owner's cell, digest time, approval posture |
| J6 | When I start, I don't want forty settings; I want to be asked the way a good office manager would ask on their first day, so I'm set up without learning software. | the whole table | the conversation itself |
| J7 | When I'm not sure it's doing the right thing, I want to hear it and say "no, do it this way", so I can trust it with my customers. | 2:00pm, 9:45pm | scenario interview, test call, daily "did I handle this right?" |

J6 and J7 are the ones the current wizard does not serve. They are also the ones no
competitor's onboarding serves (see competitor section).

## Seven design principles

1. **Conversation is the surface. Forms are the fallback.** Today the form is default and the
   conversation is a toggle. Invert it. Every step is a question Rivet asks out loud and on
   screen; the owner answers by voice, by tapping a chip, or by typing. A "show me the form"
   link exists for the person in a loud truck cab, and that is the only place the form lives.
2. **Ask about situations, not settings.** "Should I book jobs on the call, or hold them for
   you?" instead of `autonomous_booking_enabled`. "When it's 9pm and someone's basement is
   flooding, who do I ring?" instead of `after_hours_voice_mode`. Every answer is still a typed
   setting with an audit event; only the question changes. This is the scenario interview.
3. **Show value before asking for anything.** The owner should hear their phone answered in
   their trade's voice within the first minute, before billing, before a number is bought. Hearing
   it is the pitch; everything after is "make it yours".
4. **Just-in-time, not up-front.** Calendar, card processing (Stripe Connect), accounting
   sync, team members, late fees: none of these belong in setup. Each is asked for at the
   moment it is first needed, by Rivet, in one sentence: "To send this bill with a pay link I
   need to connect your bank. Takes two minutes. Now or later?" A day-one owner has no
   customer yet; asking them about ACH on day one is how we lose them.
5. **Service words only.** Rivet is "your front desk" or "your office", never "your AI agent".
   See the vocabulary table. The owner never sees a vendor name, a protocol, or the word
   "proposal".
6. **Rivet does the plumbing.** Number provisioning is silent. Forwarding is one tap: Rivet
   texts the owner a tap-to-dial link that dials the carrier code for them, or, for the day-one
   owner, is skipped because the Rivet number is the business number. Trade pack defaults are
   applied and *read back*, not presented as a form to fill.
7. **The first screen is the first day, not a dashboard.** After setup the owner lands in the
   same conversation: "You're open. Here's what I'll do when the phone rings. Want to add your
   first customer? Just tell me about them." Empty cards are replaced by what Rivet will do.

## The proposed flow: one conversation in four acts

Time target: under twelve minutes for the day-one owner, under fifteen for an established
shop. Every act is resumable and skippable with a visible default.

### Before signup: "Hear it answer" (new)

Landing CTA pair becomes **"Hear it answer your phone"** and "Start free". The first asks for a
cell number and a trade, places a sixty-second demo call in which Rivet answers as "Walsh
Plumbing" (or the name they type) and books a fake job, then texts a signup link. This is the
single strongest demonstration of J1 and costs about a dollar a lead. The visitor who is not
ready to sign up still has the experience. (Cost and abuse controls are a decision; see below.)

### Act 1: "Tell me about your business" (exists; becomes the main surface)

The talk-through orchestrator already walks profile, services, pricing, team, schedule and
tools in about five minutes. Changes:

- It is the whole screen, voice-first, with the transcript visible and tappable chips for
  finite answers (trade, days open, solo or team). The mic is live as soon as Rivet stops
  talking.
- The trade pack is chosen inside the conversation ("Sounds like plumbing. I'll start you
  with the plumbing price list; you can change any price later") rather than on a card grid.
- **The output is a read-back, not an inbox chore.** After each stage Rivet shows "Here's what I
  heard" with the settings in plain words and inline edit. "That's right" is the approval. The
  proposal and audit mechanism stays exactly as it is; only the approval surface moves from the
  inbox to the conversation. Nothing is written until the owner confirms, which is the current
  rule, honoured in a place that does not feel like homework.
- A day-one owner is detected by the answer to "Are you already taking calls on a business
  number?" If no, the forwarding sub-step is removed and the pack prices get a gentler read-back
  ("These are typical prices for your area; most new owners start here and adjust after a few
  jobs").

### Act 2: "Here's how I'd handle it" (designed 2026-10-16; promote it)

The scenario interview from `scenario-interview-onboarding.md`, unchanged in mechanism:
Rivet plays a real call in a second voice, handles it in the owner's chosen voice, and asks
"is that right, or would you rather I…?" Every answer writes a typed setting. Two changes for
this brief:

- **Five scenarios for the day-one owner, twelve for a shop.** Day one needs: emergency
  (shown, not asked), new caller asking "how much", booking, after hours, out of area. The
  rest are offered as "want to hear more?"
- **The opener's job is trust, and it sells J4.** The no-cooling/active-leak vulnerable-occupant
  call goes first for every owner, exactly as decided.

### Act 3: "Make it yours, then call me" (reorders existing steps)

- Voice choice is one sentence ("Here's how I'll sound. Want to hear the other two?") with
  three previews, not a settings panel.
- The number: "Want a local number, or pick an area code?" One tap. Forwarding, if needed, is a
  text with a tap-to-dial link and a "I'll do it later" that leaves a visible "calls still ring
  your cell" badge rather than a warning about the AI being off.
- The trial: one screen, plain words, consistent with the landing page (see decision). "Fourteen
  days on us. After that, {plan}. Cancel by telling me."
- The test call: Rivet names the scenario ("Call your new number and ask for a repair next
  Tuesday; say you're not sure what's wrong"). The booking card lands on screen. "That's right"
  goes live.

### Act 4: the first day (new; replaces the empty dashboard)

The owner lands in the home conversation panel, which already exists, with Rivet speaking
first: "You're open. When your phone rings I'll answer as Walsh Plumbing, book repairs, and
text you. Three things worth doing this week:" then chips for *add a customer*, *send your
first estimate*, *connect your bank so customers can pay by card*. Each is a conversation, not
a page. The stat tiles and money cards stay below but are collapsed until they have data; their
empty states say what Rivet will do ("Your first paid bill will land here. I'll text the
customer a pay link the moment you mark a job done").

## Vocabulary: software words out, service words in

| Today | Instead |
|---|---|
| your AI, your AI agent, AI dispatcher | Rivet, your front desk, your office |
| Verify your AI; short test prompt | Hear it answer |
| Choose your agent's voice | How should I sound? |
| proposals; approval inbox; approve | waiting for your OK; "That's right" / "Change it" |
| provisioning; Twilio; Stripe checkout | getting your number; setting up payments |
| dashboard; Go to dashboard | Today; Open your office |
| travel buffer between jobs (minutes) | How long do you want between jobs? |
| service area radius / ZIPs | How far will you drive? |
| hourly rate | What do you charge an hour? (or: skip, use the plumbing list) |
| autonomous booking | Book it on the call / Hold it for me |
| trial, plan, checkout | Fourteen days on us; then {price}/month |

"AI" appears in nearly every onboarding heading today and twelve times on the landing page. On
the landing page it is earning its keep (the market searches for it). Inside the product, once
the owner has signed up, it should appear almost nowhere; the owner knows what Rivet is.

## Design language: from software to service

The tokens already exist and are already right: warm paper `#F6F4EF`, ink `#16202E`, a
single confident blue, Bricolage Grotesque headings, Hanken Grotesk body, 44px targets. The
onboarding ignores them (hard-coded white, slate-900 tiles and buttons). The shift is mostly
about using what is there, plus four moves:

1. **One question per screen, in the heading, in Rivet's voice.** Large type, first person
   ("What should I call your business?"), the transcript below, chips or a mic. No sidebar
   checklist of seven steps; a thin progress line and "about 8 minutes left".
2. **People and driveways, not product.** Any imagery on the landing and in the flow is of the
   trade: a truck at a curb, a hand on a thermostat, a kitchen table at night. No screenshots
   of dashboards in the onboarding, no abstract waveforms. The product's value is what happens
   in the driveway, so that is what we show.
3. **Warmth over density.** The current flow uses `text-xs` grey hints and uppercase eyebrows
   everywhere. Replace with sentences. Hints become part of what Rivet says.
4. **One brand.** ServiceOS or Rivet, on the site, in the app, in the voice greeting. (Decision.)

The March design-vision brief already asked for exactly this ("texting or speaking to an
assistant, reviewing work, not doing data entry") and the Figma export contains a
conversational onboarding (`figma-export/app/components/onboarding/OnboardingPage.tsx`) with
questions like "What do you call the work itself?" and "Here are the automations I'd turn on
for you. Toggle off anything that doesn't fit." The web wizard was built as forms anyway. This
brief is partly a request to build what was designed.

## Competitors

<!-- COMPETITOR SECTION: filled from docs/research/competitive-onboarding-narrative-2026-10-18.md -->

## What exists, what is new

**Exists (reuse):**
- Talk-through orchestrator and extractors: `packages/api/src/ai/orchestration/onboarding-conversation.ts`, `ai/agents/onboarding/`, surfaced by `components/onboarding/v2/steps/ConversationStep.tsx` and `hooks/useOnboardingConversation.ts`.
- Trade packs with price-book, templates and messages: `packages/api/src/packs/seed-pack-defaults.ts`.
- Voice preview, voice picker, verified test booking, hand-off targets: voice-parity plan U3, U6, U7.
- Scenario interview design and the 89-script corpus: `docs/strategy/scenario-interview-onboarding.md`, plan U9.
- Home conversation panel with mic: `components/home/HomeConversationPanel.tsx`.
- Design tokens and fonts: `packages/web/src/index.css`.
- Funnel instrumentation: `FUNNEL.md` events 1-12.

**New:**
- Conversation as the shell of onboarding (not a step inside a form wizard).
- Inline "That's right" approval of onboarding proposals (same proposal and audit rows, new surface).
- Day-one owner branch (no forwarding; gentler price read-back; five-scenario interview).
- Just-in-time setup prompts for Stripe Connect, calendar, accounting, team (moved out of the wizard, asked by Rivet at first need).
- Forwarding by tap-to-dial text.
- Pre-signup "Hear it answer" demo call.
- First-day guided home (Act 4) and value-stating empty states.
- Vocabulary pass across onboarding, home and settings; onboarding re-skinned on the existing tokens.

## Decisions needed

1. **ICP extension to the day-one owner**, and whether pricing has a ramp for them.
2. **Card at trial.** Landing says "no card required"; the flow holds a card. Pick one. The
   brief recommends no card for the trial and a card at the first live call or day 7, since the
   number cost is small and the current contradiction is a trust break at the exact moment we
   ask for trust.
3. **Brand name.** ServiceOS or Rivet, everywhere.
4. **Sequencing against the voice-parity plan.** U9 (scenario interview) is last of nine units.
   This brief argues the onboarding surface (Act 1 inversion, vocabulary, tokens, Act 4) can
   ship ahead of U1-U8 because it touches no telephony, and U9 should be pulled forward behind
   U3 and U6, which it depends on.
5. **Pre-signup demo call.** Roughly a dollar per lead in telephony and model cost, plus abuse
   controls (rate limit per number, consent line). Worth it or not.

## Phasing

| Phase | Scope | Depends on | Rough size |
|---|---|---|---|
| 1. Make it a conversation | Talk-through becomes the default surface for identity and pack; inline read-back approval; vocabulary pass; onboarding on brand tokens; one-question screens; forwarding-by-text; Act 4 first-day home; fix the card and brand contradictions | nothing in the voice plan | 2-3 weeks, web + small API |
| 2. Hear it, then shape it | Voice preview first (U3), scenario interview (U9) with the five/twelve split, verified test call (U6) | U3, U6 | per the voice-parity plan |
| 3. Value before signup | "Hear it answer" demo call; just-in-time Stripe Connect / calendar prompts in the home conversation | Phase 1, cost decision | 1-2 weeks |

## How we would know

Existing funnel events already measure most of it. Add three:

- `time_to_first_heard`: seconds from signup to the owner hearing Rivet speak. Target under 60.
- `conversation_completion`: share of owners who finish Act 1 by voice or chips, vs "show me the form".
- `first_day_action`: share of owners who take one Act 4 chip within 24 hours.

And watch the two the plan already names: wizard completion by cohort, and the first-week
correction count, which should fall when the owner has heard the behaviour before going live.
