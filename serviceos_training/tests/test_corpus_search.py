"""Wraps the embed + 10-query search self-test into the pytest suite."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def test_embed_and_search_selftest():
    import embed_corpus
    import search_corpus

    embed_corpus.main([])  # offline embed of sample_corpus.jsonl
    assert search_corpus.selftest() == 0, "10-query semantic search self-test failed"
