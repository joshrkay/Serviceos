#!/usr/bin/env python3
"""
Step 1: Reddit / Pushshift corpus collector.

Downloads r/Plumbing, r/HVAC, r/HomeImprovement, and r/DIY post+comment
dumps from the Academic Torrents Pushshift mirror (2005–2024) and
extracts relevant threads into JSONL for training.

Source: https://academictorrents.com/details/1614740ac8c94505e4ecb9d88be8bed7b6afddd4
Kaggle mirror: https://www.kaggle.com/datasets/i221113hadiyatanveer/the-pushshift-reddit-dataset-submissions

OUTPUT
------
output/reddit/
  {subreddit}_posts.jsonl      — one post per line: {id, title, selftext, score, url}
  {subreddit}_comments.jsonl   — one comment per line: {id, parent_id, body, score}
  {subreddit}_pairs.jsonl      — question+top-answer pairs for supervised training

USAGE
-----
  python3 01_reddit_pushshift.py --subreddits plumbing hvac homeimprovement diy
  python3 01_reddit_pushshift.py --from-local /path/to/RS_2024-01.zst
"""

import argparse
import json
import os
import sys
from pathlib import Path

try:
    import zstandard as zstd
except ImportError:
    print("Install dependencies first: pip install -r requirements.txt")
    sys.exit(1)

import posthog_client as ph

TARGET_SUBREDDITS = {"plumbing", "hvac", "homeimprovement", "diy"}

# Keywords that signal a plumbing or HVAC post — used to filter r/homeimprovement
RELEVANCE_KEYWORDS = {
    "plumb", "pipe", "drain", "leak", "faucet", "toilet", "shower", "bathtub",
    "water heater", "hvac", "furnace", "ac", "air condition", "heat pump",
    "duct", "thermostat", "refrigerant", "no heat", "no cool", "p-trap",
    "sewer", "septic", "water pressure", "hot water", "cold water", "disposal",
    "garbage disposal", "dishwasher drain", "washing machine drain", "standpipe",
    "wax ring", "flapper", "fill valve", "angle stop", "shut off valve",
    "condensate", "evaporator", "condenser", "compressor", "capacitor",
    "contactor", "blower", "inducer", "igniter", "flame sensor", "heat exchanger",
}

OUTPUT_DIR = Path(__file__).parent.parent / "output" / "reddit"


def is_relevant(text: str) -> bool:
    text_lower = text.lower()
    return any(kw in text_lower for kw in RELEVANCE_KEYWORDS)


def process_zst_dump(file_path: str, subreddit_filter: set[str], record_type: str, out_dir: Path):
    """Stream a zstandard-compressed NDJSON Pushshift dump and extract relevant records."""
    writers: dict[str, object] = {}

    def get_writer(subreddit: str):
        if subreddit not in writers:
            out_file = out_dir / f"{subreddit}_{record_type}.jsonl"
            writers[subreddit] = open(out_file, "a", encoding="utf-8")
        return writers[subreddit]

    dctx = zstd.ZstdDecompressor(max_window_size=2**31)
    count = 0
    kept = 0

    with open(file_path, "rb") as fh:
        with dctx.stream_reader(fh) as reader:
            buffer = b""
            while True:
                chunk = reader.read(2**20)  # 1 MB chunks
                if not chunk:
                    break
                buffer += chunk
                lines = buffer.split(b"\n")
                buffer = lines[-1]
                for line in lines[:-1]:
                    if not line.strip():
                        continue
                    count += 1
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    sub = record.get("subreddit", "").lower()
                    if sub not in subreddit_filter:
                        continue

                    if record_type == "posts":
                        text = f"{record.get('title', '')} {record.get('selftext', '')}"
                        if sub in {"plumbing", "hvac"} or is_relevant(text):
                            out = {
                                "id": record.get("id"),
                                "subreddit": sub,
                                "title": record.get("title"),
                                "selftext": record.get("selftext"),
                                "score": record.get("score"),
                                "url": record.get("url"),
                                "created_utc": record.get("created_utc"),
                            }
                            get_writer(sub).write(json.dumps(out) + "\n")
                            kept += 1
                    elif record_type == "comments":
                        body = record.get("body", "")
                        if sub in {"plumbing", "hvac"} or is_relevant(body):
                            out = {
                                "id": record.get("id"),
                                "subreddit": sub,
                                "parent_id": record.get("parent_id"),
                                "link_id": record.get("link_id"),
                                "body": body,
                                "score": record.get("score"),
                                "author_flair": record.get("author_flair_text"),
                                "created_utc": record.get("created_utc"),
                            }
                            get_writer(sub).write(json.dumps(out) + "\n")
                            kept += 1

                    if count % 500_000 == 0:
                        print(f"  Processed {count:,} records, kept {kept:,}...")

    for f in writers.values():
        f.close()

    print(f"Done. Processed {count:,} records total, kept {kept:,}.")


