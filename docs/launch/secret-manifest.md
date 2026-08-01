# CI / Deploy Secret Manifest

_Owner: QUALITY-2026-07-12 WS7 (CI/deployment operational honesty)._

Exact inventory of every GitHub Actions secret each workflow reads, derived by
grepping `secrets.` across `.github/workflows/`. Use this to provision a fresh
repo, to audit which gates are actually enforceable today, and to see — in one
place — which gates **cannot run without credentials** (and therefore must
never be read as "green = covered").

`GITHUB_TOKEN` is auto-injected by GitHub Actions and is intentionally omitted
from the per-secret tables below (nothing to provision).

## Legend

- **Blocking**: the job hard-fails (exit 1) when the secret is missing — a
  missing secret produces RED, not a false green. WS7 added explicit
  presence-guards to the workflows marked ✅ so this is true even where the
  underlying script used to skip.
- **Optional**: the secret only enriches an otherwise-passing run (e.g. a Slack
  alert, an ephemeral DB); absence degrades gracefully and the job stays green
  by design.

---

## By workflow

### `deploy.yml` — Deploy (push to `main` → Railway)

| Secret | Purpose | Blocking? | How to obtain |
|---|---|---|---|
| `RAILWAY_TOKEN` | Auth for `railway up` (dev + prod deploy jobs). | Blocking — deploy step errors without it. | Railway dashboard → Account/Project → Tokens. |
| `DEV_HEALTHCHECK_URL` | Base URL of the **dev** API for post-deploy health poll + smoke. | **Blocking (WS7)** — the job hard-fails with an explicit message if unset. No URL ⇒ no deploy verification ⇒ not a green deploy. | Railway dev API service public domain (e.g. `https://api-dev.up.railway.app`). No trailing path. |
| `PROD_HEALTHCHECK_URL` | Base URL of the **prod** API for post-deploy health poll + smoke. | **Blocking (WS7)** — same as dev. | Railway prod API service public domain. No trailing path. |

Post-deploy flow (both envs): `railway up --detach` → `scripts/ci/wait-for-healthy.sh`
polls `/health` for `"status":"ok"` (≤5 min) → `npm run smoke-test` hits
`/health` + `/ready` + `/api/telephony/health`. Prod deploy `needs:` the dev job,
so a failed dev post-deploy check blocks prod promotion.

### `pr-checks.yml` — PR Checks

No provisioned secrets (only auto `GITHUB_TOKEN` for the sticky voice-quality
PR comment). The new `mobile-typecheck` job needs none.

### `e2e.yml` — E2E (Option B, smoke-only)

| Secret | Purpose | Blocking? | How to obtain |
|---|---|---|---|
| `E2E_CLERK_PUBLISHABLE_KEY` | Real Clerk `pk_test_` to run the full journey specs (Option A). | Optional (documented Option B) — absent ⇒ hermetic smoke + always-on Journey-1 only, job stays green. **WS7 adds a `::warning::` annotation so the coverage gap is visible.** | Clerk dashboard → API keys (test instance). See `qa/reports/2026-05-11/clerk-testing-tokens-runbook.md`. |
| `E2E_CLERK_SECRET_KEY` | Real Clerk `sk_test_` — unlocks journey + onboarding-v2 specs and the ephemeral test DB. | Optional (Option B). | Clerk dashboard → API keys (test instance). |
| `E2E_DATABASE_URL` | BYO Postgres for E2E instead of ephemeral testcontainers. | Optional. | Any reachable Postgres URL; only used when the Clerk secret is also set. |

### `mms-vision-smoke.yml` — MMS vision smoke (daily)

| Secret | Purpose | Blocking? | How to obtain |
|---|---|---|---|
| `AI_PROVIDER_API_KEY` | Real vision-capable model key for the image→estimate path. | **Blocking** — existing guard exits 1 if empty. | OpenAI (or compatible) API key with a vision model. |
| `SLACK_ALERTS_WEBHOOK` | Slack incoming webhook for failure alerts. | Optional (failure-only step). | Slack → Incoming Webhooks. |

### `voice-smoke-real.yml` — Voice smoke, real call (daily)

| Secret | Purpose | Blocking? | How to obtain |
|---|---|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account for the real outbound test call. | **Blocking (WS7 guard added)** | Twilio console. |
| `TWILIO_AUTH_TOKEN` | Twilio auth. | **Blocking (WS7)** | Twilio console. |
| `TWILIO_TEST_NUMBER_FROM` | Caller number for the smoke call. | **Blocking (WS7)** | Twilio phone number. |
| `TWILIO_TEST_NUMBER_TO` | Destination number (staging inbound). | **Blocking (WS7)** | Twilio / staging telephony config. |
| `STAGING_TWIML_URL` | TwiML endpoint the call is pointed at. | **Blocking (WS7)** | Staging API telephony webhook URL. |
| `STAGING_DB_URL` | Staging DB — asserts the proposal actually landed. | **Blocking (WS7)** | Staging Postgres connection string. |
| `SLACK_ALERTS_WEBHOOK` | Failure alert. | Optional. | Slack Incoming Webhooks. |

### `qa-matrix-gate.yml` — QA Matrix Gate (nightly + dispatch)

Requires **11** secrets (all Blocking — **WS7 adds an early presence-guard** in
addition to `qa:doctor`). Full names + purpose: `docs/runbooks/qa-github-secrets.md`.

