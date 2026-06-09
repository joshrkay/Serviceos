"""Offline, dependency-free text vectorizer (char 3-gram TF) + cosine.

This is the OFFLINE FALLBACK used by embed_corpus.py / search_corpus.py when no
OPENAI_API_KEY is available. It is LEXICAL, not semantic — it catches surface
overlap, not deep meaning. The real semantic path uses OpenAI
text-embedding-3-small (1536-dim) and only runs when a key is present.

Mirrors scripts/data-pipeline/local-embed.ts so the TS and Python sides behave
the same offline.
"""
from __future__ import annotations

import math
import re
from collections import Counter

_NORM = re.compile(r"[^a-z0-9 ]+")
_WS = re.compile(r"\s+")


def _normalize(text: str) -> str:
    return _WS.sub(" ", _NORM.sub(" ", text.lower())).strip()


def vectorize(text: str, n: int = 3) -> Counter:
    t = f" {_normalize(text)} "
    grams = [t[i : i + n] for i in range(0, max(0, len(t) - n + 1))]
    return Counter(grams)


def cosine(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    small, large = (a, b) if len(a) < len(b) else (b, a)
    dot = sum(v * large.get(k, 0) for k, v in small.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)
