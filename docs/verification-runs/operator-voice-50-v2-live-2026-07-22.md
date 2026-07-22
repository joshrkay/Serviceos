# Operator Voice Top-50 v2 — Live acceptance (2026-07-22)

**When:** 2026-07-22T18:28:50Z → 2026-07-22T18:32:21Z  
**Host:** `https://serviceosapi-development.up.railway.app`  
**Corpus:** `fixtures/voice/operator-voice-top-50-v2-cases.json` (v2 — fresh utterances)  
**Tenant:** QA Mobile (`b8e2dc0f-04c2-4ba0-9385-0ebcf3168052`)  
**Fixtures:** 27/27 catalog records seeded (idempotent reuse)  
**Raw JSON:** `/opt/cursor/artifacts/operator-voice-50-v2-20260722-1828/results.json`

## Scoreboard

| Surface | PASS | PARTIAL | DEGRADED | FAIL | BLOCKED |
|---------|-----:|--------:|---------:|-----:|--------:|
| Assistant chat | 30 | 19 | 1 | 0 | 0 |
| **In-app voice** | **43** | **6** | **1** | **0** | **0** |

**Voice: 43/50 PASS** — up from 41/50 on the v1 corpus (same tenant, same fixture seed).

## Voice non-PASS (7 cases)

| # | Op | Verdict | Tag / note |
|---|-----|---------|------------|
| 9 | create_job | PARTIAL | `seed-gap` — Alvarez not in catalog |
| 22 | send_estimate_nudge | DEGRADED | Classifier reprompt |
| 25 | edit_invoice | PARTIAL | `ambiguous-name` — two Smith customers |
| 29 | send_invoice | PARTIAL | `ambiguous-name` — Smith invoice |
| 34 | create_appointment | PARTIAL | `ambiguous-name` — Smith scheduling |
| 47 | feedback | PARTIAL | `ambiguous-name` — Smith |
| 49 | lookup_balance | PARTIAL | `ambiguous-name` — Smith balance |

## Comparison to v1 baseline (same day, post-merge)

| Corpus | Voice PASS | Assistant PASS |
|--------|----------:|---------------:|
| v1 (2026-07-20 utterances) | 41/50 | 31/50 |
| **v2 (fresh utterances)** | **43/50** | 30/50 |

v2 phrasing generalizes slightly better on voice (+2 PASS) with the same QA fixture seed.

## Reproduce

```bash
source /opt/cursor/artifacts/railway-database-url.env
cd packages/api && QA_TENANT_ID=b8e2dc0f-04c2-4ba0-9385-0ebcf3168052 \
  QA_ACTOR_ID=25abab01-4303-4626-9672-af9a19bf6a64 NODE_ENV=development \
  npx tsx scripts/seed-operator-voice-fixtures.ts

cd ../..
CASES_PATH=fixtures/voice/operator-voice-top-50-v2-cases.json \
OUT_DIR=/opt/cursor/artifacts/operator-voice-50-v2-rerun \
API_URL=https://serviceosapi-development.up.railway.app \
node scripts/probe-operator-voice-50-live.mjs
```
