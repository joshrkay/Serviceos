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
  still holds the price the seeder set, and a row that moves takes the new pick as its
  baseline in the same statement that writes its price, so a second re-run still sees an
  untouched seed; anything the owner has edited is left alone, and the read-back says which
  happened ("Your labor rate is yours; I left it"). Knowing which rows
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
  tenant), consent, rate limits and a reserved daily budget. Screen 7's
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
- Custom per-day booking hours. The `booking_hours` choice speaks only the three presets
  `ChoiceWritesSchema` allows (`weekdays_7_5`, `mon_sat_7_5`, `any_time`), and the free-speech
  override maps a spoken schedule onto one of them or asks the owner to confirm the closest
  (U5). Weekdays plus Saturday mornings, split shifts, seasonal hours and the like wait for a
  validated `customBusinessHours` payload on `onboarding_voice_policy` and a settings consumer
  that reads it; until both exist, nothing stages hours the contract cannot hold.

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
  `onboarding.draft_approved`, `onboarding.owner_phone_set` (number masked) and
  `onboarding.draft_retry` (both S1b), plus the existing proposal lifecycle events (S1b adds
  `proposal.retried`). S4 adds `onboarding.draft_undone` and `onboarding.draft_reset` (U9).
  U8 adds `invoice.payment_mode_unavailable` and reuses
  `invoice.payment_link_deactivated` with the reason `payment_mode_changed`. U7 adds
  `demo_job_dropped` (a queued job refused by the lease-generation check),
  `demo_write_rejected` (a write refused by the same check inside its own transaction),
  `demo_inflight_reaped` (a stale in-flight registry row removed), `demo_callsid_mismatch`
  (a validly signed callback, or the `Calls` response, presenting a second CallSid for a
  lease) and `demo_budget_alert` (the daily call budget reaching 80% of a cap, or filling one).
- **Integer cents:** tier prices, trip fee and hourly rate are cents end to end; the price
  multiplier is applied in integer arithmetic with explicit rounding in one function.
- **tenant_id + RLS:** `onboarding_drafts` carries `tenant_id` with RLS like
  `onboarding_session` (migration 195). `regional_price_tiers` and `demo_calls` are
  platform tables with no `tenant_id`, admin-write only, the same posture as `tenants`;
  `demo_call_budget` (U7; one row per UTC day, no `tenant_id` at all), `demo_tenant_leases`
  and `demo_inflight_jobs` (U7) are the same kind of platform table, and the last two's
  `tenant_id` only names the demo tenant a call or a running job holds.
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
  proposal has executed (a set that failed, stopped or was part-undone from the inbox goes
  through U9's retry or `POST /draft/reset` first, never a reopen); it re-assembles for the
  current trade and metro, pre-fills `choices`
  from the live settings (greeting → override label; the enum keys → the option whose writes
  match; prices → the current headline items, repriced only while the tenant still has a
  seeded baseline, U6; the owner's cell → the live `tenant_settings.owner_phone`, copied onto
  the draft's `owner_phone` (U10) even when it is null, so a number the owner has since
  changed or cleared in Settings replaces the one the draft captured at the first run and
  U10's `ownerPhone` payload field cannot write the old number back over the newer edit),
  resets `status='draft'`, `proposal_ids=[]`,
  bumps `version`, and emits `onboarding.draft_reopened`. The pre-fill and the cell are read
  from `tenant_settings` inside reopen's own locked write, before the read-back is shown. The
  read-back then shows what is
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
  draft-only `existing_number` answer is never written as itself; U6 turns it into the
  settings payload's `forwarding` field), create them with surface
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
  races and leaves the repeat-tap contract alone: a repeat approve stays S1's idempotent
  no-op 200 `approvedNow: false` carrying the stored proposal ids, and U11 adds only the row
  lock and the optional `expectedVersion` check. On an already approved draft that check is
  what tells a retry of the same approval (200, as before) from a stale tab's approval (409
  `VERSION_CONFLICT`); see U11.
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
    Zod schemas; an answered `existing_number` never appears in either payload as a key (its
    effect, the settings payload's `forwarding` field, is U6's).
  - Edge: approve with choices unanswered → each takes its `mostShops` default (option A
    today), no gated proposal minted; no recorded timezone → 400 `TIMEZONE_REQUIRED`, zero
    proposal rows, draft still `'draft'`; stale `version` on PUT → 409; approve twice → second
    is a no-op 200 returning the same two ids (as S1 shipped; U11 keeps it, for a repeat that
    carries the version the draft was approved from or none, and adds the lock and the version
    check, including the 409 for a stale tab on an approved draft).
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
  `error` on the status poll. Which failure it was arrives as the step's structured
  `failureCode` (U6), and only `area_code_unavailable` makes the number turn re-search and
  offer the next candidate, "That one just went. Here's another."; every other code shows its
  own copy and never offers a new number by itself (the code-driven turn is U6's, with its
  tests)
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
    `booking_hours` (its output reaches the draft only through `matchBookingHoursPreset`,
    below), and a new `packages/api/src/ai/tasks/onboarding/choice-override-extractor.ts`
    with one Zod schema per remaining key: `greeting` as length-capped free text, and the enum
    keys `booking_posture`, `payment_collection_mode`, `emergency_target`, `after_hours_mode`
    each classified to one of that key's allowed values from `ALLOWED_WRITES_BY_KEY` or a
    clarification; `BusinessProfileExtractor` is not involved. One clarification on low
    confidence)
  - create `packages/api/src/onboarding/choices/booking-hours-match.ts`
    (`matchBookingHoursPreset`, pure: a spoken schedule becomes one of the three presets or
    `no_match`)
  - modify `packages/api/src/routes/onboarding-draft.ts` (`POST /draft/override/:settingKey`,
    `POST /draft/override` with the setting-key classifier, `PUT /draft/metro`) and
    `packages/api/src/onboarding/draft/repository.ts` (`setMetro`, a thin caller of U11's
    locked-write helper: lock, refuse once approved, compare version, bump; a metro change and
    a staged choice serialise on the same row lock)
  - modify `packages/web/src/components/onboarding/v3/OptionPairTurn.tsx`, `ReadbackCard.tsx`
    (override turn UI reusing `TranscriptCard`)
  - tests: `packages/api/test/onboarding/choices/override.test.ts` (mocked gateway; one case
    per key, all seven, plus a clarification case per enum key),
    `packages/api/test/onboarding/choices/booking-hours-match.test.ts`,
    `packages/api/test/routes/onboarding-draft.route.test.ts` (extend),
    `packages/web/src/components/onboarding/v3/OverrideTurn.test.tsx`,
    `packages/api/test/integration/onboarding-draft-writers-vs-approve.test.ts` (U11's table,
    created in S4: add the `PUT /draft/metro` row)
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

  **Booking hours: presets only, never coerced.** `ChoiceWritesSchema` carries
  `bookingHoursPreset` with three fixed values, and `onboardingVoicePolicyPayloadSchema` is
  derived from it, so a schedule outside those three cannot be staged faithfully.
  `ScheduleExtractor` can return one (weekdays plus Saturday 7-12), and storing the nearest
  preset (`mon_sat_7_5`) would let Rivet book Saturday afternoons against the owner's
  instruction. So the override never stages the extractor's schedule directly.
  `matchBookingHoursPreset(extraction)` folds it into a per-day open/close map and compares
  that, day by day, with `bookingHoursFromPreset(p)` for each preset (the function the
  voice-policy handler writes with, so the matcher and the handler cannot drift). An exact
  match returns `{ kind: 'preset', preset }` and is staged like any other override. Anything
  else returns `{ kind: 'no_match', closest, difference }`: a day or hours the schedule adds
  or drops, a day with two windows, a seasonal entry (an empty extraction stays the existing
  "what hours?" clarification). `closest` is the preset that disagrees with the spoken
  schedule on the fewest days, then on the fewest weekly minutes, a tie going to the narrower
  preset (weekdays plus Saturday 7-12 is closest to `mon_sat_7_5`, and the second sentence
  says it also covers Saturday afternoons), and nothing is staged. The
  response is `{ staged: false, clarification: { kind: 'confirm_preset', preset, question } }`
  and the question comes from one template, "Closest I have is Monday to Saturday, 7 to 5.
  That also covers Saturday afternoons. Is that right?", whose second sentence is generated
  from `difference` and names what the preset adds or leaves out. Only the owner's yes (a
  chip, or a spoken "yes") sends the confirmation, `POST /draft/override/booking_hours` with
  `confirmPreset: <preset>` (a closed enum, so the server keeps no memory of the first call),
  and that call stages `{override}` with the preset's own Rivet line, so the read-back says
  what the owner confirmed. "No" offers the three presets as chips; "Neither" falls back to
  the option pair. The confirmation is not a low-confidence clarification and does not use
  the one-question cap above. Custom per-day hours are deferred (Scope Boundaries) until a
  validated `customBusinessHours` payload and a settings consumer exist.
- **Patterns to follow:** `ai/agents/onboarding/constants.ts` thresholds,
  `ai/orchestration/onboarding-conversation.ts` extractor invocation.
- **Test scenarios:**
  - Happy path: "I charge one twenty to come out and one seventy-five an hour" → trip fee
    12000, rate 17500 cents, line rendered with those numbers; "just hold them for me, I'll call
    back" on `booking_posture` → `autonomousBookingEnabled: false`; "say Walsh, go ahead" on
    `greeting` → `voiceGreeting` set verbatim.
  - Edge: two numbers with no units → clarification question returned, nothing staged.
  - Booking hours, representable: "Monday through Saturday, seven to five" → `mon_sat_7_5`
    staged with that preset's Rivet line; "weekdays, seven to five" → `weekdays_7_5`; "any
    time, day or night" → `any_time`.
  - Booking hours, unrepresentable (never staged without confirmation): "weekdays and
    Saturday mornings" (the extractor returns Monday to Friday 7-5 plus Saturday 7-12) →
    `{ staged: false }` with "Closest I have is Monday to Saturday, 7 to 5. That also covers
    Saturday afternoons. Is that right?"; the draft's `choices.booking_hours`, its `version`
    and its audit trail are unchanged (no `onboarding.choice_staged`), and an approval taken
    now builds `onboarding_voice_policy` from the previously resolved preset, not the closest
    one. The same for weekdays 8 to 5, Saturdays in summer only (seasonal), a split shift,
    different hours on different days and a closed weekday. A table-driven test runs the
    stubbed extractor over every row and asserts no first call stages a
    `bookingHoursPreset`. "Yes" (`confirmPreset: 'mon_sat_7_5'`) stages exactly that preset
    and emits one `onboarding.choice_staged`; a `confirmPreset` outside the three values →
    400; "No" returns the three preset chips and stages nothing. Unit
    (`booking-hours-match.test.ts`): each preset's own `bookingHoursFromPreset` output
    matches itself; every row above is `no_match` with the expected `closest` and
    `difference`; a tie goes to the narrower preset.
  - Error: gateway timeout → 503 with the card unchanged; override on a key not in the
    registry → 400.
  - Metro: `PUT /draft/metro` after approval → 409 `DRAFT_APPROVED` with the draft unchanged;
    racing an approve in both orders is the metro row of U11's writer-vs-approve race test.
  - Integration: none beyond U2's draft tests and that race row (no new tables).
- **Verification:** an owner can override any of the seven settings by voice and see the
  change in the read-back before approving; hours the three presets cannot hold are either
  confirmed against the closest preset or not staged at all.

