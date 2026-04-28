# Customer Calling Agent — Implementation Roadmap

**Goal:** turn `flow.md` + `skills.md` + `test-plan.md` into discrete gap stories that fit the existing P-NNN-NNN format and can be dispatched by `/dispatch-story` in parallel waves.

**Phase mapping:** Customer-calling agent work spans the existing phase numbering plus a new **Phase 8 — Customer Voice Agents** that we'll create. Stories below are proposed P8-001..P8-014 and will live in `docs/stories/phase-8-stories.md` (originals) and `docs/stories/phase-8-gap-stories.md` (the actual implementation). A dispatch addendum at `docs/superpowers/contracts/p8-dispatch-addendum.md` accompanies them.

**Pre-existing dependencies:** several skills assume capabilities from earlier phases. Don't dispatch this work until at least:
- `P0-027` (Whisper STT integrated) — done per security review
- `P0-029, P0-030, P0-031` (frontend Clerk auth) — required for in-app agent
- `P3-016` (AssistantPage connected to backend) — required for in-app agent

If any of those are not yet merged, dispatch them first via the existing P0/P3 wave plan.

## Story slice overview

| Story | Title | Size | Wave | Channel scope |
|---|---|---|---|---|
| P8-001 | Pg entity resolver + trigram indexes | M | 8A | both |
| P8-002 | `enforce_compliance` skill (business hours + tenant DNC) | S | 8A | both |
| P8-003 | `enforce_session_caps` skill | S | 8A | both |
| P8-004 | Calling-agent state machine (channel-agnostic core) | M | 8A | both |
| P8-005 | `disclose_recording` skill + state-aware copy | S | 8A | telephony |
| P8-006 | `identify_caller` skill (phone match) | S | 8A | telephony (in-app reuses it for CRM lookup) |
| P8-007 | `confirm_intent` skill | S | 8A | both |
| P8-008 | `escalate_to_human` skill (in-app variant) | S | 8A | in-app |
| P8-009 | In-app voice session integration: AssistantPage drives state machine | M | 8B | in-app |
| P8-010 | `summarize_session` skill | S | 8B | both |
| P8-011 | Twilio inbound webhook + adapter shell (TwiML round-trips) | M | 8B | telephony |
| P8-012 | Twilio Media Streams integration: live audio → state machine | M | 8C | telephony |
| P8-013 | `escalate_to_human` telephony variant + on-call rotation | S | 8C | telephony |
| P8-014 | `record_call` skill (Twilio recording → S3 + voice repo) | S | 8C | telephony |

**Wave plan:**

| Wave | Stories | Mode | Blocks |
|---|---|---|---|
| 8A | P8-001..P8-008 | parallel (8 agents) | 8B |
| 8B | P8-009, P8-010, P8-011 | parallel (3 agents) — can run in parallel with the back half of 8A as long as 8A core merges first | 8C |
| 8C | P8-012, P8-013, P8-014 | parallel (3 agents) | done |

Sprint estimate: **3 wall-clock days** with multi-agent (8 → 3 → 3 = 14 stories in 3 waves). Sequential equivalent: ~3 weeks.

**Note:** P8-012's "Media Streams" path is the most operationally risky story (real-time audio over WebSocket). Allow extra review time; do not auto-dispatch it without a human in the loop.

---

## Story specs (drop into `docs/stories/phase-8-gap-stories.md`)

### P8-001 — Postgres entity resolver + trigram indexes

> **Size:** M | **Layer:** AI/Data | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** P0-019 (core entity Pg repos), P0-024 (RLS middleware)

**Allowed files:** `packages/api/src/ai/resolution/pg-entity-resolver.ts, packages/api/src/ai/resolution/entity-resolver.ts, packages/api/src/db/schema.ts, packages/api/test/ai/resolution/**`

