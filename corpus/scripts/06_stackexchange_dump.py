#!/usr/bin/env python3
"""
Step 7: Stack Exchange DIY dump processor.

Downloads and processes the diy.stackexchange.com data dump from
Internet Archive. Contains structured Q&A with expert-verified answers,
tagged plumbing/hvac/water-heater/drain/furnace/air-conditioning etc.

Source: https://archive.org/details/stackexchange_20251231

Dump format: XML files (Posts.xml, Tags.xml, Comments.xml)
License: CC BY-SA 4.0 — verify before commercial use.

OUTPUT
------
output/stackexchange/
  diy_posts.xml              — raw downloaded dump
  plumbing_qa.jsonl          — {id, title, body, answers, tags, score}
  hvac_qa.jsonl
  all_diy_qa.jsonl           — merged

USAGE
-----
  python3 06_stackexchange_dump.py
  python3 06_stackexchange_dump.py --tags plumbing hvac water-heater drain furnace
  python3 06_stackexchange_dump.py --from-local /path/to/diy.stackexchange.com.7z
"""

import argparse
import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    import requests
    from tqdm import tqdm
except ImportError:
    print("Install dependencies: pip install requests tqdm")
    raise

OUTPUT_DIR = Path(__file__).parent.parent / "output" / "stackexchange"

# Internet Archive URL for DIY Stack Exchange dump (Dec 2025)
ARCHIVE_URL = "https://archive.org/download/stackexchange_20251231/diy.stackexchange.com.7z"

# Tags to extract — plumbing and HVAC focused
TARGET_TAGS = {
    "plumbing", "hvac", "water-heater", "drain", "furnace", "air-conditioning",
    "pipe", "toilet", "faucet", "leak", "shower", "bathtub", "sewer",
    "heat-pump", "ductwork", "thermostat", "refrigerant", "water-pressure",
    "garbage-disposal", "washing-machine", "dishwasher",
}


def download_dump(out_dir: Path) -> Path | None:
    """Download the DIY Stack Exchange dump archive."""
    archive_file = out_dir / "diy.stackexchange.com.7z"
    if archive_file.exists():
        print(f"  Archive already downloaded: {archive_file.name}")
        return archive_file

    print(f"  Downloading Stack Exchange DIY dump (~500 MB)...")
    print(f"  Source: {ARCHIVE_URL}")
    print("  This may take several minutes on a typical connection.")

    try:
        resp = requests.get(ARCHIVE_URL, stream=True, timeout=300)
        resp.raise_for_status()
        total = int(resp.headers.get("content-length", 0))

        with open(archive_file, "wb") as f:
            downloaded = 0
            for chunk in resp.iter_content(chunk_size=65536):
                f.write(chunk)
                downloaded += len(chunk)
                if total:
                    pct = downloaded / total * 100
                    print(f"    {pct:.1f}% ({downloaded / 1e6:.0f} MB / {total / 1e6:.0f} MB)", end="\r")

        print(f"\n  Downloaded: {archive_file.name}")
        return archive_file
    except Exception as e:
        print(f"  Download failed: {e}")
        print("""
  Manual download steps:
    1. Go to: https://archive.org/details/stackexchange_20251231
    2. Find "diy.stackexchange.com.7z" and download it
    3. Place the file at: output/stackexchange/diy.stackexchange.com.7z
    4. Re-run this script
""")
        return None


def extract_archive(archive_path: Path, out_dir: Path) -> Path | None:
    """Extract .7z archive. Requires p7zip or 7z."""
    posts_xml = out_dir / "Posts.xml"
    if posts_xml.exists():
        print(f"  Already extracted: {posts_xml.name}")
        return posts_xml

    # Try system 7z
    for cmd in ["7z", "7za", "p7zip"]:
        result = subprocess.run([cmd, "x", str(archive_path), f"-o{out_dir}", "-y"], capture_output=True)
        if result.returncode == 0:
            print(f"  Extracted with {cmd}")
            return posts_xml if posts_xml.exists() else None

    print("""
  7z not found. Install it:
    Ubuntu/Debian: sudo apt-get install p7zip-full
    macOS: brew install p7zip
  Then re-run this script.
""")
    return None


