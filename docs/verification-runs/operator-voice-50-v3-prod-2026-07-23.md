# Operator voice top-50 v3 — production — 2026-07-23

**Latest clean evidence:** 2026-07-23T17:41:40Z (deadline-tuned + seeded)  
**API:** `https://serviceosapi-production.up.railway.app`  
**Web:** `https://app.therivetapp.com`  
**Corpus:** `fixtures/voice/operator-voice-top-50-v3-cases.json`  
**Tenant:** `44c63e93-33fc-4c45-8bc2-11e0a50d2973` (`joshrkay+7 QA Organization`)  
**Harness:** `node scripts/production-retest.mjs --probe v3 --jwt-file .tmp-prod-serviceos.jwt`

## Scoreboard (progression today)

| Run | When (UTC) | Voice PASS | Assistant PASS | Notes |
|-----|------------|----------:|---------------:|-------|
| Auth blocked | ~04:53 | n/a | n/a | `sk_test_` only |
| Broken OpenAI key | ~06:49 | **3/50** | 0/50 | breaker open |
| Key fixed, unseeded | ~16:39 | **7/50** | 5/50 | still classifier aborts |
| Seeded fixtures | ~17:08 | **7/50** | 2/50 | fixtures OK; AI flaky |
| **Deadlines raised** | **17:41** | **26/50** | **5/50** | best — early 0/14 while breaker open, late **26/36** |
| Post-redeploy “clean” | ~17:56 | 10/50 | 0/50 | started half-open again |

**Best voice PASS: 26/50**  
Artifact: `/opt/cursor/artifacts/operator-voice-50-v3-prod-20260723-1741-deadlines/`

Dev baseline (seeded QA): **50/50**.

## Production changes applied (Railway)

### AI Profile A (OpenAI)
| Variable | Value |
|----------|--------|
| `AI_PROVIDER_BASE_URL` | `https://api.openai.com/v1` |
| `AI_PROVIDER_API_KEY` | New valid `sk-proj-…` (old key was **401 invalid**) |
| `AI_DEFAULT_MODEL` | `gpt-4o-mini` |
| `AI_LIGHTWEIGHT_MODEL` | `gpt-4o-mini` |
| `AI_STANDARD_MODEL` | `gpt-4o-mini` |
| `AI_COMPLEX_MODEL` | `gpt-4o` |

Same model + deadline block also applied on **Development**.

### Deadline tuning (critical)
Default `classify_intent` budget (4s) was aborting Railway→OpenAI calls and opening the breaker.

| Variable | Value |
|----------|------:|
| `AI_CLASSIFY_INTENT_DEADLINE_MS` | **12000** |
| `AI_LIGHTWEIGHT_DEADLINE_MS` | **6000** |
| `AI_STANDARD_DEADLINE_MS` | **10000** |
| `AI_COMPLEX_DEADLINE_MS` | **20000** |

### OpenAI billing
- Usage Tier 1 (500 RPM gpt-4o-mini)
- Payment on file; **auto-recharge enabled**

### Not changed (intentional)
- Clerk stays `pk_live_` / `sk_live_` (no test keys)
- `serviceos` JWT template lifetime left at 60s
- `NODE_ENV` still `"development"` — do **not** flip until AI is stably green

## Fixture seed (production QA tenant)

| Item | Value |
|------|--------|
| Tenant renamed | `joshrkay+7 QA Organization` |
| Carlos technician | `users` row `Carlos` (empty last name) for catalog match |
| Seed result | **27 records** (9 created / 18 reused) |
| DB | `hopper.proxy.rlwy.net` (production — not shinkansen) |

## Auth path (probe)

Clerk Production `sk_live_` → active session → `POST /sessions/{id}/tokens/serviceos` → `.tmp-prod-serviceos.jwt` with 25s refresh. `/api/me` **200**.

## Remaining production gap (why not 50/50)

1. **Railway→OpenAI still aborts intermittently** (`Request was aborted`), which opens the circuit breaker. When the breaker is open/half-open at probe start, the first ~14 cases degrade; when it recovers mid-run, pass rate jumps (26/36 on the late window).
2. **`/api/health/ai/completion` probe** uses a hard **5s** race (code default) and can itself contribute abort noise — prefer not to scrape it in a tight loop.
3. **Assistant PASS** lags voice (fallback envelopes) even when voice proposals succeed.
4. Optional: OpenRouter Profile B failover, or raise OpenAI tier / add a second provider for true failover.

### Recommended next ops steps
1. Keep deadline env vars; avoid hammering `/ai/completion`.
2. Redeploy (or wait for closed breaker) → immediately run top-50 without health scrape loops.
3. Consider OpenRouter Profile B (`docs/runbooks/live-ai-restore.md`) as failover.
4. After sustained completionProbe ok + closed breaker for hours: set `NODE_ENV=production`.
5. Re-run for target **50/50**.

## Related

- Runbook: `docs/runbooks/operator-voice-top-50-production-rerun.md`
- AI restore: `docs/runbooks/live-ai-restore.md`
- PR: https://github.com/joshrkay/Serviceos/pull/731
