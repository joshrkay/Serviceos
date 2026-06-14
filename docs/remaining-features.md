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
| `experiments/infra/src/stacks/secrets-stack.ts` | `DEEPGRAM_API_KEY` secret already present — no new secrets needed |

**Behavior:** WebSocket to `wss://api.deepgram.com/v1/listen`. Emits `partial` events (for interruption detection) and `final` event (for intent classification). Uses Deepgram's Node SDK — no raw socket management.

---

### 1B — ElevenLabs streaming TTS provider

**Why:** OpenAI `tts-1` buffers the full audio file (~800 ms TTFA). ElevenLabs streaming synthesis pipes audio as tokens generate (~250 ms TTFA) — the difference between "robotic pause" and natural conversation.

**Note:** The `TtsProvider` interface in `tts-provider.ts` is already designed for swapping.

| File | Change |
|---|---|
| `packages/api/src/ai/tts/tts-provider.ts` | Add `ElevenLabsTtsProvider` alongside existing `OpenAiTtsProvider` |
| `packages/api/src/config/` | Add `ELEVENLABS_API_KEY`, `TTS_PROVIDER` env vars |
| `experiments/infra/src/stacks/secrets-stack.ts` | Add `ELEVENLABS_API_KEY` secret |

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

## 3 — Domain Knowledge Gaps  ✅ SHIPPED

> **Status (2026-06-14):** the entire §3 set shipped during the Phase 8 /
> rivet-architect build and is wired into the calling agent on **both** the
> in-app and voice-turn channels. Retained here as a built-feature index, not
> remaining work. Each item names its primary seam; grep before assuming a gap
> remains (see
> `docs/solutions/workflow-issues/verify-spec-gaps-against-shipped-code.md`).

### 3A — Emergency detection fast-path ✅

`emergency_dispatch` is the 15th intent (`ai/orchestration/intent-classifier.ts`);
the FSM fast-paths it past `entity_resolution`/`intent_confirm` straight to
`escalating` (`ai/agents/customer-calling/transitions.ts`). A deterministic
pre-LLM keyword detector (`ai/agents/customer-calling/emergency-detector.ts`,
RV-140) speaks the 911 safety line first (RV-142) and pages on-call with a
retry ladder (RV-143). The execution handler creates an urgent job + owner SMS
page (RV-141) and now also places a **tentative appointment hold** on the
soonest feasible slot (`proposals/execution/emergency-dispatch-handler.ts` —
this closed the documented RV-141 appointment-hold deviation). HVAC/Plumbing
emergency indicators live in the detector's keyword table.
Shipped: **PR #551** + this branch.

### 3B — Vertical terminology injection ✅

`formatVerticalForCallerPrompt()` (`verticals/context-assembly.ts`) renders
service types, equipment, and aliases into prompt text; surfaced via
`verticals/resolve-active-pack.ts` and injected into the classifier system
prompt through `verticalPromptResolver`
(`ai/agents/customer-calling/inapp-adapter.ts`,
`ai/voice-turn/create-voice-turn-processor.ts`).

### 3C — Maintenance plan / membership awareness ✅

`buildCallerPlanContext()` + `formatCallerPlanForPrompt()`
(`ai/orchestration/caller-plan-context.ts`) query active agreements
(`hasActivePlan`, plan names, earliest next-service-due) and feed the classifier
via `callerPlanResolver` on both channels.

### 3D — Service type disambiguation templates ✅

`IntakeQuestion` (`verticals/registry.ts`) with per-pack `intake_questions`
(hvac / plumbing / electrical), rendered by `formatIntakeQuestionsForPrompt()`
(`verticals/context-assembly.ts`).

### 3E — Objection handling scripts ✅

`ObjectionScript` (`verticals/registry.ts`) with per-pack `objection_scripts`
(hvac / plumbing / electrical), rendered by `formatObjectionScriptsForPrompt()`
(`verticals/context-assembly.ts`).

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