| Secret | Purpose | Blocking? | How to obtain |
|---|---|---|---|
| `E2E_BASE_URL` | Railway dev web base URL. | Blocking | Railway dev web domain. |
| `E2E_API_URL` | Railway dev API base URL. | Blocking | Railway dev API domain. |
| `E2E_DB_URL_READONLY` | Read-only assertions against dev DB. | Blocking | Dev Postgres (RO role). |
| `E2E_DB_URL_READWRITE` | Seeder writes. | Blocking | Dev Postgres (RW role). |
| `E2E_CLERK_HMAC_SECRET` | Mints dev Clerk HMAC session tokens (`CLERK_DEV_HMAC_TOKENS=true` on the API). | Blocking | Must match the API's `CLERK_SECRET_KEY`-derived HMAC secret. |
| `E2E_TENANT_A_ID` / `_CUSTOMER_ID` / `_JOB_ID` | Tenant-A fixtures for isolation checks. | Blocking | Seeded QA tenant IDs. |
| `E2E_TENANT_B_ID` / `_CUSTOMER_ID` / `_JOB_ID` | Tenant-B fixtures (cross-tenant RLS). | Blocking | Seeded QA tenant IDs. |

### `qa-runbook.yml` — QA Runbook (manual `workflow_dispatch` only)

Reads the **same 11 `E2E_*` secrets** as `qa-matrix-gate.yml` (same source, same
purpose). Manual-only; not a scheduled gate. (WS7 did not add a guard here — it
is operator-invoked, not an automated green/red signal — but the same secrets
apply.)

### `voice-quality-pre-deploy.yml` — Voice Quality Layer 2 (release/* branches)

| Secret | Purpose | Blocking? | How to obtain |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Real Claude calls for Layer 2 corpus. | **Blocking** — existing guard exits 1 if empty. | Anthropic console. |
| `OPENAI_API_KEY` | Real OpenAI calls (2-of-3 voting / graders). | **Blocking** — existing guard. | OpenAI dashboard. |

### `voice-quality-weekly-trend.yml` — Voice Quality Layer 2 weekly trend

| Secret | Purpose | Blocking? | How to obtain |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Weekly Layer 2 run. | Effectively blocking (run is real-API). | Anthropic console. |
| `OPENAI_API_KEY` | Weekly Layer 2 run. | Effectively blocking. | OpenAI dashboard. |
| `SLACK_VOICE_QUALITY_WEBHOOK` | Weekly trend Slack post. | Optional (`continue-on-error`). | Slack Incoming Webhooks. |

### `voice-quality-nightly.yml` — Voice Quality (nightly Pg)

No provisioned secrets — runs against a testcontainer Postgres with the mock
gateway. (Owned by the voice-gate agent; listed for completeness.)

### `redis-multi-instance.yml` — Redis multi-instance correctness (WS7, weekly + dispatch)

No provisioned secrets — spins up a local `redis:7-alpine` service and sets
`TEST_REDIS_URL=redis://localhost:6379` itself. Hard-fails if Redis is
unreachable. **This gate must be GREEN before `numReplicas > 1` ships in
`railway.toml`** (see that file's `numReplicas` comment and
`docs/runbooks/scaling.md`).

---

## Gates that CANNOT run without credentials (explicit operational blockers)

These are **not** false-green: each hard-fails (or self-skips with a visible
annotation) when its credentials are absent. They are listed here as the honest
set of coverage that is unavailable until an operator provisions secrets.

| Gate | Missing-credential behavior | Unblocked by |
|---|---|---|
| Post-deploy smoke (`deploy.yml`) | **Hard fail** — `DEV_/PROD_HEALTHCHECK_URL` unset ⇒ deploy job errors. | `DEV_HEALTHCHECK_URL`, `PROD_HEALTHCHECK_URL` |
| Real outbound call (`voice-smoke-real.yml`) | **Hard fail (WS7 guard).** | 6 Twilio/staging secrets above |
| MMS vision real model (`mms-vision-smoke.yml`) | **Hard fail (existing guard).** | `AI_PROVIDER_API_KEY` |
| QA matrix gate (`qa-matrix-gate.yml`) | **Hard fail (WS7 guard + `qa:doctor`).** | 11 `E2E_*` secrets |
| Voice Quality Layer 2 (`voice-quality-pre-deploy.yml`) | **Hard fail (existing guard).** | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` |
| Full E2E journeys (`e2e.yml`) | **Self-skip + `::warning::` (WS7).** Green is smoke-only, not full coverage. | `E2E_CLERK_PUBLISHABLE_KEY`, `E2E_CLERK_SECRET_KEY` |

## Railway operator cutover (deploy topology)

The deploy pipeline in `deploy.yml` deploys the **api + web** services only.
The **worker** (and optional **voice**) service cutover is a documented manual
operator task — see `docs/deployment.md` → "Deploy topology (web + worker)"
(setup steps at `docs/deployment.md` §Setup, lines ~103–126):

1. Create the second Railway service on the same repo/image.
2. Set its **Config File Path** to `railway.worker.toml`.
3. Set the `PROCESS_ROLE` dashboard variable per service (`web` / `worker`).
4. **Deploy the web service first** whenever a release contains a migration —
   migrations run exactly once via `railway.toml`'s `preDeployCommand`
   (`railway.worker.toml` has none).

Scaling past one replica additionally requires `REDIS_URL` + `NUM_REPLICAS` +
PgBouncer (see `railway.toml` and the `redis-multi-instance.yml` gate above).
