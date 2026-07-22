# Operator Voice Top-50 v3 — Post PR #727 (2026-07-22)

**When:** 2026-07-22T20:25:28Z → 2026-07-22T20:29:13Z  
**Host:** `https://serviceosapi-development.up.railway.app`  
**Corpus:** `fixtures/voice/operator-voice-top-50-v3-cases.json` (v3)  
**Changes under test:** PR #725 (disambiguation follow-up) + PR #727 (estimate/invoice stabilization)  
**Fixtures:** 27/27 reused  
**Raw JSON:** `/opt/cursor/artifacts/operator-voice-50-v3-post727-20260722-2025/results.json`

## Scoreboard

| Surface | PASS | PARTIAL | DEGRADED | FAIL |
|---------|-----:|--------:|---------:|-----:|
| Assistant chat | 30 | 18 | 2 | 0 |
| **In-app voice** | **50** | **0** | **0** | **0** |

## Delta vs post-725 run (45/50 voice PASS)

| Metric | Post-725 | Post-727 | Δ |
|--------|--------:|---------:|--:|
| Voice PASS | 45/50 | **50/50** | **+5** |
| Estimate PASS | 7/8 | **8/8** | +1 (#15) |
| Invoice PASS | 8/10 | **10/10** | +2 (#25, #29) |

## Previously failing cases — now PASS

| # | Op | Post-725 | Post-727 | Path |
|---|-----|----------|----------|------|
| 15 | create_estimate | DEGRADED (provider) | **PASS** | Deterministic `draft_estimate` pattern |
| 25 | edit_invoice | PARTIAL (Smith escalate) | **PASS** | Disambig → confirm (`disambig=true`) |
| 29 | send_invoice | PARTIAL (Smith escalate) | **PASS** | Disambig → confirm |
| 47 | feedback | PARTIAL | **PASS** | Disambig → confirm |
| 49 | lookup_balance | PARTIAL | **PASS** | Disambig → confirm |

## Run

```bash
CASES_PATH=fixtures/voice/operator-voice-top-50-v3-cases.json \
OUT_DIR=/opt/cursor/artifacts/operator-voice-50-v3-post727-20260722-2025 \
API_URL=https://serviceosapi-development.up.railway.app \
node scripts/probe-operator-voice-50-live.mjs
```
