# Remaining Features

*Last updated: 2026-04-29*

## Shipped (this sprint)

| Feature | Status |
|---|---|
| Stripe Payment Links — invoice checkout | ✅ |
| Stripe `checkout.session.completed` webhook + idempotency | ✅ |
| Public invoice payment page (token-based, `/pay/:token`) | ✅ |
| Estimate approval page (token-based, `/e/:token`) | ✅ |
| Twilio SMS + SendGrid email delivery (`/send` endpoints) | ✅ |
| 12 Stripe / public-invoice edge case hardening fixes | ✅ |
| P0-023: Postgres repo pool ternary wiring (6 repos) | ✅ |

---

## 1 — Voice Provider Upgrades

Before dispatching Phase 8, wire two provider additions into the existing pluggable interfaces. Both are isolated — no state machine changes.

### 1A — Deepgram Nova-3 streaming STT backend provider

**Why:** Whisper is file-based (1–3 s latency). The calling agent needs real-time streaming STT to sound natural. Deepgram Nova-3 delivers transcripts in ~300 ms via WebSocket.

**Note:** Deepgram is already on the *frontend* (technician voice input). The backend gap is a `DeepgramStreamingProvider` class for the calling agent's real-time path. Whisper stays for async technician uploads.

| File | Change |
|---|---|
| `packages/api/src/voice/transcription-providers.ts` | Add `DeepgramStreamingProvider` alongside existing `OpenAiWhisperProvider` |
| `infra/src/stacks/secrets-stack.ts` | `DEEPGRAM_API_KEY` secret already present — no new secrets needed |

**Behavior:** WebSocket to `wss://api.deepgram.com/v1/listen`. Emits `partial` events (for interruption detection) and `final` event (for intent classification). Uses Deepgram's Node SDK — no raw socket management.

---

### 1B — ElevenLabs streaming TTS provider

**Why:** OpenAI `tts-1` buffers the full audio file (~800 ms TTFA). ElevenLabs streaming synthesis pipes audio as tokens generate (~250 ms TTFA) — the difference between "robotic pause" and natural conversation.

**Note:** The `TtsProvider` interface in `tts-provider.ts` is already designed for swapping.

| File | Change |
|---|---|
| `packages/api/src/ai/tts/tts-provider.ts` | Add `ElevenLabsTtsProvider` alongside existing `OpenAiTtsProvider` |
| `packages/api/src/config/` | Add `ELEVENLABS_API_KEY`, `TTS_PROVIDER` env vars |
| `infra/src/stacks/secrets-stack.ts` | Add `ELEVENLABS_API_KEY` secret |

**Behavior:** Streams audio chunks directly to Twilio Media Streams WebSocket rather than buffering full file. Selectable via `TTS_PROVIDER=elevenlabs` env var; falls back to OpenAI TTS if unset.

**Cost:** ~$0.0003/min — absorb into per-minute rate, do not line-item to customers.

---

## 2 — Phase 8: Customer Calling Agent

14 stories across 3 waves. Full specs in `docs/superpowers/agents/customer-calling/implementation-roadmap.md`.

### Wave 8A (parallel — 8 stories)

| Story | Title | Key output |
|---|---|---|
| P8-001 | Pg entity resolver + trigram indexes | `PgEntityResolver` with pg_trgm GIN indexes; replaces `NullEntityResolver` |
| P8-002 | `enforce_compliance` skill | Business-hours check + tenant DNC list |
| P8-003 | `enforce_session_caps` skill | In-memory token/$ cap with `cost_cap_approached` / `cost_cap_exceeded` events |
| P8-004 | Calling-agent state machine core | Channel-agnostic FSM: `greeting → intent_capture → entity_resolution → intent_confirm → dispatching → closing` |
| P8-005 | `disclose_recording` skill | State-aware disclosure copy; telephony-required, in-app optional |
| P8-006 | `identify_caller` skill | Phone number → customer match; pre-loads recent job + open invoice |
| P8-007 | `confirm_intent` skill | Reads back classified intent + entities for customer confirmation |
| P8-008 | `escalate_to_human` (in-app variant) | Handoff to dispatcher in-app session |

### Wave 8B (parallel — 3 stories, after 8A merges)

