# Voice realtime (media-streams) rollout & resilience

WS3 (voice ingestion resilience). The realtime voice path (Twilio Media
Streams → Deepgram STT → ElevenLabs TTS over a WebSocket) is the newer, higher
quality transport. The legacy `<Gather>` speech path is the proven fallback.
Every control below fails **toward Gather** — never dead air, never a silent
hangup, never an undisclosed recording.

> **Deploy topology (WS14).** Everything in this runbook — the media-streams
> WS attach, the `<Voice>` webhook handlers, the health circuit, the mid-call
> REST redirect — runs on whichever service serves `PROCESS_ROLE=web` (or, in
> the optional three-service topology, `PROCESS_ROLE=voice`). In that
> topology the dedicated voice service is where realtime lives: it deploys
> rarely and is the only service Twilio's phone-number webhooks point at, so
> `web`/`worker` deploys never interrupt a live call. See
> `docs/deployment.md` "Optional third service: dedicated voice (WS14)" for
> setup and `docs/prod-env-checklist.md` for the per-service `PUBLIC_API_URL`
> requirement.

## The two switches

| Control | Where | Effect |
|---------|-------|--------|
| `TWILIO_MEDIA_STREAMS_ENABLED` (env) | `app.ts` → `resolveMediaStreamsEnabled(process.env)` | **Master switch, three states.** `false` → every call uses Gather, full stop (kill switch). `true` → forced on; requires `TTS_PROVIDER=elevenlabs` + `ELEVENLABS_API_KEY` (hard-validated in `shared/config.ts`, `DEEPGRAM_API_KEY` missing only warns). **Unset / `auto`** → on **iff** the full streaming stack is already present: `TTS_PROVIDER=elevenlabs` AND `ELEVENLABS_API_KEY` AND `DEEPGRAM_API_KEY` (all three; stricter than `true`, so auto never boot-crashes on a half-capable stack). Any partial stack → off. Also gates whether the Deepgram provider + WS upgrade handler are even constructed. |
| `voice_realtime` (per-tenant flag) | `tenant_feature_flags` table | **Per-tenant kill switch, default ON.** Consulted only when the master switch is on, via `isEnabledForTenantWithDefault(tenantId, 'voice_realtime', true)`. An unconfigured tenant gets realtime; setting `enabled=false` for a tenant is the kill switch that pins **that one tenant** to Gather (no redeploy). It is not a cohort/percentage ramp — there is no staged-rollout logic anywhere in the code; the flag is a boolean per-tenant off-switch, nothing more. |

> **Auto-mode rollout note (WS7).** A prod env that already has all three keys
> (`TTS_PROVIDER=elevenlabs` + `ELEVENLABS_API_KEY` + `DEEPGRAM_API_KEY`) but
> leaves `TWILIO_MEDIA_STREAMS_ENABLED` **unset** now flips from Gather-only to
> realtime **on the next deploy**. Mitigations in place: the per-tenant
> `voice_realtime` kill switch, the health circuit, and the mid-call REST
> degrade below. To stay Gather-only despite a full key set, set
> `TWILIO_MEDIA_STREAMS_ENABLED=false` explicitly.

Kill-switch usage: with the master switch on, every tenant gets realtime by
default — there is nothing to "ramp". The only per-tenant action is the OFF
switch: to pause a single tenant during an incident (a caller reports garbled
audio, a tenant-specific TTS misconfiguration), set its `voice_realtime`
override to `false` — that tenant falls back to Gather immediately, no redeploy.
Delete the override (or set it back to `true`) to return the tenant to realtime.
To pause realtime for EVERY tenant at once, use the master switch
(`TWILIO_MEDIA_STREAMS_ENABLED=false`) or let the health circuit trip.

## The /voice decision (fallback table)

The `POST /api/telephony/voice` branch (`routes/telephony.ts`,
`shouldUseRealtimeStream`) picks Stream vs Gather. Stream is chosen **only when
every gate passes**:

| Condition | Result |
|-----------|--------|
| Master switch OFF | **Gather** (flag never consulted) |
| Realtime prerequisites missing (STT or TTS not configured) | **Gather** (flag never consulted) |
| Health circuit OPEN | **Gather** (flag never consulted) |
| `voice_realtime` tenant flag OFF | **Gather** |
| `voice_realtime` flag read THROWS (e.g. DB blip) | **Gather** (fail toward the proven path) |
| All of the above healthy | **Stream** |

Prerequisites are derived from the **same capability computation the `/health`
canary uses** (`realtimeCapabilities()` in `app.ts`): `DEEPGRAM_API_KEY` set AND
a TTS key present. The cheap synchronous gates (prereqs, circuit) run before the
flag DB read, so a fallback decision never incurs a Postgres hit.

## The health circuit

`telephony/realtime-health-circuit.ts` — a dead-simple in-process breaker shared
between the `/voice` branch (reads `isOpen()`) and the mediastream adapter
(feeds `recordFailure`/`recordSuccess`). One process-wide instance, **not
per-tenant**: a realtime transport outage (Deepgram down, TTS misconfigured) is
a global capability failure, so a global trip protects every tenant.

