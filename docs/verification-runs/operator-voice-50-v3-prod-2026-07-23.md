# Operator voice top-50 v3 — production — 2026-07-23

**When:** 2026-07-23T06:49:12Z  
**API:** `https://serviceosapi-production.up.railway.app`  
**Web:** `https://app.therivetapp.com`  
**Corpus:** `fixtures/voice/operator-voice-top-50-v3-cases.json`  
**Tenant:** `44c63e93-33fc-4c45-8bc2-11e0a50d2973` (`joshrkay+7@gmail.com`, owner)  
**Raw JSON:** `/opt/cursor/artifacts/operator-voice-50-v3-prod-20260723-0649/`  
**Harness:** `node scripts/production-retest.mjs --probe v3 --jwt-file .tmp-prod-serviceos.jwt`

## Scoreboard

| Metric | Result |
|--------|--------|
| **Voice PASS** | **3/50** |
| **Assistant PASS** | **0/50** |
| Voice DEGRADED | 47/50 (`voice_classifier_provider`) |
| Assistant DEGRADED | 50/50 (`llm_fallback_envelope`) |
| Auth method | Clerk Production `sk_live_` + active session → `POST /sessions/{id}/tokens/serviceos` → `.tmp-prod-serviceos.jwt` (refreshed every 25s; 60s template untouched) |

Voice PASS case IDs: **15, 25, 29**.

### Comparison

| Run | Voice PASS | Notes |
|-----|----------:|-------|
| Earlier same day (browser JWT, AI healthy) | **11/50** | Unseeded live tenant |
| **This run** (session token remint, AI breaker open) | **3/50** | Classifier provider failures dominate |
| Dev baseline (seeded QA) | **50/50** | post PR #727 |

## Platform

| Check | Result |
|-------|--------|
| `GET /health` | 200 — DB ok |
| `GET /api/health/ai` | provider **unavailable**, breaker **open** (`Request was aborted.`) |
| `GET /api/health/ai/completion` | **fail** (timeout / provider_error) |
| Web Clerk | `pk_live_` |
| Prod `/api/me` with serviceos JWT | **200** |
| Dev `/api/me` with same JWT | 401 (expected — different Clerk instance) |

## Auth path used

1. Browser login to Clerk dashboard (GitHub OAuth) → copied Production `sk_live_` / `pk_live_` into gitignored `.env.production.local`
2. Confirmed Railway production `CLERK_SECRET_KEY` still `sk_live_`
3. Active Clerk session for `user_3GcSONr4v9xf3vhts4gQFyO0Asn` → mint `serviceos` JWT via Backend API (browser ticket flow hit Cloudflare bot checks)
4. Background refresh every 25s into `.tmp-prod-serviceos.jwt` (harness re-reads per case)
5. Did **not** extend JWT template lifetime; did **not** flip Railway to test keys

## Root cause of low PASS

Not auth. Almost every case hit LLM gateway circuit breaker:

- Voice: `classifier_provider_failure` / spoken “I'm having trouble hearing you…”
- Assistant: `fallback` / `llm_fallback_envelope`

Railway production has `AI_PROVIDER_API_KEY` (`sk-proj-…`) + `AI_PROVIDER_BASE_URL` + `AI_DEFAULT_MODEL` — naming matches `packages/api` (not a missing `OPENAI_API_KEY`). Breaker opened after earlier success (`lastSuccessAt` 2026-07-23T03:52:08Z). Needs provider/network/quota restore per `docs/runbooks/live-ai-restore.md`, then rerun.

## Optional next for 50/50 parity

1. Restore production AI (breaker closed + completion probe ok)
2. Seed operator-voice fixtures on a QA-marked prod tenant (or accept live-tenant baseline)
3. Rerun:
   ```bash
   source .env.production.local
   # keep JWT refresh loop OR remint before run
   OUT_DIR=/opt/cursor/artifacts/operator-voice-50-v3-prod-$(date -u +%Y%m%d-%H%M) \
     ./scripts/run-production-operator-voice-50.sh v3 --jwt-file .tmp-prod-serviceos.jwt
   ```

## Related

- Runbook: `docs/runbooks/operator-voice-top-50-production-rerun.md`
- Prior blocked attempt (no auth): same filename earlier section / `production-retest-2026-07-23.md`
- Harness: `scripts/production-retest.mjs` (`--jwt-file`)
