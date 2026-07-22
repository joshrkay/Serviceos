# Operator Voice Top-50 v4/v5/v6 — Live acceptance (2026-07-22)

**Host:** `https://serviceosapi-development.up.railway.app`  
**Tenant:** QA Mobile (`b8e2dc0f-04c2-4ba0-9385-0ebcf3168052`)  
**Fixtures:** seeded (27 records reused)  
**Stack:** post-#727 (`main` at probe time)

## Summary

| Corpus | Voice PASS | Status |
|--------|----------:|--------|
| **v4** | **49/50** | Valid run — one transient provider failure |
| v5 | 14–17/50 | **Invalid** — OpenAI classifier unstable (32–37 `voice_classifier_provider` per run) |
| v6 | 11–17/50 | **Invalid** — same provider instability (33–39 provider failures per run) |

v4 confirms the new phrasing generalizes at the same bar as v3 post-#727. v5/v6 must be re-probed when `/api/health/ai` reports stable success (not just `available: true` with a half-open breaker).

## v4 — canonical run

**When:** 2026-07-22T21:33:25Z → 2026-07-22T21:36:36Z  
**Cases:** `fixtures/voice/operator-voice-top-50-v4-cases.json`  
**Raw JSON:** `/opt/cursor/artifacts/operator-voice-50-v4-20260722-2135/results.json`

| Surface | PASS | PARTIAL | DEGRADED |
|---------|-----:|--------:|---------:|
| Assistant chat | 33 | 17 | 0 |
| **In-app voice** | **49** | **0** | **1** |

### Category breakdown (voice)

| Category | PASS |
|----------|-----:|
| client | 8/8 |
| job | 5/6 |
| estimate | 8/8 |
| invoice | 10/10 |
| schedule | 8/8 |
| ops | 10/10 |

### Sole non-PASS

| # | Op | Verdict | Reason | Utterance |
|---|-----|---------|--------|-----------|
| 13 | edit_job | DEGRADED | `voice_classifier_provider` | Mark job number twelve complete |

Smith ambiguity cases (#25 edit invoice, #29 send invoice) **passed** on v4 with the new phrasing — no extra deterministic patterns needed for v4.

## v5 / v6 — provider-degraded runs (not baselines)

Multiple attempts (initial batch + 3 health-gated retries per corpus) all showed 30+ classifier provider failures even when the health endpoint reported `available: true`. Example platform snapshot at v4 start:

```json
{"providers":[{"name":"api.openai.com","available":false,"breakerState":"half-open","lastError":"Request was aborted."}]}
```

Do **not** treat v5/v6 scores from 2026-07-22 evening as product regressions. Re-run when the breaker is `closed` with recent `lastSuccessAt`.

### v5 artifacts (best voice PASS = 17/50)

- `/opt/cursor/artifacts/operator-voice-50-v5-20260722-2135/results.json` (first batch)
- `/opt/cursor/artifacts/operator-voice-50-v5-clean-20260722-2150/results.json` (retries; overwrites same OUT_DIR)

One non-provider failure observed across v5 runs: case #13 (`Complete job twelve in the system`) → `voice_reprompt_low_confidence` (watch on next clean run).

### v6 artifacts (best voice PASS = 17/50)

- `/opt/cursor/artifacts/operator-voice-50-v6-20260722-2135/results.json`
- `/opt/cursor/artifacts/operator-voice-50-v6-clean-20260722-2150/results.json`

## Re-run v5/v6 when provider is stable

```bash
# Gate: breaker closed + recent success
curl -s https://serviceosapi-development.up.railway.app/api/health/ai

for V in v5 v6; do
  CASES_PATH=fixtures/voice/operator-voice-top-50-${V}-cases.json \
  OUT_DIR=/opt/cursor/artifacts/operator-voice-50-${V}-$(date -u +%Y%m%d-%H%M) \
  API_URL=https://serviceosapi-development.up.railway.app \
  node scripts/probe-operator-voice-50-live.mjs
done
```

Target: **50/50 voice PASS** per corpus (same bar as v3 post-#727).
