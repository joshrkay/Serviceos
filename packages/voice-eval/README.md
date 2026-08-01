# @serviceos/voice-eval

Runnable eval harness for the ServiceOS voice agent. **Not** a workspace member
(it is intentionally excluded from the root `workspaces` array and the
`packages/api` build); run it directly with `npx tsx`.

## What it measures

| Runner | Metric | Gold source | LIVE target |
|---|---|---|---|
| `run-intent-eval.ts` | intent accuracy + macro-F1 + confusion matrix | `data/corpus/utterances.jsonl` (held-out 20% by stable hash) | **≥ 92%** |
| `run-slot-eval.ts` | per-slot precision/recall/F1 + micro-F1 | `data/fixtures/transcripts/*.json` `expected_entities` | **≥ 0.88** |

Critical slots: `name, address, service_type, time_window, problem_description`.

## Two modes

- **OFFLINE (default)** — deterministic baselines (`baseline-classifier.ts`,
  `slot-extractor.ts`). No network, no keys, always runs in CI. Reports the real
  numbers and enforces only a low regression floor (50%) unless `--gate`.
- **LIVE (`--live`)** — **wired, credential-gated.** Routes the held-out split
  through the **production** classifier (`classifyIntent`, fast-path + LLM
  fallback together) behind the Layer-2 real gateway
  (`createRealLayerTwoGateway`, Anthropic via the OpenAI-compat endpoint).
  Requires `ANTHROPIC_API_KEY` (or `AI_PROVIDER_API_KEY`). With `--gate`,
  enforces the goal thresholds (intent ≥ 92%, slot micro-F1 ≥ 0.88); without it,
  report-only. When no key is present it **fails fast (exit 2)** with a clear
  message — it never silently falls back to offline.

### Live design notes

- **Synthetic tenant.** The classifier never touches the DB/RLS; live eval uses
  the shared `system` tenant so the gateway's tenant override pins the model.
- **Fast-path metric.** Live measures production behavior end to end and reports
  the **fast-path hit rate** — the fraction of utterances resolved by a
  deterministic short-circuit (empty transcript / opted-in phrase match) with no
  LLM call, detected by the absence of `tokenUsage` on the result.
- **Slot path.** Live slot eval runs `classifyIntent` then projects entities via
  the production `extractLaunchSlots`. It measures the **four LLM-derived slots**
  (`name`, `address`, `time_window`, `problem_description`). `service_type` is
  **excluded**: the classifier does not emit it — `extractLaunchSlots` sources it
  from the tenant vertical pack (and phone from caller-ID), so gating the LLM on
  it would be neither fair nor achievable.
- **Cost controls.** `--max-utterances N` takes a deterministic (stable-hash)
  sub-sample so runs are comparable. `VOICE_EVAL_COST_CAP_CENTS` (default 500 =
  $5, per script) caps spend: each run projects cost conservatively (no cache
  discount) and **aborts (exit 3) before spending** if the projection exceeds
  the cap. Exit codes: `1` gate fail, `2` no key, `3` over cost cap.

## Run

```bash
npx tsx packages/voice-eval/run-intent-eval.ts                              # offline, report
npx tsx packages/voice-eval/run-intent-eval.ts --gate                       # offline, enforce floor
npx tsx packages/voice-eval/run-intent-eval.ts --live                       # production model (needs key)
npx tsx packages/voice-eval/run-intent-eval.ts --live --gate --max-utterances 200
npx tsx packages/voice-eval/run-slot-eval.ts --live --gate --max-utterances 100
```

The scheduled CI surface is `.github/workflows/voice-eval-live.yml`
(weekly cron + `workflow_dispatch`, cost-capped, not PR-blocking).

## Current offline baseline (this pass)

- Intent: ~62% accuracy / ~57% macro-F1 on the held-out rows (rule baseline).
- Slot: ~87.5% micro-F1 across 305 transcripts (heuristic baseline).

These are honest baseline numbers from non-ML rules/heuristics. The production
LLM model is expected to clear 92% / 0.88 in `--live` mode; those numbers are
measured by the live path (credential-gated) and are NOT claimed as achieved
from the offline baselines.
