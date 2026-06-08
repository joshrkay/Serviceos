# CORPUS MANIFEST

Every committed voice-corpus data file: source, count, license. Generated for
the voice corpus + comprehension-depth pass. All data is synthetic and
PII-free (verified by `pnpm test:pii-leakage`).

## Data files

| File | Rows | Lang | Source | License |
|------|-----:|------|--------|---------|
| `data/corpus/behaviors.yaml` | 35 behaviors | — | Hand-authored, aligned to `packages/shared/src/enums.ts` `ProposalType` + `VOICE_INBOUND_ASSISTANTS` | internal |
| `data/corpus/utterances.jsonl` | 1,820 | en | Deterministic expansion of `seeds/templates.en.json` | internal-synthetic |
| `data/corpus/utterances_es.jsonl` | 1,400 | es | Deterministic expansion of `seeds/templates.es.json` (native US-Latino phrasing + code-switch) | internal-synthetic |
| `data/corpus/edge_cases.jsonl` | 157 | en | Hand-authored phonetic/disfluent transcripts (`build-edge-negatives.ts`) | internal-synthetic |
| `data/corpus/negatives.jsonl` | 62 | en | Hand-authored non-intent scripts (`build-edge-negatives.ts`) | internal-synthetic |
| `data/corpus/slot_fixtures/address.jsonl` | 45 | en | Hand-authored (`build-slots.ts`) | internal-synthetic |
| `data/corpus/slot_fixtures/time.jsonl` | 44 | en | Hand-authored (`build-slots.ts`) | internal-synthetic |
| `data/corpus/slot_fixtures/phone.jsonl` | 44 | en | Hand-authored, `555` fictional blocks (`build-slots.ts`) | internal-synthetic |
| `data/corpus/slot_fixtures/service.jsonl` | 45 | en | Hand-authored against `corpus/data/vocabulary.json` lay terms | internal-synthetic |
| **Total labeled examples** | **3,617** | | | |

## Seed files (generator inputs)

| File | Purpose | License |
|------|---------|---------|
| `data/corpus/seeds/fillers.json` | Service / time / synthetic-persona / address filler banks | internal-synthetic |
| `data/corpus/seeds/templates.en.json` | English seed templates per intent | internal-synthetic |
| `data/corpus/seeds/templates.es.json` | Spanish + code-switch seed templates per intent | internal-synthetic |

## Pre-existing corpus (not modified by this pass)

| File | Purpose | Source |
|------|---------|--------|
| `corpus/data/vocabulary.json` | Lay→technical plumbing/HVAC vocabulary | ASSE/ASHRAE glossaries, r/Plumbing, r/HVAC (see file `_meta`) |
| `corpus/data/triage-rules.json` | Emergency tiers + trigger phrases | Internal triage policy |
| `serviceos_training/` | Reddit ingestion pipeline (Academic Torrents) | Public Reddit archive — see `serviceos_training/README.md` |
| `packages/api/src/ai/voice-quality/corpus/golden/*.json` | ~40 golden conversation fixtures driving the live agent eval | Internal |

## Pipeline & harness (code)

| Path | Role |
|------|------|
| `scripts/data-pipeline/generate-utterances.ts` | Deterministic utterance generator |
| `scripts/data-pipeline/build-edge-negatives.ts` | Edge + negative fixture builder |
| `scripts/data-pipeline/build-slots.ts` | Slot fixture builder |
| `scripts/data-pipeline/validate-corpus.ts` | Schema + floor validation (`test:corpus-schema`) |
| `scripts/data-pipeline/dedup.ts` | Exact/near duplicate detection (`test:dedup`) |
| `scripts/data-pipeline/pii-leakage.ts` | PII guard, HARD STOP (`test:pii-leakage`) |
| `scripts/eval/run_eval.py` | Eval orchestrator (`eval:full` / `:edge-cases` / `:negatives` / `:spanish`) |
| `scripts/eval/classifier.py` | Bilingual rule-based intent classifier + routing |
| `scripts/eval/slots.py` | Address/time/phone/service extractors |
| `scripts/eval/corpus_io.py` | IO, normalization, frozen split |

## Provenance & ethics

- No real Reddit user attribution; no scraped copyrighted text is committed here.
- All personas, phone numbers (`555` blocks), addresses, and names are fictional.
- Reproducibility: `pnpm corpus:build` regenerates byte-identical JSONL from seeds.
