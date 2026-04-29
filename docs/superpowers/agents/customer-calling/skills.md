# Customer Calling Agent — Skills

A **skill** is a discrete, testable capability the agent composes. Skills are reusable across agents (the follow-up agent reuses many of the same skills with different orchestration).

Each skill has a contract: **input → output**, **errors**, **cost ceiling**, **states that use it**, and **existing primitive it wraps** (so we know what to build vs reuse).

## Skill index

| Skill | Used in states | Wraps existing | New code |
|---|---|---|---|
| `greet` | `greeting` | `tts-provider.ts` | minor (greeting templates per channel + recording disclosure) |
| `disclose_recording` | `greeting` (telephony only) | `tts-provider.ts` | minor (state-by-state disclosure text) |
| `identify_caller` | `identifying` | `customer.findByTenant`, new phone index | medium (phone match + voiceprint stub) |
| `ask_caller_info` | `identifying.ask_caller` | `tts-provider`, intent-classifier | small (capture name+address turn) |
| `capture_intent` | `intent_capture` | `reference-resolver`, `intent-classifier` | small (loop wrapper + reprompt) |
| `disambiguate_entity` | `entity_resolution` | `entity-resolver` (currently noop) | medium (real Pg resolver + UX prompt) |
| `confirm_intent` | `intent_confirm` | `tts-provider`, intent-classifier | small (verbal confirmation pattern) |
| `draft_proposal` | `proposal_draft` | `task-router`, proposal repo | small (channel metadata) |
| `notify_review_queue` | `proposal_draft` | proposals routes + (future) websocket / push | small |
| `escalate_to_human` | `escalating` | (telephony) Twilio `<Dial>` / (in-app) routing logic | medium (on-call rotation + dial config) |
| `transfer_call` | `escalating` (telephony) | Twilio API | small |
| `record_call` | always (background) | S3 upload + voice repo | small (Twilio recording → S3 → voice repo row) |
| `end_call` | `terminated` | Twilio hangup / web close | small |
| `enforce_session_caps` | always (background) | new cost-tracker | small |
| `enforce_compliance` | always (background) | new DNC + business-hours check | medium (DNC list integration optional v1) |
| `summarize_session` | `terminated` | LLM gateway | small (one-shot summary at end) |
| `emit_audit` | every transition | audit repo | small |

## Skill specs

Below: contract for every skill. Skills marked **(new)** require new files. Skills marked **(wrap)** extend existing files.

---

### `greet` (wrap)

Plays the channel-appropriate greeting.

**Input:** `{ tenantId, channel: 'telephony' | 'inapp', callerKnown?: { firstName?: string } }`
**Output:** `{ played: boolean, durationMs: number }`
**Errors:** `TtsProviderUnavailable`, `TenantSettingsMissing`
**Cost ceiling:** `< $0.005 / invocation` (TTS audio).
**States:** `greeting`
**Wraps:** `packages/api/src/ai/tts/tts-provider.ts`
**New work:**
- Per-tenant greeting template loaded from `settings.greetings.{channel}`.
- After-hours variant.
- Personalization: "Hi <firstName>" when caller is known via phone match.

---

### `disclose_recording` (new — minor)

Plays the call recording disclosure. **Telephony only.** Runs immediately after `greet` and before any caller utterance is captured.

**Input:** `{ tenantId, callerState?: string /* US state for state-specific text */ }`
**Output:** `{ disclosed: boolean }`
**Errors:** none (best-effort — recording continues even if disclosure TTS fails; legal review required before production)
**Cost ceiling:** `< $0.002`
**States:** `greeting` (telephony)
**New file:** `packages/api/src/ai/skills/disclose-recording.ts`
**New work:**
- Static disclosure copy in `packages/shared/src/legal/recording-disclosure.ts` keyed by state.
- Two-party-consent state list (CA, FL, IL, MD, MA, MT, NV, NH, PA, WA + a few others).

---

### `identify_caller` (new — medium)

Resolves the inbound phone number to a `Customer` record, or returns `unknown`.

