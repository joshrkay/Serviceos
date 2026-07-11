# Voice realtime (media-streams) rollout & resilience

WS3 (voice ingestion resilience). The realtime voice path (Twilio Media
Streams → Deepgram STT → ElevenLabs TTS over a WebSocket) is the newer, higher
quality transport. The legacy `<Gather>` speech path is the proven fallback.
Every control below fails **toward Gather** — never dead air, never a silent
hangup, never an undisclosed recording.

## The two switches

| Control | Where | Effect |
|---------|-------|--------|
| `TWILIO_MEDIA_STREAMS_ENABLED` (env) | `app.ts` → `mediaStreamsEnabled` | **Master switch.** Off → every call uses Gather, full stop. Also gates whether the Deepgram provider + WS upgrade handler are even constructed. Requires `TTS_PROVIDER=elevenlabs` + `ELEVENLABS_API_KEY` (validated in `shared/config.ts`); `DEEPGRAM_API_KEY` missing only warns. |
| `voice_realtime` (per-tenant flag) | `tenant_feature_flags` table | **Staged rollout, default ON.** Consulted only when the master switch is on, via `isEnabledForTenantWithDefault(tenantId, 'voice_realtime', true)`. An unconfigured tenant gets realtime; setting `enabled=false` for a tenant is a **kill switch** pinning that tenant to Gather. |

Staged-rollout recipe: keep `TWILIO_MEDIA_STREAMS_ENABLED=true` globally, and
pre-seed `voice_realtime = false` for tenants you are NOT ready to ramp. Flip a
tenant to `true` (or delete the override, since default is ON) to enable it.
To pause a single tenant during an incident, set its `voice_realtime` override
to `false` — no redeploy.

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
  fully closes it.
- Deterministic (injectable clock; no timers).

The adapter feeds it at the session-establishment sites in
`mediastream-adapter.ts`:

- **Deepgram open failure** (`deepgram_open_failed`) → `recordFailure` +
  `voice.realtime.session_failed` audit, then the WS closes 1011 (Twilio ends
  the call). Subsequent calls degrade to Gather once the breaker trips.
- **Disclosure/greeting bootstrap failure** → `recordFailure` +
  `voice.disclosure.init_failed` audit. An undisclosed recording is a compliance
  stop signal, but we **do not hang up a live customer** — the call continues.
- **Clean establishment** (Deepgram open + successful disclosure init, or
  Deepgram open when no bootstrap is wired) → `recordSuccess` resets the breaker.

### Mid-call REST redirect — not implemented (floor-only)

On a mid-call terminal failure the adapter records the circuit failure + audit
and closes the WS (Twilio ends that leg). It does **not** REST-redirect the live
call to the Gather webhook, because no Twilio REST client is reachable from the
WS handler context: the `twilio` SDK is imported only for signature validation,
the adapter deps carry no AccountSid/auth-token/REST client, and the only
call-control seam emits TwiML strings, never REST calls. Additionally a redirect
back to `/voice` would re-enter the same branch and re-emit Stream on the first
failure (the circuit opens only after 2 consecutive failures), risking a
redirect loop. The circuit is the recovery mechanism: it steers **subsequent**
calls to Gather until the transport recovers.

## Audit events to alert on

- `voice.realtime.session_failed` — realtime session couldn't establish
  (Deepgram open failure). Tenant-scoped, correlated by `callSid`.
- `voice.disclosure.init_failed` — the caller was NOT given the recording
  disclosure and the session is unledgered. **Compliance-critical** — alert on
  any occurrence.

Both are emitted best-effort (never block or throw into the audio path).