**Build prompt:** Replace `NullEntityResolver` (default in production) with `PgEntityResolver` that resolves free-text references to tenant-scoped IDs. Use pg_trgm GIN indexes on `customers.name`, `jobs.title`, `invoices.invoice_number`, plus a date range index on `appointments.scheduled_for`. Return `{ kind: 'resolved' | 'ambiguous' | 'not_found' | 'skipped' }` per the existing interface. Confidence score = trigram similarity 0..1; threshold τ_ent = 0.80 for unambiguous.

**Review prompt:** Verify all queries are tenant-scoped via `withTenant()`. Verify indexes exist via migration. Verify confidence thresholds documented. Verify performance under realistic data sizes (10k customers).

**Automated checks:**
```bash
npx tsc --project packages/api/tsconfig.build.json --noEmit
npm test --workspace=packages/api -- --run --grep "P8-001|PgEntityResolver"
```

**Required tests:**
- [ ] Happy path — exact name match resolves to one customer
- [ ] Trigram fuzzy — "Rodrigez" resolves to "Rodriguez" with confidence < 1
- [ ] Ambiguous — two candidates above τ_ent → `ambiguous` with both
- [ ] Not found — no candidate above τ_ent → `not_found`
- [ ] Tenant isolation — Tenant A's "Bob" not visible to Tenant B
- [ ] Date references — "next Tuesday" resolves to absolute date in tenant timezone
- [ ] Performance — p95 < 50ms for 10k customers

---

### P8-002 — `enforce_compliance` skill

> **Size:** S | **Layer:** AI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-024

**Allowed files:** `packages/api/src/compliance/**, packages/api/src/ai/skills/enforce-compliance.ts, packages/api/src/db/schema.ts, packages/api/test/compliance/**`

**Build prompt:** Implement business-hours and tenant-local DNC list checks. Inputs: `{ tenantId, callerNumber?, channel, currentTime, businessHours }`. Outputs: `{ allowed, reasons }`. Tenant DNC list is stored in `tenant_dnc_list` table (migration TBD). Business hours read from existing `settings`. After-hours = allowed but with `reason: ['after_hours']` so caller flow uses after-hours greeting branch.

**Required tests:** business hours hit/miss, DNC hit, missing tenant settings (default to "during business hours, M-F 9-5 tenant TZ"), DNC service unavailable (fail closed unless tenant config opts to fail open).

**Automated checks:**
```bash
npx tsc --project packages/api/tsconfig.build.json --noEmit
npm test --workspace=packages/api -- --run --grep "P8-002|enforce_compliance"
```

---

### P8-003 — `enforce_session_caps` skill

> **Size:** S | **Layer:** AI | **AI Build:** High | **Human Review:** Light

**Dependencies:** none

**Allowed files:** `packages/api/src/ai/skills/session-cost-tracker.ts, packages/api/test/ai/skills/**`

**Build prompt:** In-memory per-session cost tracker. Tracks tokens, $, ms. Emits `cost_cap_approached` at 80%, `cost_cap_exceeded` at 100%. Configurable caps per tier (free / paid). Pure function + small class. No persistence v1.

**Automated checks:**
```bash
npx tsc --project packages/api/tsconfig.build.json --noEmit
npm test --workspace=packages/api -- --run --grep "P8-003|session-cost-tracker"
```

---

### P8-004 — Calling-agent state machine (channel-agnostic core)

> **Size:** M | **Layer:** AI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P8-001, P8-002, P8-003

**Allowed files:** `packages/api/src/ai/agents/customer-calling/**, packages/api/test/ai/agents/customer-calling/**`

**Build prompt:** Implement the state machine in `docs/superpowers/agents/customer-calling/flow.md` as a pure TypeScript module. States, events, transitions, guards. Channel-agnostic — no Twilio, no MediaRecorder. Skill calls are dependency-injected. The state machine is a function `(currentState, event, context) => { nextState, sideEffects[], events[] }`. No I/O.

**Required tests:** every state × every event in the transition table from `flow.md`. Adversarial sequences (events out of order). Tests double as documentation.

**Forbidden files:** `packages/api/src/app.ts` (wiring is a separate story).

