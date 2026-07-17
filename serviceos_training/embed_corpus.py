#!/usr/bin/env python3
"""Embed the training corpus for semantic search.

Two modes:
  - LIVE  (OPENAI_API_KEY present): embed with text-embedding-3-small (1536-dim);
            intended to backfill training_corpus.embedding in Supabase.
  - OFFLINE (default in sandbox): embed sample_corpus.jsonl with the local
            char-ngram vectorizer and write sample_embeddings.json so the
            embed -> store -> search path runs end-to-end with no network.

Run (offline):  python3 serviceos_training/embed_corpus.py
Run (live):     OPENAI_API_KEY=... python3 serviceos_training/embed_corpus.py --live

The 50,000-row real ingest is a separate, credential-gated step (download the
Academic Torrents dump, run 02_reddit_processor.py, then this script with --live
to backfill embeddings). It cannot run in this sandbox (torrent + OpenAI host are
network-blocked and there is no DB).
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from local_embed import vectorize
import posthog_client as ph

HERE = Path(__file__).resolve().parent
SAMPLE = HERE / "sample_corpus.jsonl"
OUT = HERE / "sample_embeddings.json"

EMBEDDING_MODEL = "text-embedding-3-small"  # matches 01_schema.sql vector(1536)


def load_sample() -> list[dict]:
    with SAMPLE.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def embed_live(texts: list[str]) -> list[list[float]]:
    """Real embeddings via OpenAI. Only called with --live and a key present."""
    from openai import OpenAI  # lazy import; optional dependency

    client = OpenAI()
    resp = client.embeddings.create(model=EMBEDDING_MODEL, input=texts)
    return [d.embedding for d in resp.data]


def embed_offline(texts: list[str]) -> list[dict]:
    """Offline lexical vectors (char-ngram TF). Stored as sparse dicts."""
    return [dict(vectorize(t)) for t in texts]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Embed the training corpus")
    parser.add_argument("--live", action="store_true", help="Use OpenAI embeddings (requires OPENAI_API_KEY)")
    args = parser.parse_args(argv)

    rows = load_sample()
    texts = [r["text"] for r in rows]

    live = args.live and bool(os.environ.get("OPENAI_API_KEY"))
    if args.live and not os.environ.get("OPENAI_API_KEY"):
        print("⚠️  --live requested but OPENAI_API_KEY is not set; falling back to offline.")

    if live:
        vectors = embed_live(texts)
        payload = {"mode": "live", "model": EMBEDDING_MODEL,
                   "rows": [{**r, "embedding": v} for r, v in zip(rows, vectors)]}
    else:
        vectors = embed_offline(texts)
        payload = {"mode": "offline_lexical", "model": "char3gram-tf",
                   "rows": [{**r, "embedding": v} for r, v in zip(rows, vectors)]}

    OUT.write_text(json.dumps(payload), encoding="utf-8")
    print(f"Embedded {len(rows)} rows ({payload['mode']}) -> {OUT}")
    ph.capture("corpus_embedded", {
        "row_count": len(rows),
        "mode": payload["mode"],
        "model": payload["model"],
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
