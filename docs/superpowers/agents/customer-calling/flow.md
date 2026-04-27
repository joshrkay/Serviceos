# Customer Calling Agent — Flow

**Purpose:** Handle inbound customer voice interactions. Identify the caller, capture intent, draft proposals (job, appointment, customer creation, note), and hand off to the human review queue. Channels: **inbound phone (Twilio)** and **in-app voice (web AssistantPage)**. The two channels share the same state machine; they differ only at the I/O boundary (telephony adapter vs browser audio).

**Companion files:** `skills.md`, `test-plan.md`, `implementation-roadmap.md`. **Framework:** `../README.md`.

## States

```
                         ┌──────────┐
                         │  idle    │
                         └────┬─────┘
                              │ session_started
                              ▼
                         ┌──────────┐    no consent / hangup
                         │ greeting │──────────────────────┐
                         └────┬─────┘                      │
                              │ greeted_ok                 │
                              ▼                            │
                       ┌──────────────┐  unknown_caller    │
                       │ identifying  │────┐               │
                       └────┬─────────┘    │               │
                            │ caller_known │ ask_phone     │
                            ▼              ▼               │
                  ┌─────────────────┐  ┌──────────────┐    │
                  │ intent_capture  │←─│ ask_caller   │    │
                  └────┬────────────┘  └──────────────┘    │
                       │ intent_classified                  │
                       ▼                                    │
                  ┌─────────────────────┐                   │
                  │ entity_resolution   │                   │
                  └────┬────────────────┘                   │
                       │ resolved | clarification_needed   │
                       ▼                                    │
                  ┌─────────────────────┐                   │
                  │ intent_confirm      │                   │
                  └────┬────────────────┘                   │
                       │ confirmed                          │
                       ▼                                    │
                  ┌─────────────────────┐                   │
                  │ proposal_draft      │                   │
                  └────┬────────────────┘                   │
                       │ proposal_queued                    │
                       ▼                                    │
                  ┌─────────────────────┐                   │
                  │ closing             │                   │
                  └────┬────────────────┘                   │
                       │ closed                             │
                       ▼                                    │
                  ┌─────────────────────┐                   │
                  │ terminated          │◀──────────────────┘
                  └─────────────────────┘
```

Plus three **escape states** entered from any other state: `escalating` (transfer to human), `degraded` (LLM/STT broken — fall back to human or "we'll call you back"), `terminated` (cleanup + audit).

### State definitions

| State | What it does | Entry side effects | Exit |
|---|---|---|---|
| `idle` | Agent off-duty. No active session. | none | session created |
| `greeting` | Initial utterance. Identifies the business; (telephony) discloses recording. | TTS plays greeting. Audit `session.started`. | caller's first response heard or silence timeout |
| `identifying` | Resolves caller identity. Phone-number lookup against customers table; asks if no match. | Reads tenant business hours; checks DNC list (telephony). | caller resolved, or `ask_caller` ladder, or `unknown_caller` flag set |
| `intent_capture` | Listens for caller's request. Streams transcript through reference-resolver + intent-classifier. | Starts conversation message append. | intent classified with confidence ≥ τ, OR clarification needed, OR multi-intent split |
| `entity_resolution` | Disambiguates references ("the Rodriguez job", "my last invoice"). Uses entity-resolver against customer/job/invoice/appointment indexes. | Pulls top-K candidates with confidence scores. | resolved, or asks one disambiguation question, or marks `pendingReference` |
| `intent_confirm` | Verbal confirmation of what's about to happen. ("So you'd like to schedule a service appointment for Friday at 2pm — correct?") | TTS reads back proposal summary. | confirmed → next state; corrected → back to `intent_capture` |
| `proposal_draft` | Calls task-router with intent + entities. Creates proposal in queue. | Persists Proposal row with `sourceContext.channel = 'inbound_call' \| 'inapp_voice'`. | proposal id obtained → `closing` |
| `closing` | "I've got that booked. You'll get an SMS confirmation. Anything else?" Optional second-intent loop back to `intent_capture`. | Audit `proposal.queued`. | `closed` event |
| `escalating` | Caller requested human, OR confidence too low, OR cost cap, OR abuse. Transfers (telephony: dial out; web: show "wait" + page on-call). | Audit `escalation.requested` with reason. | transfer accepted or declined |
| `degraded` | STT/LLM/Provider failed. Fall back to "I'll have someone call you back" + drops a high-priority `human_callback_required` proposal. | Records failure mode. | `closing` with degraded summary |
| `terminated` | Cleanup. Final audit. Compute call summary for review queue. | `session.ended` audit, finalize transcript, store call recording S3 path. | — |

