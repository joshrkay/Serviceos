# Live AI restore — Railway configuration fixes

**Status:** RCA confirmed 2026-07-20 · config playbook  
**Code PR:** [#714](https://github.com/joshrkay/Serviceos/pull/714) (`AI_DEFAULT_MODEL` tenant fallthrough + completion probe)  
**Related:** `docs/runbooks/openrouter-ai-provider.md`, `docs/prod-env-checklist.md`

This runbook is the **configuration** fix only. Apply these Railway variables
even if #714 is not merged yet — wrong models on OpenAI fail with or without
the code fix; after #714, `AI_DEFAULT_MODEL=gpt-4o-mini` is enough for OpenAI.

---

## Current live state (measured)

| Service (Railway / hostname) | `/health` `environment` | `/api/health/ai` | Completions |
|------------------------------|-------------------------|------------------|-------------|
| `@serviceos/api` **Development** → `serviceosapi-development.up.railway.app` | `development` | `api.openai.com` closed | **Fail** — Claude model ids → OpenAI |
| `@serviceos/api` **production** → `serviceosapi-production.up.railway.app` | `development` | `providers: []` | **Dead** — no `AI_PROVIDER_API_KEY` |
| Web `serviceosweb-*` | n/a | n/a | Confirm `VITE_API_URL` → go-live API |

Prometheus proof (dev): only  
`gateway_requests_total{provider="api.openai.com",model="claude-*",outcome="error"}`  
(zero successes).

---

## Mandatory: Development **and** production

Apply the **same** AI profile to **both** Railway environments. Do not stop
after Dev.

| Railway environment | Service | Public host |
|---------------------|---------|-------------|
| `Development` | `@serviceos/api` | `https://serviceosapi-development.up.railway.app` |
| `production` | `@serviceos/api` | `https://serviceosapi-production.up.railway.app` |

Names match `.github/workflows/deploy.yml` (`--environment Development` /
`--environment production`).

**Live state as of last probe (still broken until vars applied):**

- Development: `providers: [api.openai.com]` but completions use Claude ids → fail
- production: `providers: []` → no `AI_PROVIDER_API_KEY`

---

## Profile A — Stay on OpenAI (immediate fix)

Use this **now** on **both** API environments. Matches today’s OpenAI key.

### Variables to SET (identical on Dev + Prod)

| Variable | Value | Development | production |
|----------|-------|:-----------:|:----------:|
| `AI_PROVIDER_BASE_URL` | `https://api.openai.com/v1` | ✓ | ✓ |
| `AI_PROVIDER_API_KEY` | working `sk-…` OpenAI key | already set | **must set** (copy from Dev or new key) |
| `AI_DEFAULT_MODEL` | `gpt-4o-mini` | ✓ | ✓ |
| `AI_LIGHTWEIGHT_MODEL` | `gpt-4o-mini` | ✓ | ✓ |
| `AI_STANDARD_MODEL` | `gpt-4o-mini` | ✓ | ✓ |
| `AI_COMPLEX_MODEL` | `gpt-4o` | ✓ | ✓ |

Setting **all three** tier vars is deliberate: it overrides any Claude/Llama
code defaults and avoids partial-tier traps.

### Variables to UNSET (or delete) if present — on **both** envs

| Variable | Why |
|----------|-----|
| `AI_LIGHTWEIGHT_MODEL=claude-*` | Forces Claude onto OpenAI |
| `AI_STANDARD_MODEL=claude-*` | same |
| `AI_COMPLEX_MODEL=claude-*` | same |
| `AI_*=meta-llama/*` or `qwen/*` while base URL is OpenAI | same class of mismatch |
| OpenRouter-only leftovers while on OpenAI | confusion / wrong host |

### Apply via CLI (both environments in one shot)

Requires `RAILWAY_TOKEN` (or `railway login`) + project linked + the OpenAI key:

```bash
export AI_PROVIDER_API_KEY='sk-...'   # real OpenAI key — never commit
./scripts/apply-railway-ai-profile.sh a
# sets AI_* on @serviceos/api for Development AND production

# Optional: also worker services
# ALSO_WORKER=1 ./scripts/apply-railway-ai-profile.sh a
```

Dry-run first:

```bash
DRY_RUN=1 AI_PROVIDER_API_KEY=sk-dummy ./scripts/apply-railway-ai-profile.sh a
```

### Railway click-path (same vars twice)

1. Railway → project → service **`@serviceos/api`**
2. Environment **Development** → Variables → set table above → **Redeploy**
3. Environment **production** → Variables → set **the same table** (incl. key) → **Redeploy**
4. Do **not** flip `NODE_ENV=production` until smoke is green on **both**

### Verify both hosts

```bash
./scripts/verify-live-ai-envs.sh
# With gated probe:
# METRICS_TOKEN=… ./scripts/verify-live-ai-envs.sh
```

Manual:

```bash
curl -sS https://serviceosapi-development.up.railway.app/api/health/ai
curl -sS https://serviceosapi-production.up.railway.app/api/health/ai
# production must NOT show "providers":[]
```

Authenticated assistant chat on each env must **not** return
`fallbackStage: "error-envelope"`.

Local static check (no network):

```bash
cd packages/api
AI_PROVIDER_BASE_URL=https://api.openai.com/v1 \
AI_PROVIDER_API_KEY=sk-dummy \
AI_DEFAULT_MODEL=gpt-4o-mini \
AI_LIGHTWEIGHT_MODEL=gpt-4o-mini \
AI_STANDARD_MODEL=gpt-4o-mini \
AI_COMPLEX_MODEL=gpt-4o \
npm run check:ai-provider-config
```

---

## Profile A + OpenRouter fallback (FM-03 dual-provider — preferred for voice 50/50)

Keep **OpenAI as primary** (Profile A). Add OpenRouter as a **fallback** so
primary abort/5xx advances instead of sole-provider `LLM_PROVIDER_UNAVAILABLE`.
This is **not** Profile B (which replaces the primary).

Requires the factory wiring from `AI_FALLBACK_PROVIDER_*` (merged with the
voice DEGRADED→50/50 plan). Partial config (key without URL) is ignored.

| Variable | Value |
|----------|-------|
| Primary | unchanged Profile A (`api.openai.com` + `gpt-4o-mini` / `gpt-4o`) |
| `AI_FALLBACK_PROVIDER_BASE_URL` | `https://openrouter.ai/api/v1` |
| `AI_FALLBACK_PROVIDER_API_KEY` | `sk-or-…` |
| `AI_FALLBACK_LIGHTWEIGHT_MODEL` | `meta-llama/llama-3.1-8b-instruct` |
| `AI_FALLBACK_STANDARD_MODEL` | `meta-llama/llama-3.3-70b-instruct` (optional) |
| `AI_FALLBACK_COMPLEX_MODEL` | `qwen/qwen2.5-vl-72b-instruct` (optional) |
| `AI_CLASSIFY_INTENT_DEADLINE_MS` | **12000** (never leave empty — empty → 4s default) |

```bash
export AI_FALLBACK_PROVIDER_API_KEY='sk-or-...'
./scripts/apply-railway-ai-fallback.sh
# Or set the same vars in Railway desktop → production → @serviceos/api → Variables
cd packages/api && npm run check:ai-provider-config
./scripts/verify-live-ai-envs.sh
```

---

## Profile B — OpenRouter Option A (primary swap — different from failover)

After OpenAI smoke is green (or instead of A if you have `sk-or-…` ready).
Apply to **both** `Development` and `production` (same script, profile `b`).
**Do not use Profile B when you want dual-provider failover** — use the
section above instead.

| Variable | Value |
|----------|-------|
| `AI_PROVIDER_BASE_URL` | `https://openrouter.ai/api/v1` |
| `AI_PROVIDER_API_KEY` | `sk-or-…` |
| `AI_LIGHTWEIGHT_MODEL` | `meta-llama/llama-3.1-8b-instruct` |
| `AI_STANDARD_MODEL` | `meta-llama/llama-3.3-70b-instruct` |
| `AI_COMPLEX_MODEL` | `qwen/qwen2.5-vl-72b-instruct` |
| `AI_DEFAULT_MODEL` | unset **or** same as standard (optional) |

```bash
export AI_PROVIDER_API_KEY='sk-or-...'
./scripts/apply-railway-ai-profile.sh b
./scripts/verify-live-ai-envs.sh
```

Full notes: `docs/runbooks/openrouter-ai-provider.md`.

**Unset** OpenAI-only model names (`gpt-4o*`) when switching, or leave
`AI_DEFAULT_MODEL` unset so per-tier OpenRouter ids win.

---

## Production hardening (after AI smoke green)

Apply on the **go-live** API environment only (usually **production**):

| Variable | Value | Notes |
|----------|-------|-------|
| `NODE_ENV` | `production` | Enables `validateProductionConfig` — missing AI key fails boot |
| `CLERK_DEV_HMAC_TOKENS` | unset or `false` | Forbidden when `NODE_ENV=production` |
| `METRICS_TOKEN` | long random secret | Gates `/metrics` and `/api/health/ai/completion` |
| Clerk keys | `pk_live_` / `sk_live_` | Or `ALLOW_CLERK_TEST_KEYS=true` only for staging |

Confirm:

```bash
curl -sS https://serviceosapi-production.up.railway.app/health
# → "environment":"production"
curl -sS https://serviceosapi-production.up.railway.app/api/health/ai
# → non-empty providers
```

---

## Web configuration

On **web** Railway services (`@serviceos/web` / `serviceosweb-*`):

| Variable | Value |
|----------|-------|
| `VITE_API_URL` | Go-live API origin, e.g. `https://serviceosapi-production.up.railway.app` (no trailing slash) |
| `VITE_CLERK_PUBLISHABLE_KEY` | Same Clerk instance as API |

Wrong `VITE_API_URL` → UI looks fine, AI hits the dead host.

---

## Worker / voice services (if split)

If `PROCESS_ROLE=worker` or `voice` services exist, they share the same AI
gateway for background jobs. Set the **same** AI_* block on those services
(or rely on shared Railway variable groups). Missing key there → silent hermetic
mock on workers only.

---

## Ordered rollout checklist

- [ ] `./scripts/apply-railway-ai-profile.sh a` (or `b`) — **both** `Development` + `production`
- [ ] `./scripts/verify-live-ai-envs.sh` green (or manual curls on both hosts)
- [ ] Dev `/api/health/ai` shows correct host (`api.openai.com` or `openrouter.ai`)
- [ ] **Prod** `/api/health/ai` non-empty (not `providers: []`)
- [ ] Dev `/api/health/ai/completion` → `completionProbe.ok: true` (after #714 deploy)
- [ ] Prod completion probe ok
- [ ] Dev + Prod assistant chat → not `error-envelope`
- [ ] Web `VITE_API_URL` → go-live API (usually production host)
- [ ] Merge/deploy [#714](https://github.com/joshrkay/Serviceos/pull/714) if not already on the running image
- [ ] `NODE_ENV=production` on go-live API only (after smoke green)
- [ ] Re-run top-50 operator probe (`docs/verification-runs/…`)

---

## What not to trust

| Signal | Meaning |
|--------|---------|
| `/api/health/ai` breaker `closed` | Gateway exists; **not** proof completions work |
| `/health` `status: ok` | Process up; AI may still be mock/broken |
| Railway “OpenAI configured” | Base URL/key only — model ids may still be Claude |

Use `/api/health/ai/completion` or a real assistant turn.
