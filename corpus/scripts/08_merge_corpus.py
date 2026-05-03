#!/usr/bin/env python3
"""
Step 8 (final): Merge all corpus outputs into a unified training JSONL.

Normalizes all sources into a common schema and writes:
  output/corpus_final.jsonl   — all records, one per line
  output/corpus_stats.json    — counts by source, category, type

Schema per record:
  {
    "id":          unique record ID,
    "source":      reddit | youtube | stackexchange | justanswer | terrylove |
                   angi | homeadvisor | asse | ashrae | lbnl,
    "category":    plumbing | hvac | general,
    "record_type": qa_pair | utterance | glossary_term | review | fault_pair,
    "question":    customer-facing text (lay language) or None,
    "answer":      expert/technical text or None,
    "text":        raw text (for utterances / glossary entries),
    "metadata":    {source-specific fields},
  }

USAGE
-----
  python3 08_merge_corpus.py
  python3 08_merge_corpus.py --min-length 50 --output corpus_final.jsonl
"""

import argparse
import hashlib
import json
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent.parent / "output"

PLUMBING_KEYWORDS = {
    "plumb", "pipe", "drain", "leak", "faucet", "toilet", "shower", "bathtub",
    "p-trap", "trap", "wax ring", "flapper", "fill valve", "angle stop",
    "water heater", "disposal", "garbage disposal", "sewer", "septic",
    "water pressure", "hot water", "cold water", "dishwasher", "washing machine",
}

HVAC_KEYWORDS = {
    "hvac", "furnace", "ac", "air condition", "heat pump", "duct", "thermostat",
    "refrigerant", "no heat", "no cool", "compressor", "condenser", "evaporator",
    "blower", "inducer", "igniter", "flame sensor", "heat exchanger", "capacitor",
    "contactor", "mini split", "air handler",
}


def infer_category(text: str) -> str:
    text_lower = text.lower()
    plumb_hits = sum(1 for kw in PLUMBING_KEYWORDS if kw in text_lower)
    hvac_hits = sum(1 for kw in HVAC_KEYWORDS if kw in text_lower)
    if plumb_hits > hvac_hits:
        return "plumbing"
    if hvac_hits > plumb_hits:
        return "hvac"
    return "general"


def make_id(source: str, content: str) -> str:
    return f"{source}_{hashlib.md5(content.encode()).hexdigest()[:12]}"


def load_reddit(out_dir: Path) -> list[dict]:
    records = []
    reddit_dir = out_dir / "reddit"
    for pairs_file in reddit_dir.glob("*_pairs.jsonl"):
        subreddit = pairs_file.stem.replace("_pairs", "")
        with open(pairs_file, encoding="utf-8") as f:
            for line in f:
                raw = json.loads(line)
                question = f"{raw.get('question_title', '')} {raw.get('question_body', '')}".strip()
                answer = raw.get("answer", "")
                if not question or not answer:
                    continue
                records.append({
                    "id": make_id("reddit", question),
                    "source": "reddit",
                    "category": infer_category(question + " " + answer),
                    "record_type": "qa_pair",
                    "question": question,
                    "answer": answer,
                    "text": None,
                    "metadata": {
                        "subreddit": subreddit,
                        "score": raw.get("answer_score"),
                        "post_id": raw.get("post_id"),
                    },
                })
    return records


def load_stackexchange(out_dir: Path) -> list[dict]:
    records = []
    se_dir = out_dir / "stackexchange"
    for jsonl in se_dir.glob("*_qa.jsonl"):
        with open(jsonl, encoding="utf-8") as f:
            for line in f:
                raw = json.loads(line)
                question = f"{raw.get('title', '')} {raw.get('body', '')}".strip()
                top_answer = next(iter(raw.get("answers", [])), {})
                answer = top_answer.get("body", "")
                if not question:
                    continue
                records.append({
                    "id": make_id("stackexchange", question),
                    "source": "stackexchange",
                    "category": infer_category(question + " " + answer),
                    "record_type": "qa_pair",
                    "question": question,
                    "answer": answer or None,
                    "text": None,
                    "metadata": {
                        "tags": raw.get("tags", []),
                        "score": raw.get("score"),
                        "accepted": top_answer.get("is_accepted"),
                    },
                })
    return records


def load_youtube(out_dir: Path) -> list[dict]:
    records = []
    utterances_file = out_dir / "youtube" / "all_utterances.jsonl"
    if not utterances_file.exists():
        return records
    with open(utterances_file, encoding="utf-8") as f:
        for line in f:
            raw = json.loads(line)
            text = raw.get("text", "").strip()
            if not text or len(text) < 20:
                continue
            records.append({
                "id": make_id("youtube", f"{raw.get('video_id')}{raw.get('start_sec')}{text}"),
                "source": "youtube",
                "category": raw.get("channel_category") or infer_category(text),
                "record_type": "utterance",
                "question": None,
                "answer": None,
                "text": text,
                "metadata": {
                    "video_id": raw.get("video_id"),
                    "channel": raw.get("channel"),
                    "title": raw.get("title"),
                    "start_sec": raw.get("start_sec"),
                },
            })
    return records


