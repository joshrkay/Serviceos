#!/bin/bash
# ============================================================
# ServiceOS Training Data Pipeline — Mac Mini Setup
# Run this once to install dependencies and configure env
# ============================================================

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ServiceOS Training Corpus — Mac Mini Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Python dependencies ──────────────────────────────────
echo ""
echo "▶ Installing Python dependencies..."
pip3 install \
  zstandard \
  supabase \
  python-dotenv \
  openai \
  tqdm \
  langdetect \
  pandas \
  pyarrow

echo "✓ Python deps installed"

# ── 2. Data directory ────────────────────────────────────────
DATA_DIR="$HOME/serviceos_data"
mkdir -p "$DATA_DIR"
echo "✓ Data dir: $DATA_DIR"

# ── 3. .env file (if not already present) ───────────────────
ENV_FILE="$HOME/serviceos_data/.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" << EOF
# ServiceOS Training Pipeline — Environment Config
# Fill in your Supabase credentials

SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_KEY=eyYourServiceRoleKeyHere

# Optional: for embedding generation
OPENAI_API_KEY=sk-your-key-here

# Data directory (where .zst files live)
DATA_DIR=${DATA_DIR}
EOF
  echo "✓ Created $ENV_FILE — fill in your Supabase credentials"
else
  echo "✓ .env already exists at $ENV_FILE"
fi

# ── 4. Torrent client check ──────────────────────────────────
echo ""
echo "▶ Checking for torrent client..."
if command -v transmission-cli &> /dev/null; then
  echo "✓ transmission-cli found"
elif command -v brew &> /dev/null; then
  echo "  Installing transmission-cli via Homebrew..."
  brew install transmission-cli
  echo "✓ transmission-cli installed"
else
  echo "  ⚠ Homebrew not found. Install manually:"
  echo "    https://transmissionbt.com/download"
fi

# ── 5. Print torrent instructions ───────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " NEXT STEP: Download the Reddit data"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " 1. Open this URL in a browser to get the torrent file:"
echo "    https://academictorrents.com/details/1614740ac8c94505e4ecb9d88be8bed7b6afddd4"
echo ""
echo " 2. In your torrent client, select ONLY these files:"
echo "    ✓ Plumbing_submissions.zst          (~800MB)"
echo "    ✓ HVAC_submissions.zst              (~300MB)"
echo "    ✓ HomeImprovement_submissions.zst   (~2.5GB)"
echo "    ✓ DIY_submissions.zst               (~1.2GB)"
echo "    ✓ Plumbing_comments.zst             (~1.5GB)  [optional, more data]"
echo "    ✓ HVAC_comments.zst                 (~600MB)  [optional]"
echo ""
echo " 3. Save to: $DATA_DIR"
echo ""
echo " 4. Run the processor:"
echo "    cd \"$SCRIPT_DIR\""
echo "    python3 02_reddit_processor.py --dry-run --max-records 1000"
echo "    # If dry run looks good:"
echo "    python3 02_reddit_processor.py"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " OPTIONAL: Also download these FREE datasets"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " Roboflow plumbing parts images (957 labeled):"
echo "   https://universe.roboflow.com/plumbing/plumbing-model"
echo ""
echo " Roboflow blueprint detection (4,813 images):"
echo "   https://universe.roboflow.com/kobidding/cobidding-plumbing-model"
echo ""
echo " Kaggle call center transcripts:"
echo "   https://www.kaggle.com/datasets/oleksiymaliovanyy/call-center-transcripts-dataset"
echo ""
echo " ✓ Setup complete. Fill in .env and download torrent files."