**Input:** `{ tenantId, phoneNumber: string /* E.164 */ }`
**Output:**
```ts
type IdentifyResult =
  | { kind: 'matched', customer: Customer, confidence: number }
  | { kind: 'multiple', candidates: Customer[] /* same phone, different households — rare */ }
  | { kind: 'unknown' }
```
**Errors:** `RepositoryError`
**Cost ceiling:** `0` (DB lookup, no LLM).
**States:** `identifying`
**New files:**
- `packages/api/src/ai/skills/identify-caller.ts`
- migration adding `customers_phone_normalized_idx` index on `lower(translate(phone, '()-. ', ''))`.

**Implementation:** normalize incoming `from` number to E.164, query the index. If 2+ matches (same phone shared by household), return `multiple` and let `ask_caller_info` disambiguate.

---

### `ask_caller_info` (new — small)

Captures caller-provided identity when phone match fails. One-turn skill: prompts, transcribes the response, runs reference-resolver + intent-classifier with intent-type fixed to `identify_self`.

**Input:** `{ tenantId, channel, retriesRemaining: number }`
**Output:** `{ name?: string, address?: string, customer?: Customer /* if subsequent search succeeds */ }`
**Errors:** `MaxRetriesExceeded` → caller should be escalated
**Cost ceiling:** `< $0.02 / invocation`
**States:** `identifying.ask_caller`
**New file:** `packages/api/src/ai/skills/ask-caller-info.ts`

---

### `capture_intent` (wrap)

Loop: receive transcript turn → reference-resolver → intent-classifier → return classification or reprompt.

**Input:** `{ tenantId, conversationId, callerContext, transcriptTurn: string }`
**Output:** `{ intent: IntentType, entities: ExtractedEntities, confidence: number, transcriptUsed: string }`
**Errors:** `LowConfidence` (below τ_int = 0.75) → state machine reprompts; `ClassifierUnavailable`
**Cost ceiling:** `< $0.04 / classification` (input tokens scale with conversation history).
**States:** `intent_capture`, `closing.second_intent`
**Wraps:**
- `packages/api/src/ai/orchestration/reference-resolver.ts`
- `packages/api/src/ai/orchestration/intent-classifier.ts`

**New work:** thin loop wrapper that handles reprompt logic and emits `intent_classified` / `confidence_low` events to the state machine.

---

### `disambiguate_entity` (medium)

Resolves free-text entity references ("the Rodriguez job") to tenant-scoped IDs. Currently the resolver is a noop; this skill needs the real Postgres + trigram resolver.

**Input:** `{ tenantId, entityRefs: ExtractedEntityRef[] }`
**Output:**
```ts
type DisambiguationResult =
  | { kind: 'all_resolved', resolved: Map<RefKey, ResolvedId> }
  | { kind: 'needs_clarification', question: string, candidates: Candidate[] }
  | { kind: 'not_found', refs: RefKey[] }
```
**Errors:** `RepositoryError`
**Cost ceiling:** `< $0.01` (one LLM call to phrase the disambiguation question; trigram lookup is free).
**States:** `entity_resolution`
**New files:**
- `packages/api/src/ai/resolution/pg-entity-resolver.ts` (replaces NullEntityResolver in production)
- migration adding pg_trgm GIN indexes on `customers.name`, `jobs.title`, `invoices.invoice_number`, `appointments.scheduled_for` (range index for date refs).

**Wraps:** `packages/api/src/ai/resolution/entity-resolver.ts` interface (already exists).

---

### `confirm_intent` (small)

Reads back the proposed action and listens for caller confirmation. "So you'd like to book a service appointment for Friday at 2pm — is that right?"

**Input:** `{ tenantId, channel, intentSummary: string }`
**Output:** `{ confirmed: boolean, correction?: string /* if caller corrected something */ }`
**Errors:** `LowConfidenceConfirmation` (e.g., "I think so"), `MaxRetriesExceeded`
**Cost ceiling:** `< $0.01 / invocation`
**States:** `intent_confirm`
**New file:** `packages/api/src/ai/skills/confirm-intent.ts`

