#!/usr/bin/env bash
# ServiceOS Training Pipeline — Mac mini setup
#
# Usage:  chmod +x 00_setup.sh && ./00_setup.sh
#
# Idempotent: safe to re-run.

set -euo pipefail

DATA_DIR="${SERVICEOS_DATA_DIR:-$HOME/serviceos_data}"
ENV_FILE="$DATA_DIR/.env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$*"; }

bold "ServiceOS training pipeline setup"
echo  "  data dir : $DATA_DIR"
echo  "  scripts  : $SCRIPT_DIR"
echo

# ------------------------------------------------------------
# 1. python3
# ------------------------------------------------------------
bold "1/5  python3"
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. Install Python 3.11+ (brew install python@3.11) and re-run." >&2
  exit 1
fi
PY_VER="$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
ok "python3 $PY_VER"

# ------------------------------------------------------------
# 2. virtualenv
# ------------------------------------------------------------
bold "2/5  virtualenv"
VENV="$DATA_DIR/.venv"
mkdir -p "$DATA_DIR"
if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
  ok "created $VENV"
else
  ok "exists $VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
python3 -m pip install --quiet --upgrade pip

# ------------------------------------------------------------
# 3. python deps
# ------------------------------------------------------------
bold "3/5  python deps"
REQ="$SCRIPT_DIR/requirements.txt"
if [ ! -f "$REQ" ]; then
  echo "missing $REQ" >&2
  exit 1
fi
python3 -m pip install --quiet -r "$REQ"
ok "installed: $(tr '\n' ' ' < "$REQ")"

# ------------------------------------------------------------
# 4. data dirs
# ------------------------------------------------------------
bold "4/5  data dirs"
mkdir -p "$DATA_DIR/torrents" "$DATA_DIR/checkpoints" "$DATA_DIR/logs"
ok "$DATA_DIR/torrents       (drop the four .zst files here)"
ok "$DATA_DIR/checkpoints    (resume offsets, written by the processor)"
ok "$DATA_DIR/logs           (processor stdout/stderr)"

# ------------------------------------------------------------
# 5. .env template
# ------------------------------------------------------------
bold "5/5  .env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
# ServiceOS training pipeline — Mac mini secrets
# Fill these in, then re-run the processor.

SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...                  # service role, NOT anon

# Optional — only needed when generating embeddings (later pass)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Tunables
BATCH_SIZE=250
CHUNK_BYTES=1048576       # 1 MiB
EOF
  ok "wrote template $ENV_FILE — fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY"
else
  warn "exists $ENV_FILE (leaving alone)"
fi

# ------------------------------------------------------------
echo
bold "Done."
cat <<EOF

Next steps:
  1. Open Supabase → SQL Editor → paste $SCRIPT_DIR/01_schema.sql → Run
  2. Edit $ENV_FILE and fill in your Supabase service role key
  3. Drop the four torrent .zst files into $DATA_DIR/torrents/
       Plumbing_submissions.zst
       HVAC_submissions.zst
       HomeImprovement_submissions.zst
       DIY_submissions.zst
  4. Dry run :  source $VENV/bin/activate && \\
                python3 $SCRIPT_DIR/02_reddit_processor.py --dry-run --max-records 2000
  5. Full run:  python3 $SCRIPT_DIR/02_reddit_processor.py
EOF
