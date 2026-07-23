#!/usr/bin/env bash
# sync-dev-env-from-cloud.sh — populate gitignored **Development** env files from cloud agent secrets.
#
# Requires in shell (must be sk_test_ / pk_test_ — never sk_live_):
#   DATABASE_URL (or /opt/cursor/artifacts/railway-database-url.env)
#   CLERK_SECRET_KEY
#   VITE_CLERK_PUBLISHABLE_KEY (or CLERK_PUBLISHABLE_KEY)
#
# Usage:
#   source /opt/cursor/artifacts/railway-database-url.env  # optional
#   bash scripts/sync-dev-env-from-cloud.sh
#
# Does NOT write .env.production.local or modify Railway production.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f /opt/cursor/artifacts/railway-database-url.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /opt/cursor/artifacts/railway-database-url.env
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL required}"
: "${CLERK_SECRET_KEY:?CLERK_SECRET_KEY required}"
PK="${CLERK_PUBLISHABLE_KEY:-${VITE_CLERK_PUBLISHABLE_KEY:-}}"
: "${PK:?CLERK_PUBLISHABLE_KEY or VITE_CLERK_PUBLISHABLE_KEY required}"

if [[ "$CLERK_SECRET_KEY" == sk_live_* ]] || [[ "$PK" == pk_live_* ]]; then
  echo "ERROR: sync-dev-env refuses live Clerk keys (sk_live_/pk_live_)." >&2
  echo "       This script only writes Development local env files." >&2
  echo "       For production probes use: source scripts/load-prod-env.sh" >&2
  exit 1
fi

cat > .env.qa << EOF
# Synced from Railway Development ($(date -u +%Y-%m-%dT%H:%M:%SZ))
export E2E_BASE_URL="https://serviceosweb-development.up.railway.app"
export E2E_API_URL="https://serviceosapi-development.up.railway.app"
export E2E_DB_URL_READWRITE="${DATABASE_URL}"
export E2E_DB_URL_READONLY="${DATABASE_URL}"
export E2E_CLERK_HMAC_SECRET="${CLERK_SECRET_KEY}"
export E2E_CLERK_PUBLISHABLE_KEY="${PK}"
export E2E_CLERK_SECRET_KEY="${CLERK_SECRET_KEY}"
EOF

# Pull tenant UUIDs from dev Postgres if node/pg available
if node -e "require('pg')" >/dev/null 2>&1; then
  node << 'NODE' >> .env.qa
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  async function ids(slug) {
    const t = await c.query('SELECT id FROM tenants WHERE owner_id = $1', [`qa:${slug}`]);
    if (!t.rows[0]) return null;
    const tid = t.rows[0].id;
    const cust = await c.query('SELECT id FROM customers WHERE tenant_id=$1 AND display_name=$2', [tid, `${slug}-customer`]);
    const job = await c.query('SELECT id FROM jobs WHERE tenant_id=$1 ORDER BY created_at LIMIT 1', [tid]);
    return { tid, cust: cust.rows[0]?.id, job: job.rows[0]?.id };
  }
  const a = await ids('qa-matrix-A');
  const b = await ids('qa-matrix-B');
  if (a) {
    console.log(`export E2E_TENANT_A_ID=${a.tid}`);
    console.log(`export E2E_TENANT_A_CUSTOMER_ID=${a.cust}`);
    console.log(`export E2E_TENANT_A_JOB_ID=${a.job}`);
  }
  if (b) {
    console.log(`export E2E_TENANT_B_ID=${b.tid}`);
    console.log(`export E2E_TENANT_B_CUSTOMER_ID=${b.cust}`);
    console.log(`export E2E_TENANT_B_JOB_ID=${b.job}`);
  }
  console.log('export QA_TENANT_ID=b8e2dc0f-04c2-4ba0-9385-0ebcf3168052');
  console.log('export QA_ACTOR_ID=25abab01-4303-4626-9672-af9a19bf6a64');
  await c.end();
})().catch(e => { console.error(e.message); process.exit(0); });
NODE
fi

cat > .env << EOF
# Synced from Railway Development
PORT=3000
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173
WEB_URL=http://localhost:5173
VITE_API_URL=https://serviceosapi-development.up.railway.app
VITE_ONBOARDING_V2_ENABLED=true
CLERK_DEV_HMAC_TOKENS=true
DATABASE_URL=${DATABASE_URL}
CLERK_SECRET_KEY=${CLERK_SECRET_KEY}
CLERK_PUBLISHABLE_KEY=${PK}
VITE_CLERK_PUBLISHABLE_KEY=${PK}
EOF

cat > packages/api/.env << EOF
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173
CLERK_DEV_HMAC_TOKENS=true
DATABASE_URL=${DATABASE_URL}
CLERK_SECRET_KEY=${CLERK_SECRET_KEY}
CLERK_PUBLISHABLE_KEY=${PK}
EOF

cat > packages/web/.env.local << EOF
VITE_API_URL=https://serviceosapi-development.up.railway.app
VITE_ONBOARDING_V2_ENABLED=true
VITE_CLERK_PUBLISHABLE_KEY=${PK}
EOF

echo "Synced dev env files in $ROOT"
echo "Next: source scripts/load-dev-env.sh && npm run qa:doctor"
