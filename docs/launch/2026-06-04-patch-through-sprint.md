# Patch-Through FSM — Post-Launch Sprint Plan

**Date:** 2026-06-04
**Owner:** Engineering
**Duration:** 4-5 eng-days
**Status:** Ready to schedule (post-launch)

## TL;DR

Every component for vulnerability-aware patch-through to the owner's cell
already exists in the codebase. The single missing piece is **wiring** — no
production path calls `patchToOwnerCell` or `triageDecision` today. This
sprint plumbs the existing parts into the live FSM, lands the
`/dial-result` cascade for the owner leg, adds two cassettes, and ships
behind a per-tenant flag so we can bake it on real calls before defaulting
it on.

## What's already built (and where)

| Concern | File | Status |
| --- | --- | --- |
| Vulnerability detectors (age, medical, property, weather) | `packages/api/src/ai/vulnerability/detectors/` | ✅ |
| Signal aggregator | `packages/api/src/ai/vulnerability/signal-extractor.ts` | ✅ |
| Urgency classifier (4 tiers + AMBIGUOUS) | `packages/api/src/ai/skills/classify-urgency-tier.ts` | ✅ |
| Triage matrix (vulnerable × urgent → `patch_owner` / `high_priority_booking` / `normal`) | `packages/api/src/ai/vulnerability/triage-decision.ts` | ✅ |
| Owner-cell `<Dial>` builder + fallback (SMS + high-priority booking) | `packages/api/src/voice/triage/owner-cell-patch.ts` | ✅ |
| Context preface (NON-PII whisper) | `packages/api/src/voice/triage/context-preface.ts` | ✅ |
| `owner_phone` column + onboarding capture + settings UI | migration 143, `IdentityStep.tsx`, `BusinessProfileSheet.tsx` | ✅ |
| Twilio dial-result route + cursor cascade | `packages/api/src/routes/telephony.ts` | ✅ (dispatcher path only) |
| Vulnerability-patch reason + summary mapping | `packages/api/src/ai/skills/escalate-to-human.ts` | ✅ |

## The gap — one wiring site

Today the FSM's `notify_oncall` side-effect lands at:

> `packages/api/src/ai/voice-turn/create-voice-turn-processor.ts:542`

…which calls `escalateToHuman(...)` unconditionally. The patch-through fork
needs to happen *before* that call:

```
notify_oncall side-effect
        │
        ▼
extract vulnerability signals (existing)
        │
        ▼
classify urgency tier (existing) → map to {none|low|elevated|critical}
        │
        ▼
triageDecision(score, urgency) ─────► 'patch_owner' ──► patchToOwnerCell
        │                                                       │
        │                                                       └─► twiml → adapter
        ├──► 'high_priority_booking' ──► createHighPriorityBooking + owner SMS
        │
        └──► 'normal' ──► existing escalateToHuman (unchanged)
```

The `/dial-result` route also needs a branch: when the call leg's
`call_kind = 'owner_patch'`, the unreachable cascade should NOT walk the
dispatcher rotation — it should call `handleOwnerDialResult` and run the
single owner fallback (high-priority booking + SMS).

## Open design decisions (non-blocking, pick by Day 1 EOD)

1. **Per-tenant rollout flag**: `tenant_settings.patch_through_enabled boolean default false` so we can bake on volunteer tenants before defaulting on. Owner-phone-on-file is the natural pre-condition; flag adds explicit consent.
2. **Urgency-tier → triage-urgency mapping**: classifier emits `TIER_1..4` + `AMBIGUOUS`; triage matrix expects `{none|low|elevated|critical}`. Proposed:
   - `TIER_1_EVACUATE` → `critical`
   - `TIER_2_EMERGENCY_DISPATCH` → `critical`
   - `TIER_3_SAME_DAY_URGENT` → `elevated`
   - `TIER_4_SCHEDULE` → `low`
   - `AMBIGUOUS_NEEDS_CLARIFICATION` → `none` (defer the patch until clarification re-classifies; never patch on ambiguity)
3. **Weather resolver**: `signal-extractor` accepts optional `resolveTemps`. Wire to existing weather provider, or ship Day 1 without it (3-of-4 detectors still fire; `weatherUnavailable: true` is honest).

## Sprint breakdown

### Day 1 — Wiring scaffold + decision

**Deliverables:**
- `packages/api/src/ai/vulnerability/urgency-tier-mapping.ts` — pure mapper from `UrgencyTier` (classifier) → `UrgencyTier` (triage-decision union). Unit-test exhaustive cases.
- Migration 146: `tenant_settings.patch_through_enabled boolean default false`. Add hash to `migration-immutability.test.ts`.
- Resolve weather-wiring decision (skip vs wire) and document in this file.

**Acceptance:** mapper has 100% branch coverage; migration applies cleanly; immutability test green.

