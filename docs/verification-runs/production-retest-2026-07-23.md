# Production retest — 2026-07-23

**Latest attempt:** 2026-07-23T02:41:25Z — voice top-50 **still blocked** (agent has `sk_test_` only)  
**When:** 2026-07-23T02:36:08Z  
**API:** `https://serviceosapi-production.up.railway.app`  
**Web:** `https://serviceosweb-production.up.railway.app` / `https://app.therivetapp.com`  
**Raw JSON:** `/opt/cursor/artifacts/production-retest-20260723-0235/production-retest.json`  
**Harness:** `node scripts/production-retest.mjs --probe v3`

## Verdict

| Layer | Result |
|-------|--------|
| **Platform (unauthenticated)** | **PASS** — API, web, DB, AI completion all healthy |
| **Auth (authenticated API)** | **BLOCKED** — cannot run operator voice probe without **live Clerk** secret |
| **Operator voice top-50** | **Not run** — prod `/api/me` → 401 with dev Clerk JWT |

Production infrastructure is in better shape than Development for AI right now (provider **closed** on prod vs **open** on dev), but **we cannot prove 50/50 voice on prod** until `sk_live_…` for `clerk.therivetapp.com` is available to the probe harness.

---

## Platform checks (production)

| Check | Result |
|-------|--------|
| `GET /health` | 200 — DB ok, drain ok |
| `GET /api/health/ai` | 200 — OpenAI **available**, breaker **closed** |
| `GET /api/health/ai/completion` | **ok** — `gpt-4o-mini` ~763ms |
| Web `/`, `/login`, `/health` | 200 |
| Clerk on web | **`pk_live_`** (therivetapp production instance) |
| Stripe on web | **`pk_live_`** |
| `NODE_ENV` reported by API | still `"development"` (go-live config debt) |

### Dev comparison (same moment)

| Check | Production | Development |
|-------|------------|-------------|
| AI provider | available, closed | unavailable, **open** |
| `/api/me` with dev Clerk JWT | **401** | **200** |

---

## Auth probe

Minted Clerk `serviceos` JWT via Backend API using agent `sk_test_…` (dev instance `romantic-lark-48`):

| Target | `/api/me` |
|--------|-----------|
| **Production API** | **401** UNAUTHORIZED |
| Development API | 200 (tenant + role present) |
| Production + HMAC token | 401 (expected — HMAC disabled on prod) |

**Root cause:** Production API verifies **live** Clerk JWKS (`pk_live` / therivetapp). Agent only has **test** Clerk credentials. JWT issuer does not match production API configuration.

---

## Operator voice top-50

**Skipped** — requires authenticated `/api/me` → 200 before probe loop.

To complete production voice retest:

1. Provide `CLERK_SECRET_KEY=sk_live_…` (therivetapp production instance)
2. Ensure a prod user has `public_metadata { tenant_id, role }` + matching `users` row in **production Postgres**
3. Seed operator voice fixtures on prod tenant if needed
4. Run:

```bash
CLERK_SECRET_KEY=sk_live_… \
CLERK_USER_ID=user_… \
./scripts/run-production-operator-voice-50.sh v3

# One-time fixture seed (needs PROD_DATABASE_URL + tenant/actor UUIDs):
PROD_DATABASE_URL=postgres://… \
QA_TENANT_ID=… QA_ACTOR_ID=… \
./scripts/run-production-operator-voice-50.sh v3 --seed
```

---

## What production **can** claim today

- App is **live** and serving traffic
- Database connectivity **ok**
- **LLM completions work** on production API (completion probe passes)
- Live Clerk + Stripe keys on web (real go-live identity/billing surface)
- Auth correctly **rejects** dev tokens and HMAC (fail-closed)

## What production **cannot** claim today

- Operator voice top-50 PASS rate (not authenticated / not probed)
- Parity with Development 50/50 v3 results (#725/#727 fixes unverified on prod)
- True `NODE_ENV=production` hardening (still reports development)