def load_forums(out_dir: Path) -> list[dict]:
    records = []
    forums_dir = out_dir / "forums"
    for jsonl in forums_dir.glob("*.jsonl"):
        if jsonl.name == "all_qa.jsonl":
            continue
        source_name = jsonl.stem.split("_")[0]
        with open(jsonl, encoding="utf-8") as f:
            for line in f:
                raw = json.loads(line)
                question = raw.get("question", "")
                answers = raw.get("answers", []) or ([raw.get("answer")] if raw.get("answer") else [])
                answer = answers[0] if answers else None
                if not question:
                    continue
                records.append({
                    "id": make_id(source_name, question),
                    "source": source_name,
                    "category": infer_category(question + " " + (answer or "")),
                    "record_type": "qa_pair",
                    "question": question,
                    "answer": answer,
                    "text": None,
                    "metadata": {"url": raw.get("url"), "all_answers": answers},
                })
    return records


def load_reviews(out_dir: Path) -> list[dict]:
    records = []
    reviews_dir = out_dir / "reviews"
    for jsonl in reviews_dir.glob("*.jsonl"):
        if jsonl.name == "all_reviews.jsonl":
            continue
        with open(jsonl, encoding="utf-8") as f:
            for line in f:
                raw = json.loads(line)
                review = raw.get("review", "")
                if not review or len(review) < 30:
                    continue
                records.append({
                    "id": make_id(raw.get("source", "review"), review),
                    "source": raw.get("source", "review"),
                    "category": infer_category(review),
                    "record_type": "review",
                    "question": raw.get("project_description"),
                    "answer": None,
                    "text": review,
                    "metadata": {
                        "rating": raw.get("rating"),
                        "company": raw.get("company_name"),
                        "location": raw.get("location"),
                    },
                })
    return records


def load_reference(out_dir: Path) -> list[dict]:
    records = []
    ref_dir = out_dir / "reference"
    combined = ref_dir / "combined_glossary.jsonl"
    if not combined.exists():
        return records
    with open(combined, encoding="utf-8") as f:
        for line in f:
            raw = json.loads(line)
            term = raw.get("term", "")
            definition = raw.get("definition", "")
            if not term or not definition or raw.get("raw"):
                continue
            records.append({
                "id": make_id("glossary", term),
                "source": "glossary",
                "category": infer_category(term + " " + definition),
                "record_type": "glossary_term",
                "question": None,
                "answer": None,
                "text": f"{term}: {definition}",
                "metadata": {"term": term, "definition": definition, "source_doc": raw.get("source")},
            })
    return records


def load_lbnl(out_dir: Path) -> list[dict]:
    records = []
    lbnl_dir = out_dir / "lbnl_hvac"
    fault_pairs = lbnl_dir / "fault_symptom_pairs.jsonl"
    if not fault_pairs.exists():
        return records
    with open(fault_pairs, encoding="utf-8") as f:
        for line in f:
            raw = json.loads(line)
            fault_code = raw.get("fault_code", "")
            technical = raw.get("technical_description", "")
            for symptom in raw.get("customer_symptoms", []):
                records.append({
                    "id": make_id("lbnl", symptom),
                    "source": "lbnl",
                    "category": "hvac",
                    "record_type": "fault_pair",
                    "question": symptom,
                    "answer": technical,
                    "text": None,
                    "metadata": {
                        "fault_code": fault_code,
                        "system": raw.get("system"),
                        "urgency": raw.get("urgency"),
                        "life_safety": raw.get("life_safety", False),
                    },
                })
    return records


def main():
    parser = argparse.ArgumentParser(description="Merge all corpus outputs into unified training JSONL")
    parser.add_argument("--min-length", type=int, default=20, help="Min character length for question/answer/text")
    parser.add_argument("--output", default="corpus_final.jsonl", help="Output filename in output/")
    args = parser.parse_args()

    loaders = [
        ("reddit", load_reddit),
        ("stackexchange", load_stackexchange),
        ("youtube", load_youtube),
        ("forums", load_forums),
        ("reviews", load_reviews),
        ("reference glossaries", load_reference),
        ("lbnl fault pairs", load_lbnl),
    ]

    output_file = OUTPUT_DIR / args.output
    stats: dict[str, dict] = {}
    seen_ids: set[str] = set()
    total = 0

    with open(output_file, "w", encoding="utf-8") as out:
        for loader_name, loader_fn in loaders:
            print(f"Loading {loader_name}...")
            try:
                records = loader_fn(OUTPUT_DIR)
            except Exception as e:
                print(f"  ERROR loading {loader_name}: {e}")
                records = []

            written = 0
            for record in records:
                # Dedup
                if record["id"] in seen_ids:
                    continue
                seen_ids.add(record["id"])

                # Min length filter
                content = " ".join(filter(None, [record.get("question"), record.get("answer"), record.get("text")]))
                if len(content) < args.min_length:
                    continue

                out.write(json.dumps(record) + "\n")
                written += 1
                total += 1

                # Stats
                src = record["source"]
                cat = record["category"]
                rtype = record["record_type"]
                stats.setdefault(src, {}).setdefault(cat, {}).setdefault(rtype, 0)
                stats[src][cat][rtype] += 1

            print(f"  {written:,} records from {loader_name}")

    # Write stats
    stats_file = OUTPUT_DIR / "corpus_stats.json"
    with open(stats_file, "w", encoding="utf-8") as f:
        json.dump({"total": total, "by_source": stats}, f, indent=2)

    print(f"\nCorpus merge complete.")
    print(f"  Total records: {total:,}")
    print(f"  Output: {output_file}")
    print(f"  Stats: {stats_file}")


if __name__ == "__main__":
    main()
