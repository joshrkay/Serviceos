# Voice Go-Live Gate — Design

**Date:** 2026-05-20  
**Status:** Approved — ready for implementation plan  
**Parent:** [Solo Owner-Operator Launch](./2026-05-19-solo-owner-launch-design.md)  
**Related:** [§10 Onboarding & Self-Serve Setup](./2026-05-15-onboarding-self-serve-setup-design.md), [ServiceOS Launch Readiness](./2026-05-14-serviceos-launch-readiness-design.md)

---

## 1. Problem

Solo-owner launch needs **billing** and an **explicit owner decision** before inbound AI answers. Today:

- **Gate A + B** (subscription + trial caps) run in `createVoiceGate` — AI can answer as soon as Stripe is `trialing`/`active`, even if the owner has not finished onboarding or chosen to go live.
- **Step 4** can provision a Twilio number before billing; blocked callers hear voicemail (correct).
- **Step 6 UI** (`TestCallStep`) says “You're live / Your AI agent is answering calls” when the test-call step is `done` or `skipped`, which is **misleading** when `voice_agent_live_at` is unset — skip does not (and should not) imply AI is on.

This spec adds a **go-live gate** between billing and trial caps, plus owner controls to set/clear it.

---

## 2. Implementation status (repo audit 2026-05-20)

Use this section when writing the implementation plan — **do not rebuild what already ships.**

### Already shipped (reuse / extend)

| Area | Location | Notes |
|------|----------|--------|
| Subscription + trial gate | `packages/api/src/voice/voice-gate.ts`, `trial-limits.ts`, `load-trial-usage.ts` | Gate A + B; unit tests in `test/voice/voice-gate.test.ts`, `trial-limits.test.ts` |
| Webhook wiring | `packages/api/src/routes/telephony.ts` | Invokes `voiceGate` before AI; voicemail TwiML on block |
| Gate in production | `packages/api/src/app.ts` (~2026) | `voiceGate: createVoiceGate({ pool, auditRepo })` when pool present |
| Integration tests | `packages/api/test/telephony/telephony-voice-gate.test.ts` | Asserts TwiML branch for blocked/allowed |
| Metrics + audit on block | `voice-gate.ts` | `voiceBlocksTotal`, `voice_blocked_no_billing` / `voice_blocked_trial_cap` |
| Onboarding v2 UI | `packages/web/src/components/onboarding/v2/*` | Shell, sidebar, all six steps including `TestCallStep.tsx` |
| Derived onboarding status | `derive-status.ts`, `load-facts.ts`, `GET /api/onboarding/status` | Six steps; test call = inbound `voice_sessions` ended OR skip timestamp |
| Onboarding schema | Migration `098_tenant_settings_onboarding_fields.sql` | `onboarding_test_call_skipped_at`, `onboarding_upgrade_prompt_shown_at`, identity fields |
| Test-call skip API | `POST /api/onboarding/test-call/skip` | Sets skip timestamp; audit `tenant.test_call_skipped` |
| Session-end hook | `twilio-adapter.ts` `onSessionEnded` → `app.ts` | Fires `checkAndFireUpgradeNudge` after inbound ends |
| Upgrade nudge | `packages/api/src/voice/check-upgrade-nudge.ts` | 30-minute trial threshold; banner via `upgradePromptShownAt` |
| App shell guard | `ProtectedRoute.tsx` | Redirect to `/onboarding` when `!isComplete` (flag `VITE_ONBOARDING_V2_ENABLED`) |
| Outbound allowlist (§10 “Gate C”) | `packages/api/src/voice/outbound-allowlist.ts` | **Different concern** — NANP/premium NPA; not inbound go-live |
| E2E | `e2e/journeys/onboarding-v2.spec.ts` | Journey harness + `e2e/helpers/onboarding-v2-mock.ts` |
| Contracts | `packages/api/src/onboarding/contracts.ts` | Web mirror: `packages/web/src/types/onboarding.ts` |

### Not shipped (this spec)

| Item | Notes |
|------|--------|
| `tenant_settings.voice_agent_live_at` | Migration `100_*` (next free number after `099_*`) |
| Go-live gate in `createVoiceGate` | New reason `not_live` |
| `POST /api/voice/go-live`, `POST /api/voice/pause` | New routes (owner RBAC) |
| Auto go-live on first ended inbound | Extend existing `onSessionEnded` in `app.ts` |
| `voiceAgentLive` on status response | Extend `OnboardingStatusResponse` + web types |
| Settings toggle | New UI row (Settings still has stub actions elsewhere) |
| Distinct TwiML copy per block reason | Today one generic “being set up” message |
| Telephony fail-closed on gate errors | Today `voiceGate` errors **fail open** (`telephony.ts` ~317) |
| Fix `TestCallStep` “You're live” copy | Conditional on `voiceAgentLive` |

---

## 3. Gate naming (avoid confusion)

[§10 onboarding spec](./2026-05-15-onboarding-self-serve-setup-design.md) labels **Gate C = outbound allowlist** (`outbound-allowlist.ts`). This design does **not** repurpose that label.

