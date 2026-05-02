# ServiceOS Training Pipeline

End-to-end pipeline that runs on the Mac mini, ingests the Pushshift Reddit
trade-subreddit dump, and lands a labeled, dialect-aware training corpus in
Supabase for the voice agent.

## Files

| File | Purpose |
| --- | --- |
| `00_setup.sh` | One-shot Mac mini bootstrap (venv + deps + data dirs + `.env`). |
| `01_schema.sql` | Supabase schema: `training_corpus`, `phrase_map`, `dialect_registry`, `synthetic_calls`, three read views. |
| `02_reddit_processor.py` | Streams `.zst` files, classifies + tags accents, bulk-upserts in batches of 250. |
| `requirements.txt` | Python deps installed by `00_setup.sh`. |

## Run order

1. **Schema** — open Supabase → SQL Editor → paste `01_schema.sql` → Run.
2. **Setup** — `chmod +x 00_setup.sh && ./00_setup.sh`, then fill in
   `~/serviceos_data/.env` (Supabase URL + service-role key).
3. **Torrents** — grab only these four files from
   `academictorrents.com/details/1614740ac8c94505e4ecb9d88be8bed7b6afddd4`
   and drop them into `~/serviceos_data/torrents/`:
   - `Plumbing_submissions.zst`
   - `HVAC_submissions.zst`
   - `HomeImprovement_submissions.zst`
   - `DIY_submissions.zst`
4. **Dry run** —
   `python3 02_reddit_processor.py --dry-run --max-records 2000`
   Inspect the printed triage / trade / accent / language distribution.
5. **Full run** — `python3 02_reddit_processor.py`
   Resumable via `~/serviceos_data/checkpoints/<file>.offset`.

## Verify in Supabase

```sql
select * from corpus_stats     limit 50;
select * from emergency_signals limit 20;
select * from review_queue      limit 20;
```

## Tunables (env, read by the processor)

| Var | Default | Notes |
| --- | --- | --- |
| `SERVICEOS_DATA_DIR` | `~/serviceos_data` | Root for torrents/checkpoints/logs/.env |
| `BATCH_SIZE` | `250` | Rows per Supabase upsert |
| `CHUNK_BYTES` | `1048576` | Streaming read-ahead window |