def parse_posts_xml(posts_xml: Path, target_tags: set[str], out_dir: Path) -> tuple[int, int]:
    """
    Parse Posts.xml and extract questions + answers by tag.

    Stack Exchange Posts.xml row format:
      Id, PostTypeId (1=Question, 2=Answer), ParentId (for answers),
      Body, Title, Tags, Score, AcceptedAnswerId
    """
    print(f"  Parsing {posts_xml.name}...")

    questions: dict[str, dict] = {}
    answers: dict[str, list] = {}

    # First pass: collect all questions and answers
    context = ET.iterparse(posts_xml, events=("end",))
    count = 0
    for event, elem in context:
        if elem.tag != "row":
            continue
        count += 1
        if count % 100_000 == 0:
            print(f"    Parsed {count:,} rows...")

        post_type = elem.get("PostTypeId")
        post_id = elem.get("Id")
        score = int(elem.get("Score", "0"))
        body = elem.get("Body", "")

        if post_type == "1":  # Question
            tags_raw = elem.get("Tags", "")
            # Tags format: <plumbing><water-heater>
            post_tags = set(t.strip("<>") for t in tags_raw.split("><") if t.strip("<>"))
            if not post_tags.intersection(target_tags):
                elem.clear()
                continue

            questions[post_id] = {
                "id": post_id,
                "title": elem.get("Title", ""),
                "body": body,
                "tags": list(post_tags),
                "score": score,
                "accepted_answer_id": elem.get("AcceptedAnswerId"),
                "answers": [],
            }

        elif post_type == "2":  # Answer
            parent_id = elem.get("ParentId")
            if parent_id:
                if parent_id not in answers:
                    answers[parent_id] = []
                answers[parent_id].append({
                    "id": post_id,
                    "body": body,
                    "score": score,
                    "is_accepted": False,
                })

        elem.clear()

    # Second pass: join answers to questions
    print(f"  Found {len(questions):,} relevant questions. Joining answers...")
    for q_id, question in questions.items():
        q_answers = answers.get(q_id, [])
        accepted_id = question.get("accepted_answer_id")
        for a in q_answers:
            a["is_accepted"] = (a["id"] == accepted_id)
        question["answers"] = sorted(q_answers, key=lambda a: (-int(a.get("is_accepted", 0)), -a["score"]))

    # Write output split by primary tag
    tag_counts: dict[str, int] = {}
    writers: dict[str, object] = {}

    for question in questions.values():
        tags = question.get("tags", [])
        # Determine primary category
        primary = next((t for t in ["plumbing", "hvac", "water-heater", "furnace", "air-conditioning"] if t in tags), tags[0] if tags else "other")
        if primary not in writers:
            tag_file = out_dir / f"{primary.replace('-', '_')}_qa.jsonl"
            writers[primary] = open(tag_file, "w", encoding="utf-8")
            tag_counts[primary] = 0
        writers[primary].write(json.dumps(question) + "\n")
        tag_counts[primary] += 1

    for f in writers.values():
        f.close()

    total = sum(tag_counts.values())
    print(f"  Extracted {total:,} Q&A records:")
    for tag, cnt in sorted(tag_counts.items(), key=lambda x: -x[1]):
        print(f"    {tag}: {cnt:,}")

    return len(questions), total


def merge_all(out_dir: Path):
    """Merge all category JSONL files into all_diy_qa.jsonl"""
    output_file = out_dir / "all_diy_qa.jsonl"
    count = 0
    with open(output_file, "w", encoding="utf-8") as out:
        for jsonl in out_dir.glob("*_qa.jsonl"):
            with open(jsonl, encoding="utf-8") as f:
                for line in f:
                    out.write(line)
                    count += 1
    print(f"\nMerged {count:,} records → {output_file.name}")


def main():
    parser = argparse.ArgumentParser(description="Stack Exchange DIY dump processor")
    parser.add_argument("--from-local", help="Path to already-downloaded .7z archive")
    parser.add_argument("--posts-xml", help="Path to already-extracted Posts.xml")
    parser.add_argument("--tags", nargs="+", default=list(TARGET_TAGS), help="Tags to extract")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    target_tags = set(args.tags)

    if args.posts_xml:
        posts_xml = Path(args.posts_xml)
    else:
        archive_path = Path(args.from_local) if args.from_local else download_dump(OUTPUT_DIR)
        if not archive_path:
            sys.exit(1)
        posts_xml = extract_archive(archive_path, OUTPUT_DIR)
        if not posts_xml:
            sys.exit(1)

    parse_posts_xml(posts_xml, target_tags, OUTPUT_DIR)
    merge_all(OUTPUT_DIR)
    print("\nStack Exchange processing complete.")


if __name__ == "__main__":
    main()