- Opens after **2 consecutive** realtime session failures (default `threshold`).
- Auto **half-opens** after **60s** (default `ttlMs`): the next call is allowed
  through as a probe. A failing probe re-opens immediately; a succeeding probe
  fully closes it. Because the feed now votes at call CLOSE (below), half-open is
  effectively a **window** that lasts until an admitted probe call terminates —
  every call admitted during it is itself a probe, and one failure re-opens.
- Deterministic (injectable clock; no timers).

### The feed — real call outcomes, once per leg (WS16a)

The adapter votes the circuit from REAL per-call outcomes, **at most once per
WebSocket / call leg** (a per-connection latch — the first, most-precise signal
wins and later blunt ones are suppressed). It votes at CLOSE time, not at
establishment: recording success at establishment reset the consecutive-failure
counter, so a call that established cleanly then died mid-call never counted —
the "establish-then-die" trap that let the breaker never trip under the most
common realtime outage mode.

- **Failure** (`recordFailure`) on a terminal realtime failure:
  - **Deepgram open failure** (`deepgram_open_failed`) → also
    `voice.realtime.session_failed` audit, then the WS closes 1011 (or degrades;
    see below).
  - **Disclosure/greeting bootstrap failure** (`disclosure_init_failed`) → also
    `voice.disclosure.init_failed` audit. An undisclosed recording is a
    compliance stop signal, but we **do not hang up a live customer** — the call
    continues, and this failure vote persists (a later clean hangup does NOT
    erase it).
  - **Unexpected mid-call Deepgram close** on the live generation
    (`deepgram_unexpected_close`) — recorded BEFORE the degrade attempt, so a
    call that then degrades to Gather still counts as a realtime failure.
  - **Failed language-switch reopen** (`deepgram_reopen_failed`) — the live call
    is left with no STT; also classified `transport_failure` for the outcome.
  - **An established session that closes on a transport-failure reason**
    (`ws_error` / `ws_closed` / `slow_consumer` / `queue_overflow_terminal`).
- **Success** (`recordSuccess`) only when an **established** session closes on a
  clean / caller-driven reason (`twilio_stop`, `end_session`,
  `audio_idle_timeout`) — the transport survived the whole call.
- **No vote** for pre-establishment closes (invalid start frame, unknown
  CallSid, tenant mismatch, connection-cap): those are caller/config noise, not
  transport health. The feed is gated on the session being established
  (`state.session` set AND a Deepgram open attempted).

### Mid-call REST redirect — implemented (WS7)

On a mid-call terminal failure the adapter records the circuit failure + audit
and then attempts to **REST-redirect the live call to Gather** instead of only
hanging up. `telephony/twilio-call-redirect.ts` (`createTwilioCallRedirector`)
POSTs a new `Url=<PUBLIC_API_URL>/api/telephony/voice/gather-fallback` to
Twilio's `Calls/{CallSid}.json` REST resource (subaccount-aware auth token
resolved from the `start` frame's AccountSid). Wired in `app.ts` only when
`PUBLIC_API_URL` is set — absent → the adapter keeps the old 1011-close.

- **Redirect accepted** → the adapter emits `voice.realtime.degraded_to_gather`
  and closes the WS with **1000**; Twilio re-requests TwiML from
  `/voice/gather-fallback`, which continues the **same** session on Gather
  (tenant + FSM state preserved via `action=/api/telephony/gather?sid=...`).
  The WS close deliberately **skips** the terminal outcome stamp
  (`finalizeOnClose`) — the call is not over, and stamping here would
  misrecord it as `transport_failure` and fire dropped-call recovery SMS at a
  caller still on the line. The Gather leg owns finalization from this point:
  the FSM reaching `terminated` on a later `/gather` turn stamps the real
  outcome, and the recording webhook's outcome stamp + the session store's
  idle reaper backstop a mid-Gather hangup, exactly as for any Gather call.
- **Redirect rejected / no redirector / redirect throws** → today's exact
  behavior: `closeWs(1011)` on the Deepgram-open-failure site, no-op drain on
  the unexpected mid-call Deepgram close.

**No redirect loop by construction:** `/voice/gather-fallback` never calls
`shouldUseRealtimeStream` and never emits `<Connect><Stream/>` — a known CallSid
gets Gather, an unknown CallSid gets a fresh inbound Gather session. The health
circuit remains the mechanism that steers **subsequent** calls to Gather until
the transport recovers.

## Audit events to alert on

- `voice.realtime.session_failed` — realtime session couldn't establish
  (Deepgram open failure). Tenant-scoped, correlated by `callSid`.
- `voice.disclosure.init_failed` — the caller was NOT given the recording
  disclosure and the session is unledgered. **Compliance-critical** — alert on
  any occurrence.
- `voice.realtime.degraded_to_gather` — a live call was mid-call REST-redirected
  from realtime to Gather after a terminal Deepgram failure (WS7). Tenant-scoped,
  correlated by `callSid`. A spike indicates realtime-transport instability even
  when the circuit hasn't yet tripped.

All are emitted best-effort (never block or throw into the audio path).
