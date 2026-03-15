#!/usr/bin/env bash
# Dev environment setup script for AI Service OS
# Usage: ./scripts/dev-setup.sh

set -euo pipefail

echo "=== AI Service OS — Dev Setup ==="

# Check Node.js version
NODE_VERSION=$(node -v 2>/dev/null || echo "not found")
echo "Node.js: $NODE_VERSION"

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

# Copy .env.example if .env doesn't exist
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "Created .env from .env.example — please update with your values."
else
  echo ".env already exists (or no .env.example found)."
fi

# Build shared package first (other packages depend on it)
echo ""
echo "Building shared package..."
npm run build --workspace=packages/shared

# Type-check all packages
echo ""
echo "Running type check..."
npx tsc --noEmit

echo ""
echo "=== Setup complete ==="
echo "Run 'npm run dev' to start the dev servers."
