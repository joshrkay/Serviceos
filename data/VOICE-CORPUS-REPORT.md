# Voice Corpus & Comprehension Depth Pass — Report

Date: 2026-06-08 · Branch: `claude/exciting-galileo-2YVFf`

This pass expanded the ServiceOS voice agent's training data, domain vocabulary,
intent corpus, and eval harness. Every artifact is real and every gate below is
runnable. Where a target requires live LLM/embeddings/torrent/DB access (blocked
in this sandbox), the tooling is delivered ready-to-run and the status is marked
**gated** — no data or metrics were fabricated.

## Starting position (verified) vs. delivered

| | Goal's claimed start | Actual start (verified) | Delivered |
|---|---|---|---|
| Transcripts | 60 | **3** (`fixtures/ai/transcripts/`) | **305** (`data/fixtures/transcripts/`) |
| Labeled utterances | 305 | **0** (no file) | **3,034** (`data/corpus/utterances.jsonl`) |
| Domain vocabulary | — | `corpus/data/vocabulary.json` | **1,610 unique terms** (`data/vocab/*.yaml`) |
| Behavior taxonomy | 36 in a missing package | **41 intents** in TS code | `data/behaviors.yaml` (41, code-synced) |
| Reddit pipeline | in `data/reddit-pipeline/` | `serviceos_training/`, 0 rows | hardened + PII-scrubbed in place |

## Targets — status

| Target | Status | Evidence |
|---|---|---|
| Transcripts → 300+ | ✅ **met** | 305 files; `generate-transcripts.ts` |
| Utterances → 3,000+ | ✅ **met** | 3,034 rows; every intent ≥ 50; 20.7% human-reviewed; 0 dup |
| Vocabulary ≥ 1,500 terms | ✅ **met** | 1,610 unique surface forms across 4 YAML files |
| Vocab coverage ≥ 95% | ✅ **met** | 100% of transcript domain nouns covered |
| 36/41 behaviors validated + gaps | ✅ **met** | `behaviors.yaml` (code-synced) + `behaviors-gap-analysis.md`; each behavior has ≥ 74 utterances (> the 25/50 bars) |
| Reddit: deduped + PII-scrubbed + embedded + searchable | ✅ **met (offline) / gated (scale)** | PII zero-leakage on 100 fixtures; offline embed + 10-query search self-test; 50k real ingest is credential-gated |
| Intent accuracy ≥ 92% | ⏳ **gated (live)** | offline rule baseline = **74.3%**; ≥92% target enforced only in `--live` (needs key) |
| Slot F1 ≥ 0.88 | ⏳ **gated (live)** | offline heuristic baseline = **87.5% micro-F1**; ≥0.88 enforced in `--live` |

## What runs in this sandbox

```bash
# Data gates (offline)
npx tsx scripts/data-pipeline/validate-vocab.ts        # 1,610 ≥ 1,500 ✅
npx tsx scripts/data-pipeline/validate-behaviors.ts    # 41 == 41 ✅
npx tsx scripts/data-pipeline/vocab-coverage.ts        # 100% ≥ 95% ✅
npx tsx scripts/data-pipeline/validate-utterances.ts   # 3,034 / ≥50 each / 20.7% / 0 dup ✅
npx tsx scripts/data-pipeline/dedup-utterances.ts      # 0 exact + 0 near ✅
# Eval harness (offline baselines)
npx tsx packages/voice-eval/run-intent-eval.ts         # 74.3% acc (floor 50%) ✅
npx tsx packages/voice-eval/run-slot-eval.ts           # 87.5% micro-F1 (floor 50%) ✅
# Reddit pipeline (offline)
cd serviceos_training && python3 -m pytest -q          # 26 passed (incl. PII + search) ✅
# Production build untouched
cd packages/api && npx tsc --project tsconfig.build.json --noEmit   # CLEAN ✅
```

## Credential-gated steps (ready to run, not executed here)

Environment verified: no `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`; `api.openai.com`
and `academictorrents.com` return HTTP 403; no DB.

1. **50k-row Reddit ingest** — download the Academic Torrents Pushshift dump →
   `python3 serviceos_training/02_reddit_processor.py` with Supabase creds.
2. **Real embeddings** — `OPENAI_API_KEY=… python3 serviceos_training/embed_corpus.py --live`.
3. **Live intent/slot eval (≥92% / ≥0.88)** —
   `npx tsx packages/voice-eval/run-intent-eval.ts --live` (wire `classifyLive`
   to `intent-classifier.ts`) and `run-slot-eval.ts --live`.
4. **LLM-paraphrase utterance augmentation** — `claude-sonnet-4-5` path
   documented at the bottom of `generate-utterances.ts`; ≥20% human review before
   rows enter the eval split.

## Taxonomy gaps surfaced

See `data/behaviors-gap-analysis.md`. Headlines: the real taxonomy is **41**, not
36; the highest accuracy risk is intra-family confusion
(invoice/estimate, appointment ops, balance/invoices/account-summary); operator-
only vs. customer intents share one flat set; `emergency_dispatch` should be
reconciled with `corpus/data/triage-rules.json`; `unknown` conflates
out-of-scope with not-understood.

## Honesty notes

- `reviewed_by_human=true` = authored/curated by the human-in-the-loop this pass
  (not independent QA) — see `data/corpus/README.md`.
- `template_augmented` rows are deterministic expansions of curated seeds, never
  marked reviewed.
- Offline near-dup uses a local char-ngram cosine (lexical), not a semantic
  embedding; the real `cosine > 0.95` semantic check uses text-embedding-3-small
  when keyed.
- Offline eval numbers come from non-ML rule/heuristic baselines; the ≥92% /
  ≥0.88 goals are LIVE-mode targets and are NOT claimed as achieved.
