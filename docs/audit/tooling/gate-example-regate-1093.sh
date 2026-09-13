#!/bin/bash
set -u
export DOCKER_HOST=unix:///Users/joshuakay/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
T=/Users/joshuakay/.claude/jobs/c58f3967/tmp
W=/Users/joshuakay/.config/superpowers/worktrees/Serviceos/rung-map-lane
L3=/Users/joshuakay/.config/superpowers/worktrees/Serviceos/lane-3
before=$(docker ps -q | sort)
strip(){ sed 's/\x1b\[[0-9;]*m//g'; }

# ---- A: 7.6 rerun at the batch-6 head
cd "$W"
echo "== 7.6 rerun @ $(git rev-parse --short HEAD) ($(git branch --show-current)) $(date -u +%H:%M:%SZ)" | tee $T/rerun-7-6.log
DBU=$(TESTCONTAINERS_RYUK_DISABLED=true npx tsx e2e/fixtures/setup-test-db.ts 2>&1 | tee $T/rerun-7-6-setupdb.log | grep -oE "postgres://[^ \"']+" | tail -1)
echo "db=$DBU" | tee -a $T/rerun-7-6.log
env CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL="$DBU" E2E_USE_TEST_DB=true VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== STRIPE_WEBHOOK_SECRET=whsec_e2e_public_pay_link_test_secret npx playwright test e2e/journeys/public-estimate-approve-sign.spec.ts --project=chromium --retries=0 --workers=1 > $T/rerun-7-6-spec.log 2>&1
rc=$?
echo "7.6 exit=$rc : $(strip < $T/rerun-7-6-spec.log | grep -E '^\s+[0-9]+ (passed|failed|flaky)' | tr '\n' ' ')" | tee -a $T/rerun-7-6.log
strip < $T/rerun-7-6-spec.log | grep -nE 'send estimate|Error:|^\s+(✘|✓)' | head -20 | tee -a $T/rerun-7-6.log
strip < $T/rerun-7-6-spec.log | grep -E '"route":"/api/estimates/[^"]*/send"' | grep -oE '"response":\{[^}]*\}' | head -3 | tee -a $T/rerun-7-6.log

# ---- B: #1093 re-gate at the moved head (test-only delta since the gated 41d025305)
cd "$L3" && git fetch -q origin fix/users-update-tenant-predicate && git checkout -q fix/users-update-tenant-predicate && git reset -q --hard origin/fix/users-update-tenant-predicate
H=$(git rev-parse --short HEAD)
echo "== #1093 re-gate @ $H $(date -u +%H:%M:%SZ); delta vs gated 41d025305: $(git diff --stat 41d025305 HEAD | tail -1); product files in delta: $(git diff --name-only 41d025305 HEAD | grep -c 'packages/.*/src/')" | tee $T/gate-1093c-run.log
CID=$(docker run -d --rm -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=serviceos_test -p 127.0.0.1:0:5432 pgvector/pgvector:pg16 -c max_connections=300)
PORT=$(docker port "$CID" 5432 | head -1 | awk -F: '{print $NF}')
sleep 5
cd packages/api
RLS_RUNTIME_ROLE=true EXTERNAL_TEST_DB_URL="postgres://test:test@localhost:$PORT/serviceos_test" npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/users-update-tenant-predicate.test.ts test/integration/clerk-owner-membership.test.ts > $T/gate-1093c-int.log 2>&1
echo "integration exit=$? (EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:$PORT/serviceos_test)" | tee -a $T/gate-1093c-run.log
strip < $T/gate-1093c-int.log | grep -E '✓|×|Test Files|Tests ' | tee -a $T/gate-1093c-run.log
echo "-- rows left on the kept container" | tee -a $T/gate-1093c-run.log
docker exec "$CID" psql -U test -d serviceos_test -P pager=off -c "SELECT left(tenant_id::text,8) t, count(*) users FROM users GROUP BY 1 ORDER BY 1;" -c "SELECT left(tenant_id::text,8) t, event_type, count(*) FROM audit_events WHERE event_type LIKE 'user.%' OR event_type LIKE 'team.%' GROUP BY 1,2 ORDER BY 1,2;" 2>&1 | tee -a $T/gate-1093c-run.log
docker rm -f "$CID" >/dev/null 2>&1
cd "$L3"
DBU=$(TESTCONTAINERS_RYUK_DISABLED=true npx tsx e2e/fixtures/setup-test-db.ts 2>&1 | grep -oE "postgres://[^ \"']+" | tail -1)
echo "-- accept-invitation (1.11) at $H, db=$DBU" | tee -a $T/gate-1093c-run.log
env CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL="$DBU" E2E_USE_TEST_DB=true VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== npx playwright test e2e/journeys/accept-invitation.spec.ts --project=chromium --retries=0 --workers=1 > $T/gate-1093c-e2e.log 2>&1
echo "accept-invitation exit=$? : $(strip < $T/gate-1093c-e2e.log | grep -E '^\s+[0-9]+ (passed|failed|flaky)' | tr '\n' ' ')" | tee -a $T/gate-1093c-run.log
strip < $T/gate-1093c-e2e.log | grep -E '^\s+(✘|✓)' | tee -a $T/gate-1093c-run.log
echo "== end $(date -u +%H:%M:%SZ)" | tee -a $T/gate-1093c-run.log

# ---- cleanup: only containers this script created
after=$(docker ps -q | sort)
comm -13 <(echo "$before") <(echo "$after") | xargs -r docker rm -f >/dev/null 2>&1
echo "ALL DONE $(date -u +%H:%M:%SZ)"
