# Operator Voice Top-50 v3 — Post PR #725 (2026-07-22)

**When:** 2026-07-22T19:10:28Z → 2026-07-22T19:14:06Z  
**Host:** `https://serviceosapi-development.up.railway.app`  
**Corpus:** `fixtures/voice/operator-voice-top-50-v3-cases.json` (v3)  
**Change under test:** PR #725 — disambiguation follow-up loop + multi-turn probe  
**Fixtures:** 27/27 reused (`seed-operator-voice-fixtures.ts`)  
**Raw JSON:** `/opt/cursor/artifacts/operator-voice-50-v3-post725-20260722-1910/results.json`

## Scoreboard

| Surface | PASS | PARTIAL | DEGRADED | FAIL |
|---------|-----:|--------:|---------:|-----:|
| Assistant chat | 30 | 18 | 2 | 0 |
| **In-app voice** | **45** | **4** | **1** | **0** |

## Delta vs pre-725 v3 run (42/50 voice PASS)

| Metric | Pre-725 | Post-725 | Δ |
|--------|--------:|---------:|--:|
| Voice PASS | 42/50 | **45/50** | **+3** |
| Voice PARTIAL | 4 | 4 | 0 |
| Voice DEGRADED | 4 | 1 | −3 |

Smith flows that **no longer hit ambiguity** on turn 1 now pass with confirmation only (#34 create_appointment, #46 late_fee). Multi-turn disambiguation is exercised on the remaining Smith cases (`disambiguationSent: true`).

## Voice non-PASS (5 cases)

| # | Op | Verdict | Reason | Notes |
|---|-----|---------|--------|-------|
| 15 | create_estimate | DEGRADED | `voice_classifier_provider` | Infrastructure / classifier failure |
| 25 | edit_invoice | PARTIAL | `voice_no_proposal` | Smith ambiguity → disambig sent → turn 2 **escalating** |
| 29 | send_invoice | PARTIAL | `voice_no_proposal` | Same pattern |
| 47 | feedback | PARTIAL | `voice_no_proposal` | Same pattern |
| 49 | lookup_balance | PARTIAL | `voice_no_proposal` | Same pattern |

For #25/#29/#47/#49: turn 1 correctly parks in `entity_resolution`; probe sends `104 Cedar`; turn 2 returns `escalating` with on-call notify (spoken: *"I'm connecting you with a team member…"* — the cost-cap escalation line). Follow-up did not reach `intent_confirm`.

## Run

```bash
# Fixtures (Development DB)
QA_TENANT_ID=b8e2dc0f-04c2-4ba0-9385-0ebcf3168052 \
QA_ACTOR_ID=25abab01-4303-4626-9672-af9a19bf6a64 \
NODE_ENV=development \
npx tsx packages/api/scripts/seed-operator-voice-fixtures.ts

# Probe
CASES_PATH=fixtures/voice/operator-voice-top-50-v3-cases.json \
OUT_DIR=/opt/cursor/artifacts/operator-voice-50-v3-post725-20260722-1910 \
API_URL=https://serviceosapi-development.up.railway.app \
node scripts/probe-operator-voice-50-live.mjs
```

## Next fix target

Turn-2 escalation on disambiguation follow-up for invoice/send/lookup/feedback intents — investigate why `104 Cedar` does not advance to `intent_confirm` (pending context persistence vs. cost-cap vs. intent-specific resolution path).
