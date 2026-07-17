# Phase 8 — Customer Voice Agents: Wave 8C Gap Stories

> **5 stories** | Continues from P8-011

---

## Purpose

Phase 8 ships an inbound AI customer-service representative on Twilio. Waves 8A and 8B (P8-001 through P8-011) shipped the channel-agnostic FSM, eleven skills, the in-app voice path, and a Gather-mode Twilio webhook. This file covers the remaining wave 8C stories needed for v1 production parity:

- **P8-012** — Real-time audio over Twilio Media Streams (replaces ~2-4s Gather-mode round-trips with sub-second turn-taking via Deepgram Nova-3 streaming STT).
- **P8-013** — Telephony `escalate_to_human` via `<Dial>` to the on-call rotation.
- **P8-014** — `record_call` skill that pulls the Twilio recording and persists it to tenant-scoped S3 + a `voice_recordings` row.

## Exit Criteria

Inbound calls reach sub-second turn-taking with barge-in, escalations cascade through the on-call rotation with a callback fallback, and every call is recorded to tenant-scoped S3 with a `voice_recordings` row.

## Foundations already in place

- `packages/api/src/voice/transcription-providers.ts:311` — `DeepgramStreamingProvider` (Nova-3, 16 kHz PCM, interim_results) is implemented; P8-012 only wires it.
- `packages/api/src/ai/agents/customer-calling/voice-session-store.ts` — `VoiceSessionStore` already has `findByCallSid` and `withSessionLock`. P8-012 reuses unchanged.
- `packages/api/src/oncall/rotation.ts` — `OnCallRepository.listRotation` exists; P8-013 iterates on no-answer.
- `packages/api/src/db/schema.ts:1264` — migration `054_p8_telephony_tables` already added `voice_recordings.call_sid`, `source`, `recording_url`. **No new migration in wave 8C.**
- `packages/api/src/files/storage-provider.ts:147` — `S3StorageProvider.generateUploadUrl` issues presigned PUT URLs for P8-014.

---

## Story Specifications

### P8-012 — Twilio Media Streams (live audio)

> **Size:** M | **Layer:** Telephony | **AI Build:** Low | **Human Review:** Heavy

**Dependencies:** P8-011 (Gather-mode adapter merged), P8-009 (VoiceSessionStore)

**Allowed files:**
- `packages/api/src/telephony/media-streams/**` (new directory)
- `packages/api/test/telephony/media-streams/**` (new directory)
- `packages/api/src/app.ts` (mount the WebSocket server)
- `packages/api/src/routes/telephony.ts` (TwiML branching on `TWILIO_MEDIA_STREAMS_ENABLED`)
- `packages/api/package.json` (`ws`, `@types/ws`)

**Build prompt:** Upgrade from `<Gather speechTimeout>` to Twilio Media Streams over WebSocket. Mount a `WebSocketServer` (`ws` package) at `/api/telephony/stream` on the existing HTTP server. Twilio connects when our TwiML returns `<Connect><Stream url="wss://.../api/telephony/stream"/></Connect>`. Per-connection adapter:
- Decodes Twilio's μ-law 8 kHz frames and resamples to 16 kHz PCM16 LE (build a tiny μ-law conversion table; no new dep).
- Opens a `DeepgramStreamingProvider` session per call, dispatching `caller_speech` events into the FSM via `VoiceSessionStore.withSessionLock` on `is_final` transcripts.
- Synthesizes agent TTS via the existing `TtsProvider`, encodes PCM → μ-law, and streams `media` outbound frames back to Twilio.
- Treats interim transcript events during agent TTS as barge-in: sends Twilio a `clear` event and stops further outbound `media` frames.

Gate the new path behind `TWILIO_MEDIA_STREAMS_ENABLED=false` (default off). The existing Gather adapter remains the rollback target. The HTTP-upgrade handler must verify the Twilio signature on the WS handshake.