**Inbound webhook order (target):**

| Order | Name | Check |
|-------|------|--------|
| 1 | Gate A — Subscription | `subscription_status ∈ { trialing, active }` |
| 2 | **Go-live gate** | `tenant_settings.voice_agent_live_at IS NOT NULL` |
| 3 | Gate B — Trial caps | `evaluateTrialCap` while `trialing` |
| — | §10 outbound allowlist | Applies only when placing outbound dials (unchanged) |

---

## 4. Goal and non-goals

### Goal

Owners with a provisioned number and active trial/subscription **choose** when inbound AI answers. Successful test call **auto-enables** go-live; skip **does not**. Billing remains mandatory (Gate A).

### Non-goals

- Changing trial cap numbers or Stripe trial length
- Replacing onboarding step derivation (still six derived steps)
- In-app streaming voice go-live (PTT only at launch per `docs/launch/voice-interaction-scope.md`)
- `voice_agent_paused_at` separate column (v1: pause = clear `voice_agent_live_at`)
- Opt-in checkbox on skip (deferred; default **skip = A** — no auto live)

---

## 5. Data model

### Migration `100_tenant_settings_voice_agent_live.sql`

```sql
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS voice_agent_live_at TIMESTAMPTZ;
```

Register in `packages/api/src/db/schema.ts` and immutability test hash (same pattern as `098_*`).

### Semantics

- `NULL` — AI must not answer (go-live gate blocks).
- Non-null — owner enabled AI; timestamp is last enable time (re-go-live overwrites).
- Idempotent `go-live` when already set: no-op or refresh timestamp (pick one in plan; prefer **no-op** to preserve “first live” for support).

### Status API

Extend `OnboardingStatusResponse` in `packages/api/src/onboarding/contracts.ts` and `packages/web/src/types/onboarding.ts`:

```ts
voiceAgentLive: boolean; // voice_agent_live_at != null
```

Include in `loadOnboardingFacts` / `deriveOnboardingStatus` response builder (facts struct may add `voiceAgentLiveAt: Date | null` internally).

---

## 6. API

### New routes (`packages/api/src/routes/voice.ts` or existing voice router)

| Method | Path | Auth | Behavior |
|--------|------|------|----------|
| `POST` | `/api/voice/go-live` | Owner | Requires Gate A (trialing/active). `UPDATE tenant_settings SET voice_agent_live_at = COALESCE(voice_agent_live_at, NOW())`. Audit `tenant.voice_agent_live` metadata `{ source: 'manual' }`. |
| `POST` | `/api/voice/pause` | Owner | `SET voice_agent_live_at = NULL`. Audit `tenant.voice_agent_paused`. |

Return `{ voiceAgentLive: boolean, voiceAgentLiveAt?: string }` (ISO-8601).

### Auto go-live

In `app.ts`, extend the existing `onSessionEnded` callback (same pool gate as upgrade nudge):

```
after checkAndFireUpgradeNudge:
  maybeAutoGoLiveOnInboundEnd({ pool, auditRepo }, { tenantId, channel })
```

`maybeAutoGoLiveOnInboundEnd`:

- Only if billing would pass Gate A (query or reuse small helper).
- Only if `voice_agent_live_at` is null.
- Set `voice_agent_live_at = NOW()` once.
- Audit `tenant.voice_agent_live` `{ source: 'auto_test_call' }`.
- Swallow errors (same reliability bar as nudge — must not break session end).

**Note:** Auto go-live runs when a session **ends** that was allowed through the gate. Pre-live test calls that hit voicemail do not end an AI session — no auto live. First **AI-handled** inbound completion enables live.

### Unchanged

- `POST /api/onboarding/test-call/skip` — still only sets `onboarding_test_call_skipped_at`; does **not** set `voice_agent_live_at`.

---

## 7. Voice gate changes

### `createVoiceGate`

After Gate A passes, load `voice_agent_live_at` for tenant (single query or combined with subscription row via join on `tenant_settings`).

```ts
if (!liveAt) {
  // audit voice_blocked_not_live, metric reason=not_live
  return { allowed: false, reason: 'not_live' };
}
```

Extend `VoiceGateResult.reason` and `GateReason` in `trial-limits.ts` (or move shared reasons to `voice-gate-types.ts` if coupling is awkward).

### Telephony

| Reason | TwiML Say (v1) |
|--------|----------------|
| `no_billing` | “We're finishing account setup. Please leave a message after the tone.” |
| `not_live` | “This line isn't using our AI assistant yet. Please leave a message after the tone.” |
| trial caps | Keep generic voicemail v1 (cap banner remains in-app) |

### Fail-closed

On `voiceGate` throw: return same voicemail as `not_live`, log error, **do not** route to AI. Update `telephony-voice-gate.test.ts` + add case for DB failure.

---

## 8. UX

### Test call step (`TestCallStep.tsx`)

