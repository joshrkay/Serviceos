# OpenRouter AI provider (Option A)

**Status:** recommended go-live path (2026-07-20)  
**Why:** Live Railway APIs had a dead LLM path (0/50 operator voice probe). Host 70B locally on Railway is out of scope; use managed OpenRouter inference and keep ServiceOS on Railway.

## What this is

ServiceOS talks to any OpenAI-compatible chat completions API via
`packages/api/src/ai/gateway/factory.ts`. OpenRouter is that API with open
model IDs (`meta-llama/…`, `qwen/…`). Switching providers is env-only.

### Failover vs primary-swap

| Mode | How | When |
|------|-----|------|
| **Profile B primary-swap** | `AI_PROVIDER_*` → OpenRouter (`apply-railway-ai-profile.sh b`) | Full move off OpenAI |
| **Dual-provider failover** | Keep Profile A OpenAI primary; set `AI_FALLBACK_PROVIDER_*` (`apply-railway-ai-fallback.sh`) | Voice 50/50 residual after OpenAI primary already works |

Failover is **not** Profile B. The factory only populates `fallbackProviders`
when **both** `AI_FALLBACK_PROVIDER_API_KEY` and `AI_FALLBACK_PROVIDER_BASE_URL`
are set. See `docs/runbooks/live-ai-restore.md` (“Profile A + OpenRouter fallback”).

## One-time setup

1. Create an account at [openrouter.ai](https://openrouter.ai) and mint an API key (`sk-or-…`).
2. Add credits (pay-per-token; no GPU commitment).
3. On **both** Railway API environments (`Development` and `production`), set
   the same block on `@serviceos/api` (do not leave production with an empty
   key — that yields `providers: []`):

```bash
export AI_PROVIDER_API_KEY='sk-or-...'
./scripts/apply-railway-ai-profile.sh b
# equivalent manual vars:
# AI_PROVIDER_BASE_URL=https://openrouter.ai/api/v1
# AI_LIGHTWEIGHT_MODEL=meta-llama/llama-3.1-8b-instruct
# AI_STANDARD_MODEL=meta-llama/llama-3.3-70b-instruct
# AI_COMPLEX_MODEL=qwen/qwen2.5-vl-72b-instruct
```

4. Redeploy (or restart) both APIs so `createLLMGateway` rebuilds with a real key.
5. Smoke both hosts: `./scripts/verify-live-ai-envs.sh`
6. Confirm `/api/health/ai` shows a non-empty `providers` list on **Dev and Prod**.
   Note: that endpoint does **not** prove completions work — only that a
   gateway was created. Use `GET /api/health/ai/completion` (METRICS_TOKEN)
   or a real chat turn for proof.

## Model tiers

| Tier | Default OpenRouter id | Used for |
|------|----------------------|----------|
| lightweight | `meta-llama/llama-3.1-8b-instruct` | `classify_intent`, graders, supervisor review |
| standard | `meta-llama/llama-3.3-70b-instruct` | create/update customer/job, send_*, assistant chat |
| complex | `qwen/qwen2.5-vl-72b-instruct` | `draft_estimate`, `draft_invoice`, `mms_estimate` |

### Cheaper text-only complex (optional)

If MMS photo estimates are unused, you can set:

```bash
AI_COMPLEX_MODEL=qwen/qwen-2.5-72b-instruct
```

(text-only — image `mms_estimate` will fail vision capability check.)

## Cost accounting

Floor prices for the Option A models live in
`packages/api/src/ai/gateway/model-pricing.ts`. OpenRouter may route to a
pricier upstream provider — override with `AI_MODEL_PRICING_JSON` if billed
rates diverge (never guess in code).

## Production hardening (after smoke is green)

1. Set `NODE_ENV=production` on the go-live API so `validateProductionConfig`
   fails boot when `AI_PROVIDER_API_KEY` is missing (no silent hermetic mock).
2. Do **not** enable `CLERK_DEV_HMAC_TOKENS` on real production.
3. Re-run the top-50 operator probe
   (`docs/verification-runs/operator-voice-50-live-2026-07-20.md` pattern).
4. Then merge/deploy PR #714 handler gates.

## Rollback (Profile A — OpenAI)

Full Railway variable table: `docs/runbooks/live-ai-restore.md`.

```bash
AI_PROVIDER_BASE_URL=https://api.openai.com/v1
AI_PROVIDER_API_KEY=sk-...
AI_DEFAULT_MODEL=gpt-4o-mini
AI_LIGHTWEIGHT_MODEL=gpt-4o-mini
AI_STANDARD_MODEL=gpt-4o-mini
AI_COMPLEX_MODEL=gpt-4o
# Delete any meta-llama/* / qwen/* / claude-* tier leftovers
```

Static check before/after:

```bash
cd packages/api && npm run check:ai-provider-config
```

## Related

- Live AI restore (Railway config fixes): `docs/runbooks/live-ai-restore.md`
- Live AI restore plan: `docs/plans/2026-07-20-002-fix-live-ai-provider-operator-voice-plan.md`
- Env templates: `packages/api/.env.example`, `.env.production.example`
- Checklist: `docs/prod-env-checklist.md`
