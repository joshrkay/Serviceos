# Operator voice top-50 — production rerun runbook

Run the same 50 in-app voice workflows used on Development against the **live**
production API. Pairs with `fixtures/voice/operator-voice-top-50-v3-cases.json`
(canonical corpus after PR #727).

**Prior attempt (2026-07-23):** 11/50 voice PASS on production with browser JWT
auth and an unseeded live tenant. Development baseline with seeded QA tenant:
**50/50** voice PASS.

---

## Copy-paste prompt (next agent thread)

```
Run operator voice top-50 (v3 corpus) against PRODUCTION and report voice PASS count.

Targets:
- API: https://serviceosapi-production.up.railway.app
- Web: https://app.therivetapp.com
- Corpus: fixtures/voice/operator-voice-top-50-v3-cases.json
- Runbook: docs/runbooks/operator-voice-top-50-production-rerun.md

Hard rules:
- Do NOT change Railway production to sk_test_/pk_test_ (dev keys).
- Do NOT run scripts/sync-dev-env-from-cloud.sh or source scripts/load-dev-env.sh for this task.
- Do NOT extend Clerk production JWT template lifetime unless I explicitly approve (60s default is intentional).
- Do NOT commit .env.production.local or .tmp-prod-serviceos.jwt (secrets).

Auth (required — Backend API session mint fails on production Clerk):
1. Browser login on app.therivetapp.com (or Clerk sign-in token for prod user).
2. Console: copy(await window.Clerk.session.getToken({ template: 'serviceos', skipCache: true }))
3. Save single-line JWT to .tmp-prod-serviceos.jwt (must be exactly 3 dot-separated parts).
4. Verify: curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $(tr -d '\n' < .tmp-prod-serviceos.jwt)" https://serviceosapi-production.up.railway.app/api/me → 200

Run probe (refresh JWT immediately before — 60s template expires mid-run):
- If scripts/production-retest.mjs supports --jwt-file, use it.
- Else loop cases manually with the JWT file; refresh JWT every ~45s or split into batches.

Optional for 50/50 parity (not done in first attempt):
- Seed operator-voice fixtures on a prod QA tenant (see §Fixture seed below).
- Or inject CLERK_SECRET_KEY=sk_live_… into cloud agent AND merge --jwt-file harness.

Deliverables:
- Raw JSON under /opt/cursor/artifacts/operator-voice-50-v3-prod-<timestamp>/
- Markdown summary: voice PASS /50, assistant PASS /50, auth method, blockers
- Update docs/verification-runs/operator-voice-50-v3-prod-<date>.md
```

---

## Endpoints

| Surface | URL |
|---------|-----|
| Production API | `https://serviceosapi-production.up.railway.app` |
| Production web | `https://app.therivetapp.com` |
| Health (no auth) | `GET /health`, `GET /api/health/ai` |
| Auth check | `GET /api/me` with `serviceos` JWT |

Clerk production instance: **therivetapp** (`pk_live_` / `sk_live_`).

---

## Why production is harder than Development

| Topic | Development | Production |
|-------|-------------|------------|
| Probe auth | HMAC via `sk_test_` + `CLERK_DEV_HMAC_TOKENS=true` | RS256 `serviceos` JWT only; HMAC **401** |
| Mint JWT in script | Works (`POST /v1/sessions` + `/tokens/serviceos`) | **Fails** — Clerk: "Request only valid for development instances" |
| Cloud agent secrets | `sk_test_` injected | Same — **not** `sk_live_` unless you add it |
| Fixture tenant | QA tenant `b8e2dc0f-…` + seeded catalog | Live signup tenant unless you seed |
| JWT lifetime | 60s `serviceos` template | 60s — full 50-case run (~5 min) needs **refresh** or browser re-copy |

---

## Prerequisites

### 1. Live Clerk keys (verify only — do not overwrite prod with dev)

Railway **production** `@serviceos/api` Variables must have:

- `CLERK_SECRET_KEY` → `sk_live_…`
- `CLERK_PUBLISHABLE_KEY` → `pk_live_…`

Quick check (no secrets printed):

```bash
curl -sS https://serviceosweb-production.up.railway.app/env.js | grep -o 'pk_live_\|pk_test_'
# expect: pk_live_
```

Local probe file (gitignored), **never commit**:

```bash
# .env.production.local — copy from Railway production Variables only
export CLERK_SECRET_KEY="sk_live_…"
export CLERK_PUBLISHABLE_KEY="pk_live_…"
export API_URL="https://serviceosapi-production.up.railway.app"
export PROD_API_URL="https://serviceosapi-production.up.railway.app"
# Optional fixture seed:
# export PROD_DATABASE_URL="postgres://…"   # hopper.proxy.rlwy.net (NOT shinkansen dev)
```

Load without touching dev env:

```bash
source scripts/load-prod-env.sh   # on cursor/dev-env-local-f809+ ; refuses sk_test_
```

### 2. Production probe user

Example from 2026-07-23 (confirm in Clerk **Production** → Users):

| Field | Example |
|-------|---------|
| Clerk user id | `user_3GcSONr4v9xf3vhts4gQFyO0Asn` |
| Email | `joshrkay+7@gmail.com` |
| `public_metadata.tenant_id` | `44c63e93-33fc-4c45-8bc2-11e0a50d2973` |
| `public_metadata.role` | `owner` |

List via Backend API (needs valid `sk_live_`):

```bash
source scripts/load-prod-env.sh
curl -sS -H "Authorization: Bearer ${CLERK_SECRET_KEY}" \
  "https://api.clerk.com/v1/users?limit=10" | \
  python3 -c "import sys,json; [print(u['id'], (u.get('public_metadata') or {}).get('tenant_id')) for u in json.load(sys.stdin)]"
```

### 3. Sign-in token (optional, no password)

```bash
CLERK_USER_ID=user_3GcSONr4v9xf3vhts4gQFyO0Asn
curl -sS -X POST https://api.clerk.com/v1/sign_in_tokens \
  -H "Authorization: Bearer ${CLERK_SECRET_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"${CLERK_USER_ID}\"}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('url',''))"
# Open returned URL in browser → completes sign-in
```

---

## Rerun procedure

### Step A — Platform smoke (no auth)

```bash
curl -sS https://serviceosapi-production.up.railway.app/health
curl -sS https://serviceosapi-production.up.railway.app/api/health/ai
curl -sS https://serviceosapi-production.up.railway.app/api/health/ai/completion
```

Expect: DB ok, AI provider available/closed, completion probe ok.

### Step B — Capture browser JWT

1. Sign in on `https://app.therivetapp.com`.
2. DevTools console:

```javascript
copy(await window.Clerk.session.getToken({ template: 'serviceos', skipCache: true }))
```

3. Write **one line** to repo root (gitignored):

```bash
xclip -o > .tmp-prod-serviceos.jwt
python3 -c "t=open('.tmp-prod-serviceos.jwt').read().strip(); print(len(t), len(t.split('.')))"
# expect: ~800–900 chars, 3 parts
```

4. Verify auth:

```bash
curl -sS -H "Authorization: Bearer $(tr -d '\n' < .tmp-prod-serviceos.jwt)" \
  https://serviceosapi-production.up.railway.app/api/me | python3 -m json.tool
# expect: 200 + tenant_id + role owner
```

### Step C — Run top-50

**With `--jwt-file`** (recommended; harness re-reads the file before each case for the 60s template):

```bash
OUT_DIR=/opt/cursor/artifacts/operator-voice-50-v3-prod-$(date -u +%Y%m%d-%H%M) \
  node scripts/production-retest.mjs --probe v3 --jwt-file .tmp-prod-serviceos.jwt
```

**Without `--jwt-file`** (session mint path — expect auth error on production Clerk):

```bash
source scripts/load-prod-env.sh
CLERK_USER_ID=user_3GcSONr4v9xf3vhts4gQFyO0Asn \
  OUT_DIR=/opt/cursor/artifacts/operator-voice-50-v3-prod-$(date -u +%Y%m%d-%H%M) \
  node scripts/production-retest.mjs --probe v3
```

**JWT expiry mid-run:** If cases flip to `session_create_401` / `auth_401` after case ~2,
refresh JWT (Step B) and rerun, or merge harness support for `--jwt-file` + refresh hook.

### Step D — Record results

Write `docs/verification-runs/operator-voice-50-v3-prod-<YYYY-MM-DD>.md` with:

- Timestamp, OUT_DIR, tenant_id, auth method
- Scoreboard: voice PASS /50, assistant PASS /50
- Comparison to dev 50/50 baseline
- Blockers (fixtures, JWT expiry, AI breaker)

---

## Fixture seed (optional — for 50/50 parity)

Development uses `packages/api/scripts/seed-operator-voice-fixtures.ts` on QA tenant
`b8e2dc0f-04c2-4ba0-9385-0ebcf3168052`. Production requires:

- `PROD_DATABASE_URL` → **hopper.proxy.rlwy.net** (production Postgres)
- Tenant name must contain `QA` marker **or** use break-glass override
- `QA_ACTOR_ID` = canonical `users.id` UUID in that tenant
- Active technician named **Carlos** (Clerk-provisioned, not seeded)

```bash
source scripts/load-prod-env.sh
QA_TENANT_ID=44c63e93-33fc-4c45-8bc2-11e0a50d2973 \
QA_ACTOR_ID=7975802c-e7b5-4942-ab92-57386d57a5a9 \
ALLOW_OPERATOR_VOICE_FIXTURE_SEED_OUTSIDE_DEVELOPMENT=true \
RAILWAY_ENVIRONMENT_NAME=production \
  npx tsx packages/api/scripts/seed-operator-voice-fixtures.ts
```

See `docs/runbooks/operator-voice-fixture-seed.md` for catalog contents (Khan, Johnson, Smith, Garcia, …).

---

## Do not

- Point Railway **production** at `sk_test_` / `pk_test_`.
- Run `scripts/sync-dev-env-from-cloud.sh` with live keys (script refuses) or dev keys into production files.
- Leave Clerk production `serviceos` JWT at 3600s unless explicitly approved for a one-off probe window.
- Commit `.env.production.local`, `.tmp-prod-serviceos.jwt`, or raw Clerk secrets.

---

## Known results (2026-07-23)

| Run | Auth | Voice PASS | Notes |
|-----|------|----------:|-------|
| 1 | Browser JWT, 60s template | 0/50 (49 BLOCKED) | JWT expired mid-probe |
| 2 | Browser JWT, after template briefly 3600s | **11/50** | Live tenant, no fixture seed |
| 3 | None (earlier agent — no Railway/Clerk session) | **not executed** | auth blocked |
| 4 | `sk_live_` + JWT file; invalid OpenAI key | **3/50** | breaker open |
| 5 | New OpenAI key + Profile A models | **7/50** | still aborts |
| 6 | + QA fixtures seeded (27 records) | **7/50** | fixtures OK |
| 7 | + deadline envs (classify 12s) | **26/50** | best; late window 26/36 after breaker recovered |
| Dev baseline | HMAC + seeded QA | **50/50** | post PR #727 |

Artifacts:

- `/opt/cursor/artifacts/operator-voice-50-v3-prod-20260723-0347/` (run 2)
- `/opt/cursor/artifacts/operator-voice-50-v3-prod-20260723-0649/` (run 4 — 3/50)
- `/opt/cursor/artifacts/operator-voice-50-v3-prod-20260723-1741-deadlines/` (run 7 — **26/50** best)

---

## Related

- `scripts/production-retest.mjs` — platform + auth + optional `--probe v3`
- `scripts/run-production-operator-voice-50.sh` — wrapper (requires `sk_live_`)
- `scripts/probe-operator-voice-50-live.mjs` — Development HMAC probe (not for prod)
- `docs/verification-runs/production-retest-2026-07-23.md` — key audit
- PR #727 — estimate/invoice voice fixes (code path under test)
