# Operator Voice Top-50 — Post-merge retest (2026-07-22)

**When:** 2026-07-22T17:35:58Z → 2026-07-22T17:39:17Z  
**Host:** `https://serviceosapi-development.up.railway.app`  
**Tenant:** QA Mobile (`b8e2dc0f-04c2-4ba0-9385-0ebcf3168052`)  
**Probe:** `scripts/probe-operator-voice-50-live.mjs`  
**Raw JSON:** `/opt/cursor/artifacts/operator-voice-50-post-merge-20260722-1735/results.json`

## Fixture seed

- Removed orphan `EST-0001` (no fixture provenance) blocking catalog `estimate.khan`.
- Seed run 1: **9 created / 18 reused** → 27 catalog records.
- Seed run 2: **0 created / 27 reused** (idempotent).

## Scoreboard

| Surface | PASS | PARTIAL | DEGRADED | FAIL | BLOCKED |
|---------|-----:|--------:|---------:|-----:|--------:|
| Assistant chat | 31 | 18 | 1 | 0 | 0 |
| In-app voice | **41** | 9 | 0 | 0 | 0 |

**Voice AI path: 41/50 PASS** (prior best post-U5 deploy: 37/50).

## Remaining voice PARTIAL/FAIL cases (9)

See `docs/verification-runs/operator-voice-50-case-tags.md` for tags. Residual gaps are mostly seed-gap entities (Alvarez, Jones), scheduling edge cases (#34–#38), and classifier reprompt on #49 lookup_balance.

## PR #721 merge status

All PR checks green (test, mobile-typecheck, playwright, corpus-integrity, voice-quality, Railway preview deploy). GitHub admin merge API returned **"2 of 3 required status checks are expected"** — merge may require UI approval or a missing required-check context name on branch protection.
