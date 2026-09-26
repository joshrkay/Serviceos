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
  the cap. Exit codes: `1` gate fail, `2` no key, `3` over cost cap, `4` no
  baseline recorded (see below).
  The projection prices Haiku at the harness's pinned $3/$15 per MTok (about
  3x the current $1/$5 list rate), so a cap must be sized to its sample: the
  scheduled workflow sets it per step (intent N=200 → 1500c, slot N=100 →
  800c), and `ci-workflow-voice-eval-live.test.ts` fails if a configured sample
  ever projects over its cap (#839 — the old shared 500c cap sat below both).

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

## Baseline regression gate (#839)

Both runners take `--baseline <file>` (compare) and `--record-baseline <file>`
(write). A baseline (`baselines/*.json`, see `baseline.ts`) stores the metrics,
the golden set they were scored on (row count + order-independent fingerprint
of every row *and its label*), a `tolerance` (max absolute drop per metric) and
the one command that re-records it. Compare fails with:

- exit `1` — a metric dropped past `tolerance`, or the golden set changed
  since the baseline was recorded (re-record it in the same PR, so every
  corpus/taxonomy change ships with a reviewed baseline diff);
- exit `4` — the baseline is still an unrecorded `placeholder` (fails closed).

| File | Mode | Metrics | Tolerance | Enforced by |
|---|---|---|---|---|
| `intent-offline.json` | offline | accuracy, macroF1 | 0 (deterministic) | PR Checks `voice-eval-gate` + Deploy `voice-quality-gate` |
| `slot-offline.json` | offline | microF1 + per-slot F1 | 0 (deterministic) | same |
| `intent-live.json` | live, N=200 | accuracy, macroF1 | 0.05 | `voice-eval-live.yml` (weekly) |
| `slot-live.json` | live, N=100 | microF1 + per-slot F1 | 0.05 | same |

The offline baselines are recorded (free, deterministic). **The live baselines
are placeholders** — recording them needs a paid run against the production
model (~$3 + ~$1 real spend). Either run the `recordCommand` in each file
locally with a key and commit the result, or dispatch `voice-eval-live.yml`
with `record_baseline: true` and commit the `voice-eval-live-baselines`
artifact. Until then the weekly live run exits 4.

## Current offline numbers (2026-09-26)

- Intent: 74.3% accuracy / 77.6% macro-F1 on 635 held-out rows (rule baseline).
- Slot: 88.5% micro-F1 across 305 transcripts (heuristic baseline).

These are honest baseline numbers from non-ML rules/heuristics. The production
LLM model is expected to clear 92% / 0.88 in `--live` mode; those numbers are
measured by the live path (credential-gated) and are NOT claimed as achieved
from the offline baselines.
