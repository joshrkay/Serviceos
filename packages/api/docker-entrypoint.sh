#!/bin/sh
set -e

echo "[entrypoint] Starting migrations..."
node packages/api/dist/src/db/migrate.js
echo "[entrypoint] Migrations done. Starting API server..."
exec node packages/api/dist/src/index.js
