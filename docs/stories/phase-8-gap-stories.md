# Phase 8 — Customer Voice Agents: Wave 8C Gap Stories

> **3 stories** | Continues from P8-011

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
