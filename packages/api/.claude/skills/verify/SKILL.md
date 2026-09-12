---
name: verify
description: >
  Runtime-verify packages/api changes by booting the API in-memory (no
  Postgres/Clerk) and driving real surfaces: signed Twilio webhooks, the
  media-streams WebSocket, and role/flag boot matrices. Use when /verify
  needs to observe API behavior, not just run tests.
---

# API runtime verification (in-memory, signed Twilio webhooks)

## Boot

```bash
cd packages/api
NODE_ENV=dev DEV_AUTH_BYPASS=true PORT=3101 LOG_LEVEL=warn EMAIL_ENABLED=false \
  npx tsx src/index.ts > /tmp/boot.log 2>&1 &
# poll http://localhost:3101/health until 200 (~10-20s)
```

- No `DATABASE_URL` → InMemory repos. No Clerk needed for webhook surfaces.
- For telephony surfaces add: `TWILIO_ACCOUNT_SID=ACtest… TWILIO_AUTH_TOKEN=testtoken123
  TWILIO_FROM_NUMBER=+15550001111 TWILIO_DEFAULT_TENANT_ID=<any-uuid>
  PUBLIC_API_URL=http://localhost:3101` (the default-tenant env is a dev-only
  seam for inbound tenant resolution).
- Realtime voice stack: `TTS_PROVIDER=elevenlabs ELEVENLABS_API_KEY=fake
  DEEPGRAM_API_KEY=fake` — fake keys boot fine; Deepgram open then fails at the
  WS, which is exactly how you drive the failure/degrade paths.

## Gotchas (each cost a debugging round)

- **Verify which process you're driving.** `GET /api/telephony/health` reports
  `capabilities.{mediaStreams,tts,stt}` — check it after EVERY boot cycle. A
  failed rebind (EADDRINUSE) leaves the previous boot answering and your
  env-matrix observations silently test the wrong process.
- **`ss`/`lsof` are not installed.** Kill boots with
  `pkill -f 'tsx src/inde[x].ts'` — and run the pkill in a SEPARATE shell call
  from the next boot command, or the boot half of a compound command matches
  the pattern and pkill kills your own shell (exit 144).
- **Twilio webhooks are fail-closed.** Every `/api/telephony/*` POST (and the
  `/api/telephony/stream` WS upgrade) requires a valid `x-twilio-signature`:
  `base64(HMAC-SHA1(url + sortedKeys.map(k=>k+params[k]).join(''), TWILIO_AUTH_TOKEN))`
  where url = `PUBLIC_API_URL + path` (no params for the upgrade GET). Unsigned
  → 403 (a good probe).

## Flows worth driving

- `/voice` Stream-vs-Gather matrix: keys+flag-unset → `<Connect><Stream>`;
  no keys → `<Gather>`; `TWILIO_MEDIA_STREAMS_ENABLED=false` → `<Gather>`;
  `PROCESS_ROLE=worker` → `<Gather>` + WS upgrade rejected (client-gateway 401).
- Mid-call degrade: signed WS to `/api/telephony/stream`, send a Twilio `start`
  frame (`{event:'start',start:{streamSid,callSid,accountSid,…}}`) for a
  CallSid you first created via `/voice` — fake Deepgram key fails the open,
  the adapter attempts the Twilio REST redirect (visible as
  `twilio call redirect: non-2xx` in the log) and closes 1011 on redirect
  failure.
- Session continuation: `/voice` then `POST /voice/gather-fallback` with the
  same CallSid → repair-prompt Gather TwiML whose action re-enters
  `/gather?sid=<same session id>`.
- Full async voice pipeline WITHOUT any AI keys (dev-fallback STT makes this
  work end-to-end in-memory): forge an unsigned JWT (`{"alg":"none"}` header,
  body with `sub`/`email`/far-future `exp`, any signature segment — the
  DEV_AUTH_BYPASS decoder doesn't verify) and send it as Bearer. Then
  `POST /api/files/upload-url` (JSON: filename/contentType/sizeBytes) →
  `POST /api/voice/recordings` `{fileId, audioUrl}` (202) → the in-process
  transcription worker stamps a `[Dev mode]` placeholder transcript →
  voice-action-router consumes it, the classifier degrades to 0.2/unknown
  with no LLM gateway, and a `voice_clarification` proposal appears in
  `GET /api/proposals` within ~1s. Whole recording→router→proposal seam,
  observable at HTTP. LLM-dependent branches past classification (entity
  annotate, handlers) still need a real gateway key.
- `POST /api/voice/stream-token` failure matrix: no `DEEPGRAM_API_KEY` →
  503 `NOT_CONFIGURED`; a fake key → Deepgram REST really returns 403 →
  503 "Member permissions" (permission_denied branch). The provider_error
  502 branch needs a network-level failure — not reachable by env alone.

## Postgres boot (migrations, transcript persistence, audit rows)

The in-memory boot skips anything that needs `deps.pool` (recording webhook
persistence, `call_transcript_turns`, audit rows, queue workers). For those:

```bash
docker run -d --rm --name verify-pg -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=serviceos \
  -p 127.0.0.1:55432:5432 pgvector/pgvector:pg16      # pg_isready takes ~15s
export DATABASE_URL=postgres://postgres:pg@127.0.0.1:55432/serviceos DB_SSL=false
npm run migrate:apply        # the API does NOT migrate at boot (Railway preDeploy does); ~9s cold, ~2s replay
```

- `DB_SSL=false` is mandatory: without it the pool demands SSL and every
  query fails with "The server does not support SSL connections" while
  `/health` still boots (it just reports the database down).
- A fresh DB has no tenant; the inbound `/voice` webhook resolves
  `TWILIO_DEFAULT_TENANT_ID` but the recording webhook then fails the
  `files_tenant_id_fkey`, and the voice gate sends the call to voicemail
  (`no_billing`, then `not_live`). Seed once:
  `INSERT INTO tenants (id, owner_id, owner_email, name, subscription_status)
   VALUES ('<TWILIO_DEFAULT_TENANT_ID>', 'u', 'u@x.com', 'Verify', 'active');
   INSERT INTO tenant_settings (tenant_id, business_name, voice_agent_live_at)
   VALUES ('<same>', 'Verify', now());`
- Recording webhook: `RecordingUrl` must be a plain URL (the handler appends
  `.mp3` and fetches with Basic auth); any local HTTP server that answers 200
  works, and the dev storage provider accepts the upload. The signed POST then
  runs the whole recording → attach → transcript-ingestion chain, observable in
  `voice_recordings`, `call_transcript_turns` and `audit_events`.
- To end a Gather session deterministically (for ended-session paths), boot
  with `VOICE_MAX_CALL_DURATION_MS=4000` and send a Gather turn after 4 s.
- The transcript-ingestion queue is only registered when an embedding
  provider exists: set `AI_PROVIDER_API_KEY=sk-fake AI_PROVIDER_BASE_URL=<any
  local 200-server>/v1`. Without it the recording hook attaches turns but
  silently skips the enqueue (`if (!queue) return`), and embeddings fail
  harmlessly with the fake key.
- The forged `alg:none` JWT recipe above does NOT pass against a Postgres
  boot (`Clerk token rejected` → 401). To trigger an unauthenticated,
  DB-backed 500 (Sentry capture, global error handler), stop Postgres and hit
  `GET /public/estimates/<any-token>` — it throws `ECONNREFUSED` through
  `asyncRoute`.
