# feat: "Pick, don't build" voice-first onboarding

**Created:** 2026-10-18
**Depth:** Deep
**Status:** plan

## Summary

Replace the seven-step onboarding wizard with one conversational surface in which Rivet
assembles a complete, typical shop from the owner's trade and metro, walks seven this-or-this
choices (each showing what Rivet would say if picked), reads the result back in plain words,
and writes everything through the existing proposal and audit path on a single "That's right".
Free speech becomes the override, not the opener. Design source: `docs/strategy/onboarding-ux-spec-2026-10-18.md`
(section 3b) and `docs/strategy/onboarding-redesign-service-first-2026-10-18.md`; clickable
prototype linked from both.

## Problem Frame

A day-one plumber or HVAC owner-operator who has never sent an invoice cannot get through
today's setup without doing office work: an eleven-field identity form, a 21-control hours
grid, carrier forwarding codes, "Verify your AI". The conversational path that matches the
product's promise exists (`packages/api/src/ai/orchestration/onboarding-conversation.ts`) but
is a sidebar toggle on two of seven steps and ends in an inbox chore. Among competitors only
Goodcall sets up conversationally (its Gabi drafts the greeting, questions and steps from a
spoken or typed description and runs practice calls; see the competitive research), and it
configures the phone agent alone. No competitor sets up the back office that way: prices,
booking posture, hours, how the owner gets paid, emergency routing. That broader setup is the
unowned position.

## Requirements

- R1. From trade and metro alone, the owner sees a complete, sensible shop before answering
  anything, with the typical choice marked.
- R2. Seven choices, each two options with Rivet's resulting line visible, answerable by tap,
  by saying "first"/"second", or by typing; free speech available as an override on every one.
- R3. Nothing is written to tenant settings until the owner confirms the read-back; the write
  goes through `onboarding_*` proposals with audit rows, undo window and inbox history intact.
- R4. The whole pass (demo call excluded) completes in under five minutes on a phone, with
  every target at least 44 px and no horizontal overflow at 320 px.
- R5. Rivet's lines are spoken in the tenant's chosen voice, with a non-voice path at every turn
  and a visible live transcript.
- R6. A day-one owner (no existing business number) never sees a forwarding step; an
  established shop gets forwarding as a tap-to-dial text.
- R7. The existing seven-step status contract (`packages/api/src/onboarding/contracts.ts`,
  consumed by `packages/mobile/app/(onboarding)/onboarding.tsx`) keeps working; new facts are
  additive.
- R8. Funnel measurement continues (`FUNNEL.md` events 1-12) and gains `answer_mode` per turn,
  `time_to_first_heard`, `readback_edit_count`, `conversation_completion`, `first_day_action`.
- R9. The v2 wizard and its tests are deleted once the flag flips (CLAUDE.md dead-code rule).

## Key Technical Decisions

- **The assembled shop is a draft row, not seven proposals.** New table `onboarding_drafts`
  holds the typical shop and the owner's staged choices; "That's right" mints the
  `onboarding_*` proposals from the draft and approves them in the same transaction through
  the batch-approve function `POST /api/proposals/approve-batch` already uses
  (`packages/api/src/routes/proposals.ts:322`). Rationale: proposals stay the only write path
  (R3), while editing a choice is a row update rather than `editProposal` plus re-validation,
  and "Keep the rest as is" has a clean target. (Alternatives: a proposal per choice, rejected
  because seven drafts pile up and edits re-validate; direct settings writes with audit,
  rejected because it loses undo and the inbox record for AI-assembled config.)
- **Choices bypass the FSM.** A typed `PUT /api/onboarding/draft/choices/:settingKey` stages a
  choice. The orchestrator at `ai/orchestration/onboarding-conversation.ts` is a linear
  six-state extractor pipeline with session-locked turns; a finite tap needs no LLM and no
  state. The FSM stays for the "ask me the three facts" path and for established-shop
  long-form capture. (Alternative: choices as `user_turn` events, rejected because each would
  need a pseudo-state and an extractor call returning what the tap already said.)
- **Option pairs are a typed TypeScript registry per trade**, Zod-validated at load, mirroring
  `packages/api/src/verticals/packs/`. Content changes with a PR; seven rows per trade do not
  justify a table or an editor. The corpus `ownerFacing` block (voice-parity U9) stays
  reserved for scenario cards. Rivet's line per option is a template rendered server-side so
  the spoken sentence and the setting cannot drift.
- **Regional prices are a platform table with an in-code national default.**
  `regional_price_tiers(trade, metro_code, tier JSONB in cents, source, updated_at)`, no
  `tenant_id` (platform-owned like `tenants`), founder-curated per launch metro, `'US'` as the
  fallback row; absent that, `*_LINE_ITEM_DEFAULTS` apply and the copy drops the city. The
  owner's price choice becomes a multiplier passed into `seed-pack-defaults.ts`, not a second
  seed set. That holds for a first run only: the seeder skips any catalog item or template
  whose canonical name already exists, so on U6's "Re-run setup" the price card does not
  re-seed. It updates the pack's two headline items (visit fee, labor rate) and the estimate
  template line items that carry those same seeded amounts, in each case only while the row
  still holds the price the seeder set; anything the owner has edited is left alone, and the
  read-back says which happened ("Your labor rate is yours; I left it").
