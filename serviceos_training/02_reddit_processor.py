#!/usr/bin/env python3
"""
Stream Reddit NDJSON from .zst archives, classify, batch upsert into Supabase training_corpus.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import zstandard as zstd
from dotenv import load_dotenv
from tqdm import tqdm

# langdetect is optional: when absent, language is reported as "unknown" so the
# module stays importable for offline parse/classify/scrub testing.
try:
    from langdetect import LangDetectException, detect
except Exception:  # pragma: no cover - optional dependency
    class LangDetectException(Exception):
        pass

    def detect(_text: str) -> str:  # type: ignore[misc]
        raise LangDetectException("langdetect not installed")

# `supabase` is imported lazily inside get_supabase() — it is only needed for the
# actual DB upsert, not for parsing/classification/scrubbing. `Client` appears
# only in annotations (PEP 563 via `from __future__ import annotations`), so it
# is never evaluated at runtime and needs no module-level import.
from corpus_classification import classify_record, clean_for_corpus
from scrub_pii import scrub_pii

if False:  # type-checking only; never executed
    from supabase import Client  # noqa: F401

DEFAULT_BATCH_SIZE = 400
MIN_TEXT_LEN = 15


def load_env() -> None:
    env_path = Path.home() / "serviceos_data" / ".env"
    if env_path.is_file():
        load_dotenv(env_path)
    load_dotenv()


def get_supabase() -> "Client":
    from supabase import create_client  # lazy: only needed for DB writes

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key or "YOUR_PROJECT" in url:
        print(
            "Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in ~/serviceos_data/.env",
            file=sys.stderr,
        )
        sys.exit(1)
    return create_client(url, key)


def detect_language(text: str) -> str:
    sample = text[:500] if text else ""
    if len(sample) < 20:
        return "unknown"
    try:
        return detect(sample)
    except LangDetectException:
        return "unknown"


def get_subreddit_name(obj: dict[str, Any]) -> str:
    s = obj.get("subreddit")
    if isinstance(s, str):
        return s
    if isinstance(s, dict):
        return str(s.get("display_name") or s.get("name") or "")
    return ""


def parse_created_utc(obj: dict[str, Any]) -> str | None:
    cu = obj.get("created_utc")
    if cu is None:
        return None
    try:
        ts = float(cu)
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def submission_text(obj: dict[str, Any]) -> str:
    title = (obj.get("title") or "").strip()
    body = (obj.get("selftext") or "").strip()
    if title and body:
        return f"{title}\n\n{body}"
    return title or body


def build_source_id(kind: str, obj: dict[str, Any]) -> str | None:
    name = obj.get("name")
    if isinstance(name, str) and name.startswith(("t1_", "t3_", "t6_")):
        return name
    rid = obj.get("id")
    if not isinstance(rid, str) or not rid:
        return None
    prefix = "t3_" if kind == "submission" else "t1_"
    if rid.startswith(prefix):
        return rid
    return f"{prefix}{rid}"


def iter_zst_json_lines(path: Path) -> Iterator[dict[str, Any]]:
    dctx = zstd.ZstdDecompressor(max_window_size=2**31)
    with path.open("rb") as fh:
        reader = dctx.stream_reader(fh)
        text_io = io.TextIOWrapper(reader, encoding="utf-8", errors="replace")
        for line in text_io:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def classify_row(
    *,
    source_id: str,
    source_type: str,
    subreddit: str,
    permalink: str | None,
    created_iso: str | None,
    raw_text: str,
    cleaned: str,
    english_only: bool,
) -> dict[str, Any] | None:
    if len(cleaned) < MIN_TEXT_LEN:
        return None
    lang = detect_language(cleaned)
    if english_only and lang not in ("en", "unknown"):
        return None

    # Classify on the original cleaned text (rule-based; unaffected by PII), but
    # PERSIST only PII-scrubbed text. Drop the row entirely if any residual PII
    # signal remains after scrubbing, so nothing leaks into the corpus.
    cls = classify_record(cleaned_text=cleaned, subreddit=subreddit)
    scrub = scrub_pii(cleaned)
    if scrub.has_residual_pii:
        return None
    cleaned_scrubbed = scrub.scrubbed
    raw_scrubbed = scrub_pii(raw_text).scrubbed
    row: dict[str, Any] = {
        "source_id": source_id,
        "source_type": source_type,
        "source_subreddit": subreddit or None,
        "reddit_permalink": permalink,
        "created_utc": created_iso,
        "raw_text": raw_scrubbed[:50000],
        "cleaned_text": cleaned_scrubbed[:50000],
        "language": lang,
        "triage_label": cls["triage_label"],
        "trade": cls["trade"],
        "fixture_tags": cls["fixture_tags"],
        "trigger_phrases": cls["trigger_phrases"],
        "accent_signals": cls["accent_signals"],
        "is_layman": cls["is_layman"],
        "confidence_score": cls["confidence_score"],
        "reviewed": False,
    }
    return row


def process_submission(obj: dict[str, Any], english_only: bool) -> dict[str, Any] | None:
    raw = submission_text(obj)
    if not raw or raw in ("[removed]", "[deleted]"):
        return None
    sid = build_source_id("submission", obj)
    if not sid:
        return None
    sub = get_subreddit_name(obj)
    cleaned = clean_for_corpus(raw)
    permalink = obj.get("permalink")
    if isinstance(permalink, str) and not permalink.startswith("http"):
        permalink = f"https://reddit.com{permalink}"
    return classify_row(
        source_id=sid,
        source_type="submission",
        subreddit=sub,
        permalink=permalink if isinstance(permalink, str) else None,
        created_iso=parse_created_utc(obj),
        raw_text=raw,
        cleaned=cleaned,
        english_only=english_only,
    )


def process_comment(obj: dict[str, Any], english_only: bool, min_score: int) -> dict[str, Any] | None:
    score = obj.get("score")
    if isinstance(score, int) and score < min_score:
        return None
    body = (obj.get("body") or "").strip()
    if not body or body in ("[removed]", "[deleted]"):
        return None
    author = (obj.get("author") or "").lower()
    if author in ("automoderator", "[deleted]"):
        return None
    sid = build_source_id("comment", obj)
    if not sid:
        return None
    sub = get_subreddit_name(obj)
    cleaned = clean_for_corpus(body)
    return classify_row(
        source_id=sid,
        source_type="comment",
        subreddit=sub,
        permalink=None,
        created_iso=parse_created_utc(obj),
        raw_text=body,
        cleaned=cleaned,
        english_only=english_only,
    )


def record_kind(obj: dict[str, Any]) -> str | None:
    if "selftext" in obj and "title" in obj:
        return "submission"
    if "body" in obj and "link_id" in obj:
        return "comment"
    return None


def flush_batch(client: Client, batch: list[dict[str, Any]], dry_run: bool) -> None:
    if not batch:
        return
    if dry_run:
        return
    client.table("training_corpus").upsert(batch, on_conflict="source_id").execute()


def gather_zst_files(data_dir: Path, include_comments: bool) -> list[Path]:
    files = sorted(data_dir.glob("*.zst"))
    out: list[Path] = []
    for p in files:
        name = p.name.lower()
        if "submission" in name or "submissions" in name:
            out.append(p)
        elif include_comments and "comment" in name:
            out.append(p)
    return out


def run_validate_schema(data_dir: Path, include_comments: bool) -> int:
    """Read the first JSON object from the first matching .zst; print keys and inferred kind."""
    zst_files = gather_zst_files(data_dir, include_comments)
    if not zst_files:
        print(f"No matching .zst files under {data_dir}", file=sys.stderr)
        return 1
    path = zst_files[0]
    first: dict[str, Any] | None = None
    for obj in iter_zst_json_lines(path):
        if isinstance(obj, dict):
            first = obj
            break
    if not first:
        print(f"No JSON object decoded from {path.name}", file=sys.stderr)
        return 1
    kind = record_kind(first)
    keys = sorted(first.keys())
    preview = keys[:50]
    more = len(keys) - len(preview)
    print(f"Schema check — file: {path}")
    print(f"First record key count: {len(keys)}")
    print(f"Keys (first 50): {preview}{' …' if more > 0 else ''}")
    print(f"Inferred record_kind: {kind}")
    if kind == "submission":
        t = first.get("title")
        print(f"title (preview): {str(t)[:120]!r}")
    elif kind == "comment":
        b = first.get("body")
        print(f"body (preview): {str(b)[:120]!r}")
    else:
        print(
            "Could not infer submission vs comment (expected title+selftext or body+link_id). "
            "Adjust record_kind() if your dump uses different field names.",
            file=sys.stderr,
        )
        return 2
    return 0


def run() -> int:
    parser = argparse.ArgumentParser(description="Reddit training corpus processor")
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=None,
        help="Directory with .zst files (default: DATA_DIR env or ~/serviceos_data)",
    )
    parser.add_argument(
        "--validate-schema",
        action="store_true",
        help="Parse first record from first .zst, print keys and record kind, then exit (no DB)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Parse and classify only; no DB writes")
    parser.add_argument("--max-records", type=int, default=0, help="Stop after N accepted rows (0 = no limit)")
    parser.add_argument("--comments", action="store_true", help="Include *_comments*.zst files")
    parser.add_argument("--english-only", action="store_true", help="Skip non-English rows")
    parser.add_argument("--min-score", type=int, default=-999, help="Minimum Reddit score for comments")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    args = parser.parse_args()

    load_env()
    data_dir = args.data_dir or Path(os.environ.get("DATA_DIR", str(Path.home() / "serviceos_data")))
    if not data_dir.is_dir():
        print(f"Data directory not found: {data_dir}", file=sys.stderr)
        return 1

    if args.validate_schema:
        return run_validate_schema(data_dir, args.comments)

    zst_files = gather_zst_files(data_dir, args.comments)
    if not zst_files:
        print(f"No matching .zst files under {data_dir}", file=sys.stderr)
        return 1

    client: Client | None = None
    if not args.dry_run:
        client = get_supabase()

    stats: Counter[str] = Counter()
    samples: list[dict[str, Any]] = []
    batch: list[dict[str, Any]] = []
    accepted = 0

    for zpath in zst_files:
        for obj in tqdm(iter_zst_json_lines(zpath), desc=zpath.name, unit="ln"):
            kind = record_kind(obj)
            row: dict[str, Any] | None = None
            if kind == "submission":
                row = process_submission(obj, args.english_only)
            elif kind == "comment" and args.comments:
                row = process_comment(obj, args.english_only, args.min_score)
            elif kind == "comment" and not args.comments:
                continue

            if row is None:
                continue

            stats[row["triage_label"]] += 1
            accepted += 1
            if len(samples) < 5:
                samples.append(
                    {
                        "triage": row["triage_label"],
                        "trade": row["trade"],
                        "sub": row["source_subreddit"],
                        "snippet": (row["cleaned_text"][:120] + "…")
                        if len(row["cleaned_text"]) > 120
                        else row["cleaned_text"],
                    }
                )

            batch.append(row)
            if len(batch) >= args.batch_size:
                flush_batch(client, batch, args.dry_run)
                batch.clear()

            if args.max_records and accepted >= args.max_records:
                break
        if args.max_records and accepted >= args.max_records:
            break

    flush_batch(client, batch, args.dry_run)

    print("── Triage distribution ──")
    for k, v in sorted(stats.items(), key=lambda x: -x[1]):
        print(f"  {k}: {v}")
    print(f"Total accepted rows: {accepted}")
    if samples:
        print("── Sample rows ──")
        for s in samples:
            print(s)

    if args.dry_run:
        print("(dry-run: no database writes)")

    return 0


if __name__ == "__main__":
    raise SystemExit(run())
