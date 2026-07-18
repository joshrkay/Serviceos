"""Shared IO + text normalization for the ServiceOS voice-corpus eval harness.

Pure stdlib — no third-party deps — so `pnpm eval:full` runs in any
environment that has Python 3.9+.
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from typing import Any, Iterator

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CORPUS_DIR = os.path.join(REPO_ROOT, "data", "corpus")
SLOT_DIR = os.path.join(CORPUS_DIR, "slot_fixtures")
EVAL_RESULTS_DIR = os.path.join(REPO_ROOT, "eval-results")


def load_jsonl(path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def iter_jsonl(path: str) -> Iterator[dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def normalize(text: str) -> str:
    """Lowercase, strip accents, join contractions, drop punctuation, collapse ws.

    Apostrophes are deleted (not spaced) so contractions join — "what's" ->
    "whats", "don't" -> "dont" — which is what the lexical patterns key on.
    """
    t = strip_accents(text.lower())
    t = t.replace("'", "").replace("’", "")
    t = re.sub(r"[^a-z0-9 ]", " ", t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


def fnv1a(s: str) -> int:
    """32-bit FNV-1a — matches scripts/data-pipeline/lib.ts for stable splits."""
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def split_of(row_id: str, holdout_ratio: int = 5) -> str:
    """Deterministic, frozen train/test split keyed on row id.

    20% holdout when holdout_ratio == 5. Never changes for a given id, so the
    test set stays frozen across corpus revisions (regression-safe).
    """
    return "test" if fnv1a(row_id) % holdout_ratio == 0 else "train"


def require_id(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fail loudly if any row is missing 'id', instead of letting split_of
    raise a bare KeyError deep inside a loop somewhere downstream.

    Defensive hardening only: after the T6-F01 corpus migration every row in
    data/corpus/utterances.jsonl has a stable id (canonical or
    legacy-<sha1>). This guard exists so a future regression (a new row
    landing without one) produces a clear, actionable error message instead
    of a cryptic KeyError stack trace.
    """
    for row in rows:
        if "id" not in row:
            raise ValueError(f"row missing 'id': {row}")
    return rows