- **Metro from area code is a static NPA→metro map in code**, extending
  `packages/api/src/compliance/us-geography.ts` which today maps area code to state only. One
  spoken confirmation when an NPA spans metros, and the inferred city is always visible and
  changeable: a cell can keep the area code of a former city, so a unique NPA is a guess, not a
  fact. The Ready screen names the city it priced for ("the way most Cleveland plumbing shops
  run") with a one-tap "Not Cleveland?" that takes a typed or spoken city and re-assembles
  (`PUT /draft/metro`, allowed while no choice is staged; lands with U5's overrides). When the
  owner skips, the national tier applies and the copy drops the city.
- **Keep the seven step ids; add facts.** `contracts.ts:150` hard-codes `.length(7)` and
  mobile consumes it. `derive-status.ts` gains `draftStatus` and `choicesAnswered` facts; the
  new shell derives its own turn list client-side from facts plus draft. (Alternative: a new
  `choices` step, rejected because it breaks the contract and mobile.)
- **Billing stays before the number is bought** (D-037: the number is bought only when the
  owner picks it; no purchase for a tire-kicker). The spec's "here's your number, already
  held" is implemented as: show one candidate from `POST /api/onboarding/phone/available`
  during the choices, collect the trial on one screen after the read-back, then buy on "That
  works". Whether a card is taken at trial is the founder's open decision; the plan is neutral.
- **STT stays Deepgram streaming; TTS moves to the server voice.**
  `packages/web/src/hooks/useDeepgramDictation.ts` already streams with interims; Web Speech
  API is unreliable on iOS Safari and would be a second stack. `POST /api/voice/tts`
  (`routes/voice.ts:280`) exists but uses the default voice; it gains a `voice` parameter and a
  clip cache so "you've been hearing me in this voice" is true. Browser `speechSynthesis`
  (`hooks/useTTS.ts`) becomes the fallback.
- **New web tree, same route.** `components/onboarding/v3/` behind a flag at the lazy import
  in `packages/web/src/routes.ts:67`; `OnboardingShell.tsx` is a step router whose body serves
  seven step components and would be 90 % deleted by evolution.
- **No mocked seams; vertical slices; test-first.** (Founder direction, 2026-10-18.) Nothing is
  built against a mocked API or stubbed service to be "connected later". Each unit is a
  vertical slice: contract in `packages/shared`, API with Docker-gated integration tests
  against real Postgres, web against the real API, Playwright against the real stack via the
  repo's verify skills, all in the same PR, releasable behind the flag on its own. Tests are
  written before the code they prove (red, green, refactor); the LLM gateway is the one seam
  unit tests may stub, per CLAUDE.md, and every DB-touching change still has an integration
  test that pins real columns. (Alternative: a web lane on mocks in parallel with the API,
  rejected: the integration cost lands later and larger.)
- **The demo call is last and decision-gated.** It needs platform Twilio credentials, a
  tenant-less public route, fixture tenants per trade, consent and rate limits. Screen 7's
  in-app "hear it" delivers most of the value without telephony.

## Scope Boundaries

**In scope:** choice registry and assembly; draft, choices and approve API with a new
`onboarding_voice_policy` proposal; the v3 conversational shell and option-card component;
server-voice TTS with clip cache and a first/second matcher; free-speech override; day-one
branch, forwarding-by-text, first-day home state; vocabulary pass on onboarding and home copy;
retirement of v2; funnel events; the pre-signup demo call as the final unit.

**Non-goals:** the scenario interview (voice-parity U9), voice preview persistence
(`voice_preview_at`, U3), verified test booking (`test_booking_verified_at`, U6), hand-off
targets (U7); Stripe Connect interception at first invoice (the first-day chip links to the
existing `/api/billing/connect/onboarding`); a founder-facing editor for option pairs or price
tiers; import from a photo; pricing or plan changes.

### Deferred to follow-up work
- Stripe Connect "ask at first bill" interception in the invoice send path.
- `booking_required_fields` typed key (named in the spec; no screen writes it in this pass).
- Message templates table (TODO at `packages/api/src/packs/seed-pack-defaults.ts:14`).
- The `.length(7)` status contract: loosen once mobile ships a tolerant reader.

## Repository invariants touched

- **Human-approval gate / Zod proposals:** every settings write in this plan happens by
  approving `onboarding_*` proposals (existing five plus new `onboarding_voice_policy`), each
  with a Zod contract in `packages/api/src/proposals/contracts/onboarding.ts` and a handler in
  `proposals/execution/onboarding-handlers.ts`. The draft row is pre-approval state only.
  Execution remains async after the 5 s undo window (`proposals/lifecycle.ts:53`); the
  read-back shows "Saving, tap to undo" for that window.
- **Audit events:** `onboarding.draft_created`, `onboarding.choice_staged`,
  `onboarding.draft_approved`, plus the existing proposal lifecycle events.
- **Integer cents:** tier prices, trip fee and hourly rate are cents end to end; the price
  multiplier is applied in integer arithmetic with explicit rounding in one function.
- **tenant_id + RLS:** `onboarding_drafts` carries `tenant_id` with RLS like
  `onboarding_session` (migration 195). `regional_price_tiers` and `demo_calls` are
  platform tables with no `tenant_id`, admin-write only, the same posture as `tenants`.
- **LLM gateway:** the free-speech override calls the existing extractors through the gateway;
  the choice path makes no model call.
- **Catalog resolver:** the trip fee and hourly rate land as catalog items via the pack
  seeder, so quotes on calls stay catalog-grounded.
- **Entity resolver:** untouched.
- **Times UTC:** draft timestamps UTC; `clientTimezone` is captured on the first turn because
  `onboarding_tenant_settings` is gated on timezone.

## High-Level Technical Design

```mermaid
flowchart LR
  A[Signup / demo call] --> B[GET /onboarding/draft\nassembleTypicalShop(trade, metro)]
  B --> C[v3 ConversationShell\n7 option-pair turns]
  C -- tap / "first" / type --> D[PUT /draft/choices/:key\naudit: choice_staged]
  C -- "Neither, I'll say it" --> E[POST /draft/override/:key\nextractor via gateway]
  E --> D
  D --> F[Read-back card]
  F -- "That's right" --> G[POST /draft/approve\nmint onboarding_* proposals\n+ approveProposalsBatch, one tx]
  G --> H[execution-worker after 5 s undo\nonboarding-handlers write settings, seed pack]
  F -- "Tell me what to change" --> E
  H --> I[billing → number buy → test call → first-day home]
```

Server modules: `packages/api/src/onboarding/choices/{registry,assemble,override}.ts`,
`packages/api/src/onboarding/draft/{repository,routes,approve}.ts`. Web:
`packages/web/src/components/onboarding/v3/`.

## Implementation Units

### U1. Choice registry, typical-shop assembly, regional tiers
- **Goal:** Pure content and assembly: per-trade option pairs, the typical shop for (trade,
  metro), the regional price tier table with national fallback, and metro from area code.
- **Requirements:** R1, R2
- **Dependencies:** none
- **Files:**
  - create `packages/api/src/onboarding/choices/registry.ts`, `registry/{plumbing,hvac,electrical,generic}.ts`, `schema.ts` (Zod)
  - create `packages/api/src/onboarding/choices/assemble.ts`
  - create `packages/api/src/onboarding/choices/price-tiers.ts` (repository + national default)
  - modify `packages/api/src/compliance/us-geography.ts` (add NPA→metro)
  - modify `packages/api/src/db/schema.ts` (migration `310_regional_price_tiers`)
  - modify `packages/api/src/packs/seed-pack-defaults.ts` (accept a price multiplier)
  - tests: `packages/api/test/onboarding/choices/registry.test.ts`, `assemble.test.ts`,
    `price-tiers.test.ts`, `packages/api/test/compliance/npa-metro.test.ts`,
    `packages/api/test/integration/regional-price-tiers.test.ts`
- **Approach:** Each registry entry is `{ settingKey, question, options: [{ key: 'a'|'b', label,
  rivetLine (template), writes }], mostShops }`; a module-load Zod parse fails fast. The seven
  keys: `greeting`, `trip_fee_and_rate`, `booking_posture`, `payment_collection_mode`,
  `booking_hours`, `emergency_target`, `after_hours_mode`; an eighth, `existing_number`
  ("Do you already have a business number?"), asked of every owner as the last turn: nothing
  collected before it says whether a shop is established, so this answer is what decides the
  forwarding or day-one branch in U6, and a day-one owner clears it in one tap. (U3's first
  slices ask the seven; the eighth turn lands with U6.) `assembleTypicalShop(trade, metro)` returns the shop with option
  A values resolved from the tier (or national default), `mostShops` marks, and the rendered
  `rivetLine` per option with `{businessName}` and `{tripFee}` substituted. The multiplier for
  option B is an integer-cents function with one rounding rule, unit-tested.
- **Patterns to follow:** `packages/api/src/verticals/packs/plumbing.ts` (per-trade typed
  content), `verticals/registry.ts` (`VerticalPack`), migration style and NOT VALID CHECK
  constraints per `docs/solutions/database-issues/replay-migrations-check-constraints-not-valid.md`.
- **Test scenarios:**
  - Happy path: plumbing + `CLE` → seven entries, option A prices from the tier, `mostShops`
    on every entry, lines contain the business name.
  - Edge: metro with no tier row → `'US'` row; no `'US'` row → `PLUMBING_LINE_ITEM_DEFAULTS`
    and `showsCity: false`; area code spanning metros → `ambiguous: [metros]`.
  - Error: registry file missing a key for a trade fails the load-time test; a tier row with a
    non-integer price is rejected by Zod.
  - Integration: tier row inserted through the repository is read back with cents intact and
    no `tenant_id` column; RLS does not apply.
- **Verification:** every trade's registry passes the completeness test; assembly for all four
  trades × (`CLE`, unknown metro) returns a valid shop in under 5 ms with no model call.

### U2. Draft, choices and approve API; `onboarding_voice_policy` proposal
- **Goal:** The pre-approval draft, typed choice staging, and the single-transaction
  mint-and-approve on "That's right", plus the proposal contract for the settings the existing
  five do not cover.
- **Requirements:** R3, R7
- **Dependencies:** U1
- **Files:**
  - modify `packages/api/src/db/schema.ts` (migration `311_onboarding_drafts`: `tenant_id`,
    `trade`, `metro_code`, `assembled JSONB`, `choices JSONB`, `status`, `version`, timestamps; RLS)
  - create `packages/api/src/onboarding/draft/repository.ts`, `routes.ts`, `approve.ts`
  - create `packages/api/src/onboarding/draft/contracts.ts` (Zod for choices and overrides)
  - modify `packages/api/src/proposals/contracts/onboarding.ts` (add `onboarding_voice_policy`:
    greeting, `autonomous_booking_enabled`, `after_hours_voice_mode` as `voicemail|ai_answering`,
    `emergency_target` persisted as `escalation_settings.emergency_target`, a typed posture
    (`owner_cell` | `owner_cell_then_text`) separate from the E.164 `transfer_number`, which
    stays the number to ring; `payment_collection_mode` new column (migration 312);
    `quote_policy` is not added, no S1 card writes it). The runtime consumers of the new keys
    are U8, not U2: a stored value with no reader is a card that lies.
  - modify `packages/api/src/proposals/execution/onboarding-handlers.ts` (handler; writes via
    `SettingsRepository`), `packages/api/src/settings/settings.ts` and `pg-settings.ts`
    (two new keys, migration `312`), `packages/api/src/shared/contracts.ts` (`updateSettingsSchema`)
  - modify `packages/api/src/ai/orchestration/onboarding-conversation.ts` (extract
    `buildOnboardingProposals(ctx)` so the FSM path and the draft path share one builder)
  - modify `packages/api/src/onboarding/derive-status.ts`, `load-facts.ts`, `contracts.ts`
    (additive facts `draftStatus`, `choicesAnswered`)
  - modify `packages/api/src/app.ts` (mount under `/api/onboarding/draft`)
  - tests: `packages/api/test/onboarding/draft/{repository,approve,routes}.test.ts`,
    `packages/api/test/proposals/onboarding-voice-policy.test.ts`,
    `packages/api/test/onboarding/derive-status.test.ts` (extend),
    `packages/api/test/integration/onboarding-draft.test.ts`,
    `packages/api/test/integration/onboarding-voice-policy-handler.test.ts`
- **Approach:** `POST /draft` creates the draft (idempotent per tenant; `GET /draft` reads it,
  404 before). The trade, business name and optional cell it needs come from the demo-call
  lead when there is one (U7) and otherwise from the v3 shell's first screen, "What should I
  answer as?" (U3), which asks exactly those three before the draft exists; the signup form is
  unchanged and the direct "Start free" path never reaches the shell without them. The response
  is the assembled shop and the staged choices.
  `PUT /draft/choices/:settingKey` validates against the registry, stores `'a'|'b'|{override}`
  with a `version` compare-and-swap, emits `onboarding.choice_staged`. `POST /draft/approve`
  runs in one tenant transaction: build proposals from draft (existing five types plus
  `onboarding_voice_policy`), create them with surface `'onboarding_readback'`, call the same
  batch-approve function `routes/proposals.ts:322` uses, and gate on its result: that helper
  reports per-item failures in `failed` and keeps the earlier approvals, so the route throws a
  `ConflictError` when `failed.length > 0` before the draft is touched, and the one tenant
  transaction rolls every proposal row back (integration test: a failing proposal leaves no
  rows and the draft still `'draft'`). Only then set `status='approved'` and emit
  `onboarding.draft_approved`. Execution stays with `workers/execution-worker.ts` after the undo
  window. `onboarding_tenant_settings` needs timezone, so `GET /draft` records
  `clientTimezone` from the first request.
- **Patterns to follow:** `db/onboarding-session-repository.ts` and migration 195 (RLS
  table), `routes/onboarding-conversation.ts` (owner-only route shape), `routes/proposals.ts`
  batch approve, `docs/solutions/logic-errors/whole-object-refine-mints-approve-to-fail-voice-proposals.md`
  (never mint a proposal that fails its own gate).
- **Test scenarios:**
  - Happy path: stage seven choices, approve → six proposal rows exist with
    `surface='onboarding_readback'`, all `approved`, one audit trail, draft `approved`.
  - Edge: approve with three choices unanswered → defaults (option A) used, no gated
    proposal minted; stale `version` on PUT → 409; approve twice → second is a no-op 200.
  - Error: unknown `settingKey` → 400 naming the key; option `'c'` → 400; tenant without a
    draft calling approve → 404; non-owner → 403.
  - Integration: handler for `onboarding_voice_policy` writes `voice_greeting`,
    `autonomous_booking_enabled`, `escalation_settings.after_hours_voice_mode`,
    `escalation_settings.emergency_target`, `payment_collection_mode` and the booking-hours
    preset to real columns under RLS, merging `escalation_settings` rather than replacing it;
    derive-status still returns exactly seven steps.
- **Verification:** a fresh tenant goes draft → seven PUTs → approve → settings visible via
  `GET /api/settings` after the undo window, with the status contract unchanged for mobile.

### U3. The v3 conversational shell (web)
- **Goal:** One surface for the whole flow: Ready, seven option-pair turns, read-back, trial,
  number, test call, with tap and type on every turn and funnel events.
- **Requirements:** R2, R4, R7, R8
- **Dependencies:** U2 complete and deployed behind the flag (no mock lane); U4 for voice
  (renders without it)
- **Files:**
  - create `packages/web/src/components/onboarding/v3/ConversationShell.tsx`,
    `ReadyScreen.tsx`, `OptionPairTurn.tsx`, `ReadbackCard.tsx`, `TranscriptCard.tsx`,
    `NumberCard.tsx`, `TrialScreen.tsx`, `TestCallTurn.tsx`, `useOnboardingDraft.ts`
  - create `packages/web/src/components/ui/option-card.tsx` (two-option `role="radiogroup"` of
    `role="radio"` rows with `aria-checked`, roving tabindex and arrow-key movement, 56 px rows,
    one selected state)
  - modify `packages/web/src/routes.ts:67` (flag-gated lazy import),
    `packages/web/src/lib/analytics.ts` (new events), `FUNNEL.md`
  - tests: `packages/web/src/components/onboarding/v3/ConversationShell.test.tsx`,
    `OptionPairTurn.test.tsx`, `ReadbackCard.test.tsx`, `useOnboardingDraft.test.ts`,
    `packages/web/src/components/ui/option-card.test.tsx` (class contract: `min-h-11`, no
    overflow), `e2e/onboarding-v3-mobile.spec.ts` (320 px and 390 px viewports)
- **Approach:** Built against the live U2 endpoints with types imported from `packages/shared`;
  no fixture server. The shell reads `useOnboardingStatus` (existing, polls for phone and billing
  waits) and `useOnboardingDraft`, and derives the turn list client-side: ready → unanswered
  choices in registry order → read-back → billing (existing `/billing/checkout-session`) →
  number (`/phone/available` candidate shown earlier, bought on "That works"; the candidate is
  read-only and not reserved, so when `/phone/claim` fails after a long checkout because another
  buyer took it, the number turn re-searches and offers the next candidate, "That one just went.
  Here's another.", with a claim-failure test) → test call
  (existing `TestCallStep` behaviour, re-skinned) → first-day home. Header: minutes left,
  escape hatch ("Keep the rest as is" → read-back). Every turn: heading is Rivet's line,
  option cards, mic (U4), "Type instead", "Neither, I'll say it" (U5). Copy follows the
  vocabulary table in the brief; no "AI", "agent", "verify", "provisioning", "proposal",
  "dashboard" strings (a test greps the v3 tree for them). Tokens from `index.css`; no
  hard-coded slate or white.
- **Patterns to follow:** `components/onboarding/v2/steps/BillingStep.tsx:156` (radiogroup
  rows), `VoiceConfigPanel.tsx:79` (`aria-pressed` cards), `components/ui/button.tsx`,
  `e2e/estimate-approval-mobile.spec.ts` (viewport test), `hooks/useOnboardingStatus.ts`.
- **Test scenarios:**
  - Happy path: mocked draft with seven entries → seven turns → read-back shows seven rows →
    "That's right" calls approve → trial screen.
  - Edge: three choices pre-answered (resume) → shell opens on the fourth; "Keep the rest as
    is" from turn two → read-back with defaults marked "Most shops"; 320 px viewport → no
    horizontal scroll, all targets ≥ 44 px.
  - Error: approve 409 (stale version) → re-fetch draft and re-render read-back with a one-line
    notice; phone `available` empty → "Pick a different area code" path.
  - Integration (Playwright, web verify skill): tap through all turns on WebKit and Chromium
    at 390 px; funnel events fire once per turn with `answer_mode`.
- **Verification:** a new owner reaches the read-back by taps alone in under three minutes on
  a phone viewport; the forbidden-vocabulary test passes; v2 still works behind the flag.

### U4. Voice in and out: server voice for Rivet, first/second matcher, fallbacks
- **Goal:** Rivet's lines spoken in the tenant's chosen voice with barge-in; spoken answers
  matched to options client-side before any server call; tap and type fallbacks measured.
- **Requirements:** R5, R8
- **Dependencies:** none (integrates into U3)
- **Files:**
  - modify `packages/api/src/routes/voice.ts:280` and `packages/api/src/ai/tts/tts-provider.ts`
    (accept `voice`, resolve from tenant `voice_id`)
  - create `packages/api/src/ai/tts/clip-cache.ts` (key `(voiceId, sha256(text))`)
  - create `packages/web/src/hooks/useRivetVoice.ts` (compose `useDeepgramDictation` + an
    `HTMLAudioElement` player; barge-in pauses playback on first non-empty partial)
  - create `packages/web/src/lib/option-matcher.ts` ("first", "second", "the first one",
    "number two", "a", "b", option label fuzzy match)
  - modify `packages/web/src/hooks/useTTS.ts` (becomes the fallback),
    `packages/api/src/routes/voice.ts` (`POST /api/voice/tts/batch`, `GET /api/voice/tts/clip/:hash`)
  - tests: `packages/api/test/routes/voice-tts-voice-param.test.ts`,
    `packages/api/test/ai/tts/clip-cache.test.ts`,
    `packages/web/src/lib/option-matcher.test.ts`, `packages/web/src/hooks/useRivetVoice.test.ts`,
    `e2e/onboarding-v3-voice-webkit.spec.ts` (WebKit autoplay and mic spike)
- **Approach:** Option-pair lines are static per trade and voice, so the server caches clips
  and the client prefetches the next turn's clips while the current one plays. The budget
  matters: `POST /api/voice/tts` is limited to 20 requests per user per minute
  (`routes/voice.ts`), and seven headings plus fourteen option clips would hit it for a fast
  owner. So the prefetch asks for a whole turn at once (`POST /api/voice/tts/batch`: question
  plus two options, one request, counted once) and cached clips are served by content hash from
  `GET /api/voice/tts/clip/:hash`, which never counts (a miss falls back to the limited POST).
  A full pass is eight counted requests, with a test that counts them. Output
  fallback order: ElevenLabs clip → `speechSynthesis` → silent heading with type-in. Input:
  voice → tap (always rendered) → "Type instead". Option labels are passed to Deepgram as
  `keyterms`. The first clip plays from the "Make it mine" tap gesture to satisfy iOS autoplay,
  and the audio element is kept warm.
- **Patterns to follow:** `packages/api/src/ai/agents/customer-calling/filler-audio-cache.ts`
  (clip cache), `packages/web/src/hooks/useConversationVoice.ts` (barge-in rule),
  `packages/api/src/voice/deepgram-token.ts` (30 s token; refresh mid-turn).
- **Test scenarios:**
  - Happy path: "the second one" → option B; "eighty-nine" matches option A by label; clip
    request with a tenant `voice_id` hits ElevenLabs once, second request served from cache.
  - Edge: partial transcript arrives during playback → playback paused within 200 ms (fake
    timers); token expires mid-turn → refreshed without dropping the recorder.
  - Error: TTS 5xx → `speechSynthesis` fallback and `tts_fallback` event; mic permission
    denied → tap-only mode with no error banner, `answer_mode='tap'`.
  - Integration: WebKit Playwright run proves autoplay after gesture and `audio/mp4` upload
    accepted by the Deepgram stream.
- **Verification:** on iOS Safari and Android Chrome, Rivet speaks in the chosen voice,
  "first"/"second" selects correctly nine times in ten in a quiet room, and every failure path
  lands on tap without a dead end.

### U5. Free-speech override and the correction turn
- **Goal:** "Neither, I'll say it" on any card and "Tell me what to change" on the read-back
  stage a single setting from speech or text through the existing extractors.
- **Requirements:** R2, R3
- **Dependencies:** U2
- **Files:**
  - create `packages/api/src/onboarding/choices/override.ts` (single-setting extraction, one
    path per key: `PricingExtractor` for `trip_fee_and_rate`, `ScheduleExtractor` for
    `booking_hours`, and a new `packages/api/src/ai/tasks/onboarding/choice-override-extractor.ts`
    with one Zod schema per remaining key: `greeting` as length-capped free text, and the enum
    keys `booking_posture`, `payment_collection_mode`, `emergency_target`, `after_hours_mode`
    each classified to one of that key's allowed values from `ALLOWED_WRITES_BY_KEY` or a
    clarification; `BusinessProfileExtractor` is not involved. One clarification on low
    confidence)
  - modify `packages/api/src/onboarding/draft/routes.ts` (`POST /draft/override/:settingKey`,
    `POST /draft/override` with the setting-key classifier, `PUT /draft/metro`)
  - modify `packages/web/src/components/onboarding/v3/OptionPairTurn.tsx`, `ReadbackCard.tsx`
    (override turn UI reusing `TranscriptCard`)
  - tests: `packages/api/test/onboarding/choices/override.test.ts` (mocked gateway; one case
    per key, all seven, plus a clarification case per enum key),
    `packages/api/test/onboarding/draft/routes.test.ts` (extend),
    `packages/web/src/components/onboarding/v3/OverrideTurn.test.tsx`
- **Approach:** From the read-back the correction turn opens from a tapped row, so the key is
  known (U3 made every row tappable). The generic "Tell me what to change" mic has no key, so it
  first runs a setting-key classifier (one gateway call returning one of the seven read-back
  keys or `unclear`; `existing_number` is a yes/no turn of its own, never an override target;
  `unclear` asks "Which one?" with the seven row labels as chips) and only then the keyed
  extractor; `POST /draft/override` without a key is that classifier. The override endpoint
  picks the extractor by `settingKey`, calls it through
  the gateway with the spoken or typed text, and on confidence ≥ 0.7 stages `{override}` with
  the rendered Rivet line; below that it returns one clarifying question (the same
  `MAX_CLARIFICATIONS_PER_STATE` idea, capped at one here), then offers typing. Overrides are
  still approved only at the read-back.
- **Patterns to follow:** `ai/agents/onboarding/constants.ts` thresholds,
  `ai/orchestration/onboarding-conversation.ts` extractor invocation.
- **Test scenarios:**
  - Happy path: "I charge one twenty to come out and one seventy-five an hour" → trip fee
    12000, rate 17500 cents, line rendered with those numbers; "just hold them for me, I'll call
    back" on `booking_posture` → `autonomousBookingEnabled: false`; "say Walsh, go ahead" on
    `greeting` → `voiceGreeting` set verbatim.
  - Edge: "weekdays and Saturday mornings" → schedule with Saturday 7-12; two numbers with no
    units → clarification question returned, nothing staged.
  - Error: gateway timeout → 503 with the card unchanged; override on a key not in the
    registry → 400.
  - Integration: none beyond U2's draft tests (no new tables).
- **Verification:** an owner can override any of the seven settings by voice and see the
  change in the read-back before approving.

### U6. Day-one branch, number flow, forwarding by text, first-day home, retire v2
- **Goal:** Finish the flow end to end and remove the old wizard.
- **Requirements:** R6, R9, R8
- **Dependencies:** U3
- **Files:**
  - modify `packages/web/src/components/onboarding/v3/NumberCard.tsx`, `ConversationShell.tsx`
  - create `packages/api/src/onboarding/forwarding-text.ts` (owner SMS with tap-to-dial carrier
    code via `notifications/owner-sms-sender.ts`), route `POST /api/onboarding/phone/forwarding-text`
  - modify `packages/web/src/components/home/HomeConversationPanel.tsx`, `HomePage.tsx`
    (first-day state: Rivet speaks first, three chips, collapsed cards with value-stating empty
    states; the bank chip links to `POST /api/billing/connect/onboarding`)
  - modify `packages/web/src/routes.ts` (flip flag), delete `components/onboarding/v2/**` and
    its tests, `utils/onboarding-rerun.ts` callers updated to v3
  - modify `packages/web/src/components/settings/SettingsPage.tsx:1131` ("Re-run setup" → v3)
  - tests: `packages/api/test/onboarding/forwarding-text.test.ts`,
    `packages/api/test/routes/onboarding-forwarding-text.route.test.ts`,
    `packages/web/src/components/home/HomePage.first-day.test.tsx`,
    `packages/web/src/components/onboarding/v3/NumberCard.test.tsx`,
    `e2e/onboarding-v3-day-one.spec.ts`
- **Approach:** The `existing_number` choice decides the branch: "no" hides forwarding
  entirely and the Rivet number is presented as the business number; "yes" sends the owner a
  text with a `tel:` link that dials the carrier's forwarding code (table from
  `steps/PhoneStep.tsx:28-35`) and shows a "calls still ring your cell" badge on the first-day
  screen until the forwarding check passes. First-day home replaces empty KPI cards with
  Rivet's spoken opener and three chips; the existing cards stay hidden until they have data.
  Delete v2 with a re-grep for every import (CLAUDE.md dead-code rule).
- **Patterns to follow:** `notifications/owner-sms-sender.ts` (`recipientClass: 'owner'`
  skips consent), `components/home/ActivationCelebrationBanner.tsx` (first-run state),
  `docs/solutions/architecture-patterns/derive-shared-status-rule-across-frontends.md`.
- **Test scenarios:**
  - Happy path: re-run with a new price pick → the two headline catalog items and the template
    lines that still carry the seeded amounts update, an owner-edited labor rate (and the
    template line the owner changed) are untouched and the read-back says so;
    day-one owner → no forwarding turn, number card says "put it on the truck";
    established shop → forwarding text sent once, badge shown until `twilioStatus` reports
    forwarding verified.
  - Edge: owner taps "I'll do it later" → progress saved, badge persists across reload;
    first-day home with zero jobs → opener, three chips, two muted cards, no stat tiles.
  - Error: SMS provider failure → the carrier code is shown inline with copy button as the
    fallback and an event is recorded.
  - Integration: route test proves the SMS body contains the right code for each carrier.
- **Verification:** `grep -r "onboarding/v2" packages/web/src` returns nothing; e2e passes for
  both branches; the forbidden-vocabulary test extends to `components/home`.

### U8. Runtime consumers for the policy keys the cards write
- **Goal:** Every card's promise is behaviour, not a stored value. `payment_collection_mode`
  decides whether an issued invoice goes out with a pay link ("Text them a pay link") or is
  marked collect-on-site with no link ("Collect on the spot"), and what Rivet answers when a
  caller asks how to pay; `emergency_target` decides the emergency hand-off (owner cell, or
  owner cell then a text) in the voice hand-off path.
- **Requirements:** R2
- **Dependencies:** U2
- **Files:**
  - modify `packages/api/src/invoices/invoice-payment-link.ts` and the invoice send path in
    `packages/api/src/invoices/payment.ts` (read `paymentCollectionMode` from settings; no
    link and a collect-on-site note when `collect_on_site`)
  - modify the voice answer for payment questions and the emergency hand-off in
    `packages/api/src/voice/` (exact modules named at implementation; patterns:
    `voice/triage/context-preface.ts`, `voice/call-me-back/call-me-back.ts`)
  - tests: `packages/api/test/invoices/payment-collection-mode.test.ts`,
    `packages/api/test/voice/emergency-target.handler.test.ts` (mocked gateway/repos),
    `packages/api/test/integration/payment-collection-mode.test.ts`
- **Approach:** Read both keys through `SettingsRepository` at the point of behaviour, default
  to today's behaviour when unset (pay link; owner cell), so tenants that never answered the
  cards are unchanged. Audit the invoice send with the mode used.
- **Patterns to follow:** D-039/D-040 (absent key = default), the existing invoice send
  handlers in `proposals/execution/handlers.ts`.
- **Test scenarios:**
  - Happy path: `collect_on_site` → issued invoice has no pay link and the customer message
    says the tech collects on site; `pay_link` → unchanged behaviour. `owner_cell_then_text` →
    hand-off rings the owner, then texts on no answer.
  - Edge: key unset → today's behaviour; mode changed between issue and send → the value at
    send time wins, audited.
  - Error: settings read fails → fall back to default and record an event, never block the
    invoice.
  - Integration: a tenant with `collect_on_site` issues an invoice against real Postgres and the
    stored message carries no link.
- **Verification:** picking a card changes what the customer receives and what Rivet says, with
  a behaviour test per key, before the card copy is allowed to promise it.

### U7. Pre-signup "hear it answer" demo call (decision-gated)
- **Goal:** A visitor enters a cell and trade on the landing page, receives a sixty-second
  call answered as their business that books a sample job, then a signup text.
- **Requirements:** R1 (value before identity)
- **Dependencies:** U2, U4; voice-parity U3 for the preset voice on the call
- **Files:**
  - modify `packages/api/src/integrations/credentials.ts` (explicit `PLATFORM_TWILIO_*`)
  - create `packages/api/src/demo/{routes,service,script}.ts`, migration `313_demo_calls`
    (phone hash, trade, name, call_sid, status, lead_id; no `tenant_id`)
  - create fixture tenants per trade via a seed script `packages/api/scripts/seed-demo-tenants.ts`
  - modify `packages/api/src/app.ts` (public route with the `/public` IP limiter at :839),
    `packages/api/src/shared/rate-limit/phone-rate-limit.ts` (platform sentinel tenant, one
    call per number per day), `packages/api/src/flags/voice-flags.ts` (kill switch)
  - reuse `telephony/outbound-call-service.ts:266` REST pattern minus the customer bridge,
    `ai/skills/disclose-recording.ts` copy pattern for the consent line,
    `voice/outbound-allowlist.ts` NANP and premium checks, `leads/lead-service.ts`
  - web: `docs/marketing/landing-page.html` CTA pair and a `packages/web` public page
    `components/public/HearItAnswer.tsx`; modify `packages/web/src/components/auth/SignupPage.tsx`
    (forward the handoff token) and the Clerk signup webhook handler in `packages/api/src/`
    (copy it onto the tenant)
  - tests: `packages/api/test/demo/{service,routes,limits}.test.ts`,
    `packages/api/test/integration/demo-calls.test.ts`, `e2e/hear-it-answer.spec.ts`
- **Approach:** The outbound leg dials the visitor from the platform number and connects it
  to the real inbound turn processor running against a per-trade fixture tenant, so the
  visitor hears exactly what customers will. A canned `<Say>/<Gather>` script is the fallback
  if fixture tenants prove awkward. Consent line first; two-layer rate limits; daily spend cap;
  a lead row in a platform marketing tenant. The signup SMS link carries a signed, single-use
  handoff token (HMAC over `lead_id` and an expiry). Migration 313 also adds a platform table
  `signup_handoffs(token_hash PK, lead_id, tenant_id NULL, expires_at, consumed_at)`:
  `SignupPage` forwards the token into Clerk unsafe metadata, the Clerk signup webhook binds
  it exclusively (`UPDATE … SET tenant_id = $2 WHERE token_hash = $1 AND tenant_id IS NULL
  AND expires_at > now()`; a second signup with the same token binds nothing and is logged),
  and `POST /draft` consumes it atomically
  (`UPDATE … SET consumed_at = now() WHERE tenant_id = $1 AND consumed_at IS NULL AND
  expires_at > now() RETURNING lead_id`) to read the lead's trade, name and metro. No row, a
  consumed row or an expired one means the shell asks (U3's first screen); the SMS itself never
  carries the seed facts and the token is stored only as a hash.
- **Patterns to follow:** D-037 (buy nothing for a tire-kicker), `docs/solutions/logic-errors/click-to-call-gate-requires-global-twilio-sid.md`.
- **Test scenarios:**
  - Happy path: valid US cell + plumbing → call created with consent TwiML first, `demo_calls`
    row, lead row, signup SMS after hang-up.
  - Edge: same number twice in a day → 429 with a friendly message; premium or non-NANP
    number → 400; kill switch on → 503 and the landing CTA hides.
  - Error: Twilio 5xx → row `status='failed'`, no SMS, no lead; handoff token reused or
    expired → ignored, the shell asks for name and trade.
  - Integration: `demo_calls` has no `tenant_id` and is not subject to RLS; rate limiter keyed
    to the sentinel tenant persists across restarts.
- **Verification:** cost per completed demo call measured in staging before the landing CTA
  ships; founder decision recorded in `docs/decisions.md`.

## Risks & Dependencies

- **Two sources of truth (draft vs proposals).** The draft is the only pre-approval state;
  mint and approve happen in one transaction; `version` CAS rejects stale tabs.
- **Browser voice on real devices.** Tap is first-class everywhere, `answer_mode` is measured
  per turn, U4 spikes WebKit before U3 depends on it.
- **Regional prices wrong or read as advice.** Founder-curated rows, "typical" copy, prices
  land only through approval and remain editable catalog items.
- **Status contract drift.** Additive facts only; `.length(7)` preserved; pinned by extending
  `packages/api/test/onboarding/derive-status.test.ts` and the integration status test.
- **Demo call cost, abuse, TCPA.** Phased last, consent first, two-layer limits, kill switch,
  spend cap.
- **Voice-parity coupling.** Scenario turns (U9), voice preview persistence (U3) and verified
  test booking (U6) are rendered from existing facts until those units land; nothing in U1-U6
  blocks on them.

## Open Questions (deferred to implementation)

1. Exact `metro_code` vocabulary (CBSA codes vs short slugs) and the first curated metros.
2. Whether `onboarding_voice_policy` should be split so the emergency target can re-point to
   `transfer_targets.emergency` when voice-parity U7 lands without a contract version bump.
3. Deepgram `keyterms` support on the current plan tier for option-label boosting.
4. Where the trial sentence and card decision sit (founder decision in the brief).
5. Whether to keep `useTTS` after U4 or delete it (depends on fallback usage measured).

## Sizing and sequencing

Vertical slices, each one PR, each releasable behind the `onboarding_v3` flag, each test-first
with integration and end-to-end coverage in the same PR. No slice starts on a mock of a
previous one; the previous slice is merged first.

| Slice | Units | What ships | Size |
|---|---|---|---|
| S1 | U1 + U2 | Choice registry, typical-shop assembly, regional tiers, draft/choices/approve API, `onboarding_voice_policy` proposal. Live API, integration-tested, no UI yet. | 7-10 days |
| S2 | U3 | v3 shell against the live S1 API: Ready, seven turns (tap and type), read-back, approve, trial, number, test call. Playwright on the real stack. | 6-9 days |
| S3 | U4 | Server-voice TTS with clip cache, first/second matcher, barge-in, WebKit coverage. | 4-5 days |
| S4 | U5 | Free-speech override, setting-key routing for the read-back mic, metro change (`PUT /draft/metro`). | 2-3 days |
| S5 | U6 + U8 | Eighth turn (existing number) and day-one branch, number flow with claim re-search, forwarding text, first-day home, runtime consumers for `payment_collection_mode` and `emergency_target`, flag flipped, v2 deleted. | 6-8 days |
| S6 | U7 | Pre-signup demo call (founder decision first). | 6-9 days |

Serial by construction: one engineer, nine to twelve weeks for S1-S5; S6 adds about two. A
second engineer shortens S2 and S3 only where the API they depend on is already merged.

Per-slice definition of done: failing tests written first; `npx tsc --project
tsconfig.build.json --noEmit` clean in `packages/api`; unit, integration
(`npm run test:integration`) and the relevant Playwright spec green; the API verify skill
(`Serviceos/packages/api:verify`) or web verify skill (`Serviceos/packages/web:verify`) run
against the slice; dead code removed; funnel events documented in `FUNNEL.md`.