| `voiceAgentLive` | Step 6 status | UI |
|------------------|---------------|-----|
| false | current | Number + “Waiting for your call…” + primary **Turn on AI answering** → `POST /api/voice/go-live` |
| true | current | Waiting + badge “AI answering is on” |
| true | done/skipped | Celebration + “Go to dashboard” (only then: “Your AI agent is answering calls”) |
| false | skipped | “Setup complete” without claiming AI is answering; CTA to enable in Settings or go-live button |

### Phone step

One helper line: “Your number is ready. AI won't answer until you turn it on after billing.”

### Settings (v1)

Row: **AI phone answering** — toggle wired to go-live / pause; show E.164 when integration has `phoneE164`.

### Solo-owner launch doc alignment

Updates the gating table in `2026-05-19-solo-owner-launch-design.md` §1:

- **Inbound voice:** Gate A + **go-live** + Gate B (not billing alone).
- **Phone vs agent:** Step 4 number yes / AI no; step 5 paid / AI no until go-live; after go-live / AI yes subject to caps.

Mitigates “invisible proposals” when combined with inbox visibility work — owner can go live before `isComplete` and still be on onboarding shell; optional follow-up: activity panel on test-call step (out of scope here).

---

## 9. Timeline (owner-visible)

| Phase | Number | AI answers | App |
|-------|--------|------------|-----|
| Step 4 | Yes | No (`no_billing` or `not_live`) | Onboarding |
| Step 5 paid, not live | Yes | No (`not_live`) | Onboarding |
| Go-live (manual or auto test call) | Yes | Yes (Gate A + B) | Onboarding until step 6 complete |
| Skip without go-live | Yes | No (`not_live`) | Onboarding → complete, AI still off |

---

## 10. Observability

| Event | When |
|-------|------|
| `voice_blocked_not_live` | Inbound blocked at go-live gate |
| `tenant.voice_agent_live` | Manual or auto enable |
| `tenant.voice_agent_paused` | Pause |

Prom: `voice_blocks_total{reason="not_live"}` (extend existing counter). Optional: `voice_go_live_total{source="manual|auto_test_call"}`.

---

## 11. Testing

| Layer | Cases |
|-------|--------|
| Unit | `createVoiceGate`: trialing + null `live_at` → `not_live`; trialing + set → allowed (if under caps) |
| Unit | go-live/pause handlers: reject without billing; idempotent go-live |
| Integration | Telephony: paid + not live → voicemail, adapter not called |
| Integration | Auto go-live: end inbound session → `live_at` set once |
| Integration | Skip does not set `live_at` |
| Web | `TestCallStep` copy for `voiceAgentLive` true/false |
| E2E | Extend `onboarding-v2.spec.ts` or API-only if Twilio-less: mock status includes `voiceAgentLive` |

---

## 12. Files (expected touch list)

### New

- `packages/api/src/db/migrations/100_tenant_settings_voice_agent_live.sql`
- `packages/api/test/db/migration-100.test.ts`
- `packages/api/src/voice/go-live.ts` (enable/pause/auto helpers)
- `packages/api/test/voice/go-live.test.ts`
- `packages/api/src/routes/voice-control.ts` (or extend `routes/voice-sessions.ts` — pick one router in plan)

### Modified

- `packages/api/src/voice/voice-gate.ts`
- `packages/api/src/routes/telephony.ts` (TwiML + fail-closed)
- `packages/api/src/app.ts` (`onSessionEnded`)
- `packages/api/src/onboarding/load-facts.ts`, `contracts.ts`, status route response
- `packages/api/src/db/schema.ts`
- `packages/api/test/voice/voice-gate.test.ts`, `telephony-voice-gate.test.ts`
- `packages/web/src/types/onboarding.ts`
- `packages/web/src/components/onboarding/v2/steps/TestCallStep.tsx`
- `packages/web/src/components/onboarding/v2/steps/PhoneStep.tsx`
- `packages/web/src/components/settings/SettingsPage.tsx` (minimal toggle)

### Docs (follow-up PR acceptable)

- Amend `2026-05-19-solo-owner-launch-design.md` gating table
- Add cross-link from `2026-05-15-onboarding-self-serve-setup-design.md` trial-gate section

---

## 13. Success criteria

| # | Criterion | Verification |
|---|-----------|--------------|
| 1 | Paid tenant cannot get AI until `voice_agent_live_at` set | Integration telephony test |
| 2 | First completed AI inbound auto-sets live | Integration + audit row |
| 3 | Skip completes onboarding without setting live | Integration skip test |
| 4 | Test-call UI does not claim “answering” when not live | Web unit or Playwright |
| 5 | Gate failure does not fail open to AI | Telephony test with throwing gate |

---

## 14. Decision log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage | `tenant_settings.voice_agent_live_at` | Matches onboarding columns; single source of truth |
| When AI may answer | Billing + explicit go-live | Product request; closes misleading “live” UX |
| Skip test call | **A** — no auto live | Keeps go-live explicit; Settings/button later |
| Auto live | First ended inbound that ran AI | Aligns with test-call step intent |
| §10 Gate C name | Keep outbound as Gate C; call this **go-live gate** | Avoid overloading outbound allowlist docs |
