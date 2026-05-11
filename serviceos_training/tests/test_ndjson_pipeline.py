"""Golden-style tests: synthetic Reddit-shaped dicts through the processor (no .zst files)."""

import importlib.util
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

_SPEC = importlib.util.spec_from_file_location(
    "reddit_processor_mod",
    _ROOT / "02_reddit_processor.py",
)
proc = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(proc)


def test_process_submission_synthetic():
    obj = {
        "id": "abc123",
        "name": "t3_abc123",
        "title": "Toilet keeps running all night",
        "selftext": "Won't stop filling the tank.",
        "subreddit": "Plumbing",
        "created_utc": 1_600_000_000.0,
        "permalink": "/r/Plumbing/comments/abc123/test/",
    }
    row = proc.process_submission(obj, english_only=False)
    assert row is not None
    assert row["source_id"] == "t3_abc123"
    assert row["source_type"] == "submission"
    assert row["source_subreddit"] == "Plumbing"
    assert row["triage_label"] in ("emergency", "urgent", "routine", "unknown")
    assert "https://reddit.com" in (row["reddit_permalink"] or "")


def test_process_submission_builds_id_without_name():
    obj = {
        "id": "xyz99",
        "title": "Slow drain in kitchen sink",
        "selftext": "",
        "subreddit": "HomeImprovement",
        "created_utc": 1_600_000_000.0,
    }
    row = proc.process_submission(obj, english_only=False)
    assert row is not None
    assert row["source_id"] == "t3_xyz99"


def test_process_comment_synthetic():
    obj = {
        "id": "def456",
        "name": "t1_def456",
        "body": "Replace the fill valve; that usually fixes a running toilet.",
        "link_id": "t3_abc123",
        "subreddit": "Plumbing",
        "score": 12,
        "author": "helper",
        "created_utc": 1_600_000_000.0,
    }
    row = proc.process_comment(obj, english_only=False, min_score=1)
    assert row is not None
    assert row["source_id"] == "t1_def456"
    assert row["source_type"] == "comment"


def test_process_comment_skips_automoderator():
    obj = {
        "id": "x",
        "name": "t1_x",
        "body": "Read the rules.",
        "link_id": "t3_y",
        "subreddit": "DIY",
        "author": "AutoModerator",
        "created_utc": 1_600_000_000.0,
    }
    assert proc.process_comment(obj, english_only=False, min_score=-999) is None


def test_record_kind_detection():
    sub = {"title": "x", "selftext": ""}
    assert proc.record_kind(sub) == "submission"
    com = {"body": "y", "link_id": "t3_z"}
    assert proc.record_kind(com) == "comment"
    assert proc.record_kind({}) is None