**Automated checks:**
```bash
npx tsc --project packages/api/tsconfig.build.json --noEmit
npm test --workspace=packages/api -- --run --grep "P8-004|customer-calling state machine"
```

---

### P8-005 — `disclose_recording` skill + state-aware copy

> **Size:** S | **Layer:** AI/Compliance | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** P8-002

**Allowed files:** `packages/api/src/ai/skills/disclose-recording.ts, packages/shared/src/legal/recording-disclosure.ts, packages/api/test/ai/skills/disclose-recording.test.ts`

**Build prompt:** Plays a state-by-state appropriate recording disclosure. Two-party-consent state list: CA, FL, IL, MD, MA, MT, NV, NH, PA, WA, CT (verify in copy). Default to two-party text if state unknown. Returns `{ disclosed }`. Legal review flag in PR description.

**Special note:** this is the only story whose copy must be reviewed by Legal before merge. The story's PR description must explicitly state "Legal review required — recording-disclosure.ts copy".

---

### P8-006 — `identify_caller` skill

> **Size:** S | **Layer:** AI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P8-001 (entity resolver), P0-019 (customer Pg repo)

**Allowed files:** `packages/api/src/ai/skills/identify-caller.ts, packages/api/src/db/schema.ts, packages/api/test/ai/skills/**`

**Build prompt:** Phone-matching skill. Normalize incoming `from` to E.164. Query indexed phone column. Return matched/multiple/unknown. Migration adds `idx_customers_phone_normalized` (lower + strip non-digits).

---

### P8-007 — `confirm_intent` skill

> **Size:** S | **Layer:** AI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-027 (LLM gateway works)

**Allowed files:** `packages/api/src/ai/skills/confirm-intent.ts, packages/api/test/ai/skills/**`

**Build prompt:** TTS-readback + yes/no LLM classifier. Returns `{ confirmed, correction? }`. Use cheaper model tier (Haiku/Sonnet). Cost ceiling enforced via P8-003.

---

### P8-008 — `escalate_to_human` skill (in-app variant)

> **Size:** S | **Layer:** AI | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P8-004

**Allowed files:** `packages/api/src/ai/skills/escalate-to-human.ts, packages/api/src/oncall/**, packages/api/test/oncall/**`

**Build prompt:** v1 in-app behavior only. Marks the conversation as `assigned_for_review`, picks an on-call dispatcher from `tenant_oncall_rotation` table (simple ordered list), creates an inbox notification. Telephony variant follows in P8-013.

---

### P8-009 — In-app voice session integration

> **Size:** M | **Layer:** AI/UI | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** P8-004, P0-029, P3-016

**Allowed files:** `packages/api/src/routes/assistant.ts, packages/web/src/components/assistant/AssistantPage.tsx, packages/web/src/components/assistant/VoiceSession.tsx (new), packages/web/src/hooks/useVoiceSession.ts (new)`

**Build prompt:** Wire AssistantPage to the calling-agent state machine via the existing `/api/voice/recordings` endpoint plus a new SSE/long-poll for state-machine events. Display the current agent state, active prompts, and queued proposals.

---

### P8-010 — `summarize_session` skill

> **Size:** S | **Layer:** AI | **AI Build:** High | **Human Review:** Light

**Allowed files:** `packages/api/src/ai/skills/summarize-session.ts, packages/api/test/ai/skills/**`

**Build prompt:** One-shot LLM summary at session end. Returns `{ summary, intentDetected, proposalIds }`. Cheap model tier.

---

### P8-011 — Twilio inbound webhook + adapter shell

> **Size:** M | **Layer:** Telephony | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P8-004

**Allowed files:** `packages/api/src/telephony/**, packages/api/src/routes/telephony.ts (new), packages/api/test/telephony/**, infra/lib/telephony-stack.ts (new), packages/api/src/db/schema.ts`

