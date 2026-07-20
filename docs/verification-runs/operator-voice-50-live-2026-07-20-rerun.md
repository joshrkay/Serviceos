# Operator Voice Top-50 — Live Re-run (2026-07-20 evening)

**Verdict:** Still **0/50**. Same failure class as the morning probe. Railway AI
configuration (Profile A/B) has **not** been applied yet — completions still
use Claude model ids against `api.openai.com`.

**Prior run:** `docs/verification-runs/operator-voice-50-live-2026-07-20.md`  
**Raw evidence:** `/opt/cursor/artifacts/prod-voice-50-rerun/results.json`  
**Probe script:** `scripts/probe-operator-voice-50-live.mjs`

---

## Scoreboard (identical to morning)

| Surface | PASS | PARTIAL | DEGRADED | FAIL | BLOCKED |
|---------|-----:|--------:|---------:|-----:|--------:|
| Assistant chat | **0** | 0 | **50** | 0 | 0 |
| In-app voice session | **0** | 0 | **50** | 0 | 0 |

**Zero proposals.** Every assistant turn: `fallbackStage: "error-envelope"`.  
Every voice turn: `intent_capture` reprompt, `score: 0`.

| | Morning | This re-run |
|--|--------:|------------:|
| Window | 20:02–20:03 UTC | 22:36–22:36 UTC |
| Host | `serviceosapi-development` | same |
| Assistant PASS | 0/50 | **0/50** |
| Voice PASS | 0/50 | **0/50** |

---

## Where we pointed

Same as morning: HMAC QA Mobile tenant on Development
(`tenant_id=b8e2dc0f-04c2-4ba0-9385-0ebcf3168052`).  
`serviceosapi-production` still reports `providers: []`.

## Metrics proof (unchanged root cause)

```
gateway_requests_total{model="claude-haiku-4-5-20251001",provider="api.openai.com",outcome="error"} 212
gateway_requests_total{model="claude-sonnet-4-6",provider="api.openai.com",outcome="error"} 110
```

No success outcomes. Host/model mismatch persists.

## How to re-run after config fix

```bash
export CLERK_SECRET_KEY='…'   # same Clerk instance as Dev API
OUT_DIR=/opt/cursor/artifacts/prod-voice-50-rerun \
  API_URL=https://serviceosapi-development.up.railway.app \
  node scripts/probe-operator-voice-50-live.mjs
```

Expected after Profile A/B on Railway: assistant/voice PASS ≫ 0 (target ≥40/50).

Config apply: `./scripts/apply-railway-ai-profile.sh a` (both envs) —  
`docs/runbooks/live-ai-restore.md`.
