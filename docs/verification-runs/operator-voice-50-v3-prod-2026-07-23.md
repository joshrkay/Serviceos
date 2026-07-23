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
| **#732 deployed** | **19:07** | **8/50** | **1/50** | fix live; correct intent repair; breaker reopened mid-run (`LLM_PROVIDER_UNAVAILABLE`) |
| Postfix retry | 19:18 | 5/50 | 1/50 | started closed; collapsed after early PASSes |

**Best voice PASS: 26/50** (pre-#732). Post-#732 deploy: **8/50**.  
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

## Code hardening (this PR — deploy before next re-run)

Shipped to stop abort noise from poisoning voice traffic and to stop
mis-labeling classifier failures as “trouble hearing you”:

1. **`isDeadlineExceeded`** recognizes `Request was aborted.` / `AbortError` →
   audit `classifier_deadline_failure` (not `classifier_provider_failure`).
2. **Classifier miss / throw** emits `intent_classified`/`unknown` so FSM uses
   `low_intent_confidence` repair — not `low_audio_confidence`.
3. **Completion probe** default timeout tracks classify deadline (min 10s),
   overridable via `AI_COMPLETION_PROBE_TIMEOUT_MS`, and cancels via AbortSignal
   (no orphaned 5s race).
4. **System-tenant readiness probes skip the circuit breaker** so health scrapes
   cannot open the provider breaker for real tenant voice calls.
5. **Adapter retries once** on provider *and* deadline aborts (fresh budget).

### Post-deploy verification (2026-07-23 ~19:07–19:18 UTC)

Deploy workflow for #732 **succeeded**. Code fix is live:
- Failures audit as `classifier_deadline_failure` (not provider)
- Spoken repair is `low_intent_confidence` (“scheduling a visit…”) — not “trouble hearing you”
- `/ai/completion` can be ok while tenant breaker is open (system probes skip breaker)

**Voice PASS after deploy: 8/50** (retry 5/50). Best remains **26/50** from pre-fix deadline tuning.

Dominant DEGRADED reason once the tenant breaker opens: `LLM_PROVIDER_UNAVAILABLE`
(failover exhaustion). Probe load (assistant + voice per case) re-trips the breaker
after a few early PASSes. Artifacts:
- `/opt/cursor/artifacts/operator-voice-50-v3-prod-20260723-1907-postfix/`
- `/opt/cursor/artifacts/operator-voice-50-v3-prod-20260723-1918-postfix2/`

Follow-up in this branch: do not classify `LLM_PROVIDER_UNAVAILABLE` /
`BREAKER_OPEN` as deadline just because the wrapped message mentions abort.

### Remaining production gap
1. Railway→OpenAI abort rate under probe load still opens the **tenant** breaker.
2. Need failover (OpenRouter Profile B) and/or breaker tuning so aborts don’t cascade the whole run.
3. Assistant PASS still lags (fallback envelopes).

### Recommended next ops steps
1. Merge/deploy breaker-code classification follow-up; keep deadline env vars.
2. Add OpenRouter Profile B failover (`docs/runbooks/live-ai-restore.md`).
3. Wait `/api/health/ai` → `available:true` / `closed`, then re-run top-50.
4. After sustained green: set `NODE_ENV=production`.

## Related

- Runbook: `docs/runbooks/operator-voice-top-50-production-rerun.md`
- AI restore: `docs/runbooks/live-ai-restore.md`
- Fix PR (merged): https://github.com/joshrkay/Serviceos/pull/732
