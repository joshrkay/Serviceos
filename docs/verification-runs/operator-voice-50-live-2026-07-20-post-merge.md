# Operator Voice Top-50 — Live Re-run

**When:** 2026-07-20T23:14:50.970Z → 2026-07-20T23:16:39.284Z  
**Host:** https://serviceosapi-development.up.railway.app  
**Cases:** same 50 utterances as 2026-07-20 probe

## Scoreboard

| Surface | PASS | PARTIAL | DEGRADED | FAIL | BLOCKED |
|---------|-----:|--------:|---------:|-----:|--------:|
| Assistant chat | 10 | 38 | 2 | 0 | 0 |
| In-app voice | 0 | 4 | 46 | 0 | 0 |

**Assistant AI path:** **10/50** PASS  
**Voice AI path:** **0/50** PASS  

Prior run (2026-07-20): 0/50 assistant, 0/50 voice (all DEGRADED).

Raw: `/opt/cursor/artifacts/prod-voice-50-post-merge-v2/results.json`

## Context

PR #714 merged and Deploy workflow completed (`deploy-railway-dev` + `deploy-railway-prod`).

### AI provider (the original 0/50 blocker)

| Host | `/api/health/ai` | `/api/health/ai/completion` |
|------|------------------|-------------------------------|
| Development | `api.openai.com` closed | `ok: true`, `gpt-4o-mini` |
| production | `api.openai.com` closed + `lastSuccessAt` | `ok: true`, `gpt-4o-mini` |

Morning probe was **50/50 DEGRADED** (`error-envelope`). After merge: **48/50 assistant turns are non-envelope**; **10/50** created a proposal card (`PASS`). Inbox shows proposals (`GET /api/proposals` total=13 during this run).

### Voice

Still weak on this surface (mostly `intent_capture` reprompt). Separate from the OpenAI/Claude host mismatch — completions work; in-app voice classify/confirm path needs follow-up.

### Honest comparison

| Run | Assistant PASS | Assistant DEGRADED | Voice PASS |
|-----|---------------:|-------------------:|-----------:|
| Morning (pre-fix) | 0 | 50 | 0 |
| Post-merge (this) | **10** | **2** | 0 |

Target from plan (≥40/50 PASS) not met yet, but the **provider choke point is cleared**.