### U6. Day-one branch, number flow, forwarding by text, first-day home, retire v2
- **Goal:** Finish the flow end to end and remove the old wizard.
- **Requirements:** R6, R9, R8
- **Dependencies:** U3
- **Files:**
  - modify `packages/web/src/components/onboarding/v3/NumberCard.tsx`, `ConversationShell.tsx`
  - the number turn's failure code: create `packages/api/src/onboarding/provisioning-failure.ts`
    (`PROVISIONING_FAILURE_CODES` = `area_code_unavailable | credentials_missing |
    provider_error | unknown`, `classifyProvisioningFailure(lastError)`, and the message
    builders for the failures `workers/provision-twilio.ts` records); modify
    `packages/api/src/workers/provision-twilio.ts` (build its `last_error` texts with those
    builders, wording unchanged), `packages/api/src/onboarding/load-facts.ts` (read the twilio
    row's `last_error` into `twilioFailureCode` instead of dropping it),
    `packages/api/src/onboarding/derive-status.ts` (a distinct phone blocker per code, and
    `failureCode` on the failed phone step) and `packages/api/src/onboarding/contracts.ts`
    (`ProvisioningFailureCodeSchema`; `failureCode` optional on the step); tests
    `packages/api/test/onboarding/provisioning-failure.test.ts`,
    `packages/api/test/onboarding/derive-status.test.ts` and `contracts.test.ts` (extend),
    `packages/api/test/integration/onboarding-status-failure-code.test.ts` (real
    `tenant_integrations` rows)
  - create migration `314_seeded_price_baseline` (`catalog_items.seeded_unit_price_cents`
    and a `seededUnitPriceCents` key on each estimate template line item inside the
    `line_item_templates` JSONB, both nullable; `tenant_settings.seeded_baseline_backfilled_at`,
    the per-tenant one-shot stamp for the backfill below) and
    `packages/api/src/packs/reprice-seeded.ts` (the re-run update path: headline items and
    template lines whose current price equals their baseline move to the new pick, and a moved
    row's baseline moves with it: price and baseline are written by the same `UPDATE`
    (`unit_price_cents` and `seeded_unit_price_cents` on a catalog item, `defaultUnitPriceCents`
    and `seededUnitPriceCents` on a template line), never in two statements; the seeder
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
    (315) adds nullable `onboarding_drafts.forwarding_source_number` and
    `forwarding_carrier`; modify `packages/api/src/onboarding/draft/contracts.ts` and
    `repository.ts` (both fields on the draft: E.164 through the existing phone normaliser, and
    the carrier enum above; staging the `existing_number` answer "no" nulls both draft columns
    in that same locked write, so the draft never holds a number beside a "no"),
    `packages/api/src/routes/onboarding-draft.ts` (`PUT
    /draft/forwarding` stages them, refused unless `existing_number` resolves to "yes", and
    written through U11's locked-write helper so it takes the row lock, is refused once the
    draft is approved and bumps `version`),
    `packages/api/src/onboarding/draft/approve.ts` (carry ONE `forwarding` field on the
    `onboarding_tenant_settings` payload, three-valued on purpose: `{ sourceNumber, carrier }`
    when `existing_number` is "yes" and both are staged, the literal `null` when it is "no"
    ("clear the line"), and no `forwarding` key at all when the question was never answered or
    "yes" has no pair yet, which means "untouched"),
    `packages/api/src/proposals/contracts/onboarding.ts` (`forwarding` optional on that
    payload's Zod schema as a union of a strict `{ sourceNumber: E.164, carrier: enum }` and
    `z.null()`, so absent and `null` stay different through validation and through the
    proposal's stored JSON), `proposals/execution/onboarding-handlers.ts`
    (`OnboardingTenantSettingsExecutionHandler`, one `SettingsRepository` write per case: a
    value writes `forwarding_source_number` and `forwarding_carrier` and, in that same write,
    nulls `forwarding_confirmed_at` and `forwarding_verified_at` whenever the source number or
    carrier differs from the stored one, so a re-run that moves the forwarding line cannot
    inherit the old line's "I dialed it" or probe stamp; `null` nulls all four columns
    (`forwarding_source_number`, `forwarding_carrier`, `forwarding_confirmed_at`,
    `forwarding_verified_at`) together; absent touches none of them), and
    `packages/api/src/settings/settings.ts` and `pg-settings.ts` (the four keys, each accepting
    an explicit `null` to clear, as the deposit keys already do, with `undefined` meaning
    untouched; not added to `updateSettingsSchema`); tests
    `packages/api/test/onboarding/draft/forwarding.test.ts`,
    `packages/api/test/integration/onboarding-draft-forwarding.test.ts` (the stamp-clearing
    and clear-on-"no" cases below run here, against real Postgres)
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
    (`POST /draft/reopen` and the settings → choices pre-fill, plus the live
    `tenant_settings.owner_phone` (null included) onto the draft's `owner_phone`, written
    through U11's locked-write helper with the `approved` status it requires; refused with
    409 unless every
    generated proposal has `executed`, so a `failed` set is retried and a `stopped` or
    part-undone one is reset through U9 first (or, once part of it is live, edited in
    Settings), and a second set is never minted beside rows that did not run; the response carries
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
  ride the `onboarding_tenant_settings` payload as the one `forwarding` field
  (`{ sourceNumber, carrier }`), and are written to `tenant_settings.forwarding_source_number` and
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
  Both stamps describe one line, the source number and carrier they were taken against, so
  the handler that writes a changed `forwarding_source_number` or `forwarding_carrier` (a
  re-run that moves the line) nulls both stamps in that same write, and the badge returns
  until the owner dials and confirms or a probe lands for the new line; an unchanged number
  and carrier leave both stamps alone. Without the clear, either old timestamp would hide the
  badge for a line the owner never dialed or probed.
  First-day home replaces empty KPI cards with
  Rivet's spoken opener and three chips; the existing cards stay hidden until they have data.
  Delete v2 with a re-grep for every import (CLAUDE.md dead-code rule).
- **A "no" to the existing-number question clears the line.** `existing_number` is a
  draft-only answer, so on its own it writes nothing, and a payload that merely left the
  forwarding fields out would leave an earlier run's `forwarding_source_number`,
  `forwarding_carrier` and both stamps in place (the handler cannot tell "not asked" from
  "answered no"); status, the probe and reopen would then keep treating an abandoned line as
  configured. So the payload's `forwarding` field has three states, and the draft is what tells
  them apart. A "yes" with its pair staged approves as `{ sourceNumber, carrier }`. A "no"
  approves as the literal `null`, and the handler clears `forwarding_source_number`,
  `forwarding_carrier`, `forwarding_confirmed_at` and `forwarding_verified_at` in one write, so
  there is no moment with the number gone and a stamp left, or the reverse. No key means
  untouched: `existing_number` was never answered (a first run that skipped the turn, or a
  draft approved before the eighth turn shipped; the question has no default) or "yes" has no
  pair staged yet, and nothing stored changes. On a re-run, reopen pre-fills the answer from the
  live columns: "yes" with the stored number and carrier when `forwarding_source_number` is set
  (re-approved as it stands, the value equals the stored one and leaves both stamps alone),
  unanswered otherwise; an established shop that flips that answer to "no" is the case the
  `null` exists for. The text, the probe and the badge key on `forwarding_source_number` being
  set, so after a clear none of them has a line to act on: both routes answer 409
  `FORWARDING_NOT_CONFIGURED` and place nothing, and the first-day state shows no forwarding
  badge.
- **Number-availability failures reach the shell as a code.** The shell can tell the
  recoverable "someone took that number" from a failure no new number fixes only if the status
  says which one it was, and today it cannot: `load-facts.ts` selects the twilio row's
  `last_error` and drops it, and `derive-status.ts` turns every `failed` row into the single
  blocker `twilio_provisioning_failed`. So the status carries a closed `failureCode`.
  `load-facts.ts` classifies `last_error` with `classifyProvisioningFailure` (the one place
  that knows the texts `provision-twilio.ts` records, built from the same message builders, so
  a reworded message cannot quietly fall through to `unknown`) into `area_code_unavailable`
  (the picked number was taken between listing and purchase, or none was left to buy:
  "Selected number … is no longer available", "No available US phone numbers …"),
  `credentials_missing` (platform Twilio or encryption credentials unset, or test credentials
  detected), `provider_error` (a Twilio HTTP failure the queue's retries did not clear) or
  `unknown` (null or unrecognised text). The status response carries the code, never the raw
  text. `derive-status.ts` maps each code to its own blocker on the phone step,
  `area_code_unavailable`, `twilio_credentials_missing` or `twilio_provider_error`, with
  `twilio_provisioning_failed` kept after it on every failure (and alone for `unknown`) so
  existing readers keep working (v2's `PhoneStep` already keys copy on the first two, so they
  start reading as written until v2 is deleted), and sets the step's `failureCode`. Both are
  additive and optional on the status contract: the seven steps are unchanged, and a response
  without them (an older server, a step that did not fail) still parses. The v3 number turn
  keys on the code alone. `area_code_unavailable` re-searches (`POST /phone/available`, same
  area code) and offers the next candidate, "That one just went. Here's another." Each offer
  waits for the owner's "That works", so the turn cannot loop by itself, and an empty search
  takes U3's "Pick a different area code" path. `credentials_missing` shows its own copy
  ("That's on our side, not yours. We've been told.") and offers no number action.
  `provider_error` and `unknown` show their own copy with one explicit Try again
  (`POST /phone/retry`, on the owner's tap) and never re-search or offer a replacement number
  on their own.
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
  reported as theirs. A third rule keeps the baseline true across re-runs: (3) the baseline
  moves with the price. `repriceSeeded` writes a moved row's price and its baseline together,
  one `UPDATE` per table: on a catalog item `SET unit_price_cents = $new,
  seeded_unit_price_cents = $new`, on an estimate template it rewrites `defaultUnitPriceCents`
  and `seededUnitPriceCents` together on each matching line of `line_item_templates`, under the
  predicate `seeded_unit_price_cents IS NOT NULL AND unit_price_cents =
  seeded_unit_price_cents` (the line's own pair for a template). The newly selected price is
  the row's new seed. Moving only the price would leave the baseline at the first seed price,
  so the next re-run would see price <> baseline, classify an untouched row as the owner's and
  leave it ("I left it") while the card promised an update. Rows the predicate skips keep both
  values, so an owner edit stays an edit.
- **Patterns to follow:** `notifications/owner-sms-sender.ts` (`recipientClass: 'owner'`
  skips consent), `components/home/ActivationCelebrationBanner.tsx` (first-run state),
  `docs/solutions/architecture-patterns/derive-shared-status-rule-across-frontends.md`.
- **Test scenarios:**
  - Happy path: re-run → `POST /draft/reopen` pre-fills the read-back with the live greeting,
    posture, payment mode, hours, emergency target, prices and owner cell; a new price pick → the two
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
    the payload carries `forwarding: null` (not omission: `buildDraftProposals` output has the
    key with the value `null`, and so does the proposal row's stored JSON after a round trip);
    approved and executed → both columns hold the staged values;
    `PUT /draft/forwarding` after approval → 409 `DRAFT_APPROVED`, and its race with approve is
    the forwarding row of U11's writer-vs-approve test.
  - Edge (forwarding re-run clears the old line's stamps): a tenant with source number A,
    carrier `verizon` and both `forwarding_confirmed_at` and `forwarding_verified_at` set; a
    re-run approved with source number B → after execution the columns hold B and `verizon`
    and both stamps are null (the first-day badge shows again); the same for a carrier-only
    change (`verizon` → `att`) and for a number-only change; number and carrier re-approved
    unchanged → both stamps untouched and the badge stays cleared; only one stamp set
    (confirmed but never probed, and the reverse) → both end null on a change. The columns and
    the stamps change in one `SettingsRepository` write (a write that fails leaves the old
    numbers beside the old stamps, never new numbers beside old stamps).
  - Edge (a re-run that answers "no" clears the old line; the explicit-null contract, real
    Postgres): an established tenant with source number A, carrier `verizon` and both stamps
    set re-runs setup (reopen pre-fills `existing_number` "yes" with A and `verizon`) and
    flips the answer to "no" → the draft's two forwarding columns are null, the approved
    payload has `forwarding: null`, and after execution all four `tenant_settings` columns
    (`forwarding_source_number`, `forwarding_carrier`, `forwarding_confirmed_at`,
    `forwarding_verified_at`) are null, written by one `SettingsRepository` write (a fault
    injected into it leaves all four at their old values, never some cleared); the text and
    probe routes answer 409 `FORWARDING_NOT_CONFIGURED` with no SMS sent and no call placed, and
    the first-day state shows no forwarding badge. "No" then "yes" on a tenant with nothing
    stored → both columns hold the staged pair and both stamps stay null (the badge shows until
    the owner confirms or a probe lands). A payload with no `forwarding` key (`existing_number`
    never answered, or "yes" with no pair staged) → all four columns exactly as they were,
    stamps included, whatever their values. "Yes" re-approved with the stored number and
    carrier → columns and stamps untouched. Reopen on a tenant with no
    `forwarding_source_number` leaves `existing_number` unanswered. Unit (`forwarding.test.ts`,
    the payload schema): `forwarding` absent, `null` and a value all parse and stay distinct;
    `{ sourceNumber }` alone, a non-E.164 number, a carrier outside the four and an extra key
    are rejected.
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
  - Edge (owner cell on re-run): the first run stored cell A on the draft and in
    `tenant_settings.owner_phone`; the owner then changes it to B in Settings and taps Re-run
    setup → `POST /draft/reopen` leaves the draft's `owner_phone` = B (not A), the read-back
    shows B, and "That's right" → the settings payload carries B and after execution
    `tenant_settings.owner_phone` is B (A is never written back over the edit). Settings
    cleared to null → the draft's `owner_phone` is null (the explicit null replaces A), the
    payload carries no `ownerPhone` and the handler leaves the column as it is (from S4 the
    `OWNER_PHONE_REQUIRED` gate then asks for a number at the read-back if the emergency choice
    rings the owner). Cell unchanged → draft and settings still agree. Integration
    (`onboarding-draft-reopen.test.ts`): real columns under RLS, the settings read and the
    draft write in one transaction.
  - Edge (two successive re-runs; unit and, against real Postgres, integration): seeded at
    labor 9,500 and trip 12,000 (each row's baseline equals its price); re-run 1 picks
    11,000 and 14,000 → both headline items and the template lines that carried those
    amounts hold the new prices and their baselines (`seeded_unit_price_cents`,
    `seededUnitPriceCents`) equal the new prices, asserted in the same read; re-run 2 picks
    12,500 and 15,000 with nothing edited in between → all of those rows move again and none
    is reported as the owner's. Variant: the owner edits the labor rate to 11,500 between the
    runs → re-run 2 leaves that item and its template line alone (11,500 <> baseline 11,000),
    moves the untouched trip fee, and the read-back names the labor rate as theirs. A
    statement that fails leaves price and baseline both at the old pick (the pair never
    splits).
  - Error: SMS provider failure → the carrier code is shown inline with copy button as the
    fallback and an event is recorded; a non-E.164 source number → 400 naming the field; a
    carrier outside `verizon | att | tmobile | other` → 400.
  - Number failure codes (unit, `provisioning-failure.test.ts`): every `last_error` the worker
    records classifies as intended. The unavailable-number text and the no-inventory text →
    `area_code_unavailable`; each unset-credentials text and the test-credentials text →
    `credentials_missing`; a Twilio HTTP 5xx or network text → `provider_error`; the
    tenant-conflict text, null, an empty string and unfamiliar text → `unknown`. The test
    iterates the message builders, so a reworded message fails here rather than degrading to
    `unknown`.
  - Status by code (derive-status unit, and integration against real `tenant_integrations`
    rows, one case per code): a failed row with each code → the phone step is `error`, carries
    `failureCode` and the blockers (`area_code_unavailable`, `twilio_credentials_missing` or
    `twilio_provider_error`, then `twilio_provisioning_failed`; `unknown` → only the last); a
    row that did not fail → no `failureCode`; `lineState`, `phoneNumber` and `pendingNumber`
    metadata unchanged; `feature-inventory.test.ts` still finds `twilio_provisioning_failed`.
  - Status contract (`contracts.test.ts`): the response parses with and without
    `failureCode`, a value outside the four is rejected, the steps stay exactly seven, and
    every other step's shape is unchanged.
  - Number turn (shell test driving the status poll): provisioning → `error` with
    `area_code_unavailable` → a new candidate is searched and shown ("That one just went");
    the same transition with `credentials_missing`, `provider_error` and `unknown` → no
    `/phone/available` call and no candidate, the code's own copy rendered (Try again only for
    the last two, calling `/phone/retry` only on the owner's tap); after the owner accepts the
    new candidate, a second `area_code_unavailable` re-searches again.
  - Integration: route test proves the SMS body contains the right code for each carrier; real
    Postgres pins the new columns (`tenant_settings.forwarding_source_number`,
    `forwarding_carrier` with its CHECK, `seeded_baseline_backfilled_at`;
    `catalog_items.seeded_unit_price_cents`; the `onboarding_drafts` forwarding columns) and
    the handler's write to them under RLS (a value, an explicit `null` that clears the four
    forwarding columns, and an absent key that leaves them alone); the backfill runs against seeded and hand-edited
    rows in a populated database (extending `migration-replay-populated-db.test.ts`).
- **Verification:** `grep -r "onboarding/v2" packages/web/src` returns nothing; e2e passes for
  both branches; the forbidden-vocabulary test extends to `components/home`.

### U10. The owner's cell: on the draft, on the settings proposal, required when a choice rings it
- **Goal:** The owner's cell, optional on the first screen and used today only to place the
  metro (nothing persists it), is stored on the draft, travels on the settings proposal and
  lands in `tenant_settings.owner_phone`, so U6's forwarding text has a number to go to and the
  hand-off rings the number the owner typed. Both emergency options ring the owner (the
  schema permits only `owner_cell` and `owner_cell_then_text`), so once the read-back can ask
  for the number, approval refuses a draft that has none.
- **Requirements:** R4, R6
- **Dependencies:** U2; U11 (the cell is written under its lock-then-compare invariant)
- **Files:**
  - modify `packages/api/src/onboarding/draft/contracts.ts` and `repository.ts` (store
    `owner_phone` E.164 on the draft from the first screen's cell on `POST /draft`, normalised
    with the existing phone normaliser; `setOwnerPhone` behind `PUT /draft/owner-phone`, body
    `{ ownerPhone, version }`, to add or change it later: lock, refuse once approved, compare
    `version`, write and bump, inline in S1b and a thin caller of U11's locked-write helper once
    S4 extracts it), create `packages/api/src/onboarding/draft/owner-phone.ts` (the one
    normaliser and E.164 guard that the route, the repository and the proposal contract share),
    `packages/api/src/routes/onboarding-draft.ts` (the route; audit `onboarding.owner_phone_set`
    with the number masked), migration `313_onboarding_drafts_owner_phone` (nullable
    `onboarding_drafts.owner_phone`, CHECK E.164; S1b), and, with the S2 web consumer rather
    than in #1694, `packages/shared/src/contracts/onboarding-draft.ts` (body and response)
  - modify `packages/api/src/onboarding/draft/approve.ts` (carry `ownerPhone` on the
    `onboarding_tenant_settings` payload when the draft has one),
    `packages/api/src/proposals/contracts/onboarding.ts` (optional E.164 `ownerPhone` on that
    payload) and `proposals/execution/onboarding-handlers.ts` (the handler writes
    `tenant_settings.owner_phone` through `SettingsRepository`, and leaves an existing value
    alone when the payload carries none). S4 adds the gate to `approve.ts`: refuse approval
    with 400 `OWNER_PHONE_REQUIRED` when the resolved emergency choice rings the owner and
    the draft has no number
  - modify (S4) `packages/web/src/components/onboarding/v3/ReadbackCard.tsx` and
    `ConversationShell.tsx` (when the number is missing and needed, the read-back asks "Which
    number should I ring in an emergency?" above "That's right", one typed field, server-side
    validation; the first screen's cell stays optional)
  - tests: `packages/api/test/onboarding/draft/owner-phone.test.ts`,
    `packages/api/test/integration/onboarding-draft-owner-phone.test.ts`, and in S4 the v3
    shell tests
- **Approach:** Two PRs, in this order, on purpose. The API half ships in S1b (the S1
  follow-ups PR): the column, the cell stored on create, `PUT /draft/owner-phone`, the
  `ownerPhone` payload field and the handler's write. It does NOT include the
  `OWNER_PHONE_REQUIRED` gate: both emergency options ring the owner, so a gate would make
  every draft without a cell unapprovable until the read-back can ask for the number, and the
  read-back cannot ask until S4. A gate with nothing to lift it is a capability that can never
  be approved (CLAUDE.md, #909). The gate and the read-back prompt therefore ship together in
  S4, in one PR, so the refusal always has a control that lifts it. The window between the two
  is safe: v3 stays behind the flag until S5, and the runtime consumer that rings the number
  (U8's `emergency_target`) also lands in S5, after the gate. The cell is a fact about the
  owner, not a choice, so it lives on the draft and travels on the settings proposal like the
  business name. On a re-run the draft's cell is reopen's copy of the live setting (U6), so the
  payload carries what Settings holds today, never the number the first run captured. From S4,
  approval, not staging, is the gate, so the owner can answer the seven
  cards first and supply the number at the read-back. The refusal is a business rule, not a
  schema one: the emergency enum already rejects, at staging, any value outside the two
  options that ring the owner.
- **Patterns to follow:** `onboarding/draft/approve.ts` (`TIMEZONE_REQUIRED`), the identity
  step's owner-phone normalisation in `routes/onboarding.ts`.
- **Test scenarios:**
  - Happy path (S1b): cell on the first screen → the draft has it, normalised → approve → the
    settings payload carries `ownerPhone` → after execution `tenant_settings.owner_phone` is
    set; `PUT /draft/owner-phone` before approval adds or replaces it and the approval carries
    the latest.
  - Edge (S1b, no gate): no cell and emergency choice `owner_cell`, and separately
    `owner_cell_then_text` → approve succeeds with the usual two proposals, the settings
    payload has no `ownerPhone`, and after execution nothing was written for `owner_phone` (an
    existing stored value is left as it was); a non-E.164 value → 400 naming the field; a
    stale `version` on the PUT → 409 `VERSION_CONFLICT`; the PUT after approval → 409
    `DRAFT_APPROVED`.
  - Gate (S4): no cell and emergency choice `owner_cell` (and separately
    `owner_cell_then_text`) → approve 400 `OWNER_PHONE_REQUIRED`, zero proposal rows, draft
    still `'draft'`; the shell test drives that 400 and asserts the read-back renders the field
    above "That's right", and filling it calls `PUT /draft/owner-phone` and the next approve
    succeeds. A cell already on the draft → no prompt and no refusal. Gate and prompt are one
    PR: the shell test fails if approve can answer `OWNER_PHONE_REQUIRED` while the read-back
    has no field to answer it. No emergency choice can ring nobody: `emergency_target`
    accepts only the two ringing values, and anything else is a 400 at staging (U5).
  - Integration: the column round-trips under RLS; the payload reaches the handler and writes
    `tenant_settings.owner_phone`; a payload without `ownerPhone` leaves an existing value
    untouched. The owner-phone `PUT` vs approve race is a row in U11's table-driven test.
  - Re-run (lands with U6's reopen in S5): the draft's cell is the live
    `tenant_settings.owner_phone`, null included, so approve never writes a stale number back
    over a newer Settings edit; the case is U6's "Edge (owner cell on re-run)".
- **Verification:** S1b: the number the owner typed, on the first screen or by `PUT`, is the one
  in `tenant_settings.owner_phone` after execution, and a draft without one still approves.
  S4: no tenant can approve an owner-ringing emergency choice without a number on file, and
  the number the owner typed is the one the hand-off rings.

### U9. Whole-draft undo, reset, execution tracking and retry
- **Goal:** "Saving, tap to undo" is one tap that undoes the whole approval, onboarding does
  not move past the saving screen until every generated proposal has executed, and an approval
  that cannot finish (one proposal failed, or the owner undid one of the pair from the inbox)
  has a way out that works: retry, a reset back to an editable draft, or a pointer to Settings
  when part of it is already live.
- **Requirements:** R3
- **Dependencies:** U2
- **Files:**
  - modify `packages/api/src/routes/onboarding-draft.ts` (`POST /draft/retry` in S1b, which
    takes no body; `POST /draft/undo` and `POST /draft/reset` in S4, each with a required
    `{ expectedVersion }`, and S4 gives retry the same field); create
    `packages/api/src/onboarding/draft/retry.ts`
    (`retryFailedDraftProposals`, S1b; S4 adds its `expectedVersion` comparison); modify `packages/api/src/onboarding/draft/approve.ts`
    (the undo and reset helpers, S4, over one shared locked read of the draft and its
    proposals) and `packages/api/src/onboarding/draft/repository.ts` (undo and reset are draft
    writers under U11's invariant: each goes through the locked-write helper, declaring the
    `approved` status it requires, not a second locking path),
    `packages/api/src/proposals/proposal.ts` and `pg-proposal.ts` (S1b:
    `ProposalRepository.resetFailedForRetry`, one conditional `UPDATE … WHERE status =
    'execution_failed'` that moves the row to `draft` and clears `approved_at`, the error, the
    claim and the retry count, so the re-approval gets a fresh undo window; S4: a locking read
    of a proposal set by id, ordered, `FOR UPDATE`, which the in-memory repo implements as a
    plain ordered read), `proposals/pg-proposal-execution.ts` and `proposal-execution.ts` (S1b:
    a retried execution replaces its earlier `failed` `proposal_executions` row under the same
    idempotency key), `proposals/audit.ts` (S1b: `proposal.retried`),
    `packages/api/src/onboarding/load-facts.ts` and `derive-status.ts` (S1b: the `draft` fact
    gains `execution: 'pending' | 'executing' | 'executed' | 'failed' | 'stopped'`, `null`
    while the draft is still being edited, derived by `deriveDraftExecution` from the
    generated proposals' statuses; the raw statuses never leave the server); S4 adds an
    optional, derived `recovery: 'reset' | 'settings'` beside it in the same block
    (`derive-status.ts` and `contracts.ts`, present only while `execution` is `failed` or
    `stopped`), and rewrites the `deriveDraftExecution` and `retry.ts` doc comments, which
    today name the whole-draft undo as the way out of `stopped`
  - modify `packages/web/src/components/onboarding/v3/ConversationShell.tsx` (undo button during
    the window, which posts the `version` from the approve response; the wait screen holds while
    `execution` is `pending` or `executing`; on
    `failed`, "Something didn't save. Try again." → retry (posting the draft's `version`), plus "Start over" (reset) beneath it
    when `recovery` is `reset`; on `stopped`, never Retry, since it cannot recover: with
    `recovery: 'reset'` copy that says part of the setup was undone and a "Start over" button
    that calls `POST /draft/reset` with the draft's `version` and then re-renders the
    read-back with the owner's answers intact, and with `recovery: 'settings'` copy that says
    part of it is already live and a link to the Settings page, no button; the same screen
    answers a `DRAFT_RESET_REFUSED` the server reaches on a race the same way)
  - modify `packages/shared/src/contracts/onboarding-draft.ts` (S4: the undo and reset bodies
    `{ expectedVersion }`, retry's optional `expectedVersion`, and their typed refusals, kept
    equal to the API's Zod by `wire-contract.test.ts`)
  - tests: `packages/api/test/onboarding/draft/undo.test.ts`, `reset.test.ts`,
    `packages/api/test/onboarding/derive-status.test.ts` (extend),
    `packages/api/test/integration/onboarding-draft-undo.test.ts`,
    `packages/api/test/integration/onboarding-draft-reset.test.ts`, the v3 shell tests; shipped
    in S1b: `packages/api/test/onboarding/draft/retry.test.ts` (extended in S4 for
    `expectedVersion`),
    `packages/api/test/proposals/lifecycle-retry.test.ts`,
    `packages/api/test/integration/onboarding-draft-execution.test.ts`
- **Approach:** The derived `execution` fact and `POST /draft/retry` ship in the S1 follow-ups
  PR (#1694); undo and reset ship in S4. `POST /draft/undo` takes a required body
  `{ expectedVersion }`: the draft's `version` as the saving screen rendered it, which is the
  version after the approval the screen is showing (`draft.version` in the approve response, or
  the status draft block's `version` when the screen is rebuilt after a reload). It runs in one
  tenant transaction that locks, then decides, then writes. It locks the draft row through
  `updateLocked`, requiring `approved`: a draft already back in `draft` (a double tap, or
  another tab got there first) is 409 `DRAFT_NOT_APPROVED`, and an `expectedVersion` other than
  the row's `version` is 409 `VERSION_CONFLICT` naming the version sent and the version found,
  with nothing changed and the proposals not yet read. The version is what binds the tap to the
  approval its screen showed. Without it, tab A's saving screen for approval 1 can outlive tab
  B's undo (or reset), edit and approval of a new pair inside the window, and A's versionless
  undo would lock the *current* `proposal_ids` and undo B's approval. An approved draft is
  frozen and its `version` moves only when undo, reset or reopen take it out of `approved`
  (retry does not write the row), and every approval bumps it again, so one version names one
  approval. Then it takes `SELECT … FOR UPDATE` on the proposals in
  `proposal_ids` (ordered by id, so two undos cannot deadlock), and requires EVERY locked row
  to still be `approved` and inside the undo window (`isInUndoWindow`, read from the locked
  row). If any row is `executing`, `executed`, `execution_failed` or `undone`, if any window
  has closed, or if a listed proposal is missing, it refuses with 409 and a typed reason
  (`DRAFT_UNDO_REFUSED` naming the offending statuses, or `UNDO_WINDOW_CLOSED`), changes
  nothing, and the shell says so; the inbox's per-proposal undo remains for the executed case,
  and a set the inbox has already split (one `undone`, `rejected` or `expired`) is the reset's,
  below, not a looser undo. Only then does it revert the whole set with the transition
  `POST /api/proposals/:id/undo` makes (`approved → undone`), return the draft to `'draft'` with `proposal_ids = []`, and
  emit `onboarding.draft_undone`. The lock is what closes the race at the five-second
  boundary: the worker claims a row with `UPDATE … WHERE id = $1 AND status = 'approved'`
  (`claimForExecution`), so a claim that arrives while undo holds the locks waits and then
  matches nothing because the rows are `undone`, and a claim that committed first shows as
  `executing` to the locked read and refuses the undo. The draft cannot reopen while a
  generated proposal is applying or has applied.

  **Reset: the way out of a set that can no longer finish as one unit.** The inbox can undo
  ONE member of the approved pair (`approved → undone` inside the window). Every other escape
  then rejects the set: undo wants every row `approved`, retry wants `execution_failed`, and
  reopen (U6) wants every row `executed`; the fact reads `stopped`, and an owner who is sent
  to a whole-draft undo that refuses is stuck before billing. `POST /draft/reset` is the
  locked reconciliation for that case, and it is its own endpoint rather than a looser
  `/draft/undo` on purpose. Undo is the one-tap, all-or-nothing reversal inside the saving
  window: its refusal on a set that is not wholly `approved` is how the owner learns the inbox
  already acted, and the saving screen's button should keep meaning only that. Reset is
  reached from `stopped` (and `failed`), tolerates terminal members, and emits a different
  event, so the audit trail tells an owner's undo from a clean-up after a partial stop. It
  accepts a superset of what undo accepts and shares its locked read.

  The body is `{ expectedVersion }`, the `version` the shell rendered the state from (the
  status draft block carries it). One tenant transaction, lock then decide then write:
  (1) lock the draft row through `updateLocked`, requiring `approved`: a draft already back in
  `draft` (a double tap, or another tab got there first) is 409 `DRAFT_NOT_APPROVED`, and a
  stale `expectedVersion` (a tab that rendered an earlier approval, since replaced by a reset
  and a new approval) is 409 `VERSION_CONFLICT`, so a reset can never revert an approval its
  caller never saw; (2) `SELECT … FOR UPDATE` the proposals in `proposal_ids`, ordered by id,
  the same locking read as undo; (3) decide from the locked rows only. The set is accepted
  when every listed proposal is either `approved` and inside the undo window
  (`isInUndoWindow`, read from the locked row) or *not applied*: any status outside
  `approved | executing | executed` (`undone`, `rejected`, `expired`, `execution_failed`, and
  the pre-approval `draft` or `ready_for_review` that an inbox reopen of a rejection leaves
  behind), or a listed id with no row. It refuses with 409 `DRAFT_RESET_REFUSED`, naming the
  offending statuses and a `reason`, when ANY proposal is `executed` (`applied`: that work is
  live, and only the inbox's undo of executed work or the Settings page reverses it) or
  `executing` (`executing`: it is landing now, and the next poll shows `executed` or
  `failed`); with `UNDO_WINDOW_CLOSED` when an `approved` row's window has closed (the worker
  is about to claim it); and a refusal changes nothing. (4) Write: every `approved` row goes to
  `undone` by the transition `POST /api/proposals/:id/undo` makes, with its audit row; rows
  that were already not applied are left exactly as they are (reset mints, moves and
  re-approves nothing, and clearing `proposal_ids` is what detaches them from the draft); the
  draft returns to `'draft'` with its staged choices intact, `proposal_ids = []` and
  `version + 1`, through the locked-write helper; and `onboarding.draft_reset` is emitted with
  the reverted ids and the `{ id, status }` of every other member. The next approval mints a
  fresh pair. The row locks close the same boundary race as undo: a worker claim
  (`UPDATE … WHERE id = $1 AND status = 'approved'`) that arrives while reset holds the set
  waits and then matches nothing because the row is `undone`, and a claim that committed
  first shows as `executing` to the locked read and refuses the reset.

  The window is five seconds, and the surviving sibling of a split pair executes by itself
  once its own window closes, so the common landing for a split approval is the Settings
  pointer: `executed` + `undone` is refused as `applied` (reopen refuses it too, since not
  every row executed), and the shell's copy sends the owner to the Settings page instead of
  offering the same button again. Reset succeeds when the owner is quick, when the sibling
  failed, or when every member is already out of the way. To keep the shell from offering a
  button the server will refuse, the status draft block carries `recovery`, derived from the
  same statuses: `'settings'` when any listed proposal is `executing` or `executed`, else
  `'reset'`; the server stays the authority for the race and the window. Reopen keeps its own
  precondition (`approved` and every proposal `executed`): it edits a live setup, so a failed,
  stopped or part-undone set is retried or reset here first and never reopened on top of rows
  that did not run.

  `POST /draft/retry` locks the draft row, then moves each of the set's `execution_failed`
  proposals along the only path `proposals/lifecycle.ts` allows (`execution_failed → draft`
  through `resetFailedForRetry`, then approved again through the batch-approve helper with a
  fresh `approvedAt`), in one request transaction with a `proposal.retried` audit row each, so
  the worker's `approved` sweep picks them up after a fresh undo window; it emits
  `onboarding.draft_retry`. Proposals that are not `execution_failed` are left alone; a draft
  that is not approved is 409 `DRAFT_NOT_APPROVED`, and a set with nothing in
  `execution_failed` is 409 `DRAFT_RETRY_NOTHING_FAILED` (a second retry racing the first
  sees the first's outcome under the draft lock). The execution state is derived, never
  stored: `failed` when any listed proposal is `execution_failed` (it wins over every other
  state); `stopped` when none is but one is outside `approved | executing | executed` (undone
  or rejected from the inbox, expired) or no longer exists, which retry cannot recover
  (`undone` is terminal in `lifecycle.ts`), so the shell neither waits forever nor offers
  Retry, and its recovery is `POST /draft/reset`, or the Settings page once part of the set is
  live (`recovery`); `executed` when all are; `executing` when work is in flight; `pending` when all are
  approved and none is picked up; and `null` while the draft is still being edited or lists
  nothing, so a vacuous "executed" never opens billing.

  Retry carries the version for the same reason as undo. `POST /draft/retry` also takes
  `{ expectedVersion }`, the approved draft's `version` as the failed screen rendered it; under
  the draft lock, after the `approved` check, any other value is 409 `VERSION_CONFLICT` naming
  both versions, nothing is reset and no `proposal.retried` row is written. Without it, a tab
  still showing the failure of approval 1 could re-queue the failed proposals of a newer pair
  another tab approved after a reset. This is a change to the retry that #1694 ships, not part
  of it: that route reads no body (its handler calls `retryFailedDraftProposals` without
  parsing `req.body`), so a version sent today is ignored. It is a follow-up in S4, with undo
  and reset: the strict `{ expectedVersion }` schema (a positive integer), the comparison in
  `retryFailedDraftProposals`, and the shared wire schema. The field is optional until
  approve's becomes required, in the same step (U11), so a client that posts nothing keeps
  working until then; S2's web can send it from the start. A retry still does not write the
  draft row, so it leaves `version` unchanged, and two tabs retrying one failed set at one
  version race to the existing `DRAFT_RETRY_NOTHING_FAILED`.
- **Patterns to follow:** `routes/proposals.ts` undo handler and `proposals/lifecycle.ts`,
  `workers/execution-worker.ts` retry semantics, D-039/D-040.
- **Test scenarios:**
  - Happy path: approve → undo inside the window, sending the approve response's
    `draft.version` → every proposal reverted, settings untouched,
    draft `'draft'` and editable again, one audit row.
  - Edge: any one proposal `executing`, `executed`, `execution_failed` or `undone` (one case
    each; the `undone` one is an inbox-split pair, whose way out is the reset below) →
    409 `DRAFT_UNDO_REFUSED`, no row changed, draft still `approved`; the window closed on one
    row → 409 `UNDO_WINDOW_CLOSED`, nothing changed; approve → all executed → fact `executed`
    and the shell moves to billing.
  - Undo, version (the stale-tab finding): tab A renders the saving screen for approval 1 at
    version v (from its approve response); inside the window tab B undoes (the draft is back in
    `draft`), stages a change and approves a new pair (`approved` at v + 3); tab A's `POST
    /draft/undo { expectedVersion: v }` → 409 `VERSION_CONFLICT` naming v and v + 3, tab B's two
    proposals still `approved`, the draft still `approved` at v + 3 with its `proposal_ids`
    untouched, no `onboarding.draft_undone` row, settings untouched; B's own undo with v + 3
    then succeeds. The same when B reached the new pair through `POST /draft/reset` instead of
    undo, and when A's version is ahead of the row's. A tab whose version matches (the approve
    response's, or the status block's after a reload) undoes as in the happy path. A missing
    body, `{}`, a non-integer, zero, negative or extra key → 400 naming `expectedVersion`,
    nothing locked or written. The same tap sent twice (the second after the first undid) → 409
    `DRAFT_NOT_APPROVED`, nothing written. Ordering: a stale `expectedVersion` with a closed
    window → `VERSION_CONFLICT`, not `UNDO_WINDOW_CLOSED`, because the proposals are never read.
  - Race (the five-second boundary, two real connections): (a) the worker's
    `claimForExecution` arrives after undo has locked the set → the claim blocks, undo commits,
    the claim returns null, no handler runs and the draft is `'draft'`; (b) the claim commits
    first → undo reads `executing`, refuses with 409, the draft stays `approved` and the
    executing proposal finishes untouched. Never: draft `'draft'` while any generated proposal
    is `executing` or `executed`.
  - Race (a stale undo against the other tab, two real connections, both orders, looped): tab
    B's reset (or undo) and tab A's undo carrying the same version → exactly one succeeds; the
    loser waited behind the lock, found the draft in `draft` and is 409 `DRAFT_NOT_APPROVED`;
    the draft ends in `draft` once with one audit row, and no proposal of a later approval is
    touched.
  - Error: one proposal `execution_failed` → fact `failed`, the shell holds and offers retry;
    retry moves that one only through `draft → approved` with a new `approvedAt` (the others
    untouched), it executes after the fresh window, and the fact is `executed`.
  - Retry, version (S4): `POST /draft/retry { expectedVersion: v }` with v the failed screen's
    version re-queues as above; tab A holding v after tab B reset and re-approved (`approved` at
    v + 3) with one of B's proposals `execution_failed` → 409 `VERSION_CONFLICT`, B's failed
    proposal still `execution_failed`, no `proposal.retried` row; a non-integer or extra key →
    400; no body → the behaviour #1694 shipped, until S4 makes the field required. A retry does
    not change the draft's `version`.
  - Error (stopped): a proposal undone from the inbox, one rejected, one expired and one
    missing (one case each) → fact `stopped`, `POST /draft/retry` answers 409
    `DRAFT_RETRY_NOTHING_FAILED`, and the shell offers no Retry and does not wait; a set with
    one `execution_failed` and one `undone` → `failed`, and retry re-queues only the failed
    one.
  - Reset, the finding's case (an inbox-split pair): approve → both `approved` in the window,
    the owner undoes ONE of them from the inbox → fact `stopped` with `recovery: 'reset'`,
    retry 409 `DRAFT_RETRY_NOTHING_FAILED`, undo 409 `DRAFT_UNDO_REFUSED`; `POST /draft/reset`
    with the draft's `version` → 200: the other proposal is `undone` (one audit row), the draft
    is `'draft'` at `version + 1` with `proposal_ids = []` and its choices intact,
    `tenant_settings` untouched, exactly one `onboarding.draft_reset` naming the reverted id
    and the other member's status; a choice `PUT` carrying the new version succeeds, and the
    next approve mints exactly two new proposals beside the two old ones, which are not
    touched again.
  - Reset, other accepted sets (table-driven, one case per row, each ending editable with one
    `onboarding.draft_reset`): `undone` + `undone` (nothing left to revert), `rejected` +
    `approved` in the window, `expired` + `approved` in the window, `execution_failed` +
    `undone`, `execution_failed` + `execution_failed`, a stray `draft` or `ready_for_review`
    member + `undone`, and a listed id with no row + `approved` in the window; all `approved`
    in the window also resets (a superset of undo).
  - Reset, refused (nothing written in any case: draft still `approved`, `version` and every
    proposal unchanged, no audit row): `executed` + `undone` (the sibling executed before the
    inbox undo) → 409 `DRAFT_RESET_REFUSED`, reason `applied`; the status reads `stopped` with
    `recovery: 'settings'`, so the shell shows the Settings link and no Start over button, and
    the same screen results when the 409 is the answer to a tap made before the poll caught
    up; `POST /draft/reopen` on that set is refused too, so the pointer is the one way
    forward and nothing loops. `executing` + `undone` → 409 `DRAFT_RESET_REFUSED`, reason
    `executing`, and once that proposal finishes the next attempt is `applied` (executed) or
    accepted (`execution_failed`). `approved` past its window + `undone` → 409
    `UNDO_WINDOW_CLOSED`. A second reset, or a reset after undo, on an already editable draft →
    409 `DRAFT_NOT_APPROVED`; a stale `expectedVersion` after a reset and a fresh approval →
    409 `VERSION_CONFLICT`, and the new pair is untouched.
  - Reset, races (two real connections, looped so ordering luck cannot pass): (a) the worker's
    `claimForExecution` on the `approved` sibling arrives after reset has locked the set → the
    claim blocks, reset commits, the claim returns null, no handler runs, the draft is
    `'draft'`; (b) the claim commits first → reset reads `executing`, refuses with 409, the
    draft stays `approved` and the proposal finishes untouched. Never: draft `'draft'` while any
    generated proposal is `executing` or `executed`. (c) The inbox undo of the surviving
    sibling racing the reset, both orders → both proposals end `undone`, the draft ends
    `'draft'`, and whichever lost the lock gets its own typed 409 or a no-op, never a
    half-written set.
  - Status (`derive-status.test.ts`): `recovery` is `'settings'` for any `stopped` or `failed`
    set holding an `executing` or `executed` proposal and `'reset'` for every other
    `stopped` or `failed` set, and is absent for `pending`, `executing`, `executed` and a
    draft still being edited.
  - Shell: `stopped` with `recovery: 'reset'` → Start over calls reset with the draft's
    `version` and re-renders the read-back with the answers intact; `recovery: 'settings'` → the
    Settings link and no reset call; `failed` → Retry always, and Start over only with
    `recovery: 'reset'`; a `DRAFT_RESET_REFUSED` reason `applied` from a stale screen swaps in
    the Settings copy, and reason `executing` or `UNDO_WINDOW_CLOSED` keeps the wait screen.
  - Shell (version): the undo button posts the `version` from the approve response and Retry
    posts the status block's `version`; a 409 `VERSION_CONFLICT` or `DRAFT_NOT_APPROVED` from
    either re-reads the status and renders whatever is current (another tab's saving screen, or
    the editable read-back) with the one-line "This changed in another window" notice, and
    neither repeats the call by itself.
  - Integration: real Postgres rows for the undo, for the mixed-status set, for every
    reset row above and for the version cases (stale undo, stale retry), under RLS.
- **Verification:** no owner reaches the trial turn with a generated proposal unexecuted, one
  tap inside the window undoes the whole approval, a tap that loses the race to the worker
  changes nothing, and an approval the owner split from the inbox ends in an editable draft or
  a pointer to Settings, never in a button the server refuses; and a tap made from a screen
  that no longer shows the current approval is refused with a 409 that changes nothing.

### U11. Draft write lock and approval compare-and-swap
- **Goal:** "That's right" approves exactly the choices the owner was looking at, exactly once.
  No write to the draft (a choice, the timezone, the owner's cell, the metro, the forwarding
  answers) racing an approval can change what is executed, and two concurrent approvals
  cannot both mint a proposal pair. Closes the gap S1 shipped with (see U2).
- **Requirements:** R3
- **Dependencies:** U2 (S1, merged). The approve half ships early, in the "S1 follow-ups" PR
  (#1694) together with U10's API half and U9's execution fact and `POST /draft/retry` (see
  the slice table); the shared `updateLocked` helper, its guard test and the table-driven
  writer race ship in S4, where U9's undo and reset and U5's `setMetro` reuse it.
- **Invariant.** Every writer of `onboarding_drafts` does the same four things in one tenant
  transaction, in this order: (1) `SELECT … FOR UPDATE` the tenant's draft row; (2) refuse
  unless the row is in the status that writer requires: `draft` for every field write (a
  write to an `approved` draft is `DraftAlreadyApprovedError`, 409 `DRAFT_APPROVED`) and
  `approved` for undo, reset (U9) and reopen (U6); (3) compare `version` with the caller's
  `expectedVersion` when it sent one (`DraftVersionConflictError`, 409 `VERSION_CONFLICT`;
  undo and reset always send one, approve and retry may omit it until S4 requires it);
  (4) compute the change from the locked row, never from an earlier read, write it and bump
  `version`. The repository exposes this as one shared helper,
  `updateLocked(tenantId, { requireStatus, expectedVersion? }, compute)`, and it is the only
  code in the repository that issues `UPDATE onboarding_drafts` (`… WHERE id = $1 AND version =
  $found`; zero rows throws). Every writer is a thin caller of it: `stageChoice` (which
  requires `expectedVersion`), `setClientTimezone`, `setOwnerPhone` (U10), `setMetro` (U5),
  `setForwarding` (U6), `markApproved`, undo and reset (U9) and reopen (U6); `POST /draft` (the INSERT)
  is the only other statement that touches the table. The in-memory repository implements the
  same helper. A writer that skipped any step could land between proposal construction and
  `markApproved`, or after it, and the executed proposals would no longer match the draft the
  owner approved; so a new writer is not done until it goes through the helper and has a row
  in the race test below.
- **Shipped in S1b (#1694), and what S4 still adds.** #1694 ships the approve half:
  `getForTenantForUpdate`, the `expectedVersion` rules below, `markApproved` as a
  `WHERE … AND version = $` compare-and-swap that throws `DraftAlreadyApprovedError` or
  `DraftVersionConflictError` instead of returning a row it did not update, and `setOwnerPhone`
  taking the four steps inline (lock, refuse once approved, compare `version`, write and bump),
  as `stageChoice` and `setClientTimezone` already did. It does not ship `updateLocked`, the
  single-`UPDATE` guard test or the table-driven writer race: the writers carry the four steps
  inline, and `onboarding-draft-approve-concurrency.test.ts` covers approve against a choice
  `PUT` and against approve, the owner-phone `PUT` against a choice `PUT`, and the timezone
  write against a choice `PUT`, on real Postgres and over HTTP. S4 extracts the helper with
  the first writers that follow (`setMetro`, undo, reset), re-expresses the existing writers over it
  with behaviour unchanged, and adds the guard and the `DRAFT_WRITERS` table that then replaces
  the scripted cases. The `packages/shared` wire schema and the web half (send the version,
  show `failed` and `stopped`) are not in #1694; they follow with the S2 consumers.
- **Files:**
  - modify `packages/api/src/onboarding/draft/contracts.ts` (`ApproveDraftBodySchema`:
    `{ expectedVersion? }`, a positive integer, optional until every client sends it, strict) and
    `packages/shared/src/contracts/onboarding-draft.ts` (`ApproveOnboardingDraftBodySchema`),
    kept equal by `packages/api/test/onboarding/draft/wire-contract.test.ts` (extend; the
    shared half ships with the S2 consumers, not in #1694)
  - modify `packages/api/src/onboarding/draft/repository.ts` (S1b: `getForTenantForUpdate(tenantId)`,
    the draft `SELECT … FOR UPDATE` that approve starts with, which refuses to run outside the
    request transaction because a lock taken there is released at once; and
    `markApproved(tenantId, proposalIds, expectedVersion)`, a compare-and-swap
    (`UPDATE … WHERE tenant_id = $1 AND status = 'draft' AND version = $3`) that throws
    `DraftVersionConflictError` or `DraftAlreadyApprovedError` when it matches nothing instead
    of returning the existing row; `setOwnerPhone` takes the four steps inline; S4: `updateLocked`,
    above, and `markApproved`, `stageChoice`, `setClientTimezone` and `setOwnerPhone` are
    re-expressed over it with their behaviour unchanged; the in-memory repository mirrors all
    of it)
  - modify `packages/api/src/onboarding/draft/approve.ts` (`approveDraft` takes
    `expectedVersion`, locks first, and builds from the locked row)
  - modify `packages/api/src/routes/onboarding-draft.ts` (`POST /draft/approve` validates the
    body and drops its own unlocked pre-read; one error mapper turns `DraftVersionConflictError`
    into 409 `VERSION_CONFLICT`, the code `PUT /draft/choices/:settingKey` already uses, and
    `DraftAlreadyApprovedError` into 409 `DRAFT_APPROVED` for every draft `PUT`; an already
    approved draft on approve stays the idempotent 200 `approvedNow: false` with the stored ids
    when the request carries no `expectedVersion` or the version the draft was approved from
    (`version - 1`), and answers 409 `VERSION_CONFLICT` for any other)
  - modify `packages/web/src/lib/onboardingDraftApi.ts` and
    `packages/web/src/hooks/useOnboardingDraft.ts` (`approve` sends the draft's `version`)
  - tests: `packages/api/test/onboarding/draft/approve.test.ts` (extend),
    `packages/api/test/onboarding/draft/repository-writers.test.ts` (S4: the helper's four steps
    and the single-`UPDATE` guard),
    `packages/api/test/routes/onboarding-draft.route.test.ts` (extend),
    `packages/api/test/integration/onboarding-draft-approve-concurrency.test.ts`,
    `packages/api/test/integration/onboarding-draft-writers-vs-approve.test.ts` (S4: the
    table-driven writer races; U5 and U6 add their rows in their own PRs),
    `packages/web/src/hooks/useOnboardingDraft.test.ts` (extend)
- **Approach:** `POST /draft/approve` takes `{ expectedVersion }`, the `version` of the draft
  the read-back was rendered from. The first statement of the approve transaction is
  `getForTenantForUpdate`. `withTenant` reuses the request-scoped client, so the row lock is held until
  the response commits or rolls back, and every other writer of the row waits behind it. Under
  the invariant that holds for every writer, not only the two that already took `FOR UPDATE`
  first (`stageChoice` and `setClientTimezone`): `PUT /draft/owner-phone`,
  `PUT /draft/metro` and `PUT /draft/forwarding` are born under the same lock. A write that
  arrives during an approval blocks, then finds the draft approved and gets `DRAFT_APPROVED`,
  whichever endpoint it came through; a write that took the lock first has bumped `version`,
  so an approval carrying the pre-write version gets `VERSION_CONFLICT` (and one carrying no
  version builds from the row exactly as the write left it). Under the lock, in this order:
  no row → 404; `status = 'approved'` → a repeat, and `expectedVersion` tells a retry from a
  stale tab. An approved draft is frozen (every field writer refuses it, and undo, reset and reopen
  move it out of `approved`) and `markApproved` bumps `version` once, so the version an
  approval was made from is always the approved row's `version - 1`. No `expectedVersion`
  (older clients post `{}`) or `expectedVersion = version - 1` → 200 `{ approvedNow: false }`
  with the ids the row already carries: a double tap, or a retry after a lost response, is a
  success, as S1 shipped. Any other `expectedVersion` → 409 `VERSION_CONFLICT` naming the
  version sent and the version the draft was approved from: that tab's read-back was stale
  (another tab edited and approved after it rendered), so the call must not be answered as
  though it had approved what that tab showed; the web re-reads and lands on the approved
  state. S1b implements exactly this rule, the 409 included. For a draft still in `draft`,
  `expectedVersion` present and `<>` the row's `version` → 409 `VERSION_CONFLICT` naming
  expected and found. None of these paths mints anything. A missing `expectedVersion` is
  accepted while older clients post `{}`: the
  row lock alone already serialises every writer against approve and approve against approve; S4 makes
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
  re-reads on a 409; a `VERSION_CONFLICT` on a draft that is still `draft` shows the existing
  one-line "your answers changed somewhere else" notice and the owner re-taps on the refreshed
  read-back (U3 renders it). A `VERSION_CONFLICT` whose re-read shows the draft `approved` (a
  stale tab) lands the shell on the approved state, which shows what was approved rather than
  what the tab last rendered, with no re-tap. A repeat tap or a retry after a lost response
  (same version) gets the idempotent 200 and the shell moves on to "Saving" with the ids it
  carries.
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
  - Edge (already approved): approve again with the version the draft was approved from
    (`version - 1`: a double tap, or a retry after a lost response) → 200 `approvedNow: false`
    with the same two ids, still exactly two proposal rows for the tenant and no new audit
    row; the same with no `expectedVersion` (older clients) → the same 200.
  - Edge (stale tab): tab A renders the read-back at version 5; tab B stages a change (the
    draft goes to 6) and approves from 6 (the draft is `approved` at 7); tab A approves with 5
    → 409 `VERSION_CONFLICT` naming 5 and 6, still exactly two proposal rows (B's), the draft
    and its `proposal_ids` untouched, no new audit row; an `expectedVersion` ahead of the row's
    → the same 409; after the re-read tab A sees `approved` and lands on the approved state.
  - Race, every draft writer vs approve (two real connections, both orders; scripted per
    writer in S1b's `onboarding-draft-approve-concurrency.test.ts` for `PUT /draft/choices/:key`,
    the timezone write and `PUT /draft/owner-phone`, then table-driven from S4 over a
    `DRAFT_WRITERS` list in `onboarding-draft-writers-vs-approve.test.ts` that starts with those
    three and gains `PUT /draft/metro` (S4, U5) and `PUT /draft/forwarding` (S5, U6), each row
    added by the PR that adds the endpoint): (a) the write takes the lock and commits first, then the approve that
    carries the pre-write version → `VERSION_CONFLICT`, no proposals, the new value is on the
    draft, and an approve that carries no version mints from the row with the new value in its
    payload; (b) the approve takes the lock first and commits, and the write that was waiting
    → 409 `DRAFT_APPROVED`, the draft row unchanged by it, and the draft's resolved choices
    and settings facts (owner phone, metro-derived city and prices, forwarding number and
    carrier) equal, field by field, the payloads of the two proposals that executed. Never: a
    proposal payload that differs from the committed draft's resolved fields.
  - Race, writer vs writer (two connections, looped): an owner-phone `PUT` and a choice `PUT`
    concurrently → both applied in lock order, `version` up by two, neither field lost (each
    computes its change from the locked row, not a stale copy).
  - Race, approve vs approve (two connections, both carrying the same `expectedVersion`,
    repeated in a loop so ordering luck cannot pass it): both return 200, the first with
    `approvedNow: true` and the one that waited behind the lock with `approvedNow: false` (it
    finds the draft approved and its `expectedVersion` equal to the row's `version - 1`, so it
    is a retry, not a stale tab); afterwards exactly one pair of `onboarding_*` proposals
    exists for the draft (counted by `source_context.draftId`), its ids equal the draft's
    `proposal_ids`, and both responses carry those same ids. The same race with the second
    approve carrying an older `expectedVersion` (a stale tab) → the first is 200
    `approvedNow: true`, the second 409 `VERSION_CONFLICT`, and still exactly one pair.
  - Unit: `markApproved` with a stale version, or on a non-`draft` status, throws and writes
    nothing, identically in the Pg and in-memory repositories; `approveDraft` builds from the
    row `getForTenantForUpdate` returned (a repo double that changes the row after an earlier read proves
    the earlier read is unused); `approveDraft` on an `approved` row returns the stored ids for
    no `expectedVersion` or `version - 1` and throws `DraftVersionConflictError` for any other
    (one parametrised case, Pg and in-memory); every field writer refuses an `approved` draft, compares a
    supplied `expectedVersion` and bumps `version` (one parametrised case per writer); a guard
    test reads `onboarding/draft/repository.ts` and fails if `UPDATE onboarding_drafts` appears
    anywhere but the helper.
  - Web: `approve` sends the hook's current version; a 409 `VERSION_CONFLICT` re-reads and sets
    the notice; a 409 `VERSION_CONFLICT` whose re-read shows the draft `approved` (the stale
    tab) lands on the approved state with no notice and no re-tap; a repeat approve resolves
    as success with the same ids and leaves no error; a double tap sends one request.
  - Integration: all of the races above on real Postgres under RLS, in
    `packages/api/test/integration/`, as CLAUDE.md requires for a DB-touching change.
- **Verification:** no interleaving of draft writes (any endpoint), a timezone write and one or
  more approvals yields proposals that differ from the approved draft's resolved choices, or more
  than one proposal pair per draft; and a stale tab's approval of an already approved draft is
  refused with 409 instead of being answered as an approval it never made, while a retry of the
  same approval is still a 200.

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
    (`onPaymentCollectionModeChanged(client, before, after)`, run inside the settings write's
    own transaction by both write sites of the key, the `onboarding_voice_policy` handler in
    `proposals/execution/onboarding-handlers.ts` and `PATCH /api/settings` in
    `routes/settings.ts`, through a new `afterWrite` option on `SettingsRepository.update`),
    `packages/api/src/workers/deactivate-payment-links.ts` (the queue handler, registered in
    `app.ts`) and `packages/api/src/workers/payment-link-reconciliation-sweep.ts` (the daily
    backstop); modify `packages/api/src/queues/queue.ts` and `pg-queue.ts` (`sendOn(client,
    type, payload, idempotencyKey, options)`: the same `INSERT … ON CONFLICT (idempotency_key)
    DO NOTHING` on a caller-supplied client, with the table bootstrap done first on the queue's
    own connection; the in-memory queue implements it as a plain send),
    `packages/api/src/settings/settings.ts` and `pg-settings.ts` (the `afterWrite` option: it
    runs inside `update`'s transaction after the row write and before commit, with the prior
    and new rows read under the row lock), `packages/api/src/invoices/invoice-payment-link.ts` (a
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
    `packages/api/test/workers/payment-link-reconciliation-sweep.test.ts`,
    `packages/api/test/integration/pg-queue-send-on.test.ts`,
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
  a policy change, in three pieces so that no single failure leaves a live link behind.
  - *Atomic enqueue.* Both write sites run `onPaymentCollectionModeChanged` inside the
    settings write's own transaction (the `afterWrite` option on `SettingsRepository.update`),
    not after it. It compares the prior and the new value, both read under the row lock; when
    the stored value moved from `pay_link` or from unset to `collect_on_site` it inserts the
    `deactivate_payment_links` job row with `queue.sendOn(client, …)` on that same client:
    payload `{ tenantId, pass: 1 }`, idempotency key `deactivate-payment-links:<tenantId>:<settings
    updated_at>`. Unset counts: an absent key means the `pay_link` default (D-039/D-040), so a
    tenant that never answered the card can hold live links from before the card existed.
    `PgQueue.send` takes its own pooled connection, so enqueueing after the write would let a
    worker claim the job before the settings transaction committed, re-read `pay_link` and
    no-op, with the job gone, and a crash between the commit and the enqueue would lose it.
    Written in the transaction, the job row and the new mode commit together or not at all: a
    worker cannot see the job until the mode it will re-read is committed, and a rolled-back
    write leaves no job. This is the P0-009 async-worker pattern `provision-twilio` uses, with
    an outbox-style insert. No Stripe call runs inside a settings request or a proposal
    execution, so a Stripe outage cannot fail a settings write.
  - *The job.* The handler re-reads the mode first and does nothing if it is no longer
    `collect_on_site` (the owner switched back before the job ran). Otherwise it pages
    through the tenant's `open` and `partially_paid` invoices that hold a link
    (`findOpenWithPaymentLink`) and calls `deactivateInvoicePaymentLink` on each with the new
    reason `payment_mode_changed`. That helper deactivates the link at Stripe under whichever
    account scope minted it, clears the columns only while they still hold that link, and audits
    each invoice (`invoice.payment_link_deactivated`, or `_deactivation_failed` with the columns
    kept); one tenant-level event records the counts. If any invoice failed, the job throws after
    the batch so the queue retries only what is left: a cleared invoice no longer qualifies,
    which is also what makes a re-run safe. A `pass: 1` job enqueues exactly one follow-up, before
    it starts its batch: `{ tenantId, pass: 2 }` with `delaySeconds: 120`, under a key of its own,
    the first pass's key plus `:pass2` (`deactivate-payment-links:<tenantId>:<settings
    updated_at>:pass2`). It needs its own key because the queue's unique index
    (`ON CONFLICT (idempotency_key) DO NOTHING`) would silently drop a second message that
    reused the first pass's key, and the `pass` field in the payload is what caps the chain: a
    `pass: 2` job never enqueues anything, so there are exactly two passes and no job can
    reschedule itself forever. Enqueueing before the batch means a pass 1 that throws and is
    retried still leaves its follow-up, and the retry's identical key inserts nothing new. The
    follow-up catches a link whose mint read `pay_link` just before the switch committed.
  - *Reconciliation.* A daily leader-gated sweep (`workers/payment-link-reconciliation-sweep.ts`,
    the P0-009 sweep pattern; it excludes `tenants.demo` like every other tenant lister, U7)
    lists the tenants whose `payment_collection_mode` is `collect_on_site` and, for each one
    that `findOpenWithPaymentLink` says still holds a live link, enqueues a `pass: 1` job under
    `deactivate-payment-links:<tenantId>:sweep:<UTC date>`. It catches what the enqueue path
    cannot see: a job that was lost or dead-lettered, a link minted after both passes by a path
    that read a stale mode, and links that predate the policy. A tenant with no live link costs
    one query and no job.

  Switching back to `pay_link` needs nothing: the pay-now flows mint a fresh link on demand once
  the columns are empty.
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
    invoice is untouched. The same two invoices on a tenant whose key was unset (a legacy
    tenant that never answered the card), switched to `collect_on_site` → one job, and running
    it deactivates both links.
  - Mode change (no-op when none): a tenant with no live links → the job succeeds, the provider
    is not called, no per-invoice events; a switch back to `pay_link` before the job runs → the
    job re-reads the mode and does nothing.
  - Mode change (which writes enqueue): `pay_link` → `collect_on_site` and unset →
    `collect_on_site` each enqueue exactly one job (the unset case matters: legacy links stay
    chargeable unless it does); `collect_on_site` written over `collect_on_site`, any switch to
    `pay_link`, `pay_link` over `pay_link` and a settings write that does not touch the key
    enqueue nothing.
  - Mode change (atomic enqueue, real Postgres, two connections): a worker polling the queue
    while the settings transaction is still open sees no job, and once it commits sees one
    whose handler reads `collect_on_site`; a settings write that rolls back (a fault injected
    after the `afterWrite` hook, and a hook that throws) leaves the old mode and no job row; a
    connection killed between the row write and the commit leaves neither; `sendOn` on a key
    that already exists inserts nothing and does not throw. Run for both write sites: `PATCH
    /api/settings` (the request transaction) and the `onboarding_voice_policy` handler (its
    own transaction).
  - Mode change (idempotent re-run): running the job twice, and enqueueing it twice under one
    idempotency key, makes no second provider call and writes no second audit row for an
    invoice already cleared; one invoice whose Stripe call fails keeps its columns and is
    audited as failed, the others are still deactivated, the job throws, and the retry touches
    only the failed one.
  - Mode change (the follow-up pass): a `pass: 1` job enqueues exactly one `pass: 2` job, under
    the first key plus `:pass2` with a 120 s delay (assert the key differs from the first
    pass's, so the unique index keeps both), and a retry of pass 1 enqueues no second one; the
    `pass: 2` job runs once, deactivates a link minted by a racing request just after the first
    pass, and enqueues nothing (no pass 3, whatever the outcome); with the mode switched back
    before it runs it does nothing; the cap is read from the payload's `pass`, not inferred
    from the key.
  - Mode change (reconciliation sweep): a `collect_on_site` tenant holding a live link whose
    job row was deleted, and another holding a link minted after both passes → the sweep
    enqueues one `pass: 1` job each and running it deactivates the link; a second sweep the
    same day enqueues nothing new (same key); a `collect_on_site` tenant with no live link, a
    `pay_link` tenant and a `tenants.demo` tenant → no job.
  - Integration: a tenant with `collect_on_site` issues an invoice against real Postgres and the
    stored message carries no link; `findOpenWithPaymentLink` returns only `open` and
    `partially_paid` rows that hold a link, tenant-scoped under RLS and paged.
- **Verification:** picking a card changes what the customer receives and what Rivet says, with
  a behaviour test per key, before the card copy is allowed to promise it; a pay link texted
  before a switch to collect-on-site no longer charges once the job has run (or, if the job
  was lost, once the daily sweep has); and a failed mode read never produces a link.

### U7. Pre-signup "hear it answer" demo call (decision-gated)
- **Goal:** A visitor enters a cell and trade on the landing page, receives a sixty-second
  call answered as their business that books a sample job, then a signup text.
- **Requirements:** R1 (value before identity)
- **Dependencies:** U2, U4; voice-parity U3 for the preset voice on the call
- **Files:**
  - modify `packages/api/src/integrations/credentials.ts` (explicit `PLATFORM_TWILIO_*`)
  - create `packages/api/src/demo/{routes,service,script,lease,lease-token,reset,job-guard,inflight,write-fence,call-budget}.ts`,
    migration `316_demo_calls` (313 went to the owner-cell column in S1b and 314-315 are S5's;
    phone hash, trade, name, lease_id, call_sid, status, lead_id, and the budget reservation
    the call holds: `budget_day`, `reserved_cents`, `budget_released_at`; no `tenant_id`); the
    same migration adds `demo_call_budget` (`day` DATE primary key, `calls_reserved`,
    `calls_cap`, `est_cost_cents`, `cost_cap_cents`, all integers, CHECKs added `NOT VALID`; see
    Daily budget), `demo_tenant_leases` and `demo_inflight_jobs` (see Approach), a unique index
    on `demo_tenant_leases.call_sid WHERE call_sid IS NOT NULL`, the sequence
    `demo_lease_generation_seq` and `tenants.demo BOOLEAN NOT NULL DEFAULT false`
  - create the demo tenant pool per trade, each tenant cloned from that trade's fixture, via a
    seed script `packages/api/scripts/seed-demo-tenants.ts` (idempotent; pool size
    `DEMO_POOL_PER_TRADE`, default 3)
  - create `packages/api/src/workers/demo-lease-reaper.ts` (a leader-gated P0-009 sweep that
    reclaims expired leases, takes over resets whose heartbeat has gone stale and reaps
    in-flight registry rows whose heartbeat has lapsed); extract the
    `information_schema` table walk that `tenants/deprovision.ts` uses to purge a tenant into a
    shared helper that takes a keep-list, an optional batch size and a `beforeStep` fence hook
    (deprovision passes none of them and keeps its single transaction; `demo/reset.ts` passes
    `demo_tenant_leases`, `demo_inflight_jobs`, the tenant row and the audit trail, bounded
    batches and the token fence)
  - modify `packages/api/src/db/rls-runtime-role.ts` (`applyTenantContext`, the one function
    every tenant-scoped transaction opener calls, runs the write fence from
    `demo/write-fence.ts` through a registered hook, so `db/` does not import `demo/`, whenever
    the async context carries a demo lease)
  - modify every sweep and report that lists tenants so it excludes `tenants.demo` (found by
    grepping `FROM tenants` and the tenant lister under `workers/`, `billing/`, `analytics/`
    and `metrics/`; at least `workers/setup-reminder-sweep.ts`, `trial-reminder-sweep.ts`,
    `dunning-sweep.ts`, `money-reconciliation.ts`, `overage-settlement-reconciliation.ts` and
    `billing/call-usage-billing.ts`), and the platform-admin tenant list
  - modify `packages/api/src/app.ts` (public route with the `/public` IP limiter at :839;
    `handleQueueMessage` runs `demo/job-guard.ts` before any handler, which checks the
    generation, registers the job in `demo_inflight_jobs` and heartbeats it, and the queue is
    wrapped so an enqueue for a demo tenant must carry a lease generation),
    `packages/api/src/workers/execution-worker.ts` (a demo tenant's proposals are claimed only
    under an `active`, unexpired lease, and run with that lease's generation in context),
    `packages/api/src/shared/rate-limit/phone-rate-limit.ts` (platform sentinel tenant, one
    call per number per day), `packages/api/src/flags/voice-flags.ts` (kill switch)
  - reuse `telephony/outbound-call-service.ts:266` REST pattern minus the customer bridge,
    `ai/skills/disclose-recording.ts` copy pattern for the consent line,
    `voice/outbound-allowlist.ts` NANP and premium checks, `leads/lead-service.ts`
  - web: `docs/marketing/landing-page.html` CTA pair and a `packages/web` public page
    `components/public/HearItAnswer.tsx`; modify `packages/web/src/components/auth/SignupPage.tsx`
    (forward the handoff token) and the Clerk signup webhook handler in `packages/api/src/`
    (copy it onto the tenant)
  - tests: `packages/api/test/demo/{service,routes,limits,lease,lease-token,reset,job-guard,inflight,write-fence,call-budget}.test.ts`,
    `packages/api/test/integration/demo-calls.test.ts`,
    `packages/api/test/integration/demo-call-budget.test.ts`,
    `packages/api/test/integration/demo-callback-binding.test.ts`,
    `packages/api/test/integration/demo-tenant-leases.test.ts`,
    `packages/api/test/integration/demo-reset-fencing.test.ts`,
    `packages/api/test/integration/demo-job-generation.test.ts`,
    `packages/api/test/integration/demo-inflight-fence.test.ts`,
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
  (`id`, `tenant_id`, `visitor_phone_hash`, `call_sid`, `leased_at`, `expires_at`, `state`
  (`active | resetting | released`, CHECK added `NOT VALID`), `reset_started_at`,
  `reset_heartbeat_at`, `reset_token` (the fencing token), `generation`, `released_at`) in one
  transaction: the tenant is picked `FOR UPDATE SKIP LOCKED` among the
  trade's demo tenants with no unreleased lease, and a partial unique index on `tenant_id WHERE
  released_at IS NULL` is the backstop (it covers `active` and `resetting` alike), so two
  callers can never hold one tenant (a second, on `visitor_phone_hash` under the same
  predicate, stops one visitor holding two). `expires_at`
  is the call start plus the longest a demo can run: the call is created with a Twilio ring
  `Timeout` of 30 s and a `TimeLimit` of 90 s, and the lease adds 30 s of grace, 150 s in all,
  so a lease cannot lapse under a live call. The inbound turn processor gets its tenant from the
  `active` lease its callback names (next paragraph), never from a trade-level lookup. A Twilio
  failure on the `Calls` request releases the lease at once, and a definitive one also returns
  the day's budget reservation (Daily budget, below).
- **Callbacks find the lease by a signed token, not by `call_sid`.** Twilio can answer the
  visitor and fetch the voice URL, or send a terminal status callback (`failed`, `busy`,
  `no-answer`, `completed`), before the outbound `Calls` request has returned to us and before
  any post-create write has committed. A lookup by `call_sid` finds no lease in that window: a
  fast answer would hear the busy line and the demo call would be lost, and an early terminal
  callback would match nothing and skip its cleanup, leaving the tenant held until the reaper's
  `expires_at` sweep. So the lease is named by something we mint before Twilio can call us, in
  this order. (1) The lease insert commits, `call_sid` still null. (2) `demo/lease-token.ts`
  mints a token over the lease id, the tenant id and an expiry equal to the lease's
  `expires_at`: `base64url(payload).HMAC-SHA256(payload)` with a required discriminator
  `a: 'demo_lease'`, verified with `timingSafeEqual`, the construction of
  `proposals/one-tap-undo.ts` (the discriminator is why a one-tap approve or undo token cannot
  verify as this one), keyed by a platform secret `DEMO_LEASE_TOKEN_SECRET` read the way
  `ONE_TAP_APPROVE_SECRET` is in `app.ts` (explicit in prod and staging, a fixed dev fallback
  elsewhere). It is not single-use, because one call produces several status callbacks, so it
  consumes no nonce. (3) The `Calls` request carries it in BOTH callback URLs, the voice `Url`
  and the `StatusCallback`, as `?lease=<token>`. `requireTwilioSignature`
  (`telephony/twilio-signature.ts`) validates the exact URL Twilio called, query string
  included, so the token also sits inside Twilio's own signature check; the two layers are
  independent. (4) Each callback verifies the token (signature, discriminator, expiry), loads the
  lease by the id inside it and binds the CallSid it carries in one statement: `UPDATE
  demo_tenant_leases SET call_sid = $sid WHERE id = $lease AND (call_sid IS NULL OR call_sid =
  $sid)`. One row means this is the first sight of the CallSid, or the CallSid already bound
  (Twilio's retries and the later status callbacks); zero rows means a different CallSid is
  bound, and the callback is rejected with 403, writes nothing and audits
  `demo_callsid_mismatch`. The voice callback then answers as the demo tenant only while the
  lease is `state = 'active' AND expires_at > now()`; otherwise it speaks the busy line and
  hangs up. The `Calls` response runs the same statement with the sid it
  returns, so whichever of the first callback and the response arrives first binds and the
  other verifies; the response is no longer the only thing that can bind, and nothing depends on
  its bookkeeping having committed. The unique index on `call_sid` stops one CallSid binding two
  leases. `demo_calls` carries `lease_id` from the lease transaction, so its status and the
  signup SMS after `completed` key on the lease too, not on a `call_sid` that may not be written
  yet. Later hops of the same call (the turn processor's Gather actions and its stream)
  resolve the tenant by the bound `call_sid` under `state = 'active' AND expires_at > now()`,
  which is safe because the first callback committed the bind before it returned TwiML. A
  forged, tampered, other-secret or wrong-purpose token is 403 and writes nothing. An expired
  token is treated like a reclaimed lease: the voice callback speaks the busy line and hangs up,
  a status callback answers 200 and does nothing, and the reaper owns the cleanup. An early
  terminal callback binds the CallSid and then takes `resetAndRelease`'s claim exactly as a late
  one does.
- **Release and reset.** The lease is the tenant's hold on the pool, so it is never touched
  until the tenant is clean. The call-status callback (completed, failed, busy, no-answer,
  canceled; it finds its lease by the signed token, so one that beats the `Calls` response
  counts) and the reaper (every 30 s, for `active` leases past `expires_at`) can both fire
  for one lease, and a reset can outlive the process that began it, so they end the lease
  through one function, `resetAndRelease`, built on a claim, a heartbeat and a fencing token.
  (1) Claim: `UPDATE demo_tenant_leases SET state = 'resetting', reset_started_at = now(),
  reset_heartbeat_at = now(), reset_token = gen_random_uuid(), generation =
  nextval('demo_lease_generation_seq') WHERE id = $1 AND state = 'active' RETURNING
  reset_token`; zero rows means the other path holds the lease or it is already released, and
  this one does nothing (the callback still answers Twilio 200). The claim runs under `SET
  LOCAL lock_timeout = '5s'`: its row lock waits behind any demo write transaction holding the
  share lock described under Queued work, and a timeout leaves the lease `active` and counts as
  zero rows, so the other path, or the reaper once `expires_at` passes, claims it. The fresh
  `generation` is the claim's first effect on queued work: it invalidates every job stamped
  before it (see Queued work). `reset_token` is the resetter's fencing token for everything below.
  (2) Heartbeat: while the reset runs, the resetter renews `reset_heartbeat_at` every 10 s
  from its own pooled connection (`UPDATE … SET reset_heartbeat_at = now() WHERE id = $1 AND
  state = 'resetting' AND reset_token = $token`); zero rows means it was taken over, and it
  stops. The reaper alone may take over a `resetting` lease, and only when the heartbeat is
  stale by 60 s (six missed beats): `UPDATE … SET reset_token = gen_random_uuid(),
  reset_heartbeat_at = now() WHERE id = $1 AND state = 'resetting' AND reset_heartbeat_at <
  now() - interval '60 seconds' RETURNING reset_token`. The age of the claim never justifies a
  takeover, so a slow purge that is still alive is left alone, and a resetter that died is
  replaced within about a minute: that is how a reset interrupted by a crash finishes.
  (3) Fenced steps: a stale heartbeat is a judgement, not proof (a paused process or a
  partitioned network can come back), so the heartbeat alone does not keep two resetters
  apart. The token does. Every side effect of the reset carries it and is a no-op once the
  lease's token has changed: each delete batch, the queue cancel, the re-seed and the
  release runs as its own short transaction (a single statement for the release) that opens
  with `SELECT 1 FROM demo_tenant_leases WHERE id = $1 AND state = 'resetting' AND
  reset_token = $token FOR SHARE`; zero rows rolls the step back and the resetter stops
  without writing again. `FOR SHARE` makes the check and the write one act: a takeover's token
  `UPDATE` waits for a batch in flight to commit, so no write of the old resetter can land
  after the successor holds the token, and the old resetter's next step fails its check. The
  batches are bounded (the shared walk deletes one table at a time in chunks of
  `DEMO_RESET_BATCH_ROWS`, default 1,000), so a share lock never holds a heartbeat back for
  more than a few seconds; stored-object deletions run in fenced batches the same way.
  (4) Release: `UPDATE … SET state = 'released', released_at = now() WHERE id = $1 AND state =
  'resetting' AND reset_token = $token`, so a resetter whose claim was taken over cannot
  release the lease from under its successor. `released_at` is set only here, after the
  reset, so the tenant stays unleasable (the picker and the partial unique index both look at
  `released_at IS NULL`) through every step.
  The reset itself runs in this order, each step fenced: the queue cancel and drain (see
  Queued work); then deletion of the tenant's rows from every table that carries a
  `tenant_id` (the shared deprovision table walk, so a table added later is purged by
  default) except a keep-list handed to that walk: the tenant row (`tenants`; deprovision's
  closing `DELETE FROM tenants` is not part of a reset), **`demo_tenant_leases`** and the
  append-only audit trail (it stays, flagged by `tenants.demo`). The lease table must be on
  the list because its `tenant_id` names this very tenant: a walk that deleted it would erase
  the lease row while the reset is still running, before `released_at` is set, so the tenant
  would look free mid-reset and, after a failed reset, would sit free and still dirty. Then
  the re-seed of settings, catalog and templates from the fixture with the clone function the
  seed script uses, in one fenced transaction (the walk has emptied those tables, so a
  repeated re-seed starts from empty and cannot duplicate), and the deletion of the tenant's
  stored objects the way a purge does. A reset that fails at any step stops there, alerts and
  returns the claim, fenced like every other write (`UPDATE … SET state = 'active',
  expires_at = now() WHERE id = $1 AND state = 'resetting' AND reset_token = $token`), so the
  reaper's next sweep retries the whole reset from the top; every step is safe to repeat (the
  walk deletes what is left, the re-seed runs on empty tables). The batches commit
  separately, so a failed reset leaves the tenant partly cleaned rather than rolled back; the
  lease stays unreleased throughout, so that tenant stays out of the pool and is never leased
  dirty. A returned claim has `expires_at = now()`, so nothing can start under it: the turn
  processor and the generation stamp both require `state = 'active' AND expires_at > now()`.
- **Queued work and the lease generation.** The table walk cannot see the queue:
  `_queue_messages` has no `tenant_id` column (the tenant is a key inside the JSON `payload`,
  `queues/pg-queue.ts`), and the walk finds tables by that column. A transcript, notification
  or proposal-execution job created during a demo could otherwise run after the reset, or
  after the tenant's next lease, against someone else's call. So queued work is fenced by a
  generation, separately from the rows.
  - *Stamp.* `demo_tenant_leases.generation` is a BIGINT drawn from
    `demo_lease_generation_seq` when the lease is created and replaced by a fresh draw at the
    reset's claim, so no two leases of a tenant, and no lease and its own reset, share a
    value. Every job enqueued for a demo tenant carries `leaseGeneration` in its payload. The
    generation travels in an async context (`demo/job-guard.ts`) set by whoever owns the
    lease: the turn processor, from the `active`, unexpired lease its callback's token names (the bound
    `call_sid` on later hops), and
    the queue guard, from the incoming payload before it calls a handler. The wrapper around
    `queue.send` and `queue.sendOn` stamps from that context and refuses an enqueue for a
    demo tenant (`tenants.demo`) made outside one. It never reads the lease table, so a
    straggler from an old generation can only produce follow-ups stamped with its own old
    generation, never a newer one.
  - *Check.* Every queue message passes `handleQueueMessage` in `app.ts` before any handler
    runs. When the payload's `tenantId` is a demo tenant, the guard requires `leaseGeneration`
    to equal the `generation` of that tenant's unreleased lease while it is `active`; a
    missing stamp, an older generation, a `resetting` or released lease, or no lease drops the
    job: the message is deleted, the handler is never called and `demo_job_dropped` is
    audited (job type, message id, stamped and current generation). Work claimed by table
    follows the same rule: the execution worker claims a demo tenant's proposal only under an
    `active`, unexpired lease. A job that a call queued and that had not run when the call
    ended is dropped by design: the data it would act on is about to be wiped.
  - *Write fence.* The check above is a check at one instant, and a handler can outlive it.
    `PgQueue` hides a claimed row only until `visible_at`, a retry lease of the visibility
    timeout times a backoff factor (`queues/pg-queue.ts`); after that any consumer may claim
    the same message again, and nothing stops the first handler, which may still be writing.
    So a handler's writes do not trust the generation it started with. For a demo tenant,
    every tenant-scoped transaction re-validates it at write time. `applyTenantContext` runs,
    as the first statement after the tenant context is set and inside the same transaction as
    the write, `SELECT 1 FROM demo_tenant_leases WHERE tenant_id = $1 AND generation = $2 AND
    state = 'active' AND expires_at > now() FOR SHARE`, where `$2` is the `leaseGeneration` in
    the async context (`job-guard.ts` sets it for the turn processor, the queue guard and the
    execution worker; the reset's own steps carry no lease context and keep their token
    fence). Zero rows throws `StaleLeaseGenerationError`: the transaction rolls back,
    `demo_write_rejected` is audited (job type, stamped and current generation), and the guard
    deletes the message instead of letting the queue retry it. A lease context in a
    non-transactional session is refused. The share lock makes check and write one act, as the
    reset token's does: the reset claim (the `UPDATE` that replaces the generation) waits for
    every write transaction already past its check to commit, and any later transaction fails
    the check, so no write lands under a generation the claim has replaced. The lease row is
    otherwise written only by the lease lifecycle (`call_sid` bind, claim, heartbeat,
    return, release), so the share locks queue behind nothing else. A write that is not a
    database write cannot join the transaction; for a demo tenant that is a stored-object
    upload, keyed under the lease generation, so a late upload lands under a key no read path
    of the next lease reaches and the next reset's object sweep deletes. (Demo tenants have no
    Twilio subaccount, Stripe customer or Clerk organisation, so no other external effect
    exists to fence.)
  - *In-flight registry.* The drain does not infer that a handler has finished from the
    queue: `visible_at` lapses on its own clock, independent of the claimed handler, so a
    handler that outlives its window drops out of any predicate on it while it can still be
    running. The drain waits on an explicit registry. `demo_inflight_jobs` (`id`, `tenant_id`,
    `lease_id`, `generation`, `message_id`, `attempt`, `claimed_at`, `heartbeat_at`; a platform
    table without RLS, its `tenant_id` only naming the demo tenant, as on the lease table)
    holds a row for every demo job the front door lets through. `job-guard.ts` runs the
    generation check as a `SELECT … FROM demo_tenant_leases … FOR SHARE` and inserts the
    registry row in that same short transaction, so a job either registers before a reset
    claim, and the drain sees it, or fails the check and is dropped; never neither. It renews
    `heartbeat_at` every 10 s from its own pooled connection for as long as the handler runs,
    and deletes the row when the handler returns or throws. If the queue redelivers the message
    while the first handler is still running, the second handler registers a second row (keyed
    by message and attempt), because it is also running. A row whose heartbeat is 60 s stale
    belongs to a dead process: the reaper, and the drain for its own tenant, delete it and
    audit `demo_inflight_reaped`. Reaping never makes a resurrected process safe by itself;
    the write fence does that. The execution worker claims a proposal by table, not by queue
    message, so it registers nothing: it sets the same lease context, its handler's writes
    pass the same fence, and the drain still lists the tenant's `executing` proposals.
  - *Reset.* Between the claim and the row walk, each step fenced: (i) the claim has already
    replaced the generation, so nothing stamped earlier can pass the front-door check, no
    write transaction under the old generation can start, and nothing new starts under the old
    one; (ii) the queue cancel deletes the tenant's unclaimed rows,
    `DELETE FROM _queue_messages WHERE payload->>'tenantId' = $1 AND attempts = 0` (a JSON-path
    predicate, since there is no column; delayed jobs are unclaimed and go too); (iii) the
    drain waits for in-flight work to finish: every `demo_inflight_jobs` row of the tenant (any
    generation; a row leaves when its handler returns or throws, or when it is reaped as
    stale) and every `executing` proposal of the tenant, polled every second up to
    `DEMO_RESET_DRAIN_SECONDS` (default 90: the 60 s heartbeat staleness plus 30 s, so a dead
    handler is reaped before the deadline). It never reads `visible_at`
    or `attempts`; (iv) the tenant's remaining queue rows are deleted. The fence is what keeps
    a late handler from writing; the drain is the second layer, keeping the lease unreleased
    while work that could still do something else is running. A handler still registered at
    the deadline fails the step (alert, claim returned, reaper retries), so `released_at` is
    never set while a job may still be running for the tenant, and a hung handler keeps its own
    tenant out of the pool instead of leaking into the next call; if it wakes, its next write
    is rejected by the generation check.
- **Pool exhausted.** When no demo tenant of the trade is free, the request is refused up front
  with 503 `DEMO_BUSY` and the page says "Every line is busy. Try again in a minute."; nothing
  is written (no lease, no `demo_calls` or lead row, no call, and the visitor's one-call-a-day
  allowance is not spent). A call that is answered after its lease was reclaimed speaks the
  same line and hangs up, again writing nothing. Pool size is the concurrency ceiling; the kill
  switch and the daily budget still apply.
- **Never visible to owners.** Demo tenants have no `users` rows, no Clerk organisation, no
  Stripe customer or subscription and no Twilio subaccount, so no owner, dispatcher or billing
  surface can reach one. Every sweep, report and analytics query that lists tenants excludes
  `tenants.demo`, funnel and product analytics drop events from demo tenants, and the
  platform-admin tenant list hides them behind an explicit filter.
- **Daily budget: an aggregate bound, reserved before the call.** The IP limiter, the
  one-call-per-number limiter and the pool size each bound one axis (a source, a number,
  concurrency) and none bounds the total: a visitor who rotates IPs and numbers is slowed by
  neither limiter, and every call also consumes a demo tenant and a reset-and-release cycle. So
  the platform needs a ceiling on calls placed and cents committed per UTC day, and it has to be
  taken before the call exists: a counter bumped once the call is up is a log, not a cap. A
  search of `packages/api` found nothing to extend. `PhoneRateLimiter` is a tenant-scoped event
  counter per key (it is the one-call-per-number limiter; it counts events, not cost, and
  returns nothing). `tenant_budget_counters` is tenant-scoped with RLS and adds executed spend
  after the fact, with no cap predicate and no reservation. `session-cost-tracker` caps one
  session's LLM cost, and the gateway's tenant quota meters LLM tokens per tenant. None of them
  gates outbound telephony spend across the platform. What is reused is the pattern of
  `tenant_budget_counters`: UTC-day windows (`utcDayWindowStart`) and `INSERT … ON CONFLICT …
  DO UPDATE`, so concurrent writers on any instance never lose an update.
  - *The table.* `demo_call_budget(day DATE PRIMARY KEY, calls_reserved INTEGER, calls_cap
    INTEGER, est_cost_cents INTEGER, cost_cap_cents INTEGER)`: a platform table (no
    `tenant_id`, no RLS, admin-write), one row per UTC day, integer cents only.
    `est_cost_cents` is the sum of the per-call estimates reserved so far, not a measured bill.
  - *Reserve, atomically, before the Twilio request.* `demo/call-budget.ts` runs one statement:
    `INSERT INTO demo_call_budget (day, calls_reserved, calls_cap, est_cost_cents,
    cost_cap_cents) SELECT $day, 1, $cap, $unit, $costCap WHERE $cap >= 1 AND $unit <= $costCap
    ON CONFLICT (day) DO UPDATE SET calls_reserved = demo_call_budget.calls_reserved + 1,
    est_cost_cents = demo_call_budget.est_cost_cents + $unit WHERE
    demo_call_budget.calls_reserved < demo_call_budget.calls_cap AND
    demo_call_budget.est_cost_cents + $unit <= demo_call_budget.cost_cap_cents RETURNING
    calls_reserved, calls_cap, est_cost_cents, cost_cap_cents`. One row means the call is inside
    both caps and its slot and cents are taken; zero rows means a cap is reached. The conflict
    branch's `WHERE` is evaluated under the row lock that `DO UPDATE` takes, so concurrent
    reservations serialise on the day's row and cannot all pass a check that only some fit; the
    insert branch has its own `WHERE`, so the first reservation of a day cannot slip past a zero
    or sub-unit cap. The statement runs inside the lease transaction, right after the lease
    insert and with the `demo_calls` row (which records `budget_day` and `reserved_cents`), and
    that transaction commits before the `Calls` request is built: no call can exist without a
    committed reservation. Zero rows rolls the transaction back and answers exactly like an
    exhausted pool: 503 `DEMO_BUSY` and "Every line is busy. Try again in a minute.", with no
    lease, no `demo_calls` or lead row, no Twilio request, and the visitor's one-call-a-day
    allowance unspent. An exhausted pool refuses before the statement runs, so it reserves
    nothing. The day is the UTC date of an injected clock, so 00:00 UTC starts a new row and a
    full yesterday blocks nothing.
  - *Release.* The reservation is returned (`calls_reserved - 1` and `est_cost_cents -
    reserved_cents` on the row of `budget_day`, not today's) only when the `Calls` request
    fails definitively before any CallSid is bound: a Twilio response that created no call, or a
    failure before the request was sent. It runs once, in the transaction that sets
    `demo_calls.budget_released_at` (`WHERE budget_released_at IS NULL`, and only while the
    lease's `call_sid` is still null), so a retried failure handler cannot decrement twice and a
    callback that already bound a CallSid pins the reservation. An ambiguous outcome (a timeout after
    the request left) keeps the reservation, because a call may exist and be billed; so does a
    bound CallSid, answered or not, and a crash after the commit. The count therefore errs
    toward the cap and never past it.
  - *Configuration and alerts.* `DEMO_CALLS_DAILY_CAP` (default 50), `DEMO_COST_DAILY_CAP_CENTS`
    (default 2500) and `DEMO_CALL_EST_COST_CENTS` (default 50: a per-call figure for the 90 s
    `TimeLimit`, which the staging measurement under Verification replaces) are integers read at
    boot. A missing value uses its default; one that is malformed, zero or negative, or a unit
    estimate above the cost cap, fails the demo module closed (every request refused, logged)
    rather than guessing. The caps are written onto the day's row when it is created, so a
    changed env applies from the next UTC day; the kill switch is the immediate lever. The
    reservation that takes either count to 80% of its cap (integer arithmetic,
    `calls_reserved * 5 >= calls_cap * 4` and `est_cost_cents * 5 >= cost_cap_cents * 4`,
    checked on the returned row and on the same counts less this reservation, so only the
    reservation that makes the upward crossing alerts) logs, alerts and writes a `demo_budget_alert` audit
    row; the one that fills a cap does the same once more; refusals after that increment a
    metric and do not page again.
- **Consent, limits, handoff.** Consent line first; two-layer rate limits; the daily budget
  above, the only aggregate bound; a lead row in a platform marketing tenant. The signup SMS
  link carries a signed, single-use handoff token (HMAC over `lead_id` and an expiry). Migration 316 also adds a platform table
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
  - Error: Twilio 5xx → row `status='failed'`, lease released, the day's budget reservation
    returned, no SMS, no lead; handoff token reused or
    expired → ignored, the shell asks for name and trade.
  - Isolation (two concurrent callers get distinct tenants): two real connections leasing for
    the same trade, repeated in a loop → distinct demo tenants, and rows one call wrote are not
    visible under the other's tenant; a pool of N with N+1 concurrent callers → exactly one is
    refused.
  - Isolation (exhausted pool refuses without writes): all of a trade's demo tenants leased →
    503 `DEMO_BUSY` with the busy copy, and no lease, `demo_calls`, lead or SMS row, no call
    placed, the visitor's daily allowance unspent; a call answered after its lease was
    reclaimed speaks the busy line, hangs up and writes nothing.
  - Daily budget (concurrent reservations never exceed the cap; real Postgres, three or more
    connections, repeated in a loop so ordering luck cannot pass): with `calls_cap` N and N + 5
    simultaneous requests, exactly N reservations succeed and 5 are refused; the row ends at
    `calls_reserved = N` and `est_cost_cents = N × unit`, never above either cap, and the
    refused requests left no lease, `demo_calls` or lead row. With the cost cap binding first
    (`cost_cap_cents` 175, unit 50, `calls_cap` large) exactly 3 succeed. The first reservation
    of a new day is checked too: a `calls_cap` of 0, or a unit above the cost cap, refuses even
    when no row exists yet.
  - Daily budget (UTC rollover, injected clock): a reservation at 23:59:59 UTC and one at
    00:00:00 UTC the next day land on two rows; the new day starts at `calls_reserved = 1` and
    one unit of cents, a full previous day does not refuse the new one, and the release of the
    23:59 reservation after midnight decrements the old day's row (`budget_day`), not the new
    one's.
  - Daily budget (a failed `Calls` request returns the reservation): a definitive Twilio 4xx or
    5xx with no CallSid → `calls_reserved` and `est_cost_cents` back to their prior values,
    `budget_released_at` set, lease released; the failure handler run twice decrements once; a
    timeout after the request left (a fake Twilio that accepted the call and never answered)
    keeps the reservation; a bound CallSid keeps it through `no-answer`, `busy` and `failed`
    callbacks; a process killed between the commit and the request leaves it spent.
  - Daily budget (cap reached refuses without calling Twilio): with the day's row at its cap,
    requests from twenty distinct IPs and twenty distinct numbers (so neither limiter can be
    what refuses) each answer 503 `DEMO_BUSY` with the busy copy; the fake Twilio receives zero
    `Calls` requests; no lease, `demo_calls`, lead or SMS row is written; no number's
    one-call-a-day allowance is spent and the pool is untouched. A pool with no free tenant and
    a budget with room → 503 and the counters unchanged.
  - Daily budget (alerts and config): the reservation that takes either count to 80% of its cap
    raises exactly one alert and one `demo_budget_alert` row for that cap (a cap of 50 → the
    40th reservation; a cap of 7 → the 6th), filling a cap raises one more, and later refusals
    page nobody; missing env values use the defaults; a malformed, zero or negative value, or a
    unit above the cost cap, fails the demo module closed with every request refused; a cap
    changed mid-day does not alter that day's row.
  - Isolation (reset on release): after a call that created a session, messages, a booking, a
    proposal and a customer, release → every `tenant_id` table is back to a freshly cloned
    tenant's row counts (audit and `demo_tenant_leases` excepted) and settings, catalog and
    templates equal the fixture; the lease row survives the walk, is `resetting` with
    `released_at` still null while the reset runs, and is `released` only after the reset
    completes; at every point during the reset a concurrent lease attempt for that trade cannot
    select the tenant. A failing reset (a fault injected after the first delete batch, after
    the row walk, after the re-seed and during object deletion, one case each) stops at that
    step, leaves the lease unreleased and returns the claim to `active` with `expires_at =
    now()`: the tenant stays out of the pool and is never leased dirty, and the reaper's retry
    repeats the whole reset and releases a tenant equal to the fixture.
  - Isolation (callback vs reaper race): a lease past `expires_at` whose status callback lands
    while the reaper sweeps (two real connections, both orders, repeated in a loop) → exactly
    one of them wins the `active → resetting` claim and the other matches zero rows and does
    nothing; the reset runs once (counted on a reset spy), the lease is released once, the
    callback still answers 200, and a callback that arrives after the release matches nothing.
  - Callback binding (the callback beats the `Calls` response; two real connections, a fake
    Twilio held at a latch): the voice callback arrives with the lease token while the `Calls`
    request is still unanswered and the lease's `call_sid` is null → the lease is found, the
    CallSid binds, and the turn processor answers as the leased demo tenant (not the busy line)
    with writes under that lease's generation; when the response is released its bind matches
    the same sid, changes nothing and raises nothing; a statement spy shows the callback never
    looked the lease up by `call_sid` before binding. Variant: the response wins the race → the
    callback's bind matches the sid already there and proceeds.
  - Callback binding (an early terminal callback still cleans up): for each of `completed`,
    `failed`, `busy` and `no-answer`, the status callback arrives with the token before the
    response → the CallSid binds, the claim wins, the reset runs once (reset spy) and the lease
    releases once, the tenant equals the fixture, `demo_calls` ends in that status (found by
    `lease_id`) and the signup SMS goes once after `completed` only; the `Calls` response then
    arriving binds nothing new and does not revive the lease; a callback after the release
    answers 200 and does nothing.
  - Callback binding (both URLs signed): the request the fake Twilio receives carries
    `lease=<token>` on both `Url` and `StatusCallback`, the token verifies for the lease minted
    for this call, and the lease row was already committed (call_sid null) when the request
    was sent.
  - Callback binding (forged or expired token): a payload edited to name another lease or
    tenant, a flipped signature byte, a token signed under another secret, a one-tap approve or
    undo token (wrong discriminator), and a missing or malformed token → 403 on both callbacks,
    no lease row touched, nothing written; an expired token (injected clock) → the voice callback
    speaks the busy line and hangs up, the status callback answers 200 and does nothing, the
    lease is unchanged and the reaper reclaims it. Unit (`lease-token.test.ts`): round trip,
    tamper, wrong secret, expiry on an injected clock, wrong discriminator, malformed input.
  - Callback binding (a second CallSid on one lease): after CA is bound, a validly signed
    callback carrying CB → 403, `call_sid` stays CA, nothing is written and
    `demo_callsid_mismatch` is audited; CA presented again is accepted (Twilio's retries and
    the later status callbacks); a `Calls` response returning CB after a callback bound CA is
    rejected the same way; CA presented for a different lease is refused by the unique index.
  - Isolation (heartbeat): a resetter that is slow but alive is never taken over: with a purge
    slowed past 60 s and its heartbeat renewing every 10 s (fake clock), the reaper's takeover
    `UPDATE` matches zero rows on every sweep. A resetter whose heartbeat stops is taken over
    only once `reset_heartbeat_at` is 60 s stale; the token rotates and the reaper finishes the
    reset.
  - Isolation (takeover during a slow purge, two real connections, repeated in a loop):
    resetter A claims and is mid-purge with its heartbeat paused; the heartbeat is aged past
    60 s and the reaper (B) takes over, rotating the token. Exactly one resetter is writing
    afterwards: A is stopped in turn before a delete batch, before the queue cancel, before
    the re-seed and before the release (one case each), and in every case its next fenced step
    finds the token changed, writes nothing and aborts; a statement spy shows no write under
    A's token after B's takeover committed; a batch A has open when B tries to take over
    finishes first (B's token `UPDATE` waits on A's `FOR SHARE` check) and A's following step
    is refused. B re-seeds once and releases once, A's late release matches nothing, a
    heartbeat refused for a changed token stops A, and the tenant equals the fixture.
  - Isolation (queued work, generation): (a) a job enqueued before the reset is dropped after
    it: a transcript job, a notification job and a follow-up queued during a call, then the
    reset; the unclaimed rows are deleted by the queue cancel (found by `payload->>'tenantId'`,
    since `_queue_messages` has no `tenant_id`), and a copy a consumer claimed before the bump
    and receives again after it is dropped by the guard: the handler is never called, the
    message is deleted and `demo_job_dropped` is audited with both generations, and the tenant
    ends clean. (b) A job stamped with generation g1 that is delivered during the tenant's
    next lease (g2) is dropped the same way, and so is one for a tenant with no active lease.
    (c) A handler running under g1 that enqueues a follow-up after the bump produces a message
    stamped g1 (its own context, not the lease table), which the guard drops. (d) An enqueue
    for a demo tenant outside any lease context is refused. (e) A non-demo tenant's jobs pass
    through the guard unchanged and unstamped. (f) The execution worker does not claim a demo
    tenant's `approved` proposal once the lease is `resetting`.
  - Isolation (in-flight job delays release): a handler blocked mid-run on a claimed message
    when the reset starts (two real connections, a latch in the handler) → the reset claims,
    bumps the generation, cancels the unclaimed rows and waits; `released_at` stays null and
    the tenant stays unleasable while the handler is registered; when the handler finishes
    and its registry row is deleted, the drain ends, the walk and re-seed run, and only then is
    the lease released. The same when the handler throws (the row is deleted on failure too).
    A handler that never finishes: at the deadline the reset fails that step, alerts and
    returns the claim to `active`, and the tenant stays out of the pool until a later retry
    finds the drain clear. The same for a tenant's `executing` proposal.
  - Isolation (a handler that outlives its visibility window still blocks release): a handler
    held on a latch past its message's `visible_at` (fake clock; the queue redelivers the row
    to a second consumer, attempt 2, so the registry holds two rows for one message, each
    heartbeating) → the reset claims and waits; the drain never reads `visible_at`, so
    `released_at` stays null for as long as either handler runs and the lease is released
    only after both have finished; a statement spy shows the drain query names neither
    `visible_at` nor `attempts`.
  - Isolation (a late write after takeover is rejected): handler A under g1 is held at a
    latch, the reset claims (g2), and A resumes and writes (an insert, an update, and a second
    transaction in the same job, one case each) → each is rejected by the in-transaction
    `leaseGeneration` check with `StaleLeaseGenerationError`, rolled back and audited as
    `demo_write_rejected`, the message is deleted rather than retried, and the tenant equals
    the fixture afterwards. A write transaction already past its check when the claim arrives
    (two real connections; A holds the transaction open) → the claim `UPDATE` waits for it to
    commit, the walk then removes what it wrote, and a statement spy shows no write commit
    after the claim. A message of the previous lease (g1) delivered and run during the next
    lease (g2) is rejected the same way.
  - Isolation (in-flight registry): a live handler heartbeats every 10 s and is never reaped
    (fake clock, ten minutes); a handler whose process died (heartbeat stopped, row left
    behind) blocks the drain until `heartbeat_at` is 60 s stale, then its row is reaped with
    `demo_inflight_reaped` and the reset proceeds, and if that process comes back its write is
    rejected by the fence; a job delivered while the reset claims (two real connections, both
    orders, repeated in a loop) either registers before the claim and is drained or fails the
    check and is dropped with `demo_job_dropped`, never neither.
  - Isolation (expired lease reclaimed): a lease past `expires_at` with no status callback →
    the reaper resets, releases and the tenant is leasable again; an unexpired lease is never
    reclaimed.
  - Integration: `demo_calls` and `demo_call_budget` have no `tenant_id` and are not subject
    to RLS (the reservation is pinned on real Postgres by running the statement in
    `demo/call-budget.ts`, never a copy of it); rate limiter keyed
    to the sentinel tenant persists across restarts; `demo_tenant_leases` rejects a second
    unreleased lease (`active` or `resetting`) on one tenant (and on one visitor hash) at the
    partial unique index; a demo
    tenant with an open invoice, an expired trial and an unfinished setup is selected by no
    tenant-listing sweep or report, and a guard test fails when a `FROM tenants` listing under
    `workers/` or `billing/` neither filters `demo` nor is allow-listed. The queue cancel runs
    against the real `_queue_messages` table (no `tenant_id` column; the tenant is read from
    `payload->>'tenantId'`) with rows in the unclaimed, claimed and backoff states, so the
    JSON-path predicate is pinned on real columns and not on a mocked pool; the drain runs
    against the real `demo_inflight_jobs` table, and the write fence's `FOR SHARE` against the
    claim `UPDATE` is pinned on real Postgres with two connections, because a mocked pool
    cannot show a lock conflict; the CallSid bind `UPDATE` and the `call_sid` unique index are
    pinned the same way (two connections binding different sids to one lease: exactly one wins,
    in a loop).
- **Verification:** cost per completed demo call measured in staging before the landing CTA
  ships (the figure replaces the default `DEMO_CALL_EST_COST_CENTS` and sizes the first caps),
  and a staging run past the daily cap is refused with no Twilio request; a staging run of concurrent demo calls on one trade shows distinct tenants, a clean
  tenant after each, and no job from one call running or writing against the next; a callback
  that arrives before the `Calls` response returns, including an early terminal one, still lands
  on its own lease; founder decision recorded in `docs/decisions.md`.

## Risks & Dependencies

- **Two sources of truth (draft vs proposals).** The draft is the only pre-approval state;
  mint and approve happen in one transaction that locks the draft row and checks
  `expectedVersion` (U11, closing the unlocked approve S1 shipped); every other draft writer
  takes the same lock, refuses once the draft is approved and bumps `version` (U11's
  invariant: inline in the three writers that exist, one shared helper from S4), so no late write can ride behind the approval's snapshot,
  and the `version` CAS rejects stale tabs on choice writes and on approve (a stale tab's
  approve is a 409 even when another tab has already approved); undo, reset and retry carry
  the version of the approval their screen showed, so a tap from a screen that is no longer
  current is a 409 that changes nothing.
- **Browser voice on real devices.** Tap is first-class everywhere, `answer_mode` is measured
  per turn, U4 spikes WebKit before U3 depends on it.
- **Regional prices wrong or read as advice.** Founder-curated rows, "typical" copy, prices
  land only through approval and remain editable catalog items.
- **Status contract drift.** Additive facts only; `.length(7)` preserved; pinned by extending
  `packages/api/test/onboarding/derive-status.test.ts` and the integration status test.
- **Demo call cost, abuse, TCPA, cross-visitor leakage.** Phased last, consent first, two-layer
  limits, kill switch, a daily call-and-cents budget reserved atomically before the Twilio
  request (so rotating IPs and numbers cannot raise the total); every live call holds its own demo tenant by lease, named in
  both Twilio callback URLs by a signed token so a fast answer or an early terminal callback
  cannot miss it, and the tenant is reset before anyone else can lease it (U7): the reset is
  heartbeat-renewed and
  token-fenced, so a takeover leaves exactly one resetter writing, and queued work carries a
  lease generation that every demo write re-checks inside its own transaction, with release
  waiting on an in-flight registry rather than on queue visibility, so no job from one call
  runs or writes against the next.
- **Stale pay links after a policy switch, and a failed mode read.** A texted Stripe Payment
  Link stays chargeable until deactivated, so switching to collect-on-site queues deactivation
  of every live link on open invoices (the job row is written in the settings transaction, with
  a follow-up pass and a daily reconciliation sweep behind it); a failed read of the mode never
  defaults to `pay_link` (U8).
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
| S1b | U11 (approve half) + U10 (API half) + U9 (execution fact, retry) | "S1 follow-ups" PR against `main` (#1694, draft, branch `feat/pick-dont-build-s1-followups`): the approval row lock (`getForTenantForUpdate`) with optional `expectedVersion` and a `markApproved` compare-and-swap, with a repeat approve staying the idempotent 200 when it carries the version the draft was approved from (`version - 1`) or none, and a different `expectedVersion` on an approved draft answering 409 `VERSION_CONFLICT` (the stale-tab rule, implemented exactly so); `owner_phone` on the draft (migration `313_onboarding_drafts_owner_phone`), stored on create, `PUT /draft/owner-phone` (body `{ ownerPhone, version }`, the same lock-then-compare as `stageChoice`), the owner cell on the settings payload and the handler's write to `tenant_settings.owner_phone`, with no `OWNER_PHONE_REQUIRED` gate (both emergency options ring the owner, so a gate would leave every draft without a cell unapprovable until the read-back can ask; it ships with the prompt in S4); `draft.execution` on the status (`pending \| executing \| executed \| failed \| stopped`, where `stopped` covers undone, rejected, expired or missing proposals that retry cannot recover) and `POST /draft/retry`. Not in #1694: the shared `updateLocked` helper with its guard and table-driven race (S4, with the first writers that need it) and the `packages/shared` wire schemas and web consumers (S2: send the version, show `failed` and `stopped`). | 2 days |
| S3 | U4 | Server-voice TTS with clip cache, first/second matcher, barge-in, WebKit coverage. | 4-5 days |
| S4 | U5 + rest of U9 + rest of U10 + U11's shared helper | Free-speech override (booking hours mapped onto the three presets, or confirmed against the closest one and never coerced), setting-key routing for the read-back mic, metro change (`PUT /draft/metro`); `updateLocked` extracted from the inline draft writers with its single-`UPDATE` guard and the table-driven writer-vs-approve race; whole-draft undo (row-locked, all-or-nothing, with a required `expectedVersion` so a saving screen left open in a stale tab cannot undo a newer approval) on that helper; whole-draft reset (`POST /draft/reset`), the locked reconciliation for an approval the owner split from the inbox or that failed or lapsed: it accepts members that are `approved` inside the window or not applied (`undone`, `rejected`, `expired`, `execution_failed`), reverts the approved ones, returns the draft to editable at `version + 1` and emits `onboarding.draft_reset`, and refuses with a typed 409 when any member is `executing` or `executed`, sending the owner to Settings, with the derived `recovery` hint on the status so the shell never offers a refused button; the read-back's owner-cell prompt together with the `OWNER_PHONE_REQUIRED` approve gate, in one PR so the gate always has a control that lifts it; approve's `expectedVersion`, and retry's (added in this slice, since #1694's retry reads no body), made required once every client sends it. | 6-7 days (reset adds one) |
| S5 | U6 + U8 | Eighth turn (existing number) and day-one branch, number flow with claim re-search driven by a structured provisioning `failureCode` on the status (only `area_code_unavailable` re-searches; other codes show their own copy), forwarding text with owner confirmation and probe, forwarding answers on the draft (through the locked-write helper) and the settings proposal as one three-valued `forwarding` field (a changed line clears the old confirm and probe stamps; an explicit `null`, from a re-run that answers no, clears the line and both stamps; absent leaves them), seeded-price baseline with legacy backfill and the re-run repricing gate (a repriced row's baseline moves with its price), re-run reopen copying the live owner cell onto the draft, first-day home, runtime consumers for `payment_collection_mode` and `emergency_target` (pay links deactivated on a switch to collect-on-site, enqueued in the settings transaction with a follow-up pass and a daily sweep; no link on a failed mode read), flag flipped, v2 deleted. | 10-12 days |
| S6 | U7 | Pre-signup demo call (founder decision first), with a leased pool of demo tenants per trade, each call's callbacks resolving the lease by a signed token minted before the `Calls` request and binding the CallSid atomically (so a fast answer or an early terminal callback is never lost), reset before reuse (heartbeat-renewed and token-fenced, with queued work fenced by a lease generation that every write re-checks, and release waiting on an in-flight job registry rather than on queue visibility) and excluded from owner, billing and analytics surfaces; a daily call-and-cents budget is reserved atomically before every `Calls` request and returned on a definitive failure. | 9-13 days (the token and bind add one, the budget another) |

Serial by construction: one engineer, nine to twelve weeks for S1-S5; S6 adds about two. A
second engineer shortens S2 and S3 only where the API they depend on is already merged.

Per-slice definition of done: failing tests written first; `npx tsc --project
tsconfig.build.json --noEmit` clean in `packages/api`; unit, integration
(`npm run test:integration`) and the relevant Playwright spec green; the API verify skill
(`Serviceos/packages/api:verify`) or web verify skill (`Serviceos/packages/web:verify`) run
against the slice; dead code removed; funnel events documented in `FUNNEL.md`.
