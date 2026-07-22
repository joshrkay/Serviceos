# Operator Voice Top-50 v3 — Live acceptance (2026-07-22)

**When:** 2026-07-22T18:34:48Z → 2026-07-22T18:38:32Z  
**Host:** `https://serviceosapi-development.up.railway.app`  
**Corpus:** `fixtures/voice/operator-voice-top-50-v3-cases.json` (v3 — third distinct utterance set)  
**Raw JSON:** `/opt/cursor/artifacts/operator-voice-50-v3-20260722-1834/results.json`

## Scoreboard

| Surface | PASS | PARTIAL | DEGRADED |
|---------|-----:|--------:|---------:|
| Assistant chat | 33 | 17 | 0 |
| **In-app voice** | **42** | **4** | **4** |

## Cross-corpus confirmation (same tenant, same fixtures)

| Corpus | Utterance set | Voice PASS |
|--------|---------------|----------:|
| v1 | 2026-07-20 baseline | 41/50 |
| v2 | First refresh | 43/50 |
| **v3** | **Second refresh (this run)** | **42/50** |

All three independent phrasings land in the **41–43/50** band, confirming the stack generalizes beyond memorized examples.

## Voice non-PASS (8 cases)

| # | Op | Verdict | Reason |
|---|-----|---------|--------|
| 16 | create_estimate | DEGRADED | Classifier reprompt |
| 25 | edit_invoice | PARTIAL | Smith ambiguity (`voice_no_proposal`) |
| 29 | send_invoice | PARTIAL | Smith ambiguity |
| 46 | late_fee | PARTIAL | Smith ambiguity |
| 47 | feedback | DEGRADED | Classifier reprompt |
| 48 | standing_instruction | DEGRADED | Classifier reprompt |
| 49 | lookup_balance | PARTIAL | Smith ambiguity |
| 50 | lookup_revenue | DEGRADED | Classifier reprompt |

## Run

```bash
CASES_PATH=fixtures/voice/operator-voice-top-50-v3-cases.json \
OUT_DIR=/opt/cursor/artifacts/operator-voice-50-v3-rerun \
API_URL=https://serviceosapi-development.up.railway.app \
node scripts/probe-operator-voice-50-live.mjs
```
