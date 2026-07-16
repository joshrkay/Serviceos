#!/usr/bin/env python3
"""Semantic search over the embedded corpus.

Reads sample_embeddings.json (produced by embed_corpus.py) and returns the
top-k most similar corpus rows for a query. Works for both offline (sparse
char-ngram) and live (dense OpenAI) embeddings.

  python3 serviceos_training/search_corpus.py "no hot water"
  python3 serviceos_training/search_corpus.py --selftest   # 10 query fixtures

The --selftest gate corresponds to the goal's "semantic search returns relevant
results on 10 query fixtures". Offline it uses lexical vectors, so the fixtures
are lexically related to their target docs; the live path would use real
semantics. In a Supabase deployment this is the `embedding <=> query` / pgvector
search exposed via /api/corpus/search.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path

from local_embed import vectorize
import posthog_client as ph

HERE = Path(__file__).resolve().parent
EMB = HERE / "sample_embeddings.json"

# 10 query fixtures -> expected matching doc id (top-3).
QUERY_FIXTURES = [
    ("no hot water coming from the tap", "sample-001"),
    ("basement flooding from a burst pipe", "sample-002"),
    ("ac blowing warm air not cooling the house", "sample-003"),
    ("furnace no heat and it is freezing", "sample-004"),
    ("breaker keeps tripping in the garage", "sample-005"),
    ("i smell gas like rotten eggs", "sample-006"),
    ("kitchen sink clogged and backing up", "sample-007"),
    ("outlet sparking with a burning smell", "sample-009"),
    ("sump pump failed basement filling with water", "sample-010"),
    ("toilet keeps running the flapper is bad", "sample-011"),
]


def _cosine_dense(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _cosine_sparse(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    small, large = (a, b) if len(a) < len(b) else (b, a)
    dot = sum(v * large.get(k, 0) for k, v in small.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0


def load() -> dict:
    if not EMB.exists():
        from embed_corpus import main as build
        build([])
    return json.loads(EMB.read_text(encoding="utf-8"))


def search(query: str, k: int = 5):
    data = load()
    live = data["mode"] == "live"
    if live:
        from embed_corpus import embed_live
        qv = embed_live([query])[0]
        scored = [(_cosine_dense(qv, r["embedding"]), r) for r in data["rows"]]
    else:
        qv = vectorize(query)
        scored = [(_cosine_sparse(qv, Counter(r["embedding"])), r) for r in data["rows"]]
    scored.sort(key=lambda x: -x[0])
    return scored[:k]


def selftest() -> int:
    failures = 0
    for query, expected in QUERY_FIXTURES:
        top = search(query, k=3)
        ids = [r["id"] for _, r in top]
        ok = expected in ids
        if not ok:
            failures += 1
        print(f"  {'✅' if ok else '❌'} {query!r} -> {ids} (want {expected})")
    print(f"\nSemantic search self-test over {len(QUERY_FIXTURES)} queries: "
          f"{'PASS' if failures == 0 else f'FAIL ({failures})'}")
    ph.capture("semantic_search_selftest_completed", {
        "query_count": len(QUERY_FIXTURES),
        "failure_count": failures,
        "passed": failures == 0,
    })
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Search the embedded corpus")
    parser.add_argument("query", nargs="?", help="query text")
    parser.add_argument("--selftest", action="store_true", help="run the 10 query fixtures")
    parser.add_argument("-k", type=int, default=5, help="top-k results")
    args = parser.parse_args()

    if args.selftest:
        return selftest()
    if not args.query:
        print("usage: search_corpus.py <query> | --selftest", file=sys.stderr)
        return 2
    for score, row in search(args.query, args.k):
        print(f"  {score:.3f}  [{row['trade']}/{row['triage']}] {row['id']}: {row['text'][:90]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