**Review prompt:** Verify μ-law ↔ PCM16 round-trips correctly. Verify barge-in cancels TTS within one Deepgram interim result. Verify tenant isolation (a stream's CallSid must resolve to the originating tenant's session). Verify the WS upgrade rejects un-signed requests. Verify the feature flag truly bypasses the new path.

**Automated checks:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P8-012|MediaStream"
```

**Required tests:**
- [ ] μ-law ↔ PCM16 round-trip identity within tolerance
- [ ] Barge-in cancels outbound TTS frames on first interim result
- [ ] Mocked-WS integration: Twilio `start` → audio → Deepgram final → FSM transition → outbound media → `stop`
- [ ] Tenant isolation: Tenant A CallSid stream cannot reach Tenant B session
- [ ] Feature flag off → Gather path is still emitted

---

### P8-013 — Telephony `escalate_to_human` + on-call rotation `<Dial>`

> **Size:** S | **Layer:** Telephony | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P8-008 (in-app escalate skill), P8-011 (Gather adapter)

**Allowed files:**
- `packages/api/src/ai/skills/escalate-to-human.ts` (extend)
- `packages/api/src/telephony/twilio-call-control.ts` (new)
- `packages/api/src/telephony/twilio-adapter.ts` (replace `notify_oncall` no-op)
- `packages/api/src/routes/telephony.ts` (add `/dial-result`)
- `packages/api/test/telephony/**`

**Build prompt:** Replace the no-op `notify_oncall` branch in `twilio-adapter.ts:143` with a real `<Dial>` to the on-call rotation. New `TwilioCallControl` interface in `twilio-call-control.ts` exposes `dialDispatcher(callSid, dispatcherPhone, opts)` that produces TwiML `<Dial timeout="20" action="/api/telephony/dial-result?sid=...">+1...</Dial>`. Extend `escalate-to-human.ts` to accept an optional `callControl?: TwilioCallControl` and emit a transfer descriptor when `channel === 'telephony'`. Add `POST /api/telephony/dial-result` that reads `DialCallStatus`; on `no-answer` or `failed`, advances to the next `OnCallRepository.listRotation` entry via the FSM; if exhausted, queues a `customer_callback_required` proposal and plays "we'll call you back". On successful connect, the FSM transitions to `closing`.

**Review prompt:** Verify rotation cascade: dispatcher 1 no-answer → dispatcher 2 dialed; all no-answer → callback proposal queued + audit emitted. Verify the in-app variant still works unchanged. Verify signature verification on `/dial-result`. Verify the polite "we'll call you back" message includes business name.

**Automated checks:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P8-013|escalate"
```

**Required tests:**
- [ ] Skill returns `transfer` descriptor for telephony channel with first dispatcher
- [ ] Dial-result `no-answer` advances to next rotation entry
- [ ] Rotation exhausted → `customer_callback_required` proposal queued + audit emitted
- [ ] In-app escalate (P8-008) tests still pass unchanged
- [ ] `/dial-result` rejects un-signed requests

---

### P8-014 — `record_call` skill (Twilio recording → S3 + voice_recordings row)

> **Size:** S | **Layer:** Telephony | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P8-011

**Allowed files:**
- `packages/api/src/telephony/recording-webhook.ts` (new)
- `packages/api/src/voice/voice-service.ts` (small extension: `recordInboundCall` helper)
- `packages/api/src/routes/telephony.ts` (add `/recording`)
- `packages/api/src/telephony/twilio-adapter.ts` (add `recordingStatusCallback` to initial TwiML)
- `packages/api/test/telephony/**`

**Build prompt:** Add `<Record>` (or `recordingStatusCallback="/api/telephony/recording"` on the initial connect verb) to inbound TwiML. Twilio POSTs the finalized recording metadata to `POST /api/telephony/recording`. The webhook (1) verifies Twilio signature via existing middleware, (2) reads `RecordingSid`, `RecordingUrl`, `CallSid`, `RecordingDuration`, (3) resolves the session by CallSid via `VoiceSessionStore.findByCallSid` to get `tenantId`, (4) fetches recording bytes from Twilio's signed URL using `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` HTTP basic, (5) PUTs to S3 at `serviceos-recordings/<tenant_id>/<call_sid>.mp3` using `S3StorageProvider.generateUploadUrl` + `fetch`, (6) inserts a `voice_recordings` row with `source='inbound_call'`, `call_sid`, `recording_url`, `duration_seconds`, `status='completed'`. Idempotent on `(tenant_id, call_sid)` partial unique index already in migration 054.

**Review prompt:** Verify signature middleware blocks forged calls. Verify S3 PUT uses tenant-scoped key. Verify `voice_recordings` insert is idempotent under retry. Verify no recording bytes are logged. Verify TWILIO_AUTH_TOKEN is not leaked into logs/errors.

**Automated checks:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P8-014|record_call|recording"
```

**Required tests:**
- [ ] Webhook rejects un-signed/forged requests
- [ ] Happy path: Twilio fetch → S3 PUT → `voice_recordings` row created with correct tenant + `source='inbound_call'`
- [ ] Idempotency: second webhook with same RecordingSid is a no-op
- [ ] Tenant scoping: row tenant matches the resolved session tenant, not Twilio's payload
- [ ] Auth token not leaked in error messages

---

### P8-015 — Dropped-call SMS recovery

> **Size:** S | **Layer:** Intake | **AI Build:** Medium | **Human Review:** Heavy | **Wave:** 2 (Wave-C1)

> **PRD codename:** N-007 (PRD v2 §9)
> **Day-in-the-life moments:** Mike bad-day 1:30pm (caller hangs up after 11 seconds; SMS goes out within 60s).

**Dependencies:** P8-001 (inbound calling agent), P7-001 (Twilio), P0-036 (phone rate-limit), P0-037 (LinkableEntityType), P4-015 (brand voice)

**Allowed files:** `packages/api/src/voice/recovery/**`, `packages/api/src/sms/recovery/**`, `packages/api/src/workers/dropped-call-worker.ts`, `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts` (dep-injection edit only), `packages/api/src/voice/voice-service.ts` (mirror edit only), `packages/api/src/db/schema.ts`, `packages/shared/src/contracts/dropped-call-event.ts`

**Build prompt:** Detect when an inbound voice session ends without a resolved outcome (caller hung up before booking or transfer, audio quality failure, system error mid-call) and, within 60 seconds, send an SMS to the caller in the shop's brand voice (P4-015). The SMS includes a generic apology + a context cue if a partial transcript exists ("Sounds like you were calling about your AC — want to text or call back? We're here."). The dropped-call event is threaded to the original intake using P0-037's expanded `LinkableEntityType` so a subsequent SMS reply continues the same conversation. Recovery is suppressed if the call resulted in a successful booking or owner transfer. Rate-limited per caller (P0-036, scope=`sms_recovery`, limit=1, window=5min). The trigger site is `finalizeTerminalOutcome` in `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts` (after `session.terminalOutcome` is set) — inject a `droppedCallScheduler` and fire when outcome ∈ {`dropped`, `failed`}.

**Review prompt:** Verify drop detection within 5 seconds of session end. Verify SMS within 60s P95. Verify the SMS does not go out for successful or transferred calls. Verify partial transcript context is sanitized (no PII leak in the SMS body). Verify recovery is rate-limited per caller (no SMS spam if the caller keeps dropping). Confirm the 60s deferred-send uses the existing queue infra with `runAfter`, not a `setTimeout`.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P8-015"
```

**Required tests:**
- [ ] Hangup before booking → SMS sent within 60s
- [ ] Successful booking → no SMS
- [ ] Audio failure mid-call → SMS sent
- [ ] Partial transcript context included when available
- [ ] No transcript → generic SMS
- [ ] Threaded — subsequent reply belongs to same intake conversation
- [ ] Rate-limited — same caller within 5 min gets one SMS, not multiple

**Non-goals:** Outbound voice callback (V2); recovery for SMS-initiated conversations (different problem); recovery for owner-cell patches that fail (V2).

---

### P8-016 — Vulnerability-aware emergency triage

> **Size:** S | **Layer:** Intake | **AI Build:** Medium | **Human Review:** Heavy | **Wave:** 2 (Wave-C1)

> **PRD codename:** N-008 (PRD v2 §9)
> **Day-in-the-life moments:** Mike 4:30pm (elderly woman with mom on oxygen, 104°F); Mike bad-day 11:00am (flat-voice elderly caller; supervisor agent catches what the primary missed).

**Dependencies:** P8-001 (inbound calling agent), P1-001 (customer entity), P1-022 (users.mobile_number for owner-cell paging)

**Allowed files:** `packages/api/src/voice/triage/**`, `packages/api/src/ai/vulnerability/**`, `packages/api/src/integrations/weather/**`, `packages/api/src/customers/customer.ts` (additive fields only), `packages/api/src/customers/pg-customer.ts` (additive fields only), `packages/api/src/ai/skills/escalate-to-human.ts` (extend with new EscalationReason + owner-cell + fallback), `packages/api/src/ai/agents/customer-calling/state-machine.ts` (call triage-decision at escalation site), `packages/api/src/db/schema.ts`, `packages/shared/src/contracts/vulnerability-signal.ts`

**Build prompt:** Extend the inbound calling agent's escalation skill to weigh four vulnerability signals in urgency classification:
- **Age**: caller mentions age >65, or matched customer record indicates
- **Weather**: tenant locale has temperature >100°F or <20°F in the last 24h (fetch from weather provider, cached per locale per hour)
- **Medical**: caller utterance mentions oxygen, dialysis, breathing trouble, illness, infant, elderly relative
- **Property type**: known B2B account flagged as occupied (e.g., property manager reporting on residents)

Signals combine into a vulnerability score. **Vulnerability + urgency** (e.g., no AC + summer heat + age >65) → patch to owner's cell (via P1-022's `mobile_number`) with a 5-second context preface ("Medical priority, no AC, elderly, your customer since 2024. Putting them through.") rather than booking. **Vulnerability alone** (no immediate urgency) → high-priority booking with owner notification, not auto-booked into normal flow. If the owner is unreachable for 60 seconds, fall back to high-priority booking and SMS the owner what happened. Add migration 109 for `customers.date_of_birth + account_type`, migration 110 for `weather_cache`, migration 111 for `vulnerability_signals` (analytics). The 5s preface is deterministic-template — NOT LLM (5s is too tight for a model round-trip + TTS).

**Review prompt:** Verify signals are extracted from utterance content, customer record, **and** weather API independently. Verify combination logic does not bias against legitimate non-emergency calls (high specificity). Verify the 5-second context preface is concise and non-PII-leaky. Verify the fallback when owner is unreachable is sane. Verify the system does not claim medical authority (the brand voice must not say "you have a medical emergency" — just escalate the call). Verify weather-API failure does not block the call — degrade to age + medical signals.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P8-016"
```

**Required tests:**
- [ ] Age + urgency + weather → patches owner
- [ ] Medical mention + urgency → patches owner
- [ ] Age alone → high-priority booking, owner notified
- [ ] No vulnerability → normal flow
- [ ] Weather API failure → fall back to age + medical only
- [ ] Owner unreachable → high-priority booking + owner SMS
- [ ] Context preface excludes PII (no full address)
- [ ] Correct-escalation rate >95% on labeled fixture set

**Non-goals:** Real-time vital monitoring (not our domain); medical priority routing to first responders (we do not claim authority); self-reported disability status as a signal (privacy, regulatory).
