# Live AI restore (operator voice)

**Status:** RCA confirmed 2026-07-20  
**Related:** `docs/verification-runs/operator-voice-50-live-2026-07-20.md`,  
`docs/plans/2026-07-20-002-fix-live-ai-provider-operator-voice-plan.md`,  
`docs/runbooks/openrouter-ai-provider.md`

## Confirmed root cause

On `serviceosapi-development.up.railway.app`:

| Signal | Value |
|--------|--------|
| `/api/health/ai` | `api.openai.com`, breaker `closed` (looks healthy) |
| Prometheus | `gateway_requests_total{provider="api.openai.com",model="claude-haiku-4-5-20251001",outcome="error"}` and same for `claude-sonnet-4-6` — **zero successes** |
| Causal | One authenticated `POST /api/assistant/chat` increments those Claude→OpenAI error counters and returns `fallbackStage: "error-envelope"` |

**Why:** Two stacked bugs:

1. **Provider/model mismatch** — host is OpenAI; routed model ids were Claude defaults from `DEFAULT_AI_ROUTING_CONFIG` (main).
2. **`AI_DEFAULT_MODEL` ignored for real tenants** — factory wired `AI_DEFAULT_MODEL` only under `tenantOverrides[system]`. Tenant traffic never saw `gpt-4o-mini` (the Zod default). Fixed in PR #714: system override falls through to any tenant without its own override.

On `serviceosapi-production.up.railway.app`: `/api/health/ai` → `providers: []` (no `AI_PROVIDER_API_KEY` / hermetic mock). Both hosts report `environment: "development"`.

## Host inventory (ops)

| Host | Role | AI key | health/ai | Notes |
|------|------|--------|-----------|--------|
| `serviceosapi-development` | canary / probe host | present (OpenAI) | openai, closed | Completions failed until model/default-model fix + align env |
| `serviceosapi-production` | intended go-live | absent (`providers: []`) | empty | Needs key + models; HMAC auth off (`CLERK_DEV_HMAC_TOKENS` not enabled) |
| `serviceosweb-*` | SPA | n/a | n/a | Confirm `VITE_API_URL` points at the go-live API |

## Immediate fix (stay on OpenAI)

On the API service that has the OpenAI key:

```bash
AI_PROVIDER_BASE_URL=https://api.openai.com/v1
AI_PROVIDER_API_KEY=sk-...   # working OpenAI key
AI_DEFAULT_MODEL=gpt-4o-mini
# Optional explicit tiers (overrides DEFAULT_AI_ROUTING_CONFIG):
# AI_LIGHTWEIGHT_MODEL=gpt-4o-mini
# AI_STANDARD_MODEL=gpt-4o-mini
# AI_COMPLEX_MODEL=gpt-4o
```

Redeploy/restart. Then:

1. `GET /api/health/ai` → openai present  
2. `GET /api/health/ai/completion` (Bearer `METRICS_TOKEN` in prod) → `completionProbe.ok: true`  
3. Authenticated assistant chat → **not** `error-envelope`

## Preferred go-live (Option A — OpenRouter)

See `docs/runbooks/openrouter-ai-provider.md`. Set base URL + `sk-or-…` + Llama/Qwen tier models.

## After AI is green

1. Set `NODE_ENV=production` on the go-live API (boot will require AI key).  
2. Re-run top-50 operator probe.  
3. Merge/deploy PR #714 handler gates (`send_estimate`, etc.).
