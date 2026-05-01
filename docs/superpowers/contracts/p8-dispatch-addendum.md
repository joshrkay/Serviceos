# Phase 8 (Customer Voice Agents — Wave 8C) — Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/phase-8-gap-stories.md` with the metadata needed to dispatch each story to a Claude agent running in an isolated worktree.

For every story, the agent prompt should include:
- The full body of the story from `phase-8-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from `docs/superpowers/contracts/`

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 8C-1 | P8-013, P8-014 | parallel (2 agents, isolated worktrees) | unlocks 8C-2 clean baseline of `routes/telephony.ts` and `twilio-adapter.ts` |
| 8C-2 | P8-012 | single agent, after 8C-1 merges | sprint complete |

P8-012 ships last because it rewrites the TwiML emission path in `routes/telephony.ts`. Letting P8-013 (`/dial-result`) and P8-014 (`/recording`) land first keeps the merge surface clean and gives P8-012 a stable baseline.

## Migration ledger

**No new migrations in wave 8C.** Migration `054_p8_telephony_tables` (already merged) covers all schema needs:
- `tenant_oncall_rotation` (used by P8-013)
- `call_summaries` (used by P8-010)
- `voice_recordings.call_sid`, `source`, `recording_url` (used by P8-014)

Coordinator step: confirm `054_p8_telephony_tables` is in `git log origin/main` before launching any 8C agent.

---

## P8-013 — Telephony `escalate_to_human` + on-call rotation `<Dial>`

**Wave:** 8C-1
**Migration number reserved:** none (uses existing `tenant_oncall_rotation` from migration 054)
**Forbidden files:**
- `packages/api/src/telephony/media-streams/**` (P8-012 owns)
- `packages/api/src/voice/**` (P8-014 owns the small extension)
- `packages/api/src/db/schema.ts` (no migrations this wave)
- `packages/shared/**` (Tier 1 locked)
- `packages/api/src/oncall/rotation.ts` (do not change `OnCallRepository` interface; consume what's there)

**Allowed files (concrete list):**
- `packages/api/src/telephony/twilio-call-control.ts` (new)
- `packages/api/src/ai/skills/escalate-to-human.ts` (modify — add telephony branch)
- `packages/api/src/telephony/twilio-adapter.ts` (modify — replace `notify_oncall` no-op at line 143 with `<Dial>` emission)
- `packages/api/src/routes/telephony.ts` (modify — add `POST /dial-result`)
- `packages/api/test/telephony/twilio-call-control.test.ts` (new)
- `packages/api/test/telephony/twilio-adapter.test.ts` (extend)
- `packages/api/test/telephony/telephony-routes.test.ts` (extend)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P8-013|escalate|telephony" && \
  git diff --name-only origin/main... | grep -vE "^(packages/api/src/telephony/twilio-call-control\.ts|packages/api/src/ai/skills/escalate-to-human\.ts|packages/api/src/telephony/twilio-adapter\.ts|packages/api/src/routes/telephony\.ts|packages/api/test/telephony/)" | (! grep . )
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- `054_p8_telephony_tables` in `git log origin/main --oneline`.
- P8-008 merged (in-app `escalate-to-human.ts` baseline exists).
- P8-011 merged (`twilio-adapter.ts` and Gather routes exist).

**Risk note:**
- **Phone numbers leak via logs.** Treat `dispatcherPhone` as PII. Never log full numbers; mask middle digits if logging at all.
- **Rotation exhaustion deadlock.** If no on-call entries exist (empty rotation), the skill must short-circuit immediately with the callback proposal — do not loop.
- **Concurrent calls to the same dispatcher.** Twilio doesn't deduplicate `<Dial>`; if two callers escalate at once, both will ring the first dispatcher. Acceptable for v1.

**Implementation hints:**
1. The existing in-app branch in `escalate-to-human.ts:36` returns an `EscalationResult` with `assignedUserId` and `message`. The telephony branch returns the same shape plus an optional `transfer: { dispatcherPhone, fallbackTwiml }` field; the adapter consumes that.
2. Look up the dispatcher's phone via the `users` table (already tenant-scoped) — there's no separate "dispatcher phone" column today; use `users.phone` or extend `OnCallEntry` to carry it without a schema change (join in the SQL).
3. `OnCallRepository.listRotation` already returns entries ordered by `order_index`; iterate using a per-call cursor stored in the session context.

---

## P8-014 — `record_call` skill (Twilio recording → S3 + voice_recordings row)

**Wave:** 8C-1
**Migration number reserved:** none (`voice_recordings.call_sid`, `source`, `recording_url` exist from migration 054)
**Forbidden files:**
- `packages/api/src/telephony/media-streams/**` (P8-012 owns)
- `packages/api/src/ai/skills/escalate-to-human.ts` (P8-013 owns)
- `packages/api/src/telephony/twilio-call-control.ts` (P8-013 owns)
- `packages/api/src/db/schema.ts` (no migrations this wave)
- `packages/shared/**`
- `packages/api/src/files/storage-provider.ts` (consume what's there; do not extend)

**Allowed files (concrete list):**
- `packages/api/src/telephony/recording-webhook.ts` (new)
- `packages/api/src/voice/voice-service.ts` (modify — add `recordInboundCall` helper)
- `packages/api/src/routes/telephony.ts` (modify — add `POST /recording`)
- `packages/api/src/telephony/twilio-adapter.ts` (modify — add `recordingStatusCallback` to initial TwiML response)
- `packages/api/test/telephony/recording-webhook.test.ts` (new)
- `packages/api/test/telephony/twilio-adapter.test.ts` (extend)
- `packages/api/test/telephony/telephony-routes.test.ts` (extend)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P8-014|record_call|recording" && \
  git diff --name-only origin/main... | grep -vE "^(packages/api/src/telephony/recording-webhook\.ts|packages/api/src/voice/voice-service\.ts|packages/api/src/routes/telephony\.ts|packages/api/src/telephony/twilio-adapter\.ts|packages/api/test/telephony/)" | (! grep . )
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- `054_p8_telephony_tables` in `git log origin/main --oneline`.
- P8-011 merged (`routes/telephony.ts`, `twilio-adapter.ts` exist).
- Either `S3_BUCKET` and S3 creds env vars are set, OR a `DevStorageProvider` fallback is acceptable for tests.

**Risk note:**
- **Recording byte logging.** Never log the recording payload. Log only `RecordingSid`, `CallSid`, `tenantId`, and byte length.
- **Twilio auth token leakage.** The webhook fetches Twilio's signed recording URL using HTTP basic auth. Make sure error messages strip the token before bubbling up.
- **Cross-tenant attack vector.** Twilio's payload includes `AccountSid` but not our `tenant_id`; resolve tenant via `VoiceSessionStore.findByCallSid`. Reject if no session matches — never trust the payload.
- **Idempotency.** Twilio retries on non-2xx. The partial unique index `idx_call_summaries_tenant_call` is for summaries; for `voice_recordings`, use `INSERT ... ON CONFLICT (tenant_id, call_sid) DO NOTHING` and verify the existing index supports it.

**Implementation hints:**
1. Use `node:fetch` (global) for both the Twilio download and the S3 PUT.
2. The S3 PUT URL from `S3StorageProvider.generateUploadUrl` is presigned; pass the recording bytes as the request body and `Content-Type: audio/mpeg`.
3. `voice-service.ts` already has the Pg repo wired in `app.ts`; reuse it rather than constructing a new instance.

---

## P8-012 — Twilio Media Streams (live audio)

**Wave:** 8C-2 (after 8C-1 merges)
**Migration number reserved:** none
**Forbidden files:**
- `packages/api/src/ai/skills/escalate-to-human.ts` (P8-013 owns)
- `packages/api/src/telephony/twilio-call-control.ts` (P8-013 owns)
- `packages/api/src/telephony/recording-webhook.ts` (P8-014 owns)
- `packages/api/src/voice/transcription-providers.ts` (consume `DeepgramStreamingProvider` as-is; do not extend)
- `packages/api/src/voice/voice-service.ts` (P8-014 owns)
- `packages/shared/**`, `packages/api/src/db/schema.ts`

**Allowed files (concrete list):**
- `packages/api/src/telephony/media-streams/twilio-mediastream-server.ts` (new)
- `packages/api/src/telephony/media-streams/mediastream-adapter.ts` (new)
- `packages/api/src/telephony/media-streams/mulaw-codec.ts` (new)
- `packages/api/src/telephony/media-streams/index.ts` (new — barrel)
- `packages/api/test/telephony/media-streams/*.test.ts` (new)
- `packages/api/src/app.ts` (modify — mount WS server alongside HTTP server)
- `packages/api/src/routes/telephony.ts` (modify — feature-flagged `<Connect><Stream/></Connect>` TwiML branch)
- `packages/api/package.json` (add `ws`, `@types/ws`)
- `packages/api/src/telephony/twilio-adapter.ts` (modify — small surface for emitting stream TwiML when flag on; **do not** rewrite Gather path)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P8-012|MediaStream|mulaw" && \
  git diff --name-only origin/main... | grep -vE "^(packages/api/src/telephony/media-streams/|packages/api/test/telephony/media-streams/|packages/api/src/app\.ts|packages/api/src/routes/telephony\.ts|packages/api/src/telephony/twilio-adapter\.ts|packages/api/package\.json|packages/api/package-lock\.json)" | (! grep . )
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- Wave 8C-1 baseline is merged into the current integration branch (verified by tsc clean + full test pass before this story is dispatched). Wave 8C-1 stories may not yet be on `origin/main`.
- `DEEPGRAM_API_KEY` available in dev/staging/prod env (already required by P8-009 streaming path).

**Risk note:**
- **Operational risk.** Real-time audio over WebSocket is the most failure-prone surface in the codebase. The roadmap originally required manual human review; the user has explicitly authorized auto-dispatch but this story still warrants slow review and a staged rollout via `TWILIO_MEDIA_STREAMS_ENABLED`.
- **Audio codec correctness.** Twilio sends μ-law 8 kHz. Deepgram expects PCM16 LE 16 kHz. Off-by-one in the conversion table or wrong sample-rate ratio produces garbage transcripts.
- **Memory leak via long-lived sockets.** Idle reaping in `VoiceSessionStore` covers FSM state, but the WS connection itself must close on FSM `end_session` or after 30 minutes of audio inactivity. Add an explicit teardown.
- **Tenant isolation on WS handshake.** Twilio includes `streamSid` and `callSid` in the `start` event — resolve `tenantId` via `VoiceSessionStore.findByCallSid` and reject the WS if the CallSid is unknown or belongs to a different tenant context.
- **Backpressure on outbound TTS.** Twilio's `media` outbound buffer can stall; track ack frames and pace sends rather than flooding.

**Implementation hints:**
1. `DeepgramStreamingProvider.openSession` already exists at `packages/api/src/voice/transcription-providers.ts:311`. Construct it once per WS connection.
2. The TTS provider lives at `packages/api/src/ai/tts/tts-provider.ts`. Its output is raw PCM bytes — wrap with the new `mulaw-codec.ts` before Twilio.
3. Twilio Media Streams protocol: JSON envelopes over WS. Inbound events: `connected`, `start`, `media`, `stop`. Outbound: `media` (with `streamSid`), `mark`, `clear`. Spec: https://www.twilio.com/docs/voice/twiml/stream
4. Use `http.Server.on('upgrade', handler)` to attach the WSServer; do not use `express-ws` (introduces a dep) — bare `ws` is sufficient.
5. The `<Connect><Stream/></Connect>` TwiML must use `wss://` and an absolute URL — reuse `publicBaseUrl` already wired in the `TwilioAdapterDeps`.

---

## Universal pre-flight checks (run by `/dispatch-story` before launching any agent)

1. `git fetch origin && git rev-parse origin/main` — confirms fresh main.
2. Working tree clean (`git status --porcelain` empty) on the parent shell.
3. `npx tsc --project packages/api/tsconfig.build.json --noEmit` passes on the current branch.
4. All `Pre-flight` dependencies for the story have merged to main (grep `git log origin/main --oneline`).

If any pre-flight fails, the dispatcher refuses to launch and surfaces the failure. Don't auto-resolve — the human coordinator decides.
