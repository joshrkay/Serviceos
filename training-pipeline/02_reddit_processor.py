#!/usr/bin/env python3
"""
ServiceOS Training Pipeline — Reddit .zst processor

Streams Pushshift `<subreddit>_submissions.zst` files in 1 MiB chunks,
classifies each post (triage / trade / fixture / accent / language),
applies the phrase_map normalization, and bulk-inserts into Supabase
`training_corpus` in batches of BATCH_SIZE.

Usage:
  python3 02_reddit_processor.py                      # full run
  python3 02_reddit_processor.py --dry-run            # no DB writes
  python3 02_reddit_processor.py --dry-run --max-records 2000
  python3 02_reddit_processor.py --only Plumbing      # one file only

Resume:
  Per-file byte offset is checkpointed to
  $SERVICEOS_DATA_DIR/checkpoints/<file>.offset
  Re-running picks up from the last committed batch.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Iterator

import zstandard as zstd
from dotenv import load_dotenv

# ------------------------------------------------------------
# Paths + env
# ------------------------------------------------------------
DATA_DIR = Path(os.environ.get("SERVICEOS_DATA_DIR", str(Path.home() / "serviceos_data")))
TORRENT_DIR = DATA_DIR / "torrents"
CHECKPOINT_DIR = DATA_DIR / "checkpoints"
LOG_DIR = DATA_DIR / "logs"
ENV_FILE = DATA_DIR / ".env"

load_dotenv(ENV_FILE)

BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "250"))
CHUNK_BYTES = int(os.environ.get("CHUNK_BYTES", str(1024 * 1024)))

TARGET_FILES = [
    "Plumbing_submissions.zst",
    "HVAC_submissions.zst",
    "HomeImprovement_submissions.zst",
    "DIY_submissions.zst",
]

SUBREDDIT_TO_TRADE = {
    "plumbing": "plumbing",
    "hvac": "hvac",
    "homeimprovement": "general",
    "diy": "diy",
}

# ------------------------------------------------------------
# Classifier rules (intentionally simple + auditable)
# ------------------------------------------------------------
EMERGENCY_PATTERNS = [
    r"\bflood(?:ed|ing)?\b",
    r"\bburst pipe\b|\bbusted pipe\b",
    r"\bgas leak\b|\bsmell(?:ing)? gas\b",
    r"\bno heat\b|\bno hot water\b",
    r"\bsewage\b|\bsewer back(?:ed|ing) up\b",
    r"\bcarbon monoxide\b|\bco alarm\b",
    r"\bspark(?:ing|s)?\b.*\b(outlet|panel|breaker)\b",
    r"\bwater every\s*where\b",
    r"\bceiling (?:is )?leaking\b|\bwater coming through (?:the )?ceiling\b",
]
URGENT_PATTERNS = [
    r"\bleak(?:ing|s)?\b",
    r"\bdripping\b|\bdrippin\b",
    r"\bclogged\b|\bbackup\b|\bbacked up\b",
    r"\bnot working\b|\bwon't (?:turn on|start|fire)\b",
    r"\bfreezing up\b|\bfroze up\b|\bfrozen coil\b",
    r"\btripping breaker\b|\bbreaker keeps tripping\b",
    r"\bshort cycling\b",
]
ROUTINE_PATTERNS = [
    r"\bmaintenance\b|\btune.?up\b|\binspection\b",
    r"\bquote\b|\bestimate\b|\bhow much\b|\bcost\b",
    r"\breplace(?:ment)?\b|\bupgrade\b|\binstall(?:ation)?\b",
]
INFO_PATTERNS = [
    r"\bhow do i\b|\bhow to\b|\bcan (?:i|you) explain\b",
    r"\bdifference between\b|\brecommendation\b|\bwhich is better\b",
]

FIXTURES = {
    "water_heater":  [r"\bwater heater\b", r"\bhot water tank\b", r"\bwaddah heatah\b", r"\bcalentador\b"],
    "toilet":        [r"\btoilet\b", r"\bcommode\b", r"\binodoro\b", r"\bdunny\b"],
    "faucet":        [r"\bfaucet\b", r"\bspicket\b", r"\bspigot\b", r"\btap\b"],
    "drain":         [r"\bdrain\b", r"\bp.?trap\b", r"\bsink (?:is )?clog"],
    "sump_pump":     [r"\bsump pump\b"],
    "garbage_disposal":[r"\bgarbage disposal\b", r"\bdisposer\b"],
    "shower":        [r"\bshower\b"],
    "boiler":        [r"\bboiler\b"],
    "furnace":       [r"\bfurnace\b"],
    "ac_condenser":  [r"\bcondenser\b", r"\boutdoor unit\b", r"\bcompressor\b"],
    "evaporator":    [r"\bevaporator\b", r"\bindoor coil\b", r"\ba.?coil\b"],
    "thermostat":    [r"\bthermostat\b", r"\bnest\b.*\bthermostat\b"],
    "ductwork":      [r"\bduct(?:work)?\b"],
    "panel":         [r"\b(?:breaker|electrical) panel\b", r"\bservice panel\b"],
    "outlet":        [r"\boutlet\b", r"\breceptacle\b", r"\bgfci\b"],
}

# Compile up front
EMERGENCY_RE = [re.compile(p, re.I) for p in EMERGENCY_PATTERNS]
URGENT_RE    = [re.compile(p, re.I) for p in URGENT_PATTERNS]
ROUTINE_RE   = [re.compile(p, re.I) for p in ROUTINE_PATTERNS]
INFO_RE      = [re.compile(p, re.I) for p in INFO_PATTERNS]
FIXTURE_RE   = {k: [re.compile(p, re.I) for p in v] for k, v in FIXTURES.items()}


# ------------------------------------------------------------
# Phrase + dialect lookups (loaded from Supabase, cached locally)
# ------------------------------------------------------------
@dataclass
class PhraseEntry:
    layman: str
    technical: str
    trade: str
    region: str | None


@dataclass
class DialectEntry:
    accent: str
    language: str
    pattern: re.Pattern
    weight: float


@dataclass
class Lookups:
    phrases: list[PhraseEntry] = field(default_factory=list)
    dialects: list[DialectEntry] = field(default_factory=list)

    @classmethod
    def load(cls, sb) -> "Lookups":
        """Pull phrase_map + dialect_registry. Falls back to empty in dry-run."""
        out = cls()
        if sb is None:
            return out
        pm = sb.table("phrase_map").select("layman_phrase,technical_term,trade,region").execute()
        for row in pm.data or []:
            out.phrases.append(PhraseEntry(
                layman=row["layman_phrase"],
                technical=row["technical_term"],
                trade=row["trade"],
                region=row.get("region"),
            ))
        # Longest layman first so "hot water tank" wins over "water"
        out.phrases.sort(key=lambda p: -len(p.layman))

        dr = sb.table("dialect_registry").select("accent,language,pattern,weight").execute()
        for row in dr.data or []:
            try:
                out.dialects.append(DialectEntry(
                    accent=row["accent"],
                    language=row.get("language") or "en",
                    pattern=re.compile(row["pattern"], re.I),
                    weight=float(row.get("weight") or 1.0),
                ))
            except re.error as e:
                print(f"  ! bad dialect regex {row['pattern']!r}: {e}", file=sys.stderr)
        return out


# ------------------------------------------------------------
# Classification
# ------------------------------------------------------------
@dataclass
class Classified:
    triage: str
    trade: str
    fixture: str | None
    accent: str | None
    language: str
    phrases_hit: list[str]
    dialect_hits: list[str]
    confidence: float
    normalized_text: str


def detect_language(text: str) -> str:
    try:
        from langdetect import detect, DetectorFactory
        DetectorFactory.seed = 0
        return detect(text)
    except Exception:
        return "en"


def normalize(text: str, phrases: list[PhraseEntry]) -> tuple[str, list[str]]:
    out = text
    hits: list[str] = []
    for p in phrases:
        # word-boundary, case-insensitive replace
        pat = re.compile(rf"\b{re.escape(p.layman)}\b", re.I)
        new, n = pat.subn(p.technical, out)
        if n > 0:
            hits.append(p.layman.lower())
            out = new
    return out, hits


def detect_dialects(text: str, dialects: list[DialectEntry]) -> tuple[str | None, list[str]]:
    scores: Counter[str] = Counter()
    hits: list[str] = []
    for d in dialects:
        if d.pattern.search(text):
            scores[d.accent] += d.weight
            hits.append(f"{d.accent}:{d.pattern.pattern}")
    if not scores:
        return None, hits
    accent, _score = scores.most_common(1)[0]
    return accent, hits


def classify_triage(text: str) -> tuple[str, float]:
    if any(p.search(text) for p in EMERGENCY_RE):
        return "emergency", 0.95
    if any(p.search(text) for p in URGENT_RE):
        return "urgent", 0.8
    if any(p.search(text) for p in ROUTINE_RE):
        return "routine", 0.7
    if any(p.search(text) for p in INFO_RE):
        return "info", 0.65
    return "unknown", 0.3


def classify_fixture(text: str) -> str | None:
    for fixture, patterns in FIXTURE_RE.items():
        if any(p.search(text) for p in patterns):
            return fixture
    return None


def classify(raw_text: str, subreddit: str, lookups: Lookups) -> Classified:
    normalized, phrase_hits = normalize(raw_text, lookups.phrases)
    triage, t_conf = classify_triage(normalized)
    fixture = classify_fixture(normalized)
    accent, dialect_hits = detect_dialects(normalized, lookups.dialects)
    trade = SUBREDDIT_TO_TRADE.get(subreddit.lower(), "unknown")
    lang = detect_language(raw_text[:400]) if raw_text else "en"

    # confidence: combine triage confidence + structural signals
    conf = t_conf
    if fixture:
        conf = min(1.0, conf + 0.05)
    if phrase_hits:
        conf = min(1.0, conf + 0.05)

    return Classified(
        triage=triage,
        trade=trade,
        fixture=fixture,
        accent=accent,
        language=lang,
        phrases_hit=phrase_hits,
        dialect_hits=dialect_hits,
        confidence=round(conf, 3),
        normalized_text=normalized,
    )


# ------------------------------------------------------------
# Streaming reader
# ------------------------------------------------------------
def stream_zst_lines(path: Path, start_offset: int = 0) -> Iterator[tuple[int, dict]]:
    """Yield (byte_offset_after_record, parsed_json) tuples.

    Reads the underlying file in CHUNK_BYTES windows; the zstd reader
    decompresses incrementally.
    """
    with open(path, "rb") as fh:
        if start_offset:
            fh.seek(start_offset)
        dctx = zstd.ZstdDecompressor(max_window_size=2**31)
        with dctx.stream_reader(fh, read_size=CHUNK_BYTES) as reader:
            text_stream = io.TextIOWrapper(reader, encoding="utf-8", errors="replace")
            buf = ""
            while True:
                chunk = text_stream.read(CHUNK_BYTES)
                if not chunk:
                    break
                buf += chunk
                lines = buf.split("\n")
                buf = lines.pop()  # last partial line stays in buffer
                for line in lines:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield fh.tell(), json.loads(line)
                    except json.JSONDecodeError:
                        continue
            line = buf.strip()
            if line:
                try:
                    yield fh.tell(), json.loads(line)
                except json.JSONDecodeError:
                    pass


def post_text(record: dict) -> str:
    title = (record.get("title") or "").strip()
    body = (record.get("selftext") or "").strip()
    if body in ("[removed]", "[deleted]"):
        body = ""
    return (title + "\n\n" + body).strip()


# ------------------------------------------------------------
# Supabase client
# ------------------------------------------------------------
def get_supabase():
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key or "YOUR-PROJECT" in url:
        raise SystemExit(
            f"SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing or unset in {ENV_FILE}"
        )
    from supabase import create_client
    return create_client(url, key)


# ------------------------------------------------------------
# Main
# ------------------------------------------------------------
@dataclass
class RunStats:
    seen: int = 0
    kept: int = 0
    skipped_empty: int = 0
    written: int = 0
    by_triage: Counter = field(default_factory=Counter)
    by_trade: Counter = field(default_factory=Counter)
    by_accent: Counter = field(default_factory=Counter)
    by_language: Counter = field(default_factory=Counter)

    def report(self) -> str:
        lines = [
            f"  seen          {self.seen:,}",
            f"  kept          {self.kept:,}",
            f"  skipped empty {self.skipped_empty:,}",
            f"  written       {self.written:,}",
            "  by triage     " + ", ".join(f"{k}={v}" for k, v in self.by_triage.most_common()),
            "  by trade      " + ", ".join(f"{k}={v}" for k, v in self.by_trade.most_common()),
            "  by accent     " + ", ".join(f"{k}={v}" for k, v in self.by_accent.most_common(10)),
            "  by language   " + ", ".join(f"{k}={v}" for k, v in self.by_language.most_common(5)),
        ]
        return "\n".join(lines)


def flush_batch(sb, dry_run: bool, batch: list[dict], stats: RunStats) -> None:
    if not batch:
        return
    if dry_run or sb is None:
        stats.written += len(batch)
        return
    # upsert on (source, source_id) to make re-runs idempotent
    sb.table("training_corpus").upsert(batch, on_conflict="source,source_id").execute()
    stats.written += len(batch)


def process_file(path: Path, lookups: Lookups, sb, args, stats: RunStats) -> None:
    subreddit = path.stem.replace("_submissions", "")
    print(f"\n→ {path.name}  ({path.stat().st_size / 1e9:.2f} GB)")
    ck_path = CHECKPOINT_DIR / f"{path.name}.offset"
    start = int(ck_path.read_text().strip()) if ck_path.exists() and not args.no_resume else 0
    if start:
        print(f"  resuming at byte offset {start:,}")

    batch: list[dict] = []
    t0 = time.time()
    last_log = t0

    for offset, record in stream_zst_lines(path, start_offset=start):
        stats.seen += 1
        if args.max_records and stats.seen > args.max_records:
            break

        text = post_text(record)
        if not text or len(text) < 20:
            stats.skipped_empty += 1
            continue

        c = classify(text, subreddit, lookups)
        stats.kept += 1
        stats.by_triage[c.triage] += 1
        stats.by_trade[c.trade] += 1
        if c.accent:
            stats.by_accent[c.accent] += 1
        stats.by_language[c.language] += 1

        batch.append({
            "source": "reddit",
            "source_id": f"{subreddit.lower()}:{record.get('id') or record.get('name') or stats.seen}",
            "raw_text": text,
            "normalized_text": c.normalized_text,
            "triage": c.triage,
            "trade": c.trade,
            "fixture": c.fixture,
            "accent": c.accent,
            "language": c.language,
            "region_hint": subreddit,
            "phrases_hit": c.phrases_hit,
            "dialect_hits": c.dialect_hits,
            "confidence": c.confidence,
        })

        if len(batch) >= BATCH_SIZE:
            flush_batch(sb, args.dry_run, batch, stats)
            batch.clear()
            if not args.dry_run:
                ck_path.write_text(str(offset))

        now = time.time()
        if now - last_log > 10:
            rate = stats.seen / max(1.0, now - t0)
            print(f"  …{stats.seen:,} read  ({rate:,.0f}/s)  written={stats.written:,}")
            last_log = now

    flush_batch(sb, args.dry_run, batch, stats)
    if not args.dry_run:
        ck_path.write_text(str(path.stat().st_size))
    print(f"  done in {time.time()-t0:,.0f}s")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="parse + classify but skip DB writes")
    p.add_argument("--max-records", type=int, default=0, help="stop after N records (across all files)")
    p.add_argument("--only", help="only process files matching this prefix (e.g. 'Plumbing')")
    p.add_argument("--no-resume", action="store_true", help="ignore checkpoint files")
    args = p.parse_args()

    CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    files = [TORRENT_DIR / f for f in TARGET_FILES]
    if args.only:
        files = [f for f in files if f.name.lower().startswith(args.only.lower())]
    missing = [f for f in files if not f.exists()]
    if missing and not args.dry_run:
        for f in missing:
            print(f"  ! missing {f}", file=sys.stderr)
        if len(missing) == len(files):
            print(f"\nDrop the .zst files into {TORRENT_DIR} and try again.", file=sys.stderr)
            return 2
    files = [f for f in files if f.exists()]

    sb = None if args.dry_run else get_supabase()
    print("loading phrase_map + dialect_registry…" if sb else "dry-run: skipping Supabase load")
    lookups = Lookups.load(sb)
    print(f"  phrases  {len(lookups.phrases)}")
    print(f"  dialects {len(lookups.dialects)}")

    stats = RunStats()
    for f in files:
        process_file(f, lookups, sb, args, stats)
        if args.max_records and stats.seen >= args.max_records:
            break

    print("\n=== run summary ===")
    print(stats.report())
    if args.dry_run:
        print("\n(dry-run: no rows written to Supabase)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
