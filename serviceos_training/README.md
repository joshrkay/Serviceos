# ServiceOS — AI Training Corpus Pipeline

Builds a structured training corpus for the ServiceOS inbound AI agent by:

- Pulling homeowner problem descriptions from Reddit (Academic Torrents dump; no Reddit API)
- Classifying each post by triage level (emergency / urgent / routine / unknown)
- Tagging trade (plumbing / hvac / both), fixture, and trigger phrases
- Detecting accent and dialect **linguistic signals** (pattern tags for training—not demographic labels)
- Bulk-inserting into Supabase with **pgvector** for semantic search (embeddings filled in a later step)

## Quickstart (Mac Mini)

1. **Run setup** (installs deps, creates data dir, creates `~/.env` template):

   ```bash
   chmod +x 00_setup.sh && ./00_setup.sh
   ```

2. **Fill in credentials** in `~/serviceos_data/.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`).

3. **Apply the Supabase schema**: Dashboard → SQL Editor → paste `01_schema.sql` → Run.

4. **Download the torrent** (URL printed by setup). Select only the subreddit `.zst` files you need; save to `~/serviceos_data/`.

5. **Inspect the first record** in your dump (keys + submission vs comment) without processing the full corpus:

   ```bash
   cd serviceos_training
   python3 02_reddit_processor.py --validate-schema
   ```

6. **Dry run** (no DB inserts—validates parsing and classification):

   ```bash
   python3 02_reddit_processor.py --dry-run --max-records 2000
   ```

7. **Full run**:

   ```bash
   python3 02_reddit_processor.py
   ```

8. **Include comments** (optional, more data):

   ```bash
   python3 02_reddit_processor.py --comments
   ```

### PEP 668 (externally managed Python)

If `pip3 install` fails on Homebrew Python, use a venv:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install zstandard supabase python-dotenv openai tqdm langdetect pandas pyarrow
```

## File layout

| File | Purpose |
|------|---------|
| `00_setup.sh` | One-time Mac setup: pip deps, `~/serviceos_data`, `.env` template, torrent instructions |
| `01_schema.sql` | Supabase: `training_corpus`, pgvector, views |
| `02_reddit_processor.py` | Stream `.zst` NDJSON → classify → batch upsert |
| `corpus_classification.py` | Rule-based triage, trade, fixtures, accent signals (tested) |

## What gets captured per record

| Field | Example |
|-------|---------|
| `raw_text` | "My toilet keeps running all night, won't stop filling the tank" |
| `cleaned_text` | Same, markdown stripped |
| `triage_label` | `routine` |
| `trade` | `plumbing` |
| `fixture_tags` | `{toilet}` |
| `trigger_phrases` | `{running toilet,won't stop filling}` |
| `accent_signals` | `{}` |
| `is_layman` | `true` |
| `confidence_score` | `0.75` |
| `language` | `en` |

## Accent / dialect coverage (linguistic signals)

Patterns tag **wording**, not speaker identity. Useful so the voice model maps dialect variants to the same intent.

| Dialect | Example signals |
|---------|-----------------|
| Southern US | spicket, commode, y'all, warsh, wader |
| Philadelphia / NJ | wooder, spicket |
| Boston / New England | wattah, watah, heatah |
| AAVE | tore up, drippin, finna |
| Hispanic / Spanish | está goteando, el inodoro |
| Rural / colloquial | hot water tank, the unit, the valve, the main |

## Triage classification logic

- **EMERGENCY** — Active flooding, burst pipe, gas smell, CO alarm, sewer backup, no heat in freezing temps, cannot stop water flow, etc.
- **URGENT** — No hot water, only toilet blocked, wet drywall, sudden pressure loss everywhere, AC down in extreme heat, etc.
- **ROUTINE** — Dripping faucet, running toilet, slow single drain, low pressure at one fixture, noisy pipes, jammed disposal, etc.
- **UNKNOWN** — Insufficient signal from text alone (human review)

**Confidence:** More/better pattern matches → higher score (capped at 1.0). The `review_queue` view surfaces high-confidence rows still marked unreviewed.

## Supabase queries

```sql
-- Corpus breakdown
SELECT * FROM corpus_stats;

-- Emergency rows with dialect tags
SELECT source_subreddit, triage_label, accent_signals, trigger_phrases, cleaned_text
FROM training_corpus
WHERE triage_label = 'emergency'
  AND cardinality(accent_signals) > 0
LIMIT 50;

-- Review queue (high confidence, not yet reviewed)
SELECT * FROM review_queue LIMIT 100;

-- Fixture distribution
SELECT unnest(fixture_tags) AS fixture, COUNT(*) AS cnt
FROM training_corpus
GROUP BY fixture
ORDER BY cnt DESC;

-- Semantic similarity (after embeddings are populated)
SELECT id, cleaned_text, triage_label, trade
FROM training_corpus
WHERE embedding IS NOT NULL
ORDER BY embedding <=> '[...]'::vector
LIMIT 20;
```

## Data ethics & idempotency

- **Source:** Public Reddit archive via Academic Torrents; comply with their license and Reddit’s terms for your use case.
- **Logs:** The processor logs **counts and source_ids**, not full post bodies.
- **Idempotency:** Rows are **upserted** on `source_id` (stable Reddit fullname). Re-running the pipeline does not duplicate records.

## Next steps (out of scope here)

- YouTube transcripts processor
- Synthetic labeled calls (corpus + LLM)
- OpenAI `text-embedding-3-small` backfill for `embedding`
- Vapi / Retell RAG integration

## Tests

Use a venv and install runtime + dev deps (processor imports match `requirements.txt`):

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
python3 -m pytest tests/ -v
```
