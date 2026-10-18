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
  owner's price choice travels as `hourlyRateCents` and `tripFeeCents` on the
  `onboarding_tenant_settings` payload (optional, integer cents) and the execution handler
  threads them into `activatePackWithSeed`, so the seeder has the chosen prices when it runs
  after the undo window: the headline visit and labor items land at exactly those cents and
  every other seeded price scales by the hourly ratio. No second seed set. That holds for a
  first run only: the seeder skips any catalog item or template
  whose canonical name already exists, so on U6's "Re-run setup" the price card does not
  re-seed. It updates the pack's two headline items (visit fee, labor rate) and the estimate
  template line items that carry those same seeded amounts, in each case only while the row
  still holds the price the seeder set; anything the owner has edited is left alone, and the
  read-back says which happened ("Your labor rate is yours; I left it"). Knowing which rows
  still hold the seeded price needs the baseline: U6's migration adds a nullable
  `seeded_unit_price_cents` to `catalog_items` and to the estimate template line items, set by
  the seeder from then on; a row whose baseline is null or differs from its current price is
  the owner's and is left alone. A null baseline is therefore not a neutral default: a tenant
  seeded before that migration would read as all owner-owned, and the re-run price card would
  promise an update it could not make. So the migration backfills the baseline for existing
  rows whose price exactly equals the seed price for the tenant's pack at the tenant's
  resolved price tier (an exact match is an untouched seed; everything else stays null and
  owner-owned), and the re-run flow offers repricing only when the tenant has at least one
  baseline. A tenant with none is told its prices are its own and sees no price card (U6).
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
  tenant-less public route, a leased pool of demo tenants per trade (one live call per
  tenant), consent and rate limits. Screen 7's
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
  approving `onboarding_*` proposals. A draft approval mints exactly two of them,
  `onboarding_tenant_settings` and the new `onboarding_voice_policy`, each with a Zod contract
  in `packages/api/src/proposals/contracts/onboarding.ts` and a handler in
  `proposals/execution/onboarding-handlers.ts`. The other existing types
  (`onboarding_service_category`, `onboarding_estimate_template`, `onboarding_team_member`,
  `onboarding_schedule`) stay with the FSM path: the pack seeder lands the catalog and
  templates, and the voice-policy proposal carries the hours preset. The draft row is
  pre-approval state only.
  Execution remains async after the 5 s undo window (`proposals/lifecycle.ts:53`); the
  read-back shows "Saving, tap to undo" for that window (the one tap is `POST /draft/undo`, U9;
  until it lands the screen says "Saving" with no button, as S2a shipped).
- **Audit events:** `onboarding.draft_created`, `onboarding.choice_staged`,
  `onboarding.draft_approved`, plus the existing proposal lifecycle events. U8 adds
  `invoice.payment_mode_unavailable` and reuses `invoice.payment_link_deactivated` with the
  reason `payment_mode_changed`.
- **Integer cents:** tier prices, trip fee and hourly rate are cents end to end; the price
  multiplier is applied in integer arithmetic with explicit rounding in one function.
- **tenant_id + RLS:** `onboarding_drafts` carries `tenant_id` with RLS like
  `onboarding_session` (migration 195). `regional_price_tiers` and `demo_calls` are
  platform tables with no `tenant_id`, admin-write only, the same posture as `tenants`;
  `demo_tenant_leases` (U7) is the same kind of platform table, and its `tenant_id` only names
  the demo tenant a call holds.
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
`packages/api/src/onboarding/draft/{repository,approve}.ts`, router
`packages/api/src/routes/onboarding-draft.ts`. Web:
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
  slices ask the seven; the eighth turn lands with U6.) The `generic` registry is content only:
  a "Something else" owner's pack id is `other`, which is in `SEEDABLE_PACK_IDS` and accepted
  by the `verticalPacks` contract, so approval works for every trade the first screen offers.
  `assembleTypicalShop(trade, metro)` returns the shop with option
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
  mint-and-approve on "That's right", plus `onboarding_voice_policy`, the proposal contract for
  the settings no existing `onboarding_*` type carries.
- **Requirements:** R3, R7
- **Dependencies:** U1
- **Files:**
  - modify `packages/api/src/db/schema.ts` (migration `311_onboarding_drafts`: `tenant_id`,
    `trade`, `metro_code`, `assembled JSONB`, `choices JSONB`, `status`, `version`, timestamps; RLS)
  - create `packages/api/src/onboarding/draft/repository.ts` and `approve.ts`
    (`buildDraftProposals`, `approveDraft`), and the router
    `packages/api/src/routes/onboarding-draft.ts`
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
  - modify `packages/api/src/onboarding/derive-status.ts`, `load-facts.ts`, `contracts.ts`
    (additive facts `draftStatus`, `choicesAnswered`)
  - modify `packages/api/src/app.ts` (mount under `/api/onboarding/draft`)
  - tests: `packages/api/test/onboarding/draft/{approve,wire-contract}.test.ts`,
    `packages/api/test/routes/onboarding-draft.route.test.ts`,
    `packages/api/test/proposals/onboarding-voice-policy.test.ts`,
    `packages/api/test/onboarding/derive-status.test.ts` (extend),
    `packages/api/test/integration/onboarding-draft-approve.test.ts`,
    `packages/api/test/integration/onboarding-draft-repository.test.ts`,
    `packages/api/test/integration/onboarding-voice-policy-handler.test.ts`
- **Approach:** `POST /draft` creates the draft (idempotent per tenant; `GET /draft` reads it,
  404 before). One row per tenant, so a re-run reopens that row rather than creating another:
  `POST /draft/reopen` (U6) is allowed only when the draft is `approved` and every generated
  proposal has executed; it re-assembles for the current trade and metro, pre-fills `choices`
  from the live settings (greeting → override label; the enum keys → the option whose writes
  match; prices → the current headline items, repriced only while the tenant still has a
  seeded baseline, U6), resets `status='draft'`, `proposal_ids=[]`,
  bumps `version`, and emits `onboarding.draft_reopened`. The read-back then shows what is
  live today and "That's right" mints proposals exactly as a first run does. The trade, business name and optional cell it needs come from the demo-call
  lead when there is one (U7) and otherwise from the v3 shell's first screen, "What should I
  answer as?" (U3), which asks exactly those three before the draft exists; the signup form is
  unchanged and the direct "Start free" path never reaches the shell without them. The response
  is the assembled shop and the staged choices.
  `PUT /draft/choices/:settingKey` validates against the registry, stores `'a'|'b'|{override}`
  with a `version` compare-and-swap, emits `onboarding.choice_staged`. `POST /draft/approve`
  runs in one tenant transaction (S1 shipped it without a version check or row lock; U11 adds
  both): build exactly two proposals from the draft
  (`buildDraftProposals`: `onboarding_tenant_settings` carrying name, city, pack, chosen prices
  and timezone, and `onboarding_voice_policy` carrying the other staged settings; the
  draft-only `existing_number` answer is never written), create them with surface
  `'onboarding_readback'`, call the same
  batch-approve function `routes/proposals.ts:322` uses, and gate on its result: that helper
  reports per-item failures in `failed` and keeps the earlier approvals, so the route throws a
  `ConflictError` when `failed.length > 0` before the draft is touched, and the one tenant
  transaction rolls every proposal row back (integration test: a failing proposal leaves no
  rows and the draft still `'draft'`). Only then set `status='approved'` and emit
  `onboarding.draft_approved`. Execution stays with `workers/execution-worker.ts` after the undo
  window; the one-tap undo of the whole approval, and holding onboarding until every generated
  proposal has executed, are U9. `onboarding_tenant_settings` needs timezone, so `POST /draft`
  records `clientTimezone` from the first request.
