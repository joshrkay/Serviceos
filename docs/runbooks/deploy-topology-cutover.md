# Deploy-topology cutover — web + worker + voice as separate Railway services

The repo ships the split as config-as-code (`railway.toml` = web,
`railway.worker.toml` = worker, `railway.voice.toml` = voice) and the code is
role-gated (`PROCESS_ROLE`). **This runbook is the remaining ~15 minutes of
Railway dashboard work** that turns the defined topology into the running one.
Until an operator executes it, production still runs the single-service shape
— the scorecard's "actually run the split" item is open exactly until this
checklist is done.

Why bother (what each step buys):

| Step | Payoff |
|------|--------|
| Worker service | Background sweeps/queue drain can never affect HTTP/voice latency; worker deploys never touch the request path |
| Voice service | Web/worker deploys can never drop a live call; voice deploys rarely and drains (`overlapSeconds=35`) |
| Alarms | Queue staleness, sweep lag, call completion, and drain abandonment page a human instead of rotting on `/metrics` |

## Prerequisites

- The main (web) service is deployed and healthy on `railway.toml`.
- Sentry DSN configured (`SENTRY_DSN`) — the alert channel's durable half.
- Decide the operator alert phone for SMS pages (see the SLO alerts runbook,
  `docs/runbooks/slo-alerts.md`, for the env knobs and thresholds).

## Checklist

### 1. Worker service (~5 min)

1. Railway → New Service → same repo/branch as the web service.
2. Service Settings → Config File Path → `railway.worker.toml`.
3. Service Variables: copy the web service's variable set (Railway shared
   variables / environment groups work), then set `PROCESS_ROLE=worker`.
4. On the web service: set `PROCESS_ROLE=web` explicitly.
5. Deploy worker → verify its `/health` is 200 (private networking is fine —
   Railway's probe uses it) and web still serves traffic.
6. Ordering rule from now on: **web deploys first** whenever a release
   contains a migration (only web has `preDeployCommand`).

### 2. Voice service (~5 min)

1. New Service → same repo/branch → Config File Path → `railway.voice.toml`.
2. Variables: copy the set, then `PROCESS_ROLE=voice` and — critical —
   `PUBLIC_API_URL=https://<voice-service-domain>` (its OWN public domain).
   Twilio signature validation, `<Stream>` WebSocket URLs, and the mid-call
   gather-fallback redirect are all derived from `PUBLIC_API_URL`; pointing it
   at the web domain breaks all three.
3. Give the voice service a public domain (Settings → Networking).
4. Deploy → `GET https://<voice-domain>/api/telephony/health` shows
   `capabilities.mediaStreams/tts/stt` matching the web service's.
5. **Repoint Twilio**: for each phone number (Twilio console → Phone Numbers →
   Voice webhook), change the Voice URL from the web domain to
   `https://<voice-domain>/api/telephony/voice` (keep method POST). Recording
   status callback and any per-number URLs move the same way.
6. Place a test call → confirm it lands (voice service logs the session) and
   the web service shows no `/api/telephony/voice` traffic.
7. Deploy-cadence rule: the voice service redeploys only when a release
   touches `packages/api/src/telephony/`, `ai/voice-turn/`, or the FSM — not
   on every web change. It drains live calls on deploy (25s window, 35s
   overlap), so even its own deploys don't hard-drop calls.

### 3. Alarms (~5 min)

1. Set the SLO alert variables on the **worker** service (the monitor runs
   under the worker role — see `docs/runbooks/slo-alerts.md` for names and
   defaults; at minimum the operator SMS target).
2. Sentry: create an alert rule on the SLO breach / drain-abandonment events
   (they arrive as error-level messages) → route to the on-call channel.
3. Force a test page: set the completion-rate threshold above 1.0 on a
   staging deploy for one sweep tick, confirm the SMS + Sentry event arrive,
   then revert.

## Rollback

- Any step is independently reversible: repoint Twilio webhooks back at the
  web domain (voice), or delete the extra service and unset `PROCESS_ROLE`
  on web (⇒ `all`, the original single-service behavior, which remains fully
  supported).
- Leader advisory locks make an accidental "two services both running
  workers" state correct (redundant, not duplicating side effects).

## Verification after cutover

- `GET /api/telephony/health` on the voice domain: capabilities green.
- Live call end-to-end on the voice domain.
- Worker logs show sweeps ticking; web logs show zero sweep activity.
- Deploy the web service during a test call → the call continues untouched.
