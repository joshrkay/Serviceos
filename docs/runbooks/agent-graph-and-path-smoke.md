# Agent graph coverage + real-LLM path smoke

How we prove **hosted agents still work** on the critical product/safety paths —
beyond the mock Layer-1 voice-quality gate.

## Why two tools

| Tool | What it proves | Cost | When |
|------|----------------|------|------|
| **Graph coverage** (`agent:graph-coverage`) | Every required FSM path has a corpus script and/or path-smoke case | Free (offline) | Every PR |
| **Path smoke** (`agent:path-smoke`) | The **real model** classifies canonical utterances for those paths correctly | ~$0.50–1 | PR touching a prompt or routing file + daily + manual |
| **Live intent + slot evals** (`run-intent-eval.ts --live`, `run-slot-eval.ts --live`) | The **real model** still meets the recorded live baselines (`packages/voice-eval/baselines/*-live.json`) | ~$1 | Same PR job (OBS-3) + weekly `voice-eval-live.yml` |

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
- **PR + daily:** `.github/workflows/agent-path-smoke.yml` runs the real-LLM
  smoke and the live intent + slot evals against the recorded live baselines
  with the production provider config (`secrets.OPENAI_API_KEY`); a missing
  key fails the job, it never skips. The workflow runs on **every** pull
  request; its `changes` job diffs the PR (the checked-out merge commit
  against its base parent) against the `PATH_SMOKE_PATHS` list — every file
  that defines a system prompt or routes a model (`packages/api/src/ai/**`,
  `reputation/**`, `verticals/**` (the trade sections of the caller system
  prompt), `workers/transcription.ts`, `workers/supervisor-review-worker.ts`,
  `workers/verify-ai.ts`, `proposals/edit-interpreter.ts`,
  `routes/assistant.ts`, `digest/weekly-feedback.ts`, `config/ai-routing.ts`,
  `packages/voice-eval/**` and the workflow file itself). Add a new
  prompt-defining file to that list; `test/voice-quality/ci-workflow-path-smoke.test.ts`
  fails when a file under `packages/api/src` defines a system prompt or calls
  the model outside it (wiring-only files such as `app.ts` are listed in that
  test with the reason), and executes the `changes` step against a real
  merge commit.
- **One check run per PR:** when no listed file changed, `path-smoke` is
  skipped by its job-level `if:`, and GitHub reports a job skipped by a
  conditional as success — so `path-smoke` can be a required status check
  without stalling unrelated PRs. There is exactly one `path-smoke` check run
  per PR (the old same-named skip-pass shim workflow is gone: on a mixed PR it
  reported green within seconds while the real run was still going). The
  `if:` fails closed: if `changes` fails or cannot diff, the real evals run.
- **Baseline drift:** the live steps exit 1 when the golden set changed or a
  metric fell past tolerance. Re-record with the baseline file's
  `recordCommand` (or `voice-eval-live.yml` with `record_baseline=true`) in
  the same PR that changes the prompt, and justify the new numbers in the PR.

## Adding a path

1. Add a row to `CRITICAL_PATHS` in `graph/paths.ts`.
2. If `pathSmokeRequired`, add a case to `path-smoke/cases.ts`.
3. Prefer a Layer-1 corpus script that hits the path (`scriptIdHints`).
4. Run `agent:graph-coverage --gate` and unit tests under
   `test/voice-quality/graph-coverage.test.ts`.
