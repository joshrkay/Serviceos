# Operator voice top-50 v3 — production attempt — 2026-07-23

**When:** 2026-07-23T04:53:11Z  
**API:** `https://serviceosapi-production.up.railway.app`  
**Web:** `https://app.therivetapp.com`  
**Corpus:** `fixtures/voice/operator-voice-top-50-v3-cases.json`  
**Raw JSON:** `/opt/cursor/artifacts/operator-voice-50-v3-prod-20260723-0441/`  
**Harness:** `node scripts/production-retest.mjs --probe v3` (+ `--jwt-file` support added this run)

## Scoreboard

| Metric | Result |
|--------|--------|
| **Voice PASS** | **not executed** (auth blocked) |
| **Assistant PASS** | **not executed** (auth blocked) |
| Auth method | Browser JWT / sign-in token **unavailable** in this agent pod |
| Prior prod run (same day, other agent) | **11/50** voice, **5/50** assistant (browser JWT after briefly extending template to 3600s; unseeded live tenant) |

## Platform (this run)

| Check | Result |
|-------|--------|
| `GET /health` | 200 — DB ok, drain ok |
| `GET /api/health/ai` | 200 — OpenAI **unavailable**, breaker **half-open** (`Request was aborted.`) |
| `GET /api/health/ai/completion` | **fail** — timeout / provider_error |
| Web Clerk (`app.therivetapp.com/env.js`) | **`pk_live_`** |
| API `environment` field | still `"development"` |

**Second blocker:** even if auth were fixed, production AI is currently degraded (breaker not closed). Earlier today (~03:52Z) AI was healthy; by ~04:41Z it opened.

## Auth (this run)

| Attempt | Result |
|---------|--------|
| Cloud-agent `CLERK_SECRET_KEY` | **`sk_test_` only** (romantic-lark-48) |
| Backend API `POST /v1/sessions` with prod user | N/A / refused for prod path |
| Railway / Clerk dashboard browser login | **AUTH_BLOCKED** — no Google/GitHub session in this pod |
| `app.therivetapp.com` existing session | **NOT_SIGNED_IN** |
| Email OTP to `joshrkay@gmail.com` / `joshrkay+7@gmail.com` | No mailbox access in agent |
| `.tmp-prod-serviceos.jwt` | Not present (cannot mint without browser) |

Hard rules honored: did **not** flip Railway prod to `sk_test_`, did **not** extend Clerk JWT template lifetime, did **not** commit secrets.

## What shipped to unblock the next attempt

1. `scripts/production-retest.mjs` — `--jwt-file` / `SERVICEOS_JWT_FILE`, re-reads JWT **before each case** (60s template), refuses `sk_test_` against production API URL.
2. `scripts/run-production-operator-voice-50.sh` — accepts `v3 --jwt-file .tmp-prod-serviceos.jwt` without requiring `sk_live_`.
3. `docs/runbooks/operator-voice-top-50-production-rerun.md` — copy-paste agent prompt + procedure.
4. `.gitignore` — `.tmp-prod-serviceos.jwt`.
5. Unit tests: `scripts/__tests__/production-retest-jwt-file.test.mjs`.

## Unblock checklist (human / next agent)

1. Inject `CLERK_SECRET_KEY=sk_live_…` (therivetapp) into the cloud agent **or** leave a logged-in Railway/Clerk browser session.
2. Mint sign-in token for `user_3GcSONr4v9xf3vhts4gQFyO0Asn` → open ticket URL → capture:
   ```js
   copy(await window.Clerk.session.getToken({ template: 'serviceos', skipCache: true }))
   ```
3. Save one-line JWT to `.tmp-prod-serviceos.jwt` (exactly 3 parts).
4. Confirm AI breaker closed: `curl -sS …/api/health/ai/completion`.
5. Refresh JWT immediately before run; keep refreshing the file every ~45s during the probe (harness re-reads per case):
   ```bash
   OUT_DIR=/opt/cursor/artifacts/operator-voice-50-v3-prod-$(date -u +%Y%m%d-%H%M) \
     ./scripts/run-production-operator-voice-50.sh v3 --jwt-file .tmp-prod-serviceos.jwt
   ```
6. Optional for 50/50 parity: seed fixtures on prod QA tenant (see runbook).

## Related

- Prior blocked attempt: `docs/verification-runs/production-retest-2026-07-23.md`
- Runbook: `docs/runbooks/operator-voice-top-50-production-rerun.md`
- Dev baseline: 50/50 voice PASS post PR #727 (seeded QA tenant)
