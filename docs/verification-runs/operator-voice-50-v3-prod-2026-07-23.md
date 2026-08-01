# Operator voice top-50 v3 — production — 2026-07-23

**Latest clean evidence:** 2026-07-23T22:20Z (#734 + `AI_CLASSIFY_INTENT_DEADLINE_MS=12000` restored)  
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
| **#734 voice-only A** | **21:21** | **17/50** | 0/50 (skipped) | breaker **stayed closed**; interleaved PASSes; no whole-run cascade |
| #734 voice-only retry | 21:28 | 10/50 | 0/50 (skipped) | breaker closed end-to-end |
| **#734 full B** | **21:35** | **15/50** | **11/50** | improves vs post-#732 8/50; breaker closed; assistant 11 vs 1 |
| #734 voice-only r2 | 21:55 | 11/50 | 0/50 (skipped) | breaker closed; completion probe flaky timeout |
| **Deadline restored + voice-only** | **22:20** | **30/50** | 0/50 (skipped) | Railway `AI_CLASSIFY_INTENT_DEADLINE_MS` was **empty** (code default 4s); set back to **12000**; breaker closed |
| **Deadline restored + full** | **22:29** | **28/50** | **21/50** | no cascade; assistant 21 vs post-#732 1 |

**Best voice PASS today: 30/50** (post-#734 + deadline restore). Prior best was 26/50.  
**Best full: 28/50** voice / **21/50** assistant.  
Artifacts:
- `/opt/cursor/artifacts/operator-voice-50-v3-prod-20260723-voice-only-deadline12-2220/`
- `/opt/cursor/artifacts/operator-voice-50-v3-prod-20260723-full-deadline12-2229/`

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

**Regression found 2026-07-23 ~22:05 UTC (Railway desktop):**
`AI_CLASSIFY_INTENT_DEADLINE_MS` had become an **empty string**, so production fell back to the code default **4000ms**. Restored to **12000** and redeployed `@serviceos/api`. Other deadlines were still set; no OpenRouter/fallback vars present; `NODE_ENV` left as `development` (intentional).

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

### Remaining production gap (addressed in breaker-cascade plan)
Plan: `docs/plans/2026-07-23-002-fix-voice-breaker-abort-cascade-plan.md`

| FM | Break | Fix in cascade PR |
|----|-------|-------------------|
| FM-01 | Abort counted as provider health | Local deadline/abort **not** counted toward breaker |
| FM-02 | Assistant poisons voice cell | `taskClass=classify` isolates `classify_intent` |
| FM-04 | Half-open reopen on abort | Abort no longer reopens half-open |
| FM-05 | Green completion while tenant open | `breakerBypassed` + providers on completion probe |
| FM-06 | Adapter retry on unavailable | No retry for `BREAKER_OPEN` / `LLM_PROVIDER_UNAVAILABLE` |
| FM-07 | Unavailable mislabeled deadline | Keep provider class (already on branch) |
| FM-03 | No failover provider | Follow-up: OpenRouter Profile B (ops) |

Unit multi-variation gate: **98 passed** (incl. cascade A–D).

### Post-#734 live probes (2026-07-23 ~21:21–22:01 UTC)

Deploy: [Deploy #30043016334](https://github.com/joshrkay/Serviceos/actions/runs/30043016334) **success**
(`deploy-railway-prod` after merge of #734 @ `5edf7920`).

| Gate | Result | Artifact |
|------|--------|----------|
| `/api/health/ai` pre-run | `available:true`, `breakerState:closed` | — |
| Variation A voice-only | **17/50** voice (best of 3) | `…/voice-only-2121/` |
| Variation B full | **15/50** voice, **11/50** assistant | `…/full-2135/` |
| Breaker during/after runs | **closed** every sample; `lastSuccessAt` advances | — |

**Cascade verdict:** #734 **stopped the abort→breaker→whole-run collapse**.
PASSes stay interleaved through the suite (e.g. full seq
`DPDDPDDDDDDDPDPDPDDPDDPDPDDPPDDDDPDDDDDPPDPDDPDDDD`). Post-#732 pattern
(early PASSes then total DEGRADED from open breaker) did **not** recur.

**Residual (not cascade):** DEGRADED still dominated by audit
`classifier_provider_failure` / `LLM_PROVIDER_UNAVAILABLE` while the
provider breaker remains **closed**. Single warm classify turns (~14s)
reproduce the same audit with breaker still closed — consistent with
single-provider failover wrapping a local deadline/abort as
`LLM_PROVIDER_UNAVAILABLE` (FM-07 keeps that code as provider; FM-01
correctly does not count the abort toward breaker health). Completion
probe often ~9–17s (`breakerBypassed:true`).

**Success criteria vs plan (after deadline restore):**
- Voice-only ≥ prior best 26/50 — **met (30/50)**
- Full improves vs post-#732 8/50 + no whole-run cascade — **met (28/50 voice, 21/50 assistant)**
- Failures not dominated by breaker-open from abort counting — **met** (breaker closed; residual ~20 `LLM_PROVIDER_UNAVAILABLE` without cascade)

### Recommended next ops steps
1. Keep `AI_CLASSIFY_INTENT_DEADLINE_MS=12000` — do not leave empty (falls back to 4s).
2. Do **not** flip `NODE_ENV` yet until closer to 50/50 sustained.
3. FM-03: add OpenRouter Profile B (or second provider) for remaining UNAVAILABLE noise.
4. Optional: set `AI_COMPLETION_PROBE_TIMEOUT_MS=20000` (completion probe still times out ~17s occasionally).

## Related

- Runbook: `docs/runbooks/operator-voice-top-50-production-rerun.md`
- AI restore: `docs/runbooks/live-ai-restore.md`
- Breaker-cascade plan: `docs/plans/2026-07-23-002-fix-voice-breaker-abort-cascade-plan.md`
- Fix PRs: [#732](https://github.com/joshrkay/Serviceos/pull/732), [#734](https://github.com/joshrkay/Serviceos/pull/734)