## Events

Events come from two sources:

**Telephony adapter** (Twilio webhook → internal adapter → state machine):
- `incoming_call(call_sid, from, to, tenant_id)`
- `audio_chunk_received(audio_blob, ts)`
- `dtmf_received(digit, ts)`
- `silence_timeout(ms_silent)`
- `caller_hangup`
- `call_status_updated(status)` (Twilio → in-progress, completed, failed)
- `recording_completed(recording_url)`

**In-app voice adapter** (frontend AssistantPage / VoiceUpdatePage → API):
- `session_started(user_id, tenant_id, conversation_id)`
- `audio_chunk_received(audio_blob, ts)` — same shape
- `text_input(text)` — keyboard fallback path
- `session_ended` — user closed page or clicked "end"

**Internal events** (produced by skills, consumed by the state machine):
- `intent_classified(intent_type, entities, confidence)`
- `entity_resolved(refs)` / `entity_ambiguous(candidates)` / `entity_not_found`
- `confidence_low(threshold, score)`
- `proposal_queued(proposal_id)`
- `cost_cap_approached(remaining_pct)` / `cost_cap_exceeded`
- `abuse_detected(category)` (profanity, threats, sexual content)
- `prompt_injection_detected`
- `compliance_violation_detected(rule)` (DNC hit, after-hours, missing consent)

## Transition table

States × events. Empty cell = event ignored (logged). `→X` = transition to state X. `[guard]` = condition.

| State \ Event | session_started | greeted_ok | caller_known | unknown_caller | intent_classified | entity_resolved | confirmed | proposal_queued | closed | caller_hangup | cost_cap_exceeded | abuse_detected |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| idle | →greeting | — | — | — | — | — | — | — | — | →terminated | →degraded | →terminated |
| greeting | — | →identifying | — | — | — | — | — | — | — | →terminated | →escalating | →terminated |
| identifying | — | — | →intent_capture | →ask_caller (substate) | — | — | — | — | — | →terminated | →escalating | →terminated |
| intent_capture | — | — | — | — | →entity_resolution [conf ≥ τ_int] | — | — | — | — | →terminated | →escalating | →terminated |
| entity_resolution | — | — | — | — | — | →intent_confirm [unambiguous] | — | — | — | →terminated | →escalating | →terminated |
| intent_confirm | — | — | — | — | →intent_capture [correction] | — | →proposal_draft | — | — | →terminated | →escalating | →terminated |
| proposal_draft | — | — | — | — | — | — | — | →closing | — | →terminated [proposal still drafted with partial context] | →escalating | →terminated |
| closing | — | — | — | — | →intent_capture [second intent] | — | — | — | →terminated | →terminated | →escalating | →terminated |
| escalating / degraded | — | — | — | — | — | — | — | →closing | →terminated | →terminated | →terminated | →terminated |

Confidence threshold τ_int = 0.75 (intent classification). τ_ent = 0.80 (entity resolution unambiguous). Below threshold → forced clarification.

## Substates

Some states have internal loops:

