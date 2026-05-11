#!/usr/bin/env bash
# ============================================================
# Master corpus collection orchestrator
#
# Runs all collection steps in priority order.
# Steps that require external credentials or manual downloads
# print instructions and skip gracefully.
#
# USAGE
#   bash 00_collect.sh                   # full pipeline
#   bash 00_collect.sh --step reference  # single step
#   bash 00_collect.sh --step youtube --max 100
#
# STEPS (in order)
#   reference    — ASSE/ASHRAE/InterNACHI glossaries (Steps 2,3,8)
#   youtube      — YouTube transcript extraction (Step 4)
#   forums       — JustAnswer + Terry Love + PlumbingZone (Step 5)
#   reviews      — Angi/HomeAdvisor via Apify (Step 6, needs APIFY_API_TOKEN)
#   stackexchange — Stack Exchange DIY dump (Step 7)
#   reddit       — Pushshift Reddit dump (Step 1, needs .zst files)
#   lbnl         — LBNL HVAC FDD dataset (Step 10)
#   merge        — Merge all outputs into unified corpus
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORPUS_DIR="$(dirname "$SCRIPT_DIR")"
PYTHON="${PYTHON:-python3}"

MAX_VIDEOS=500
STEP=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --step) STEP="$2"; shift 2 ;;
    --max) MAX_VIDEOS="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

run_step() {
  local name="$1"
  local cmd="$2"
  echo ""
  echo "========================================"
  echo "  STEP: $name"
  echo "========================================"
  eval "$cmd" || echo "  [STEP FAILED or skipped — continuing]"
}

install_deps() {
  echo "Checking Python dependencies..."
  pip install -q -r "$SCRIPT_DIR/requirements.txt" 2>/dev/null || {
    echo "  pip install failed. Run manually: pip install -r corpus/scripts/requirements.txt"
  }
}

step_reference() {
  run_step "Reference Documents (ASSE, ASHRAE, InterNACHI)" \
    "$PYTHON '$SCRIPT_DIR/02_reference_docs.py'"
}

step_youtube() {
  if command -v yt-dlp &>/dev/null; then
    run_step "YouTube Transcripts" \
      "$PYTHON '$SCRIPT_DIR/03_youtube_transcripts.py' --max $MAX_VIDEOS --priority 1"
  else
    echo ""
    echo "  [SKIP] yt-dlp not found. Install: pip install yt-dlp"
    echo "  Then run: python3 03_youtube_transcripts.py --priority 1"
  fi
}

step_forums() {
  run_step "Forum Scraper (JustAnswer, Terry Love, PlumbingZone)" \
    "$PYTHON '$SCRIPT_DIR/04_forum_scraper.py' --pages 50"
}

step_reviews() {
  if [[ -n "${APIFY_API_TOKEN:-}" ]]; then
    run_step "Angi/HomeAdvisor Reviews (Apify)" \
      "$PYTHON '$SCRIPT_DIR/05_angi_reviews.py' --limit 10000"
  else
    echo ""
    echo "  [SKIP] Angi/HomeAdvisor reviews require APIFY_API_TOKEN."
    echo "  Get a free token at: https://apify.com"
    echo "  Then: export APIFY_API_TOKEN=apify_api_xxx && bash 00_collect.sh --step reviews"
  fi
}

step_stackexchange() {
  run_step "Stack Exchange DIY Dump" \
    "$PYTHON '$SCRIPT_DIR/06_stackexchange_dump.py'"
}

step_reddit() {
  # Reddit requires manually downloaded .zst files from Academic Torrents
  local zst_files
  zst_files=$(find "$CORPUS_DIR/output/reddit" -name "*.zst" 2>/dev/null | head -1)
  if [[ -n "$zst_files" ]]; then
    run_step "Reddit/Pushshift Corpus" \
      "$PYTHON '$SCRIPT_DIR/01_reddit_pushshift.py' --from-local '$zst_files' --type posts"
  else
    echo ""
    echo "  [SKIP] Reddit Pushshift corpus requires manual download."
    echo "  Steps:"
    echo "    1. Install a torrent client (qBittorrent etc.)"
    echo "    2. Magnet/torrent: https://academictorrents.com/details/1614740ac8c94505e4ecb9d88be8bed7b6afddd4"
    echo "    3. Download: subreddits/plumbing_submissions.zst, subreddits/HVAC_submissions.zst"
    echo "    4. Place .zst files in: corpus/output/reddit/"
    echo "    5. Run: python3 01_reddit_pushshift.py --from-local /path/to/file.zst --type posts"
    echo "    6. Repeat with --type comments, then --build-pairs-only"
  fi
}

step_lbnl() {
  run_step "LBNL HVAC FDD Dataset" \
    "$PYTHON '$SCRIPT_DIR/07_lbnl_hvac_dataset.py'"
}

step_merge() {
  run_step "Merge All Outputs" \
    "$PYTHON '$SCRIPT_DIR/08_merge_corpus.py'"
}

# ---- Main ----
install_deps

mkdir -p "$CORPUS_DIR/output"/{reddit,reference,youtube,forums,reviews,stackexchange,lbnl_hvac}

if [[ -z "$STEP" ]]; then
  step_reference
  step_lbnl       # no auth required, fast
  step_youtube
  step_forums
  step_reviews
  step_stackexchange
  step_reddit
  step_merge
else
  case "$STEP" in
    reference) step_reference ;;
    youtube) step_youtube ;;
    forums) step_forums ;;
    reviews) step_reviews ;;
    stackexchange) step_stackexchange ;;
    reddit) step_reddit ;;
    lbnl) step_lbnl ;;
    merge) step_merge ;;
    *) echo "Unknown step: $STEP"; exit 1 ;;
  esac
fi

echo ""
echo "========================================"
echo "  Corpus collection run complete."
echo "  Output: $CORPUS_DIR/output/"
echo "========================================"
