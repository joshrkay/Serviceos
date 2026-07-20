# OpenRouter AI provider (Option A)

**Status:** recommended go-live path (2026-07-20)  
**Why:** Live Railway APIs had a dead LLM path (0/50 operator voice probe). Host 70B locally on Railway is out of scope; use managed OpenRouter inference and keep ServiceOS on Railway.

## What this is

ServiceOS talks to any OpenAI-compatible chat completions API via
`packages/api/src/ai/gateway/factory.ts`. OpenRouter is that API with open
model IDs (`meta-llama/…`, `qwen/…`). Switching providers is env-only.

## One-time setup

1. Create an account at [openrouter.ai](https://openrouter.ai) and mint an API key (`sk-or-…`).
2. Add credits (pay-per-token; no GPU commitment).
3. On the **go-live Railway API service**, set:

```bash
AI_PROVIDER_BASE_URL=https://openrouter.ai/api/v1
AI_PROVIDER_API_KEY=sk-or-...
AI_LIGHTWEIGHT_MODEL=meta-llama/llama-3.1-8b-instruct
AI_STANDARD_MODEL=meta-llama/llama-3.3-70b-instruct
AI_COMPLEX_MODEL=qwen/qwen-2.5-72b-instruct
```

4. Redeploy (or restart) the API so `createLLMGateway` rebuilds with a real key.
5. Smoke one completion (assistant chat or a tiny `classify_intent` path).
6. Confirm `/api/health/ai` shows a non-empty `providers` list (breaker registry).
   Note: that endpoint does **not** prove completions work — only that a
   gateway was created. Use a real chat turn for proof.

## Model tiers

| Tier | Default OpenRouter id | Used for |
|------|----------------------|----------|
| lightweight | `meta-llama/llama-3.1-8b-instruct` | `classify_intent`, graders, supervisor review |
| standard | `meta-llama/llama-3.3-70b-instruct` | create/update customer/job, send_*, assistant chat |
| complex | `qwen/qwen-2.5-72b-instruct` | `draft_estimate`, `draft_invoice`, updates |

### MMS photo estimates

Default complex is **text-only**. For `mms_estimate` with images, set:

```bash
AI_COMPLEX_MODEL=qwen/qwen2.5-vl-72b-instruct
```

(`qwen2.5-vl-72b-instruct` is in the default vision-capable set in
`packages/api/src/config/ai-routing.ts`.)

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

## Rollback

Point back at OpenAI (or any other OpenAI-compatible host):

```bash
AI_PROVIDER_BASE_URL=https://api.openai.com/v1
AI_PROVIDER_API_KEY=sk-...
AI_DEFAULT_MODEL=gpt-4o-mini
# unset or override the per-tier Llama/Qwen vars as needed
```

## Related

- Live AI restore plan: `docs/plans/2026-07-20-002-fix-live-ai-provider-operator-voice-plan.md`
- Env templates: `packages/api/.env.example`, `.env.production.example`
- Checklist: `docs/prod-env-checklist.md`