- **`identifying.ask_caller`** — phone unmatched: "What's your name and the address you're calling about?" Up to 2 retries before escalation.
- **`intent_capture.reprompt`** — confidence below τ_int: "I want to make sure I got that right — can you say that again?" Up to 1 retry before escalation.
- **`entity_resolution.disambiguate`** — multiple candidates: "Did you mean Bob Rodriguez or Bob Thompson?" Single retry.
- **`closing.second_intent`** — "Anything else?" Yes → loop to `intent_capture` with same session.

## Side effects per transition

Every transition records:
1. State name (entered, exited)
2. Trigger event
3. Wall-clock timestamp
4. Conversation id, tenant id
5. Call sid (telephony) or session id (in-app)

Persisted to `conversation_messages` (per-turn) and `audit_events` (per-state-change).

## Channel-specific differences

| Concern | Telephony (Twilio) | In-app (web) |
|---|---|---|
| Audio I/O | Twilio Media Streams (WebSocket) | MediaRecorder API → REST upload |
| TTS playback | `<Say>` or `<Play>` TwiML | Web Audio API + `tts-provider.ts` |
| `greeting` content | "You've reached <tenant>. This call may be recorded." | "Hi <user.firstName>." (no recording disclosure — user opted in by visiting the page) |
| `identifying` shortcut | Phone match against `customers.phone` | User is logged in — already a tenant member; identifying = "which customer/job is this about?" |
| `escalating` | Twilio `<Dial>` to on-call rotation | Show "Connecting you with a dispatcher" + page on-call |
| `terminated` cleanup | Hang up via Twilio API; finalize recording | Close mic; persist final transcript |
| Compliance | TCPA + state recording disclosures + DNC | n/a (logged-in user) |
| Cost cap | $X / call (from settings) | $Y / session (from settings) |
| Session timeout | 15 min hard cap | 30 min hard cap |

The state machine is identical. Adapters at boundaries.

## Cost & rate caps (defaults)

- Per-call LLM budget: `5,000 input tokens + 1,500 output tokens` (≈ 8 turns of intent classification).
- Per-call $ budget: `$0.40` (provider mix).
- Per-tenant per-day call budget: `100 inbound calls` (configurable in tenant settings).
- Concurrency: `3 concurrent calls per tenant` (free tier) / `unlimited` (paid).

When 80% of any cap is hit, the agent emits `cost_cap_approached`. At 100%: `cost_cap_exceeded` → escalate.

## Failure-mode → state map

| Failure | Detected by | Transition |
|---|---|---|
| Whisper STT failure | transcription worker error | → `degraded` after 2 retries |
| Intent classifier LLM timeout | gateway timeout | → reprompt once, then `escalating` |
| Provider outage (all gateways down) | gateway health check | → `degraded` immediately |
| Twilio call drops | `caller_hangup` event | → `terminated` (with whatever proposal context exists) |
| Caller silence > 10s | `silence_timeout` | reprompt; 2nd silence → `closing` |
| Prompt injection in transcript | `prompt_injection_detected` | log + ignore that turn; if repeated → `escalating` |
| Abuse / profanity | `abuse_detected` | warn once, second instance → `terminated` |
| DNC list hit (outbound only — applies to follow-up agent, not this one) | DNC service | n/a here |
| After-hours call (telephony) | tenant business hours check | → answer with after-hours greeting + offer voicemail/callback proposal |

## Open questions (for the implementation roadmap to resolve)

1. **Voicemail vs IVR after-hours?** Default to "leave a message and we'll call back tomorrow" (drops a `customer_callback` proposal) until tenant elects an after-hours staffing model.
2. **Call recording opt-out — re-prompt or drop?** Default: drop with polite "I'm not able to take this call without recording. Please call during business hours and ask for a manual callback."
3. **Voice-print authentication?** Out of scope v1. Identity = phone number match + ask-by-name fallback.
4. **Multi-language support?** Out of scope v1. Detect non-English on first turn → escalate.
5. **Does the agent ever auto-execute proposals?** Default no (matches platform-wide rule). When tenant settings explicitly allow `auto_execute_for_low_risk_proposals`, only `add_note` and `customer_callback_request` qualify.
