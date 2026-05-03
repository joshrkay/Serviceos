#!/usr/bin/env python3
"""
Step 4: YouTube transcript extractor.

Uses yt-dlp to download auto-generated captions from curated plumbing
and HVAC channels. Transcripts are converted to clean text and stored
as JSONL, one utterance per line with timestamp and video metadata.

Channels covered:
  PLUMBING
    Roger Wakefield Plumbing         — 1,600+ videos, Master Plumber
    Got2Learn Plumbing               — DIY-focused, lay + technical vocabulary
    Roto-Rooter                      — customer-facing educational content
    Benjamin Franklin Plumbing (demo channel included)

  HVAC
    HVAC School (Bryan Orr)          — 500+ videos, deep technical
    AC Service Tech LLC              — step-by-step troubleshooting
    HVAC Guide for Homeowners        — customer-facing, strong lay vocabulary
    Word of Advice TV                — homeowner explanations

  HOME INSPECTION (dual lay + technical vocabulary)
    InterNACHI Inspection Training
    Home Inspector Secrets

OUTPUT
------
output/youtube/
  {channel_slug}/
    {video_id}.json          — {video_id, title, channel, upload_date, transcript: [{start, text}]}
  all_utterances.jsonl       — flat: {video_id, channel, title, start_sec, text}

USAGE
-----
  pip install yt-dlp
  python3 03_youtube_transcripts.py
  python3 03_youtube_transcripts.py --channel-url https://www.youtube.com/@RogerWakefieldPlumbing --max 200
  python3 03_youtube_transcripts.py --video-id dQw4w9WgXcQ   (single video)
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent.parent / "output" / "youtube"

CHANNELS = {
    # --- PLUMBING ---
    "roger_wakefield": {
        "url": "https://www.youtube.com/@RogerWakefieldPlumbing",
        "category": "plumbing",
        "priority": 1,
        "notes": "1600+ videos, Master Plumber TX, both homeowner education and technical content",
    },
    "got2learn_plumbing": {
        "url": "https://www.youtube.com/@Got2LearnPlumbing",
        "category": "plumbing",
        "priority": 1,
        "notes": "DIY-focused, clear lay + technical vocabulary",
    },
    "roto_rooter": {
        "url": "https://www.youtube.com/@RotorRooter",
        "category": "plumbing",
        "priority": 2,
        "notes": "Customer-facing educational content from major service company",
    },
    # --- HVAC ---
    "hvac_school": {
        "url": "https://www.youtube.com/@HVACSchool",
        "category": "hvac",
        "priority": 1,
        "notes": "Bryan Orr — 500+ videos, extremely deep technical content",
    },
    "ac_service_tech": {
        "url": "https://www.youtube.com/@AcServiceTech",
        "category": "hvac",
        "priority": 1,
        "notes": "Step-by-step residential and commercial troubleshooting",
    },
    "hvac_guide_homeowners": {
        "url": "https://www.youtube.com/@HVACGuideforHomeowners",
        "category": "hvac",
        "priority": 1,
        "notes": "Customer-facing, strong lay vocabulary — ideal for training customer language understanding",
    },
    "word_of_advice_tv": {
        "url": "https://www.youtube.com/@WordofAdviceTV",
        "category": "hvac",
        "priority": 2,
        "notes": "Homeowner HVAC explanations",
    },
    # --- HOME INSPECTION (dual vocabulary) ---
    "internachi": {
        "url": "https://www.youtube.com/@internachi",
        "category": "inspection",
        "priority": 2,
        "notes": "InterNACHI training — describes defects in both lay and technical terms",
    },
}


def check_yt_dlp():
    try:
        result = subprocess.run(["yt-dlp", "--version"], capture_output=True, text=True)
        return result.returncode == 0
    except FileNotFoundError:
        return False


def vtt_to_text_segments(vtt_content: str) -> list[dict]:
    """Parse .vtt subtitle file into timed text segments."""
    segments = []
    lines = vtt_content.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        # Match timestamp lines: 00:00:01.234 --> 00:00:03.456
        match = re.match(r"(\d+:\d+:\d+\.\d+)\s+-->\s+(\d+:\d+:\d+\.\d+)", line)
        if match:
            start_str = match.group(1)
            parts = start_str.split(":")
            start_sec = int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
            text_lines = []
            i += 1
            while i < len(lines) and lines[i].strip() and "-->" not in lines[i]:
                # Strip VTT positioning tags
                clean = re.sub(r"<[^>]+>", "", lines[i].strip())
                if clean:
                    text_lines.append(clean)
                i += 1
            text = " ".join(text_lines).strip()
            if text:
                segments.append({"start": round(start_sec, 1), "text": text})
        else:
            i += 1
    return segments


def download_channel_transcripts(channel_slug: str, channel_info: dict, out_dir: Path, max_videos: int = 500):
    """Download transcripts for all videos in a channel."""
    channel_dir = out_dir / channel_slug
    channel_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n[{channel_slug}] Fetching video list from {channel_info['url']}...")

    # Get video URLs for the channel
    cmd = [
        "yt-dlp",
        "--flat-playlist",
        "--print", "%(id)s\t%(title)s\t%(upload_date)s",
        "--playlist-end", str(max_videos),
        channel_info["url"],
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ERROR fetching playlist: {result.stderr[:200]}")
        return

    videos = []
    for line in result.stdout.strip().split("\n"):
        if "\t" in line:
            parts = line.split("\t", 2)
            if len(parts) >= 2:
                videos.append({"id": parts[0], "title": parts[1], "date": parts[2] if len(parts) > 2 else ""})

    print(f"  Found {len(videos)} videos. Downloading transcripts...")
    downloaded = 0
    skipped = 0

    for video in videos:
        vid_id = video["id"]
        out_json = channel_dir / f"{vid_id}.json"
        if out_json.exists():
            skipped += 1
            continue

        # Download auto-generated English subtitles
        vtt_file = channel_dir / f"{vid_id}.en.vtt"
        cmd = [
            "yt-dlp",
            "--skip-download",
            "--write-auto-subs",
            "--sub-lang", "en",
            "--sub-format", "vtt",
            "--output", str(channel_dir / "%(id)s.%(ext)s"),
            f"https://www.youtube.com/watch?v={vid_id}",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)

        # Also check for manually uploaded subs
        if not vtt_file.exists():
            # yt-dlp may name it differently
            matches = list(channel_dir.glob(f"{vid_id}*.vtt"))
            if matches:
                vtt_file = matches[0]

        if vtt_file.exists():
            segments = vtt_to_text_segments(vtt_file.read_text(encoding="utf-8", errors="replace"))
            record = {
                "video_id": vid_id,
                "title": video["title"],
                "channel": channel_slug,
                "channel_category": channel_info["category"],
                "upload_date": video["date"],
                "url": f"https://www.youtube.com/watch?v={vid_id}",
                "transcript": segments,
            }
            out_json.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
            vtt_file.unlink(missing_ok=True)  # remove raw VTT after parsing
            downloaded += 1
        else:
            # No captions available — save stub
            stub = {"video_id": vid_id, "title": video["title"], "channel": channel_slug, "transcript": None, "error": "no_captions"}
            out_json.write_text(json.dumps(stub), encoding="utf-8")

    print(f"  Done: {downloaded} transcripts downloaded, {skipped} already cached.")


def flatten_to_utterances(out_dir: Path):
    """Flatten all per-video JSON files into a single utterances JSONL."""
    utterances_file = out_dir / "all_utterances.jsonl"
    count = 0
    print("\nFlattening transcripts to utterances JSONL...")
    with open(utterances_file, "w", encoding="utf-8") as out:
        for channel_dir in out_dir.iterdir():
            if not channel_dir.is_dir():
                continue
            for json_file in channel_dir.glob("*.json"):
                try:
                    record = json.loads(json_file.read_text(encoding="utf-8"))
                    if not record.get("transcript"):
                        continue
                    for seg in record["transcript"]:
                        utterance = {
                            "video_id": record["video_id"],
                            "channel": record.get("channel"),
                            "channel_category": record.get("channel_category"),
                            "title": record.get("title"),
                            "start_sec": seg.get("start"),
                            "text": seg.get("text"),
                        }
                        out.write(json.dumps(utterance, ensure_ascii=False) + "\n")
                        count += 1
                except Exception:
                    continue

    print(f"  Wrote {count:,} utterances to {utterances_file.name}")


def main():
    parser = argparse.ArgumentParser(description="YouTube transcript extractor for plumbing/HVAC training data")
    parser.add_argument("--channel-url", help="Single channel URL to process")
    parser.add_argument("--video-id", help="Single video ID to process")
    parser.add_argument("--max", type=int, default=500, help="Max videos per channel (default 500)")
    parser.add_argument("--priority", type=int, choices=[1, 2], help="Only process channels with this priority")
    parser.add_argument("--flatten-only", action="store_true", help="Skip downloads, only flatten existing JSON to utterances JSONL")
    args = parser.parse_args()

    if not check_yt_dlp():
        print("yt-dlp not found. Install it: pip install yt-dlp")
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    if args.flatten_only:
        flatten_to_utterances(OUTPUT_DIR)
        return

    if args.video_id:
        # Single video mode
        channel_dir = OUTPUT_DIR / "single"
        channel_dir.mkdir(exist_ok=True)
        cmd = [
            "yt-dlp", "--skip-download", "--write-auto-subs",
            "--sub-lang", "en", "--sub-format", "vtt",
            "--output", str(channel_dir / "%(id)s.%(ext)s"),
            f"https://www.youtube.com/watch?v={args.video_id}",
        ]
        subprocess.run(cmd)
        flatten_to_utterances(OUTPUT_DIR)
        return

    if args.channel_url:
        channels_to_process = {"custom": {"url": args.channel_url, "category": "custom", "priority": 1}}
    else:
        channels_to_process = CHANNELS

    for slug, info in channels_to_process.items():
        if args.priority and info.get("priority") != args.priority:
            continue
        download_channel_transcripts(slug, info, OUTPUT_DIR, max_videos=args.max)

    flatten_to_utterances(OUTPUT_DIR)
    print("\nYouTube transcript extraction complete.")


if __name__ == "__main__":
    main()