- **Shipped in S1 (merged to `main`), and the gap it left:** the draft, choices and approve
  API landed as described above, without one guard. `POST /draft/approve` takes no expected
  version (the web client posts `{}`); `approveDraft` reads the draft with a plain `SELECT`,
  not `FOR UPDATE` (the route pre-reads it unlocked too); and `markApproved` updates
  `WHERE tenant_id = $1 AND status = 'draft'` with no version predicate, returning the
  existing row when it matches nothing instead of failing. Two races follow. A choice `PUT`
  that commits between proposal construction and `markApproved` leaves proposals built from
  choices the approved draft no longer holds. Two concurrent approvals each mint and approve
  their own pair inside their own request transaction; the loser's `markApproved` matches
  nothing and returns the winner's row, yet the loser's request still commits (answering with
  its own proposal ids while the draft records the winner's), so a second approved pair
  exists and the execution worker runs it. S1 shipped without the lock; U11 closes both
  races, and with it the repeat-tap contract changes from S1's no-op 200 to 409
  `DRAFT_APPROVED`.
- **Patterns to follow:** `db/onboarding-session-repository.ts` and migration 195 (RLS
  table), `routes/onboarding-conversation.ts` (owner-only route shape), `routes/proposals.ts`
  batch approve, `docs/solutions/logic-errors/whole-object-refine-mints-approve-to-fail-voice-proposals.md`
  (never mint a proposal that fails its own gate).
- **Test scenarios:**
  - Happy path: stage choices, approve → exactly two proposal rows exist for the tenant,
    `onboarding_tenant_settings` and `onboarding_voice_policy`, each with
    `source_context.surface='onboarding_readback'` and the draft id, both `approved`; the
    response's `proposalIds` has those two ids and equals the draft's `proposal_ids`; the draft
    is `approved`; the audit trail is `onboarding.draft_created`, one `onboarding.choice_staged`
    per PUT and one `onboarding.draft_approved`; `tenant_settings` is untouched until the
    worker runs (pinned by `test/integration/onboarding-draft-approve.test.ts`). Unit:
    `buildDraftProposals` returns only those two inputs and both payloads parse under their
    Zod schemas; an answered `existing_number` never appears in either payload.
  - Edge: approve with choices unanswered → each takes its `mostShops` default (option A
    today), no gated proposal minted; no recorded timezone → 400 `TIMEZONE_REQUIRED`, zero
    proposal rows, draft still `'draft'`; stale `version` on PUT → 409; approve twice → second
    is a no-op 200 returning the same two ids (as S1 shipped; U11 keeps it and only adds the
    lock and the version check).
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
  read-only and not reserved, and `/phone/claim` only validates and enqueues `provision-twilio`,
  so a number another buyer took during a long checkout surfaces later as the phone step's
  `error` (`area_code_unavailable`) on the status poll; the number turn reacts to that
  transition by re-searching and offering the next candidate, "That one just went. Here's
  another.", with a test that drives the status from provisioning to error to a new candidate)
  → the voice check (`ai_check`) as the test call's pre-state, never a screen of its own:
  "Getting my voice ready." while it runs; on error, owner copy with Try again
  (`/ai-check/retry`) and Skip for now (`/ai-check/skip`), the same recovery the v2 step had
  (`GettingReadyTurn`, shipped in S2c) → test call
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
    `packages/api/test/routes/voice-tts-batch.route.test.ts`,
    `packages/api/test/onboarding/choices/registry-tts-caps.test.ts`,
    `packages/web/src/lib/option-matcher.test.ts`, `packages/web/src/hooks/useRivetVoice.test.ts`,
    `e2e/onboarding-v3-voice-webkit.spec.ts` (WebKit autoplay and mic spike)
- **Approach:** Option-pair lines are static per trade and voice, so the server caches clips
  and the client prefetches the next turn's clips while the current one plays. The budget
  matters, and the batch must not be a way around it. `POST /api/voice/tts` is limited to 20
  clips per user per minute (`ttsLimiter` in `routes/voice.ts`, added in #1603 so each billable
  clip is capped and no account becomes a free-text TTS proxy), and a turn of three clips every
  few seconds would meet that for a fast owner, so the prefetch asks for a whole turn in one
  request. The batch is bounded and charged per clip, never per request:
  - **Bounded.** `POST /api/voice/tts/batch` is exactly one turn: the question plus at most
    two option lines, so one to three items. Zod enforces each item at 1-240 characters
    (trimmed), at most three items, and at most 600 characters in total; anything else is a 400
    before any charge, cache lookup or provider call. The caps are sized from the registry
    (`onboarding/choices/registry/*.ts`): the longest question is 61 characters (the schema
    allows 140), the longest `rivetLine` template is 104 (the schema allows 260), and with the
    longest substitutions (`{businessName}` up to 120, `{ownerFirstName}` up to 60) the longest
    rendered line is 163 and the heaviest turn, the eighth, is 362 characters in all. 240 and
    600 leave about 1.5x and 1.7x headroom. The schema ceilings are looser than the batch caps,
    so the guard is a registry test that renders every trade's turns at the maximum name
    lengths and fails the content PR that outgrows either cap. Lines outside the seven turns
    (the Ready opener, the read-back, the trial and number lines) go through the single-clip
    `POST /api/voice/tts`.
  - **Charged per clip.** The batch resolves cache hits first (key `(voiceId, sha256(text))`),
    then charges the caller's budget one unit per miss, before any provider call. The budget is
    the one `ttsLimiter` already keeps (same per-user key, same `VOICE_TTS_PER_MIN`), exposed as
    a `chargeTtsClips(req, n)` helper that `POST /tts` also calls with 1, so the cap lives in
    one place. If the misses exceed what is left, it answers 429 `RATE_LIMITED` and synthesizes
    nothing; cache hits cost nothing; each synthesized clip is audited as
    `voice.tts.synthesized` with its own character count, as the single route does.
  - **Free hash reads.** Cached clips are served by content hash from
    `GET /api/voice/tts/clip/:hash`, which never charges and never synthesizes (a miss is a
    404, and the client falls back to the charged POST).

  The prefetch looks one turn ahead and no further, so a fast owner (a turn every ten seconds,
  three uncached clips a turn) draws about 18 clips a minute, inside the 20. The first pass for
  a (trade, voice) is the expensive one: later owners hit the cache for every line that embeds
  no name or price. A 429 degrades that turn to `speechSynthesis`, never to a blocked turn. A
  full pass is counted in clips, at most three per turn, with a test that counts them. Output
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
  - Batch limits (the provider-spend guard): an item over 240 characters → 400, nothing
    charged, nothing synthesized; four items → 400; three items under 240 each but over 600 in
    total → 400; an empty or whitespace-only item → 400; a three-item turn at the caps → 200.
    Charging: three uncached items charge three units; the same turn again charges zero (every
    clip a cache hit); one cached and two uncached items charge two; a turn whose misses exceed
    the remaining budget → 429 with no provider call and no partial charge; the single
    `POST /tts` and the batch draw from one per-user budget (twenty single clips leave a batch
    with nothing). Registry: every trade's turns, rendered at the maximum name lengths, stay
    within 240 per item and 600 per turn.
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
  - modify `packages/api/src/routes/onboarding-draft.ts` (`POST /draft/override/:settingKey`,
    `POST /draft/override` with the setting-key classifier, `PUT /draft/metro`)
  - modify `packages/web/src/components/onboarding/v3/OptionPairTurn.tsx`, `ReadbackCard.tsx`
    (override turn UI reusing `TranscriptCard`)
  - tests: `packages/api/test/onboarding/choices/override.test.ts` (mocked gateway; one case
    per key, all seven, plus a clarification case per enum key),
    `packages/api/test/routes/onboarding-draft.route.test.ts` (extend),
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
  - create migration `314_seeded_price_baseline` (`catalog_items.seeded_unit_price_cents`
    and a `seededUnitPriceCents` key on each estimate template line item inside the
    `line_item_templates` JSONB, both nullable; `tenant_settings.seeded_baseline_backfilled_at`,
    the per-tenant one-shot stamp for the backfill below) and
    `packages/api/src/packs/reprice-seeded.ts` (the re-run update path: headline items and
    template lines whose current price equals their baseline move to the new pick; the seeder
    writes the baseline from now on; `backfillSeededBaselines(tenantId)` for tenants seeded
    before 314; `hasSeededBaseline(tenantId)` for the re-run gate); tests
    `packages/api/test/packs/reprice-seeded.test.ts`,
    `packages/api/test/integration/reprice-seeded.test.ts`
  - modify `packages/api/src/packs/seed-pack-defaults.ts` (write the baseline on every seeded
    row; export the pricing function so the backfill and the seeder share one rounding rule)
    and `packages/api/src/db/migrate.ts` (after the SQL corpus, still under the migration
    advisory lock, run `backfillSeededBaselines` for each tenant whose
    `seeded_baseline_backfilled_at` is null); test: extend
    `packages/api/test/integration/migration-replay-populated-db.test.ts`
  - modify `packages/api/src/proposals/execution/onboarding-handlers.ts`
    (`OnboardingTenantSettingsExecutionHandler`: when the pack is already active, call
    `repriceSeeded` with the payload's prices instead of the first-run `activatePackWithSeed`,
    which skips existing names; integration test in `reprice-seeded.test.ts` runs the handler
    against a seeded tenant and asserts the moved and untouched rows)
  - create `packages/api/src/onboarding/forwarding-probe.ts` and route
    `POST /api/onboarding/phone/forwarding-probe`; migration 314 also adds
    `tenant_settings.forwarding_confirmed_at`, `forwarding_verified_at`,
    `forwarding_source_number` (nullable text, E.164) and `forwarding_carrier` (nullable text,
    CHECK in `verizon | att | tmobile | other`, added `NOT VALID` per
    `docs/solutions/database-issues/replay-migrations-check-constraints-not-valid.md`); tests
    `packages/api/test/onboarding/forwarding-probe.test.ts`
  - the forwarding answers travel the same road as the owner's cell (U10): a second migration
    in the 314 range adds nullable `onboarding_drafts.forwarding_source_number` and
    `forwarding_carrier`; modify `packages/api/src/onboarding/draft/contracts.ts` and
    `repository.ts` (both fields on the draft: E.164 through the existing phone normaliser, and
    the carrier enum above), `packages/api/src/routes/onboarding-draft.ts` (`PUT
    /draft/forwarding` stages them, refused unless `existing_number` resolves to "yes"),
    `packages/api/src/onboarding/draft/approve.ts` (carry `forwardingSourceNumber` and
    `forwardingCarrier` on the `onboarding_tenant_settings` payload),
    `packages/api/src/proposals/contracts/onboarding.ts` (both optional on that payload's Zod
    schema), `proposals/execution/onboarding-handlers.ts` (`OnboardingTenantSettingsExecutionHandler`
    writes both columns through `SettingsRepository`), and `packages/api/src/settings/settings.ts`
    and `pg-settings.ts` (the two keys; not added to `updateSettingsSchema`); tests
    `packages/api/test/onboarding/draft/forwarding.test.ts`,
    `packages/api/test/integration/onboarding-draft-forwarding.test.ts`
  - create `packages/api/src/onboarding/forwarding-text.ts` (owner SMS with tap-to-dial carrier
    code via `notifications/owner-sms-sender.ts`), route `POST /api/onboarding/phone/forwarding-text`
  - modify `packages/web/src/components/home/HomeConversationPanel.tsx`, `HomePage.tsx`
    (first-day state: Rivet speaks first, three chips, collapsed cards with value-stating empty
    states; the bank chip links to `POST /api/billing/connect/onboarding`)
  - modify `packages/web/src/routes.ts` (flip flag), delete `components/onboarding/v2/**` and
    its tests, `utils/onboarding-rerun.ts` callers updated to v3
  - modify `packages/web/src/components/settings/SettingsPage.tsx:1131` ("Re-run setup" → v3,
    which calls `POST /draft/reopen` first and lands on the read-back)
  - modify `packages/api/src/routes/onboarding-draft.ts`,
    `packages/api/src/onboarding/draft/repository.ts`, `approve.ts`
    (`POST /draft/reopen` and the settings → choices pre-fill; refused with 409 unless every
    generated proposal has `executed`, so a `failed` set is retried through U9 first and a
    second set is never minted beside failed rows; the response carries
    `repricing: { available }`, and a reopened draft's approval leaves the prices off the
    settings payload when it is false); tests
    `packages/api/test/onboarding/draft/reopen.test.ts`,
    `packages/api/test/integration/onboarding-draft-reopen.test.ts`
  - tests: `packages/api/test/onboarding/forwarding-text.test.ts`,
    `packages/api/test/routes/onboarding-forwarding-text.route.test.ts`,
    `packages/web/src/components/home/HomePage.first-day.test.tsx`,
    `packages/web/src/components/onboarding/v3/NumberCard.test.tsx`,
    `e2e/onboarding-v3-day-one.spec.ts`
- **Approach:** The `existing_number` choice decides the branch: "no" hides forwarding
  entirely and the Rivet number is presented as the business number; "yes" asks two more
  things on the same turn, "What's that number?" (E.164) and the carrier (chips from the table
  in `steps/PhoneStep.tsx:28-35`), because a yes/no cannot be forwarded and the owner's cell
  is not the business line. Both answers are staged on the draft (`PUT /draft/forwarding`),
  ride the `onboarding_tenant_settings` payload as `forwardingSourceNumber` and
  `forwardingCarrier`, and are written to `tenant_settings.forwarding_source_number` and
  `forwarding_carrier` by that proposal's handler when it executes, so the write is approved,
  audited and undoable like the rest. Nothing else writes them: they are not in
  `updateSettingsSchema`, and the staging endpoint writes the draft only. The shell holds until
  the approval has executed (U9), so the text and the probe always read stored values. The
  text then goes to the owner's cell and says to dial the
  code from the business phone (a `tel:` link only when that phone is the same device; a
  landline gets the code to punch in), the probe calls the business number, not the cell, and
  the badge says "calls still ring your cell" on the first-day
  screen until forwarding is confirmed. `twilioStatus` says nothing about the owner's carrier,
  so the badge has its own state: `tenant_settings.forwarding_confirmed_at`, set when the owner
  taps "I dialed it" on the first-day chip, and `forwarding_verified_at`, set by a probe
  (`POST /api/onboarding/phone/forwarding-probe` places a call from the platform number to the
  old business number; the inbound handler records it if it arrives at the Rivet number within
  20 s). Either clears the badge; a probe that never arrives keeps it and shows the code again.
  First-day home replaces empty KPI cards with
  Rivet's spoken opener and three chips; the existing cards stay hidden until they have data.
  Delete v2 with a re-grep for every import (CLAUDE.md dead-code rule).
- **Seeded-price baseline and the re-run gate:** A null baseline means "the owner's", so a
  tenant seeded before migration 314 would have every price skipped by `repriceSeeded` while
  the re-run card implied an update. Two rules close that. (1) Backfill:
  `backfillSeededBaselines(tenantId)` sets the baseline on a catalog item or template line only
  when its current price exactly equals the price the seeder would have written for that seed
  name under a pricing the tenant could have been seeded with: the pack defaults (every tenant
  the v2 wizard seeded, and any whose metro had no tier row); and, for a tenant with an
  onboarding draft, `standard` or `premium` of its resolved price tier (the
  `regional_price_tiers` row for the draft's `metro_code`, which came from the NPA→metro map,
  else the `'US'` row, else the pack defaults; premium is standard × `PREMIUM_MULTIPLIER_BPS`)
  or the pair on its approved `onboarding_tenant_settings` proposal (`hourlyRateCents`,
  `tripFeeCents`, which also covers a free-speech override). An exact match is an untouched
  seed; everything else keeps a null baseline and stays the owner's. The expected price comes
  from the seeder's own pricing function, exported for this and not re-derived in SQL, so
  there is one rounding rule; the one false positive, an owner who typed a seed price by hand,
  gets a repricing the read-back names. The runner has no ledger and replays the corpus every
  deploy, so the step writes only where the baseline is null, runs once per tenant in that
  tenant's own transaction, and stamps `tenant_settings.seeded_baseline_backfilled_at`; a
  tenant that fails is retried on the next deploy and a stamped one is never revisited (the
  one-shot lesson of `194_thank_you_sms`). (2) Gate: `POST /draft/reopen` reports
  `repricing.available`, derived and never stored, true when any non-archived catalog item or
  template line of the tenant has a baseline (`hasSeededBaseline`). When it is false the price
  turn says "Your prices are your own" and offers no repricing: the price row is read-only, the
  reopened draft's approval leaves `hourlyRateCents` and `tripFeeCents` off the settings
  payload (the first-run path, which requires them, is unchanged), and `repriceSeeded` is not
  called. When it is true the owner picks as before, and rows the owner edited are still
  reported as theirs.
- **Patterns to follow:** `notifications/owner-sms-sender.ts` (`recipientClass: 'owner'`
  skips consent), `components/home/ActivationCelebrationBanner.tsx` (first-run state),
  `docs/solutions/architecture-patterns/derive-shared-status-rule-across-frontends.md`.
- **Test scenarios:**
  - Happy path: re-run → `POST /draft/reopen` pre-fills the read-back with the live greeting,
    posture, payment mode, hours, emergency target and prices; a new price pick → the two
    headline catalog items and the template lines that still carry the seeded amounts update,
    an owner-edited labor rate (and the template line the owner changed) are untouched and the
    read-back says so; "yes" to an existing number → the business number and carrier are asked,
    staged on the draft, carried on the settings proposal and written to
    `tenant_settings.forwarding_source_number` and `forwarding_carrier` when it executes, the
    text says to dial from that phone, the probe calls that number;
    day-one owner → no forwarding turn, number card says "put it on the truck";
    established shop → forwarding text sent once, badge shown until the owner confirms or the
    probe lands; a probe that never arrives leaves the badge and re-shows the code.
  - Edge: owner taps "I'll do it later" → progress saved, badge persists across reload;
    first-day home with zero jobs → opener, three chips, two muted cards, no stat tiles.
  - Edge (forwarding answers): staged on the draft but not approved → `tenant_settings`
    forwarding columns still null; `existing_number` "no" → `PUT /draft/forwarding` refused and
    neither key on the payload; approved and executed → both columns hold the staged values.
  - Edge (legacy seeded tenants): rows seeded at the pack defaults, and separately rows seeded
    at the tenant's `standard` tier, its `premium` tier or a free-speech pair (scaled rows
    included), with a null baseline and an exactly matching price → after the backfill each has
    its baseline and a new price pick reprices it; a legacy row the owner edited → baseline
    stays null, the row is left alone and the read-back says it is theirs; a second deploy
    replays the backfill → no baseline overwritten and a stamped tenant is not revisited.
  - Edge (no baseline): a tenant whose rows all lack a baseline → `POST /draft/reopen` reports
    `repricing.available = false`, the price turn says "Your prices are your own" and shows
    no price card, and approval carries no prices; a tenant with at least one baseline sees
    the repricing choice.
  - Error: SMS provider failure → the carrier code is shown inline with copy button as the
    fallback and an event is recorded; a non-E.164 source number → 400 naming the field; a
    carrier outside `verizon | att | tmobile | other` → 400.
  - Integration: route test proves the SMS body contains the right code for each carrier; real
    Postgres pins the new columns (`tenant_settings.forwarding_source_number`,
    `forwarding_carrier` with its CHECK, `seeded_baseline_backfilled_at`;
    `catalog_items.seeded_unit_price_cents`; the `onboarding_drafts` forwarding columns) and
    the handler's write to them under RLS; the backfill runs against seeded and hand-edited
    rows in a populated database (extending `migration-replay-populated-db.test.ts`).
