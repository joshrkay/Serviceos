# Track C — read-only runtime probes (orchestrator-run, 2026-07-28)

Railway API/dashboard credentials: **ABSENT** in this environment. Per-service variable
enumeration (declared vs set, per `web`/`worker`/`voice`) is therefore **UNKNOWN — no credential**.
The probes below are best-effort read-only observations via MCP connectors authorized in this
session, plus one blocked direct probe. Each states exactly what it proves and no more.

## Stripe (platform) — via Stripe MCP (account-scoped, read-only)

- Account: `acct_1Tsx1z2cPEEui7wB`, display name **"Rivet"** — this is the Rivet platform account.
- `GET /v1/webhook_endpoints`: **2 enabled livemode endpoints**, BOTH pointing at
  `https://serviceosapi-production.up.railway.app/webhooks/stripe`
  (`we_1TuM0F2cPEEui7wB…` created 2026-07-17, `we_1TuI5j2cPEEui7wB…` created 2026-07-17).
  - Proves: live-mode keys/webhooks exist and target the production Railway `web` service. Enabled
    events cover the ACH lifecycle (`payment_intent.processing`/`payment_failed`), checkout,
    refunds, disputes, `setup_intent.succeeded`, `account.updated` (Connect mirroring).
  - Finding: **duplicate endpoint registration** — every Stripe event is delivered twice. The
    handler's event-ID dedupe (observed in integration logs: "Duplicate Stripe event — skipping")
    absorbs this, but it doubles webhook traffic and is a latent double-processing risk if dedupe
    ever regresses.
  - NOT proven: that the deployed service has `STRIPE_WEBHOOK_SECRET` set for either endpoint, or
    which of the two secrets it verifies against (delivery success stats not readable here).
- `GET /v1/accounts` (Connect): **empty list — zero connected accounts.**
  - Proves: **no tenant has ever completed Stripe Connect onboarding** on the live platform.
    B1.7–B1.11 cannot be rung 6; payouts-to-tenant-bank has never happened in production.
- `GET /v1/payment_intents` (live mode): **empty list — zero payment intents ever.**
  - Proves: **no live payment has ever been attempted** through the platform. The entire B9 money
    rail is code-true at best, runtime-unproven.

## PostHog — via PostHog MCP (project "Default project", org "Kay corp")

- Rivet server-side events ARE ingesting, last 30 days (aggregates only):
  `customer_created` 634 (latest 2026-07-27), `job_created` 527 (latest 2026-07-28),
  `estimate_created` 432 (latest 2026-07-27), `proposal_approved` 275 (latest 2026-07-27),
  `proposal_executed` 238 (latest 2026-07-28), `escalation_requested` 218 (latest 2026-07-27),
  `app_error` 3 (latest 2026-07-17), `test_event` 1.
  - Proves: PostHog server-side capture is **live** and events arrived as recently as today.
  - Caveat: cannot distinguish environment — no `environment` property exists in the taxonomy, so
    staging vs production attribution is UNKNOWN.
- **No `$pageview` events exist** in the project taxonomy → web-client PostHog capture is
  **not live** (server-side only).
- **No `$ai_generation`/LLM-analytics events** → PostHog LLM observability not wired (the repo's
  `ai_runs` table is the in-DB equivalent; its runtime state is separately UNKNOWN).

## Direct production probe — blocked

- `GET https://serviceosapi-production.up.railway.app/health` and `/ready`: **blocked** by this
  session's egress policy (proxy CONNECT 403; WebFetch also 403). Health/ready status of the
  deployed services is **UNKNOWN — probe blocked**, not "down".

## Not probed (no credential / no connector)

Twilio (voice + SMS) · voice stack (STT/TTS) · LLM gateway providers & `ai_runs` rows · Clerk ·
Sentry · QuickBooks (a QBO MCP connector exists in this session but is the operator's own account —
not evidence about Rivet's integration) · SendGrid · storage · push/EAS · Railway service variables.
All **UNKNOWN — no credential**, per service.