| Story | Title | Key output |
|---|---|---|
| P8-009 | In-app voice session integration | AssistantPage drives state machine; renders agent turns in conversation thread |
| P8-010 | `summarize_session` skill | Post-call summary stored in `call_summaries` table |
| P8-011 | Twilio inbound webhook + TwiML adapter | Basic `<Gather>` mode — telephony path goes live (higher latency but functional) |

### Wave 8C (human-supervised — 3 stories, after 8B merges)

| Story | Title | Key output |
|---|---|---|
| **P8-012** | **Twilio Media Streams (real-time audio)** | **WebSocket live audio → Deepgram → state machine; TTFA target < 800 ms** |
| P8-013 | `escalate_to_human` telephony variant | On-call rotation lookup + Twilio `<Dial>` transfer |
| P8-014 | `record_call` skill | Twilio recording → S3 + `call_recordings` row |

> **P8-012 is the competitive-parity story.** Avoca's core claim is "answers instantly." Without Media Streams, the agent uses `<Gather>` polling and feels slow. Do not defer P8-012 to a v2.

---

## 3 — Domain Knowledge Gaps (close during Phase 8 build)

These are prompt-engineering and data-wiring tasks that make the calling agent sound like it knows home services. They're added *while* Phase 8 is being built — not after.

### 3A — Emergency detection fast-path

**Gap:** The intent classifier has 14 intents; none is `emergency_dispatch`. A caller saying "my furnace is out at 15°F" is treated the same as a tune-up request.

**Fix:**
- Add `emergency_dispatch` as a 15th intent in `packages/api/src/ai/orchestration/intent-classifier.ts`
- In the P8-004 state machine, treat `emergency_dispatch` as a fast-path: skip `entity_resolution` and `intent_confirm`, go directly to `escalating` with on-call notification
- Add emergency indicators to vertical packs:
  - **HVAC:** "no heat," "no cool," "gas smell," "burning smell," "smoke," "sparks," "water leaking from furnace"
  - **Plumbing:** "flooding," "burst pipe," "no water," "sewage backup," "gas smell," "no hot water" (elevated priority, not full emergency unless flooding)

### 3B — Vertical terminology injection into calling agent prompts

**Gap:** `context-builder.ts` loads `context.vertical` but the calling agent receives it as a raw JSON blob with no instructions on how to use it.

**Fix:** Add `formatVerticalForCallerPrompt(verticalContext)` to `packages/api/src/verticals/context-assembly.ts`. Outputs formatted prompt text including service types, equipment terminology, emergency indicators, and disambiguation questions. Called when building the `intent_capture` state's system prompt in P8-004.

Example output:
```
Service vertical: HVAC
Equipment recognized: furnace (heater, heating unit), AC (air conditioner, central air),
  heat pump (mini split, ductless), thermostat
Service types: diagnostic ($89), tune-up, repair, installation, emergency ($150 surcharge)
Emergency indicators: no heat, no cool, gas smell, burning smell, sparks
Disambiguation: "Is this for heating or cooling?" / "How old is the unit?"
```

### 3C — Maintenance plan / membership awareness

**Gap:** When a plan member calls, the agent doesn't know they're a member and can't offer priority booking.

**Fix:** Extend `buildCallerContext()` in `packages/api/src/ai/orchestration/context-builder.ts` to query `packages/api/src/contracts/` for active maintenance contracts on the resolved customer. Pass `{ hasActivePlan: true, planType: 'Gold', nextServiceDue: '2026-06-01' }` to the state machine. The `greeting` state uses this for personalization: *"Hi Sarah, I see you're on our Gold plan — you have priority scheduling."*

### 3D — Service type disambiguation templates

**Gap:** No structured way to ask vertical-specific clarifying questions. Generic "Can you tell me more?" is weaker than "Is this a heating or cooling issue?"

**Fix:** Add `intake_questions` array to each vertical pack (`packages/api/src/verticals/packs/hvac.ts`, `plumbing.ts`):
```ts
intake_questions: [
  { trigger: 'hvac', question: 'Is this for heating or cooling?', intent: 'service_disambiguation' },
  { trigger: 'unknown_issue', question: 'Is this an emergency or can we schedule a visit?', intent: 'urgency_triage' },
]
```
The `intent_capture` state uses these when classifier confidence < τ_int.

### 3E — Objection handling scripts

**Gap:** No handling for "that's too expensive," "why do I need a dispatch fee," "can you just tell me over the phone."