**Build prompt:** Add `/api/telephony/voice` Twilio webhook. Verify Twilio signature. Translate inbound call → `incoming_call` event into the calling-agent state machine. Return appropriate TwiML (`<Say>` greet, `<Gather>` for caller turn). v1 uses `<Gather input="speech" speechTimeout="auto">` rather than Media Streams (P8-012 upgrades this). Add CDK stack registering Twilio number + webhook URL in dev/staging/prod.

**Forbidden files:** `packages/api/src/app.ts` (wiring done separately).

---

### P8-012 — Twilio Media Streams integration (live audio)

> **Size:** M | **Layer:** Telephony | **AI Build:** Low | **Human Review:** Heavy

**Dependencies:** P8-011

**Allowed files:** `packages/api/src/telephony/media-streams/**, packages/api/test/telephony/media-streams/**`

**Build prompt:** Upgrade from `<Gather speechTimeout>` to Twilio Media Streams over WebSocket. Stream caller audio chunks directly to Whisper. Lower latency, real interruption handling. **Higher operational risk — carefully reviewed.**

**Note:** this story should not be auto-dispatched. The coordinator runs it manually with a human in the loop.

---

### P8-013 — `escalate_to_human` telephony variant + on-call rotation

> **Size:** S | **Layer:** Telephony | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P8-008, P8-011

**Allowed files:** `packages/api/src/ai/skills/escalate-to-human.ts (extend), packages/api/src/telephony/twilio-call-control.ts (new), packages/api/test/telephony/**`

**Build prompt:** Add `<Dial>` transfer to on-call rotation. If first dispatcher doesn't answer within ringing timeout, fall through to next. If none answer, drop a `customer_callback_required` proposal and play a polite "we'll call you back" message.

---

### P8-014 — `record_call` skill

> **Size:** S | **Layer:** Telephony | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P8-011

**Allowed files:** `packages/api/src/telephony/recording-webhook.ts (new), packages/api/src/voice/voice-service.ts, packages/api/test/telephony/**`

**Build prompt:** Twilio recording webhook → fetch from Twilio CDN → re-upload to tenant-scoped S3 → write `voice_recordings` row with `source = 'inbound_call'`. Tenant-scoped S3 prefix: `s3://serviceos-recordings/<tenant_id>/<call_sid>.mp3`.

---

## Dispatch addendum metadata

After this roadmap is approved, write `docs/superpowers/contracts/p8-dispatch-addendum.md` with the same structure as `p0-dispatch-addendum.md`:

- Wave plan table (8A / 8B / 8C)
- Per-story block: status, wave, migration number reservation, forbidden files, verification gate, pre-flight deps
- Migration reservations: P8-001 owns `046_*` (pg_trgm indexes); P8-002 owns `047_*` (DNC list); P8-006 owns `048_*` (phone normalization index); P8-008 owns `049_*` (oncall rotation table)

Coordinator step: confirm migrations 042-045 (Sprint 1, P0-019..P0-022) merged before reserving 046+.

## Per-story acceptance gate template

For every P8-N story, the verification gate is the same shape:

```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P8-N" && \
  git diff --name-only origin/main... | grep -vE "^(<allowed-files-pattern>)" | (! grep . )
```

The `<allowed-files-pattern>` is the regex equivalent of the story's "Allowed files" line.

## Out of scope for this roadmap

- **Voice-print authentication** — security/CX feature for v2. Not blocking launch.
- **Multi-language** — explicit non-goal v1.
- **Automatic outbound call origination** (the agent calling someone) — that's the follow-up agent.
- **Cost optimization beyond per-session caps** — runs in observability, separate work stream.
- **Real-time call transcription display in dispatcher UI** — nice-to-have v2.

## Sequencing relative to other agents

Once **8A** merges (state machine + entity resolver + compliance + caps), the **customer follow-up agent** can begin its own implementation roadmap in parallel — it reuses the same skills layer (`enforce_compliance`, `enforce_session_caps`, `summarize_session`, the Pg entity resolver) and adds outbound channels.