### Day 2 — Fork at the escalation site

**Deliverables:**
- Add `triageFork(...)` helper alongside `create-voice-turn-processor.ts` that:
  1. Pulls transcript snapshot from `session` (already on `EscalationContext`).
  2. Calls `extractVulnerabilitySignals` + `classifyUrgencyTier` in parallel.
  3. Calls `triageDecision`.
  4. Branches: `patch_owner` → `patchToOwnerCell` and return its TwiML; `high_priority_booking` → `createHighPriorityBooking` + owner SMS, then short-circuit out of escalation; `normal` → fall through to existing `escalateToHuman`.
- Gate the fork on `tenant_settings.patch_through_enabled = true`. When false, behavior is unchanged.
- Wire `ownerPhoneResolver` (already typed) to `tenant_settings.owner_phone` (use the resolver already factored in `settings.ts`).

**Acceptance:** unit tests cover all 3 triage branches + the flag-off bypass; existing escalation tests stay green.

### Day 3 — Dial-result branch + owner-leg tagging

**Deliverables:**
- Tag the owner-patch dial leg: write `call_kind='owner_patch'` (or stash on `pendingTransferTwiml` metadata) so `/dial-result` can tell owner-leg from dispatcher-leg.
- `/dial-result` branch: when leg is owner-patch and dial status is in `UNREACHABLE_DIAL_STATUSES`, call `handleOwnerDialResult` instead of advancing the dispatcher cursor.
- Audit emission: `escalation.requested` with `reason='vulnerability_patch'` on the patch leg, `escalation.fallback` on unreachable.

**Acceptance:** integration test simulating Twilio dial-result no-answer routes to `handleOwnerDialResult` and produces a proposal + SMS.

### Day 4 — Voice-quality cassettes + dry-run

**Deliverables:**
- Two new cassettes under `packages/api/src/ai/voice-quality/corpus/cassettes/`:
  - `vulnerability-patch-elderly-no-heat-winter.json` — fires age + medical-ish + winter; expect `<Dial>` to owner, fallback to high-priority booking after timeout.
  - `vulnerability-patch-unreachable-owner.json` — same triggers, simulates owner no-answer; assert fallback proposal + SMS body shape.
- Run voice-quality suite + manually drive one tenant in staging with the flag on.

**Acceptance:** voice-quality gate stays at 100% PASS including new cassettes; staging dry-run produces the expected proposal and SMS.

### Day 5 — Rollout + observability

**Deliverables:**
- PostHog server events: `vulnerability_signal_extracted`, `urgency_tier_classified`, `triage_decision`, `owner_patched`, `owner_patch_fallback` (with NON-PII payload — score + tier + reason only).
- Sentry alert: spike in `owner_patch_fallback` with `fallbackReason='no_owner_number'` (means a tenant flipped the flag without setting an owner phone).
- Settings UI: surface a single toggle on the BusinessProfileSheet ("Emergency patch-through — page my cell when an at-risk caller has an urgent issue") gated on `owner_phone` being non-empty.
- Enable for 1-2 volunteer tenants. Watch funnel for 48h.

**Acceptance:** dashboard tile shows patches happening; no Sentry spikes; the volunteer tenants confirm the experience on a test call.

## Out of scope (deliberately)

- LLM-based urgency classification — the regex tier classifier is the v1 ceiling. Recall gaps land in a Phase 4d-2 sprint.
- Auto-discovery of medical equipment from prior call transcripts — current detector reads the live utterance only.
- Multi-owner patch fan-out (round-robin between two owners) — out of scope; v1 is single owner per tenant.
- A dedicated "patch_owner" cassette for every vertical — two are enough to anchor regression; more added as production traffic shows gaps.

## Risk register

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Owner phone unreachable → caller stranded | Medium | Fallback already builds a high-priority booking; SMS the owner; PostHog tracks rate; default-off flag means only opt-in tenants see this |
| False positive — non-urgent caller patched to owner | Low | AMBIGUOUS → `none` urgency forces clarification; score >= 1 AND urgent is a conservative gate |
| Owner cell goes to voicemail mid-bridge | Medium | `UNREACHABLE_DIAL_STATUSES` already includes 'voicemail'; treats as no-answer |
| Tenant flips flag without setting owner phone | Low | UI gates flag visibility on owner_phone presence; settings save validates |
| Whisper preface leaks PII | Low | `composeContextPreface` uses only NON-PII evidence strings; explicit invariant covered by `owner-cell-patch.test.ts` |

## Next action

Pick a sprint start date and assign Day 1 (the mapper + migration is a
2-hour task; good warm-up commit for whoever picks this up). Once Day 1
lands and the urgency-mapping decision is locked, Days 2-5 can run
sequentially without ambiguity.
