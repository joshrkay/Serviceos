# Agent graph coverage + real-LLM path smoke

How we prove **hosted agents still work** on the critical product/safety paths —
beyond the mock Layer-1 voice-quality gate.

## Why two tools

| Tool | What it proves | Cost | When |
|------|----------------|------|------|
| **Graph coverage** (`agent:graph-coverage`) | Every required FSM path has a corpus script and/or path-smoke case | Free (offline) | Every PR |
| **Path smoke** (`agent:path-smoke`) | The **real model** classifies canonical utterances for those paths correctly | ~$0.50–1 | PR (if key) + daily + manual |

Layer-1 voice-quality remains the plumbing/FSM cassette gate. It does **not**
call a real LLM. Path smoke is the intentional thin real-model gate.

## Critical graph (summary)

Defined in `packages/api/src/ai/voice-quality/graph/paths.ts`:

| Path id | Kind | Real-LLM smoke? |
|---------|------|-----------------|
| `book` | product | yes |
| `quote` | product | yes |
| `lead_capture` | product | yes |
| `lookup` | product | yes |
| `spanish_book` | product | yes |
| `operator_request` | safety | yes |
| `emergency` | safety | yes |
| `negotiation` | safety | yes (with `extendedIntents`) |
| `complaint` | safety | yes (with `extendedIntents`) |
| `confidence_low` | safety | no (corpus) |
| `cost_cap` | structural | no |
| `hangup` | structural | no |
| `compliance_dnc` | safety | no (corpus) |

**Production note:** `negotiation` / `complaint` path-smoke cases set
`extendedIntents: true` so the classifier prompt includes those intents. Live
telephony currently only enables extended intents for **owner** sessions
(`twilio-adapter.ts`) — customer protection is still a wiring gap; smoke proves
the model side is ready.

## Commands

```bash
# Offline coverage report (markdown)
npm run agent:graph-coverage --workspace=packages/api -- --markdown

# Fail if any required path is uncovered
npm run agent:graph-coverage --workspace=packages/api -- --gate

# Real-LLM path smoke (needs ANTHROPIC_API_KEY or AI_PROVIDER_API_KEY)
npm run agent:path-smoke --workspace=packages/api -- --gate
```

### Env

| Variable | Default | Meaning |
|----------|---------|---------|
| `AGENT_PATH_SMOKE_COST_CAP_CENTS` | `100` | Abort before spend if projection exceeds |
| `AGENT_PATH_SMOKE_PASS_RATIO` | `0.8` | Fraction of cases that must pass |
| `AGENT_PATH_SMOKE_OUT` | — | Write JSON report path |
| `AGENT_GRAPH_COVERAGE_OUT` | — | Write JSON coverage path |
| `ANTHROPIC_API_KEY` / `AI_PROVIDER_API_KEY` | — | Required for path smoke |

### Exit codes (path smoke)

| Code | Meaning |
|------|---------|
| 0 | OK / gate passed |
| 1 | Gate failed (model regressions) |
| 2 | No API key |
| 3 | Cost cap would be exceeded |

## CI

- **PR:** `agent-graph-coverage` job in `pr-checks.yml` (offline, gated).
- **PR + daily:** `.github/workflows/agent-path-smoke.yml` runs real-LLM smoke
  when `ANTHROPIC_API_KEY` is present; skips with warning on forks.

## Adding a path

1. Add a row to `CRITICAL_PATHS` in `graph/paths.ts`.
2. If `pathSmokeRequired`, add a case to `path-smoke/cases.ts`.
3. Prefer a Layer-1 corpus script that hits the path (`scriptIdHints`).
4. Run `agent:graph-coverage --gate` and unit tests under
   `test/voice-quality/graph-coverage.test.ts`.
