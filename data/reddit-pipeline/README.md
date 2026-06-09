# data/reddit-pipeline → serviceos_training

The goal references a Reddit pipeline at `data/reddit-pipeline/`. The actual,
working pipeline lives at the repo root in **`serviceos_training/`** (Python) and
**`corpus/scripts/`** (acquisition). This file documents that mapping so the
goal's path resolves; the code was hardened in place rather than relocated
(it has an existing pytest suite and cross-module imports).

## Where things are

| Goal concept | Actual location |
|---|---|
| Reddit acquisition (Academic Torrents / Pushshift) | `corpus/scripts/01_reddit_pushshift.py`, `corpus/scripts/00_collect.sh` |
| NDJSON `.zst` stream → classify → upsert | `serviceos_training/02_reddit_processor.py` |
| Rule-based classification (triage/trade/fixtures/accent) | `serviceos_training/corpus_classification.py` |
| **PII scrub (names/addresses/phones/emails)** | `serviceos_training/scrub_pii.py` (ported from `packages/api/src/ai/training/scrub.ts`) |
| Supabase schema + pgvector | `serviceos_training/01_schema.sql` (`training_corpus`, `vector(1536)`, HNSW) |
| Embedding step (+ offline fallback) | `serviceos_training/embed_corpus.py` |
| Semantic search | `serviceos_training/search_corpus.py` (offline) → pgvector `embedding <=>` in prod |
| Tests | `serviceos_training/tests/` (incl. `test_scrub_pii.py` — 100 fixtures, zero leakage) |

## What runs offline here vs. credential-gated

**Runs in this sandbox (no network/keys):**
- PII scrub zero-leakage test over 100 fixtures (`pytest tests/test_scrub_pii.py`).
- Offline embed + 10-query semantic search self-test
  (`embed_corpus.py` → `search_corpus.py --selftest`) over `sample_corpus.jsonl`.
- Full existing pipeline test suite (`pytest`).

**Credential-gated (cannot run here — verified blocked):**
- The **50,000-row real ingest**: download the Academic Torrents Pushshift dump
  (`academictorrents.com` → HTTP 403 here), then
  `python3 serviceos_training/02_reddit_processor.py` with `SUPABASE_URL` /
  `SUPABASE_SERVICE_KEY` set.
- Real embeddings: `OPENAI_API_KEY` + `embed_corpus.py --live`
  (`api.openai.com` → HTTP 403 here).
- pgvector semantic search at scale: requires a populated Supabase
  `training_corpus` table.

## PII guarantee

`02_reddit_processor.py` now scrubs `cleaned_text` and `raw_text` via
`scrub_pii.scrub_pii()` before persistence and **drops any row whose post-scrub
residual gate still trips** — so no phone/email/address PII reaches the corpus.
Names are redacted when supplied as known entities and via the all-caps
heuristic; free-form name redaction is best-effort (documented limitation).