def build_pairs(subreddit: str, out_dir: Path, min_answer_score: int = 5):
    """Join posts + comments to create question→answer pairs for supervised training."""
    posts_file = out_dir / f"{subreddit}_posts.jsonl"
    comments_file = out_dir / f"{subreddit}_comments.jsonl"
    pairs_file = out_dir / f"{subreddit}_pairs.jsonl"

    if not posts_file.exists() or not comments_file.exists():
        print(f"  Skipping pair-building for {subreddit} — missing posts or comments file")
        return

    posts: dict[str, dict] = {}
    with open(posts_file, encoding="utf-8") as f:
        for line in f:
            record = json.loads(line)
            posts[f"t3_{record['id']}"] = record

    pair_count = 0
    with open(comments_file, encoding="utf-8") as f, open(pairs_file, "w", encoding="utf-8") as out:
        for line in f:
            comment = json.loads(line)
            if comment.get("score", 0) < min_answer_score:
                continue
            parent = posts.get(comment.get("link_id"))
            if not parent:
                continue
            pair = {
                "question_title": parent.get("title"),
                "question_body": parent.get("selftext"),
                "answer": comment.get("body"),
                "answer_score": comment.get("score"),
                "subreddit": subreddit,
                "post_id": parent.get("id"),
                "comment_id": comment.get("id"),
            }
            out.write(json.dumps(pair) + "\n")
            pair_count += 1

    print(f"  Built {pair_count:,} pairs for r/{subreddit}")


def main():
    parser = argparse.ArgumentParser(description="Pushshift Reddit corpus extractor for plumbing/HVAC training data")
    parser.add_argument("--from-local", help="Path to a local .zst Pushshift dump file")
    parser.add_argument("--type", choices=["posts", "comments"], default="posts", help="Dump type")
    parser.add_argument("--subreddits", nargs="+", default=list(TARGET_SUBREDDITS), help="Subreddits to extract")
    parser.add_argument("--build-pairs-only", action="store_true", help="Skip extraction, just build Q&A pairs from existing JSONL")
    parser.add_argument("--min-answer-score", type=int, default=5, help="Minimum comment score to include in pairs")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    subreddit_filter = {s.lower() for s in args.subreddits}

    if args.build_pairs_only:
        for sub in subreddit_filter:
            print(f"Building pairs for r/{sub}...")
            build_pairs(sub, OUTPUT_DIR, args.min_answer_score)
        return

    if not args.from_local:
        print("""
No local dump file provided. To download the Pushshift corpus:

  Option A — Academic Torrents (recommended, free):
    1. Install a torrent client (e.g. qBittorrent)
    2. Go to: https://academictorrents.com/details/1614740ac8c94505e4ecb9d88be8bed7b6afddd4
    3. Download subreddit-specific files (e.g. subreddits/plumbing_submissions.zst)
    4. Re-run: python3 01_reddit_pushshift.py --from-local /path/to/file.zst --type posts

  Option B — Kaggle:
    kaggle datasets download i221113hadiyatanveer/the-pushshift-reddit-dataset-submissions

  Option C — PRAW (live Reddit API, slower, rate-limited):
    See scripts/01b_reddit_praw.py for live API collection.
""")
        sys.exit(0)

    print(f"Processing {args.from_local} (type={args.type}, subreddits={subreddit_filter})")
    process_zst_dump(args.from_local, subreddit_filter, args.type, OUTPUT_DIR)

    print("Building Q&A pairs...")
    for sub in subreddit_filter:
        build_pairs(sub, OUTPUT_DIR, args.min_answer_score)

    ph.capture("corpus_reddit_extraction_completed", {
        "record_type": args.type,
        "subreddit_count": len(subreddit_filter),
        "subreddits": sorted(subreddit_filter),
        "min_answer_score": args.min_answer_score,
    })


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        ph.capture_exception(exc)
        raise
