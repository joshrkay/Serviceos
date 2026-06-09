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
- **LIVE (`--live`)** — routes through the production classifier/extractor via
  the LLM gateway. Requires `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`. Enforces the
  goal thresholds (92% / 0.88). Not runnable in the offline sandbox; the wiring
  point is marked in `run-intent-eval.ts` (`classifyLive`).

## Run

```bash
npx tsx packages/voice-eval/run-intent-eval.ts          # offline, report
npx tsx packages/voice-eval/run-intent-eval.ts --gate   # offline, enforce floor
npx tsx packages/voice-eval/run-intent-eval.ts --live   # production model (needs key)
npx tsx packages/voice-eval/run-slot-eval.ts
```

## Current offline baseline (this pass)

- Intent: ~74% accuracy / ~78% macro-F1 on 634 held-out rows (rule baseline).
- Slot: ~87.5% micro-F1 across 305 transcripts (heuristic baseline).

These are honest baseline numbers from non-ML rules/heuristics. The production
LLM model is expected to clear 92% / 0.88 in `--live` mode; those numbers are NOT
reported as achieved here because the live path cannot run without a key.