**Implementation note:** classifier is a binary yes/no/correction model (small, cheap). Use Sonnet-tier or smaller.

---

### `draft_proposal` (wrap)

Hands off to the existing task-router with one extra metadata field.

**Input:** `{ tenantId, intent, entities, sourceContext: { channel, conversationId, callSid?, callerCustomerId? } }`
**Output:** `{ proposalId: string, proposalType: ProposalType }`
**Errors:** `UnsupportedIntent`, `RepositoryError`
**Cost ceiling:** `0` (the task router doesn't call LLMs in the drafting step).
**States:** `proposal_draft`
**Wraps:** `packages/api/src/ai/orchestration/task-router.ts`

**New work:** add `channel` and `callSid` fields to `Proposal.sourceContext`; thread through the task handlers' return values.

---

### `notify_review_queue` (small)

Lets the human review queue know a new proposal needs attention. v1 is a DB write (proposal already persisted) plus an audit event; v2 adds websocket push for real-time UI.

**Input:** `{ tenantId, proposalId, urgency: 'normal' | 'high' }`
**Output:** `{ notified: boolean }`
**Errors:** `RepositoryError`
**Cost ceiling:** `0`
**States:** `proposal_draft`
**New work:** v1 is just an audit event (`proposal.queued_for_review`). v2 (out of scope) adds frontend push.

---

### `escalate_to_human` (medium)

Routes the live caller (or in-app session) to a human dispatcher.

**Input:** `{ tenantId, channel, reason: EscalationReason, contextSnapshot: Snapshot, callSid?: string }`
**Output:** `{ kind: 'transferred', toUserId: string } | { kind: 'queued_callback' } | { kind: 'declined' }`
**Errors:** `NoOnCallAvailable`, `EscalationProviderError`
**Cost ceiling:** `0`
**States:** `escalating`
**New files:**
- `packages/api/src/ai/skills/escalate-to-human.ts`
- `packages/api/src/oncall/rotation.ts` (very basic v1: ordered list of dispatcher user IDs from settings).

**Implementation:**
- **Telephony:** issue a Twilio `<Dial>` with the on-call dispatcher's number; if no answer, drop a `customer_callback_required` proposal.
- **In-app:** mark the conversation as `assigned_for_review`; show "Connecting you with a dispatcher — they'll be with you shortly" UI; ping the dispatcher inbox.

---

### `transfer_call` (small — telephony only)

Lower-level than `escalate_to_human`: just executes the Twilio transfer mechanic.

**Input:** `{ callSid, toNumber: string, fromCallerId: string }`
**Output:** `{ transferred: boolean, twilioStatus: string }`
**Errors:** `TwilioApiError`, `InvalidCallSid`
**Cost ceiling:** Twilio's per-minute rate (treated as infrastructure cost, not session cost).
**States:** `escalating`
**New file:** `packages/api/src/telephony/twilio-call-control.ts`

---

### `record_call` (small — telephony) / **n/a in-app** (browser audio is uploaded by `voice/recordings` route)

Stores call audio + finalized transcript. Telephony only — Twilio's recording feature is enabled at call start.

**Input:** `{ tenantId, callSid, recordingUrl, transcript, durationSec }`
**Output:** `{ voiceRecordingId: string }`
**Errors:** `S3UploadError`, `RepositoryError`
**Cost ceiling:** S3 storage costs (treated as infrastructure).
**States:** background (always-on during a call)
**Wraps:** existing `voice` repository.

**New work:** Twilio recording webhook → fetch from Twilio CDN → re-upload to tenant-scoped S3 bucket → write `voice_recordings` row with `source = 'inbound_call'`.

---

### `end_call` (small)

Final hangup / session close.

**Input:** `{ channel, callSid?, sessionId }`
**Output:** `{ ended: boolean }`
**Errors:** `TwilioApiError` (telephony), but degrades gracefully (Twilio will end the call when its TwiML completes anyway).
**States:** `terminated`
**New file:** `packages/api/src/ai/skills/end-call.ts`

---

### `enforce_session_caps` (small)

Tracks cumulative cost (LLM tokens, $, wall-clock) per session. Emits `cost_cap_approached` (80%) and `cost_cap_exceeded` (100%).

**Input:** `{ sessionId, tier: 'free' | 'paid', incrementCost: { tokens?: number, dollars?: number, ms?: number } }`
**Output:** `{ remaining: { tokens: number, dollars: number, ms: number }, status: 'ok' | 'approaching' | 'exceeded' }`
**Errors:** none (it's a tracker; failures are reported via `status`).
**States:** background
**New files:**
- `packages/api/src/ai/skills/session-cost-tracker.ts`
- (optional v2) Redis-backed counter for cross-process tracking.

**Implementation:** in-memory Map keyed by sessionId. v1 is per-process only; revisit when we move to multi-instance API.

---

### `enforce_compliance` (medium)

Pre-flight check before answering (telephony) or before dispatching outbound (follow-up agent reuses this).

**Input:** `{ tenantId, callerNumber?: string, channel, currentTime, businessHours: BusinessHours }`
**Output:** `{ allowed: boolean, reasons: ComplianceReason[] }`
**Errors:** `DncProviderUnavailable` (degraded — fail open with warning, or fail closed depending on tenant setting).
**States:** `idle` → `greeting` (gate)
**New files:**
- `packages/api/src/compliance/business-hours.ts`
- `packages/api/src/compliance/dnc.ts` (v1: tenant-local DNC list in DB; v2: external provider integration)

**Implementation:** v1 checks tenant `business_hours` config + tenant DNC list. v2 adds external DNC scrub provider.

---

### `summarize_session` (small)

LLM-generated 2-sentence summary of the call/session for the review queue and audit trail.

**Input:** `{ conversationId, finalState }`
**Output:** `{ summary: string, intentDetected: IntentType[], proposalIds: string[] }`
**Errors:** `LlmUnavailable` → fall back to "Caller hung up after <N> turns. No proposal created."
**Cost ceiling:** `< $0.01`
**States:** `terminated`
**New file:** `packages/api/src/ai/skills/summarize-session.ts`

---

### `emit_audit` (small — wrap)

Wraps the audit repo to log every state transition with a consistent shape.

**Input:** `{ tenantId, conversationId, transition: { from: State, to: State, event: Event }, metadata: Record<string, unknown> }`
**Output:** `{ auditId: string }`
**Errors:** `RepositoryError` (logged but does not block the state machine).
**Cost ceiling:** `0`
**States:** every transition
**Wraps:** `packages/api/src/audit/audit.ts`
**New work:** standardized `event_type` taxonomy: `agent.calling.{state}.{action}`. Add to shared enum.

## Skill composition diagram

The state machine in `flow.md` can be redrawn as state → skills:

```
greeting          : enforce_compliance, greet, disclose_recording (telephony)
identifying       : identify_caller → ask_caller_info (if unknown)
intent_capture    : capture_intent
entity_resolution : disambiguate_entity
intent_confirm    : confirm_intent
proposal_draft    : draft_proposal, notify_review_queue
closing           : (TTS sign-off) — no LLM
escalating        : escalate_to_human → transfer_call (telephony)
terminated        : summarize_session, end_call, record_call (finalize), emit_audit (final)
background        : enforce_session_caps, emit_audit (every transition)
```

## Build vs reuse summary

| Status | Skills |
|---|---|
| Reuse as-is | (none — every skill needs at least a thin wrapper) |
| Wrap existing | `greet`, `capture_intent`, `draft_proposal`, `emit_audit`, `summarize_session` |
| New (small) | `disclose_recording`, `ask_caller_info`, `confirm_intent`, `notify_review_queue`, `transfer_call`, `record_call`, `end_call`, `enforce_session_caps` |
| New (medium) | `identify_caller`, `disambiguate_entity`, `escalate_to_human`, `enforce_compliance` |

The implementation roadmap slices these into gap stories.