**Fix:** Add `objection_scripts` to tenant settings (tenants can customize). Default scripts per vertical stored in vertical packs. When classifier detects an objection pattern, emit `objection_detected` → state machine plays scripted reframe.

Default scripts:
- "That's expensive" → *"Our technicians carry all parts on their truck so you won't pay for a second trip."*
- "Dispatch fee?" → *"The $89 diagnostic fee goes toward your repair if you proceed today."*

---

## 4 — Differentiators (post-Phase 8 launch)

These require the calling agent to be live first.

### 4A — Live customer context in every call

When `identify_caller` (P8-006) resolves a phone number, extend the pre-load to include: last job date + outcome, open estimates, open invoices, next scheduled appointment. Greeting becomes: *"Hi Sarah, are you calling about Thursday's HVAC service, or is there something else?"*

**File:** `packages/api/src/ai/orchestration/context-builder.ts` — add `buildCallerContext(tenantId, customerId)` pulling customer + recent job + open invoice in one query.

**Competitive edge:** Avoca must call the ServiceTitan API for this data. ServiceOS reads its own DB in < 50 ms.

### 4B — CSR coaching / call quality scoring

After each call, a background worker runs an LLM evaluation against the transcript. Scores: booking conversion, handling unclear requests, resolution, tone. Output goes to `call_quality_scores` table; surfaces in a dispatcher dashboard tab.

Closes the gap with Avoca Coach.

| File | Change |
|---|---|
| `packages/api/src/workers/call-quality-worker.ts` | New worker, reuses evaluation pattern from `packages/api/src/ai/evaluation/conversation-evaluation.ts` |
| `packages/api/src/routes/call-quality.ts` | New route for dashboard reads |
| Frontend | New panel in dispatcher settings page |

---

## 5 — Remaining Low-Priority Edge Cases

From the 30-item audit. Not blocking real payments but worth closing before high traffic.

| ID | File | Issue |
|---|---|---|
| EC-7 | `public-invoices.ts` | `tokenGuard` rejects with no logging; no max-length check at route layer (service has it) |
| EC-9 | `public-invoices.ts` | Route handlers don't log errors before re-throwing |
| EC-11 | `webhooks/routes.ts` | Signature failures don't distinguish stale-timestamp vs bad-sig in logs |
| EC-17 | `webhooks/routes.ts` | `event.data.object` cast with no Zod validation |
| EC-18 | `webhooks/routes.ts` | Mismatch log omits partial sig for debugging |
| EC-20 | `InvoicePaymentPage.tsx` | No fallback if `window.location.href` is blocked (rare mobile WebViews) |
| EC-22 | `InvoicePaymentPage.tsx` | `pingView` swallows errors silently; network error surfaces as "Error undefined" |
| EC-24 | `InvoicePaymentPage.tsx` | `formatMoney` doesn't guard negative values |
| EC-28 | `invoice.ts` | `InMemoryInvoiceRepository.findByViewToken` is O(n) — test-only, acceptable |

---

## 6 — Open Product Questions

These require a decision before implementation.

### Auto-transition draft invoice → open on send

**Question:** When `sendInvoice` is called on a draft invoice, should it automatically transition to `open`?

**Context:** Estimates already auto-transition (`draft` / `ready_for_review` → `sent`) when sent. Invoices currently do not. The `issueInvoice()` function sets `status: 'open'` *and* `issuedAt` + `dueDate` using the tenant's payment term days. A bare status flip without those fields would leave open invoices with no due date.

**Options:**
- A) Call `issueInvoice()` first (reads payment term days from settings) before sending — full transition including `issuedAt` / `dueDate`
- B) Require the user to explicitly issue the invoice before sending — keep two-step as-is
- C) Flip status only, leave `issuedAt` / `dueDate` null — simplest but inconsistent

---

## Go-to-Market Sequence

1. **Now available:** Invoices with Stripe payment, estimate approvals via link, SMS + email delivery
2. **Next 3 days (Phase 8A + 8B):** In-app AI voice agent live; telephony path via `<Gather>` (higher latency)
3. **+1 day (Phase 8C):** Media Streams live — real-time audio, < 800 ms TTFA, competitive with Avoca
4. **+1 week (domain knowledge):** Emergency fast-path, vertical prompts, membership awareness — prompt parity with Avoca
5. **Post-launch:** CSR coaching dashboard, live customer context greeting, objection handling tuning