- **Verification:** `grep -r "onboarding/v2" packages/web/src` returns nothing; e2e passes for
  both branches; the forbidden-vocabulary test extends to `components/home`.

### U10. The owner's cell: on the draft, on the settings proposal, required when a choice rings it
- **Goal:** An emergency choice of `owner_cell` or `owner_cell_then_text` always has an E.164
  destination, and U6's forwarding text has a number to go to. Today the first screen's cell is
  optional and used only to place the metro; nothing persists it.
- **Requirements:** R4, R6
- **Dependencies:** U2
- **Files:**
  - modify `packages/api/src/onboarding/draft/contracts.ts` and `repository.ts` (store
    `owner_phone` E.164 on the draft from the first screen's cell, normalised with the existing
    phone normaliser; `PUT /draft/owner-phone` to add or change it later), a migration in the
    314 range adding `onboarding_drafts.owner_phone`
  - modify `packages/api/src/onboarding/draft/approve.ts` (carry `ownerPhone` on the
    `onboarding_tenant_settings` payload so the handler writes `tenant_settings.owner_phone`;
    refuse approval with 400 `OWNER_PHONE_REQUIRED` when the resolved emergency choice rings
    the owner and the draft has no number)
  - modify `packages/web/src/components/onboarding/v3/ReadbackCard.tsx` and
    `ConversationShell.tsx` (when the number is missing and needed, the read-back asks "Which
    number should I ring in an emergency?" above "That's right", one typed field, server-side
    validation; the first screen's cell stays optional)
  - tests: `packages/api/test/onboarding/draft/owner-phone.test.ts`,
    `packages/api/test/integration/onboarding-draft-owner-phone.test.ts`, the v3 shell tests
- **Approach:** The API half (the column, `PUT /draft/owner-phone`, the payload field and the
  gate) ships in the S1 follow-ups PR; the read-back prompt ships with S4. The cell is a fact
  about the owner, not a choice, so it lives on the draft and
  travels on the settings proposal like the business name; the emergency card never promises a
  ring that cannot happen. Approval, not staging, is the gate, so the owner can answer the seven
  cards first and supply the number at the read-back.
- **Patterns to follow:** `onboarding/draft/approve.ts` (`TIMEZONE_REQUIRED`), the identity
  step's owner-phone normalisation in `routes/onboarding.ts`.
- **Test scenarios:**
  - Happy path: cell on the first screen → draft has it → approve → `tenant_settings.owner_phone`
    set; no cell, emergency choice `owner_cell` → approve 400 `OWNER_PHONE_REQUIRED` → read-back
    asks → `PUT /draft/owner-phone` → approve succeeds.
  - Edge: no cell and an emergency override that rings nobody → approve succeeds; a non-E.164
    value → 400 naming the field.
  - Integration: the column round-trips under RLS and the payload reaches the handler.
- **Verification:** no tenant can approve an owner-ringing emergency choice without a number on
  file, and the number the owner typed is the one the hand-off rings.

### U9. Whole-draft undo, execution tracking and retry
- **Goal:** "Saving, tap to undo" is one tap that undoes the whole approval, and onboarding does
  not move past the saving screen until every generated proposal has executed.
- **Requirements:** R3
- **Dependencies:** U2
- **Files:**
  - modify `packages/api/src/routes/onboarding-draft.ts` (`POST /draft/undo`, `POST /draft/retry`),
    `packages/api/src/onboarding/draft/approve.ts` (undo and retry helpers),
    `packages/api/src/onboarding/draft/repository.ts` (reuse the draft `FOR UPDATE` read U11 adds),
    `packages/api/src/proposals/proposal.ts` and `pg-proposal.ts` (`ProposalRepository` gains a
    locking read of a proposal set by id, ordered, `FOR UPDATE`; the in-memory repo implements
    it as a plain ordered read),
    `packages/api/src/onboarding/load-facts.ts` and `derive-status.ts` (the `draft` fact gains
    `execution: 'pending' | 'executing' | 'executed' | 'failed'`, derived from the generated
    proposals' statuses)
  - modify `packages/web/src/components/onboarding/v3/ConversationShell.tsx` (undo button during
    the window; the wait screen holds while `execution !== 'executed'`; on `failed`, "Something
    didn't save. Try again." → retry)
  - tests: `packages/api/test/onboarding/draft/undo.test.ts`,
    `packages/api/test/onboarding/derive-status.test.ts` (extend),
    `packages/api/test/integration/onboarding-draft-undo.test.ts`, the v3 shell tests
- **Approach:** The derived `execution` fact and `POST /draft/retry` ship in the S1 follow-ups
  PR; undo ships in S4. `POST /draft/undo` runs in one tenant transaction that locks, then decides,
  then writes. It takes `SELECT … FOR UPDATE` on the draft row and then on the proposals in
  `proposal_ids` (ordered by id, so two undos cannot deadlock), and requires EVERY locked row
  to still be `approved` and inside the undo window (`isInUndoWindow`, read from the locked
  row). If any row is `executing`, `executed`, `execution_failed` or `undone`, if any window
  has closed, or if a listed proposal is missing, it refuses with 409 and a typed reason
  (`DRAFT_UNDO_REFUSED` naming the offending statuses, or `UNDO_WINDOW_CLOSED`), changes
  nothing, and the shell says so; the inbox's per-proposal undo remains for the executed case.
  Only then does it revert the whole set with the transition `POST /api/proposals/:id/undo`
  makes (`approved → undone`), return the draft to `'draft'` with `proposal_ids = []`, and
  emit `onboarding.draft_undone`. The lock is what closes the race at the five-second
  boundary: the worker claims a row with `UPDATE … WHERE id = $1 AND status = 'approved'`
  (`claimForExecution`), so a claim that arrives while undo holds the locks waits and then
  matches nothing because the rows are `undone`, and a claim that committed first shows as
  `executing` to the locked read and refuses the undo. The draft cannot reopen while a
  generated proposal is applying or has applied.
  `POST /draft/retry` moves each of the set's `execution_failed` proposals along the only path
  `proposals/lifecycle.ts` allows (`execution_failed → draft`, then approved again with a fresh
  `approvedAt`), in one request transaction with a `proposal.retried` audit row, so the
  worker's `approved` sweep picks them up after a fresh undo window; it emits
  `onboarding.draft_retry`. The execution state is derived, never stored.
- **Patterns to follow:** `routes/proposals.ts` undo handler and `proposals/lifecycle.ts`,
  `workers/execution-worker.ts` retry semantics, D-039/D-040.
- **Test scenarios:**
  - Happy path: approve → undo inside the window → every proposal reverted, settings untouched,
    draft `'draft'` and editable again, one audit row.
  - Edge: any one proposal `executing`, `executed` or `execution_failed` (one case each) →
    409 `DRAFT_UNDO_REFUSED`, no row changed, draft still `approved`; the window closed on one
    row → 409 `UNDO_WINDOW_CLOSED`, nothing changed; approve → all executed → fact `executed`
    and the shell moves to billing.
  - Race (the five-second boundary, two real connections): (a) the worker's
    `claimForExecution` arrives after undo has locked the set → the claim blocks, undo commits,
    the claim returns null, no handler runs and the draft is `'draft'`; (b) the claim commits
    first → undo reads `executing`, refuses with 409, the draft stays `approved` and the
    executing proposal finishes untouched. Never: draft `'draft'` while any generated proposal
    is `executing` or `executed`.
  - Error: one proposal `execution_failed` → fact `failed`, the shell holds and offers retry;
    retry moves that one only through `draft → approved` with a new `approvedAt` (the others
    untouched), it executes after the fresh window, and the fact is `executed`.
  - Integration: real Postgres rows for the undo and for the mixed-status set.
- **Verification:** no owner reaches the trial turn with a generated proposal unexecuted, one
  tap inside the window undoes the whole approval, and a tap that loses the race to the worker
  changes nothing.

### U11. Approval compare-and-swap and row lock
- **Goal:** "That's right" approves exactly the choices the owner was looking at, exactly once.
  A choice `PUT` racing an approval cannot change what is executed, and two concurrent
  approvals cannot both mint a proposal pair. Closes the gap S1 shipped with (see U2).
- **Requirements:** R3
- **Dependencies:** U2 (S1, merged). Ships early, in the "S1 follow-ups" PR together with U10's
  API half and U9's execution fact and `POST /draft/retry` (see the slice table); U9's undo
  reuses the locked read.
- **Files:**
  - modify `packages/api/src/onboarding/draft/contracts.ts` (`ApproveDraftBodySchema`:
    `{ expectedVersion? }`, a positive integer, optional until every client sends it, strict) and
    `packages/shared/src/contracts/onboarding-draft.ts` (`ApproveOnboardingDraftBodySchema`),
    kept equal by `packages/api/test/onboarding/draft/wire-contract.test.ts` (extend)
  - modify `packages/api/src/onboarding/draft/repository.ts` (`getForUpdate(tenantId)`: the
    draft `SELECT … FOR UPDATE`; `markApproved(tenantId, proposalIds, expectedVersion)` becomes
    `UPDATE … WHERE id = $1 AND status = 'draft' AND version = $2` and throws
    `DraftVersionConflictError` or `DraftAlreadyApprovedError` when it matches nothing instead
    of returning the existing row; the in-memory repository mirrors both)
  - modify `packages/api/src/onboarding/draft/approve.ts` (`approveDraft` takes
    `expectedVersion`, locks first, and builds from the locked row)
  - modify `packages/api/src/routes/onboarding-draft.ts` (`POST /draft/approve` validates the
    body and drops its own unlocked pre-read; maps `DraftVersionConflictError` to 409
    `VERSION_CONFLICT`, the code `PUT /draft/choices/:settingKey` already uses; an already
    approved draft stays the idempotent 200 `approvedNow: false` with the stored ids)
  - modify `packages/web/src/lib/onboardingDraftApi.ts` and
    `packages/web/src/hooks/useOnboardingDraft.ts` (`approve` sends the draft's `version`)
  - tests: `packages/api/test/onboarding/draft/approve.test.ts` (extend),
    `packages/api/test/routes/onboarding-draft.route.test.ts` (extend),
    `packages/api/test/integration/onboarding-draft-approve-concurrency.test.ts`,
    `packages/web/src/hooks/useOnboardingDraft.test.ts` (extend)
- **Approach:** `POST /draft/approve` takes `{ expectedVersion }`, the `version` of the draft
  the read-back was rendered from. The first statement of the approve transaction is
  `getForUpdate`. `withTenant` reuses the request-scoped client, so the row lock is held until
  the response commits or rolls back, and every other writer of the row waits behind it:
  `stageChoice` and `setClientTimezone` already take `FOR UPDATE` first, so a `PUT` that
  arrives during an approval blocks, then finds the draft approved and gets `DRAFT_APPROVED`;
  a `PUT` that took the lock first has bumped `version`, so the approval gets
  `VERSION_CONFLICT`. Under the lock, in this order: no row → 404; `status = 'approved'` → 200
  `{ approvedNow: false }` with the ids the row already carries, whatever the version (a double
  tap or a retry after a lost response is a success, as S1 shipped); `expectedVersion` present
  and `<>` the row's `version` → 409 `VERSION_CONFLICT` naming expected and found. Neither path
  mints anything. A missing `expectedVersion` is accepted while older clients post `{}`: the
  row lock alone already serialises `PUT` against approve and approve against approve; S4 makes
  the field required once the web (S2) and mobile send it. Only then does `buildDraftProposals` run, from the
  locked row and never from an earlier read, followed by the mint, the batch approve and the
  `failed.length` gate exactly as U2 describes. `markApproved` is the second guard, not the
  first: `UPDATE … WHERE id = $1 AND status = 'draft' AND version = $2`, and zero rows throws,
  so a response and a draft row can never name different proposal ids. Any throw is a ≥ 400,
  and the request transaction rolls back the minted proposals and their approvals. Inside one
  transaction the lock makes that branch unreachable; it stays so the guarantee does not rest
  on every future caller remembering the lock, and the in-memory repository enforces the same
  predicate. Web: `useOnboardingDraft.approve` reads the version from the draft at run time (the
  hook's write queue already serialises it behind staged choices) and sends it. It already
  re-reads on a 409; a `VERSION_CONFLICT` shows the existing one-line "your answers changed
  somewhere else" notice and the owner re-taps on the refreshed read-back (U3 renders it). A
  repeat tap or a retry after a lost response gets the idempotent 200 and the shell moves on
  to "Saving" with the ids it carries.
- **Patterns to follow:** `stageChoice` in `onboarding/draft/repository.ts` (lock, then
  compare, then write), U9's lock-then-decide-then-write undo, and
  `test/integration/onboarding-draft-repository.test.ts` for real-connection setup.
- **Test scenarios:**
  - Happy path: stage choices, approve with the draft's current version → two proposals, draft
    `approved`, `version` up by one, one `onboarding.draft_approved` row (U2's happy path, now
    with the version sent).
  - Edge (stale version): `expectedVersion` behind the row (a `PUT` landed after the read-back
    rendered) → 409 `VERSION_CONFLICT`, zero proposal rows, draft still `'draft'` with its
    choices as the `PUT` left them, no `draft_approved` audit row; `expectedVersion` ahead of
    the row → the same; a non-integer `expectedVersion` → 400 naming the field; a missing one is accepted (the
    lock still serialises the writers) until S4 makes it required.
  - Edge (already approved): approve again with any version → 200 `approvedNow: false` with the
    same two ids, still exactly two proposal rows for the tenant and no new audit row.
  - Race, `PUT` vs approve (two real connections, both orders): (a) the `PUT` takes the lock
    and commits first, then the approve that carries the pre-`PUT` version → `VERSION_CONFLICT`,
    no proposals, the staged choice is on the draft; (b) the approve takes the lock first and
    commits, and the `PUT` that was waiting → `DRAFT_APPROVED`, and the draft's resolved choices
    equal, field by field, the payloads of the two proposals that executed. Never: a proposal
    payload that differs from the committed draft's resolved choices.
  - Race, approve vs approve (two connections, same `expectedVersion`, repeated in a loop so
    ordering luck cannot pass it): both return 200, the first with `approvedNow: true` and the one that waited behind the
    lock with `approvedNow: false`; afterwards exactly one pair of `onboarding_*` proposals
    exists for the draft (counted by `source_context.draftId`), its ids equal the draft's
    `proposal_ids`, and both responses carry those same ids.
  - Unit: `markApproved` with a stale version, or on a non-`draft` status, throws and writes
    nothing, identically in the Pg and in-memory repositories; `approveDraft` builds from the
    row `getForUpdate` returned (a repo double that changes the row after an earlier read proves
    the earlier read is unused).
  - Web: `approve` sends the hook's current version; a 409 `VERSION_CONFLICT` re-reads and sets
    the notice; a repeat approve resolves as success with the same ids and leaves no error; a double tap
    sends one request.
  - Integration: all of the races above on real Postgres under RLS, in
    `packages/api/test/integration/`, as CLAUDE.md requires for a DB-touching change.
- **Verification:** no interleaving of choice writes, a timezone write and one or more
  approvals yields proposals that differ from the approved draft's resolved choices, or more
  than one proposal pair per draft.

### U8. Runtime consumers for the policy keys the cards write
- **Goal:** Every card's promise is behaviour, not a stored value. `payment_collection_mode`
  decides whether an issued invoice goes out with a pay link ("Text them a pay link") or is
  marked collect-on-site with no link ("Collect on the spot"), and what Rivet answers when a
  caller asks how to pay; `emergency_target` decides the emergency hand-off (owner cell, or
  owner cell then a text) in the voice hand-off path. Switching to collect-on-site also retires
  the pay links already minted or texted, so the policy holds for old URLs as well as new ones.
- **Requirements:** R2
- **Dependencies:** U2
- **Files:**
  - modify `packages/api/src/invoices/invoice-payment-link.ts` and the invoice send path in
    `packages/api/src/invoices/payment.ts` (read `paymentCollectionMode` from settings; no
    link and a collect-on-site note when `collect_on_site`), and every customer-facing path
    that mints or shows a pay link, which must honour the same mode: `POST
    /public/invoices/:token/checkout` and `PublicInvoiceService.getOrCreateCheckoutUrl`
    (`packages/api/src/routes/public-invoices.ts`, `invoices/public-invoice-service.ts`) and
    the portal's link generation in `packages/api/src/routes/public-portal.ts` (refuse with
    409 `COLLECT_ON_SITE`, and omit the pay button from the public invoice and portal pages)
  - the mode-change path: create `packages/api/src/invoices/payment-mode-change.ts`
    (`onPaymentCollectionModeChanged`, called after the write by both write sites of the key,
    the `onboarding_voice_policy` handler in `proposals/execution/onboarding-handlers.ts` and
    `PATCH /api/settings` in `routes/settings.ts`) and
    `packages/api/src/workers/deactivate-payment-links.ts` (the queue handler, registered in
    `app.ts`); modify `packages/api/src/invoices/invoice-payment-link.ts` (a
    `payment_mode_changed` reason on `deactivateInvoicePaymentLink`),
    `packages/api/src/payments/payment-link-provider.ts` and `stripe-payment-link.ts`
    (`deactivateLink` accepts an optional customer-facing inactive message), and
    `packages/api/src/invoices/invoice.ts` with `pg-invoice.ts` (`InvoiceRepository` gains
    `findOpenWithPaymentLink(tenantId, afterId, limit)`)
  - modify the voice answer for payment questions and the emergency hand-off in
    `packages/api/src/voice/` (exact modules named at implementation; patterns:
    `voice/triage/context-preface.ts`, `voice/call-me-back/call-me-back.ts`)
  - tests: `packages/api/test/invoices/payment-collection-mode.test.ts`,
    `packages/api/test/workers/deactivate-payment-links.test.ts`,
    `packages/api/test/voice/emergency-target.handler.test.ts` (mocked gateway/repos),
    `packages/api/test/integration/payment-collection-mode.test.ts`,
    `packages/api/test/integration/payment-link-mode-switch.test.ts`
- **Approach:** Read both keys through `SettingsRepository` at the point of behaviour. The
  default (pay link; owner cell) applies only to a read that succeeds and finds the key unset
  (D-039/D-040: an absent key means the default), so tenants that never answered the cards are
  unchanged. A read that throws is not an unset key; see Read failures. Audit the invoice send
  with the mode used.
- **Read failures.** For `payment_collection_mode`, an error never becomes `pay_link`: a
  failed read is no evidence of the approved policy, and defaulting would mint or send a
  checkout link for an owner who chose "Collect on the spot". The consumer fails closed on the
  link and open on delivery. An invoice that is otherwise due to go out still goes out, with no
  link minted, none stored, none in the message, and no pay button on the public invoice or
  portal page; `POST /public/invoices/:token/checkout` answers 503 `PAYMENT_MODE_UNAVAILABLE`
  (retryable, distinct from the policy refusal 409 `COLLECT_ON_SITE`). Each occurrence is logged
  and audited as `invoice.payment_mode_unavailable` (reason `payment_mode_unavailable`) with the
  invoice id and the surface (send, public page, portal, checkout). Nothing is cached across the
  failure: the next send or page open reads again, and a link is minted, on demand by the
  existing pay-now flows, only after a read that succeeds and says `pay_link`. For
  `emergency_target` a failed read falls back to ringing the owner's cell, the one choice that
  still reaches a person, and records the same kind of event.
- **Mode change.** `payment_collection_mode` is mutable (U2), and a Stripe Payment Link is a
  direct hosted URL: invoices persist it (`stripe_payment_link_url`), customers receive it by
  text, and it stays chargeable until it is deactivated at Stripe. Hiding the button, or
  switching the mode, does not disable it. The invoice lifecycle already deactivates such links
  when an invoice leaves the payable world (`deactivateInvoicePaymentLink` in
  `invoices/invoice-payment-link.ts`: voided, canceled, settled, repriced); U8 adds the same for
  a policy change. After the write, both write sites call one function; when the stored value
  moved from `pay_link` or unset to `collect_on_site` it enqueues a `deactivate_payment_links`
  job (`{ tenantId }`, idempotency key `deactivate-payment-links:<tenantId>:<settings
  updated_at>`) on the queue, the P0-009 async-worker pattern `provision-twilio` uses. No Stripe
  call therefore runs inside a settings request or a proposal execution, and a Stripe outage
  cannot fail a settings write. The handler re-reads the mode first and does nothing if it is
  no longer `collect_on_site` (the owner switched back before the job ran). Otherwise it pages
  through the tenant's `open` and `partially_paid` invoices that hold a link
  (`findOpenWithPaymentLink`) and calls `deactivateInvoicePaymentLink` on each with the new
  reason `payment_mode_changed`. That helper deactivates the link at Stripe under whichever
  account scope minted it, clears the columns only while they still hold that link, and audits
  each invoice (`invoice.payment_link_deactivated`, or `_deactivation_failed` with the columns
  kept); one tenant-level event records the counts. If any invoice failed, the job throws after
  the batch so the queue retries only what is left: a cleared invoice no longer qualifies,
  which is also what makes a re-run safe. The job schedules one more pass of itself two minutes
  later (`delaySeconds`) to catch a link whose mint read `pay_link` just before the switch
  committed. Switching back to `pay_link` needs nothing: the pay-now flows mint a fresh link on
  demand once the columns are empty.
- **What an already-sent link shows.** The deactivation call also sets the link's customer-
  facing inactive message at Stripe (the Payment Link `inactive_message` field, sent in the same
  update as `active: false`): "{businessName} collects payment in person. Please settle up with
  {ownerFirstName} when the work is done." A customer who opens a text from last week then reads
  "pay on site", not a generic dead-link page. Confirm the field on the pinned Stripe API
  version at implementation; if it is unavailable, the hosted page is Stripe's own inactive
  page, and the invoice text and public invoice page (which U8 already switches to the
  collect-on-site message) carry the explanation. PaymentIntents from a pay page that was
  already open are outside this job: they are not standing URLs, and
  `cancelInvoicePaymentIntents` exists if the founder wants them cancelled too.
- **Patterns to follow:** D-039/D-040 (absent key = default), the existing invoice send
  handlers in `proposals/execution/handlers.ts`, `deactivateInvoicePaymentLink` in
  `invoices/invoice-payment-link.ts` (best-effort, audited, CAS clear), and
  `workers/provision-twilio.ts` (a queue handler with an idempotent enqueue).
- **Test scenarios:**
  - Happy path: `collect_on_site` → issued invoice has no pay link and the customer message
    says the tech collects on site; the public invoice page and portal show no pay button and
    `POST /public/invoices/:token/checkout` answers 409; `pay_link` → unchanged behaviour.
    `owner_cell_then_text` → hand-off rings the owner, then texts on no answer.
  - Edge: key unset (a successful read of an absent key) → `pay_link` and the owner cell, so
    an unanswered tenant is unchanged; set to `collect_on_site` → no link minted, none stored,
    none in the message; mode changed between issue and send → the value at send time wins,
    audited.
  - Error (read failure): the settings read throws → delivery continues where it would have,
    but the Stripe provider fake is never called, no link is stored or put in the message, the
    public invoice and portal pages render no pay button, `POST /public/invoices/:token/checkout`
    answers 503 `PAYMENT_MODE_UNAVAILABLE`, and `invoice.payment_mode_unavailable` is audited
    (assert the error is never read as `pay_link`); the next send after the read recovers mints
    a link only when the mode says `pay_link`. `emergency_target` read error → the owner's cell
    is rung and the event recorded.
  - Mode change (links deactivated on switch): a tenant with an `open` and a `partially_paid`
    invoice that each hold a link, plus a paid invoice with cleared columns; the
    `onboarding_voice_policy` handler writes `collect_on_site` over `pay_link`, and separately
    `PATCH /api/settings` does → one job enqueued per switch. Running it deactivates exactly the
    two live links (the provider fake receives `deactivateLink` with the minting account scope
    and the inactive message), clears their columns, and audits one
    `invoice.payment_link_deactivated` per invoice with reason `payment_mode_changed`; the paid
    invoice is untouched.
  - Mode change (no-op when none): a tenant with no live links → the job succeeds, the provider
    is not called, no per-invoice events; a switch back to `pay_link` before the job runs → the
    job re-reads the mode and does nothing; a switch from unset, or `collect_on_site` written
    over `collect_on_site`, enqueues nothing.
  - Mode change (idempotent re-run): running the job twice, and enqueueing it twice under one
    idempotency key, makes no second provider call and writes no second audit row for an
    invoice already cleared; one invoice whose Stripe call fails keeps its columns and is
    audited as failed, the others are still deactivated, the job throws, and the retry touches
    only the failed one; a link minted by a racing request just after the first pass is
    deactivated by the delayed second pass.
  - Integration: a tenant with `collect_on_site` issues an invoice against real Postgres and the
    stored message carries no link; `findOpenWithPaymentLink` returns only `open` and
    `partially_paid` rows that hold a link, tenant-scoped under RLS and paged.
- **Verification:** picking a card changes what the customer receives and what Rivet says, with
  a behaviour test per key, before the card copy is allowed to promise it; a pay link texted
  before a switch to collect-on-site no longer charges once the job has run; and a failed mode
  read never produces a link.

### U7. Pre-signup "hear it answer" demo call (decision-gated)
- **Goal:** A visitor enters a cell and trade on the landing page, receives a sixty-second
  call answered as their business that books a sample job, then a signup text.
- **Requirements:** R1 (value before identity)
- **Dependencies:** U2, U4; voice-parity U3 for the preset voice on the call
- **Files:**
  - modify `packages/api/src/integrations/credentials.ts` (explicit `PLATFORM_TWILIO_*`)
  - create `packages/api/src/demo/{routes,service,script,lease,reset}.ts`, migration
    `313_demo_calls` (phone hash, trade, name, call_sid, status, lead_id; no `tenant_id`); the
    same migration adds `demo_tenant_leases` (see Approach) and
    `tenants.demo BOOLEAN NOT NULL DEFAULT false`
  - create the demo tenant pool per trade, each tenant cloned from that trade's fixture, via a
    seed script `packages/api/scripts/seed-demo-tenants.ts` (idempotent; pool size
    `DEMO_POOL_PER_TRADE`, default 3)
  - create `packages/api/src/workers/demo-lease-reaper.ts` (a leader-gated P0-009 sweep that
    reclaims expired leases and finishes interrupted resets); extract the `information_schema`
    table walk that `tenants/deprovision.ts` uses to purge a tenant into a shared helper that
    `demo/reset.ts` reuses
  - modify every sweep and report that lists tenants so it excludes `tenants.demo` (found by
    grepping `FROM tenants` and the tenant lister under `workers/`, `billing/`, `analytics/`
    and `metrics/`; at least `workers/setup-reminder-sweep.ts`, `trial-reminder-sweep.ts`,
    `dunning-sweep.ts`, `money-reconciliation.ts`, `overage-settlement-reconciliation.ts` and
    `billing/call-usage-billing.ts`), and the platform-admin tenant list
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
  - tests: `packages/api/test/demo/{service,routes,limits,lease,reset}.test.ts`,
    `packages/api/test/integration/demo-calls.test.ts`,
    `packages/api/test/integration/demo-tenant-leases.test.ts`,
    `packages/api/test/integration/demo-tenants-excluded.test.ts`, `e2e/hear-it-answer.spec.ts`
- **Approach:** The outbound leg dials the visitor from the platform number and connects it
  to the real inbound turn processor running against a demo tenant leased to that one call, so
  the visitor hears exactly what customers will, and no one else's details. A canned
  `<Say>/<Gather>` script is the fallback if the demo tenant pool proves awkward.
- **One live call per tenant.** The turn processor writes real rows (sessions, messages, a
  booking, proposals, a customer), so two concurrent visitors on one tenant would hear each
  other's details and land jobs on a shared account, and the per-number rate limit does nothing
  about that. Isolation is a lease, not a limit. Per trade there is a small pool of demo
  tenants (`tenants.demo = true`, each cloned from the trade's fixture). Every call takes
  exactly one, as the first write of the request, by inserting a `demo_tenant_leases` row
  (`id`, `tenant_id`, `visitor_phone_hash`, `call_sid`, `leased_at`, `expires_at`,
  `released_at`) in one transaction: the tenant is picked `FOR UPDATE SKIP LOCKED` among the
  trade's demo tenants with no active lease, and a partial unique index on `tenant_id WHERE
  released_at IS NULL` is the backstop, so two callers can never hold one tenant (a second, on
  `visitor_phone_hash` under the same predicate, stops one visitor holding two). `expires_at`
  is the call start plus the longest a demo can run: the call is created with a Twilio ring
  `Timeout` of 30 s and a `TimeLimit` of 90 s, and the lease adds 30 s of grace, 150 s in all,
  so a lease cannot lapse under a live call. The inbound turn processor gets its tenant from the
  lease found by the call's `call_sid`, never from a trade-level lookup. `call_sid` is filled
  in once Twilio creates the call; a Twilio failure releases the lease at once.
- **Release and reset.** The call-status callback (completed, failed, busy, no-answer,
  canceled) and the reaper (every 30 s, for leases past `expires_at`) run the same reset and
  only then set `released_at`, so the lease stays active, and the tenant unleasable, until the
  tenant is clean. Reset deletes the tenant's rows from every table that carries a `tenant_id`
  (the deprovision table walk, so a table added later is purged by default) except the tenant
  row and an explicit keep-list, which holds the append-only audit trail (it stays, flagged by
  `tenants.demo`), and deletes the tenant's stored objects the way a purge does; then it
  re-seeds settings, catalog and templates from the fixture with the clone function the seed
  script uses. A reset that fails leaves the lease active, alerts, and is retried by the
  reaper: that tenant stays out of the pool and is never leased dirty.
- **Pool exhausted.** When no demo tenant of the trade is free, the request is refused up front
  with 503 `DEMO_BUSY` and the page says "Every line is busy. Try again in a minute."; nothing
  is written (no lease, no `demo_calls` or lead row, no call, and the visitor's one-call-a-day
  allowance is not spent). A call that is answered after its lease was reclaimed speaks the
  same line and hangs up, again writing nothing. Pool size is the concurrency ceiling; the kill
  switch and the daily spend cap still apply.
- **Never visible to owners.** Demo tenants have no `users` rows, no Clerk organisation, no
  Stripe customer or subscription and no Twilio subaccount, so no owner, dispatcher or billing
  surface can reach one. Every sweep, report and analytics query that lists tenants excludes
  `tenants.demo`, funnel and product analytics drop events from demo tenants, and the
  platform-admin tenant list hides them behind an explicit filter.
- **Consent, limits, handoff.** Consent line first; two-layer rate limits; daily spend cap;
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
  - Error: Twilio 5xx → row `status='failed'`, lease released, no SMS, no lead; handoff token reused or
    expired → ignored, the shell asks for name and trade.
  - Isolation (two concurrent callers get distinct tenants): two real connections leasing for
    the same trade, repeated in a loop → distinct demo tenants, and rows one call wrote are not
    visible under the other's tenant; a pool of N with N+1 concurrent callers → exactly one is
    refused.
  - Isolation (exhausted pool refuses without writes): all of a trade's demo tenants leased →
    503 `DEMO_BUSY` with the busy copy, and no lease, `demo_calls`, lead or SMS row, no call
    placed, the visitor's daily allowance unspent; a call answered after its lease was
    reclaimed speaks the busy line, hangs up and writes nothing.
  - Isolation (reset on release): after a call that created a session, messages, a booking, a
    proposal and a customer, release → every `tenant_id` table is back to a freshly cloned
    tenant's row counts (audit excepted) and settings, catalog and templates equal the
    fixture; the lease is released only after the reset; a failing reset keeps the lease active
    and the tenant out of the pool until the reaper's retry succeeds.
  - Isolation (expired lease reclaimed): a lease past `expires_at` with no status callback →
    the reaper resets, releases and the tenant is leasable again; an unexpired lease is never
    reclaimed.
  - Integration: `demo_calls` has no `tenant_id` and is not subject to RLS; rate limiter keyed
    to the sentinel tenant persists across restarts; `demo_tenant_leases` rejects a second
    active lease on one tenant (and on one visitor hash) at the partial unique index; a demo
    tenant with an open invoice, an expired trial and an unfinished setup is selected by no
    tenant-listing sweep or report, and a guard test fails when a `FROM tenants` listing under
    `workers/` or `billing/` neither filters `demo` nor is allow-listed.
- **Verification:** cost per completed demo call measured in staging before the landing CTA
  ships; a staging run of concurrent demo calls on one trade shows distinct tenants and a clean
  tenant after each; founder decision recorded in `docs/decisions.md`.

## Risks & Dependencies

- **Two sources of truth (draft vs proposals).** The draft is the only pre-approval state;
  mint and approve happen in one transaction that locks the draft row and checks
  `expectedVersion` (U11, closing the unlocked approve S1 shipped), and `version` CAS rejects
  stale tabs on choice writes.
- **Browser voice on real devices.** Tap is first-class everywhere, `answer_mode` is measured
  per turn, U4 spikes WebKit before U3 depends on it.
- **Regional prices wrong or read as advice.** Founder-curated rows, "typical" copy, prices
  land only through approval and remain editable catalog items.
- **Status contract drift.** Additive facts only; `.length(7)` preserved; pinned by extending
  `packages/api/test/onboarding/derive-status.test.ts` and the integration status test.
- **Demo call cost, abuse, TCPA, cross-visitor leakage.** Phased last, consent first, two-layer
  limits, kill switch, spend cap; every live call holds its own demo tenant by lease and the
  tenant is reset before anyone else can lease it (U7).
- **Stale pay links after a policy switch, and a failed mode read.** A texted Stripe Payment
  Link stays chargeable until deactivated, so switching to collect-on-site queues deactivation
  of every live link on open invoices; a failed read of the mode never defaults to `pay_link`
  (U8).
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
| S1b | U11 + U10 (API half) + U9 (execution fact, retry) | "S1 follow-ups" PR against `main`, in flight: approval row lock with optional `expectedVersion`; `owner_phone` on the draft, `PUT /draft/owner-phone`, the owner cell on the settings payload and the `OWNER_PHONE_REQUIRED` gate; `draft.execution` on the status and `POST /draft/retry`. The web consumers (send the version, ask for the cell, show a failed execution and retry) follow on S2. | 2 days |
| S3 | U4 | Server-voice TTS with clip cache, first/second matcher, barge-in, WebKit coverage. | 4-5 days |
| S4 | U5 + rest of U9 + rest of U10 | Free-speech override, setting-key routing for the read-back mic, metro change (`PUT /draft/metro`); whole-draft undo (row-locked, all-or-nothing) on U11's locked read; the read-back's owner-cell prompt; `expectedVersion` made required once every client sends it. | 4-5 days |
| S5 | U6 + U8 | Eighth turn (existing number) and day-one branch, number flow with claim re-search, forwarding text with owner confirmation and probe, forwarding answers on the draft and the settings proposal, seeded-price baseline with legacy backfill and the re-run repricing gate, first-day home, runtime consumers for `payment_collection_mode` and `emergency_target` (pay links deactivated on a switch to collect-on-site, no link on a failed mode read), flag flipped, v2 deleted. | 9-11 days |
| S6 | U7 | Pre-signup demo call (founder decision first), with a leased pool of demo tenants per trade, reset before reuse and excluded from owner, billing and analytics surfaces. | 7-10 days |

Serial by construction: one engineer, nine to twelve weeks for S1-S5; S6 adds about two. A
second engineer shortens S2 and S3 only where the API they depend on is already merged.

Per-slice definition of done: failing tests written first; `npx tsc --project
tsconfig.build.json --noEmit` clean in `packages/api`; unit, integration
(`npm run test:integration`) and the relevant Playwright spec green; the API verify skill
(`Serviceos/packages/api:verify`) or web verify skill (`Serviceos/packages/web:verify`) run
against the slice; dead code removed; funnel events documented in `FUNNEL.md`.
