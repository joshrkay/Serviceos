#!/bin/bash
set -u
export DOCKER_HOST=unix:///Users/joshuakay/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
T=/Users/joshuakay/.claude/jobs/c58f3967/tmp; L3=/Users/joshuakay/.config/superpowers/worktrees/Serviceos/lane-3
F=packages/api/test/integration/stripe-terminal-doorstep.test.ts
strip(){ sed 's/\x1b\[[0-9;]*m//g'; }
cd "$L3" && git fetch -q origin && git checkout -q -B fix/terminal-test-merge-repair origin/main && git checkout dc1398981 -- "$F"
echo "== repair @ $(git rev-parse --short HEAD) base=origin/main $(date -u +%H:%M:%SZ)" | tee $T/fix-terminal-run.log
echo "-- diff vs main (the three stale lines removed):" | tee -a $T/fix-terminal-run.log
git diff origin/main -- "$F" | grep -E '^[-+]' | grep -vE '^(\+\+\+|---)' | tee -a $T/fix-terminal-run.log
cd packages/api
echo "-- parse (typescript createSourceFile):" | tee -a $T/fix-terminal-run.log
node -e 'const ts=require("typescript"),fs=require("fs");const p="test/integration/stripe-terminal-doorstep.test.ts";const sf=ts.createSourceFile(p,fs.readFileSync(p,"utf8"),ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);console.log("parse diagnostics:",sf.parseDiagnostics.length);' | tee -a $T/fix-terminal-run.log
CID=$(docker run -d --rm -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=serviceos_test -p 127.0.0.1:0:5432 pgvector/pgvector:pg16 -c max_connections=300)
PORT=$(docker port "$CID" 5432 | head -1 | awk -F: '{print $NF}')
for i in $(seq 1 30); do docker exec "$CID" pg_isready -U test -d serviceos_test >/dev/null 2>&1 && break; sleep 1; done
echo "-- RLS_RUNTIME_ROLE=true EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:$PORT/serviceos_test npx vitest run --config vitest.integration.config.ts --reporter=verbose stripe-terminal-doorstep + invoice-webhook-paid" | tee -a $T/fix-terminal-run.log
RLS_RUNTIME_ROLE=true EXTERNAL_TEST_DB_URL="postgres://test:test@localhost:$PORT/serviceos_test" npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/stripe-terminal-doorstep.test.ts test/integration/invoice-webhook-paid.test.ts > $T/fix-terminal-vitest.log 2>&1
echo "vitest exit=$?" | tee -a $T/fix-terminal-run.log
strip < $T/fix-terminal-vitest.log | grep -E '✓|×|↓|Test Files|Tests |expected fail|Transform failed' | tee -a $T/fix-terminal-run.log
echo "-- rows left on the kept container (the F5 victim = the tenant with NO connect account):" | tee -a $T/fix-terminal-run.log
docker exec "$CID" psql -U test -d serviceos_test -P pager=off -c "SELECT left(t.id::text,8) tenant, t.stripe_connect_account_id, i.invoice_number, i.status, i.amount_paid_cents, i.amount_due_cents FROM invoices i JOIN tenants t ON t.id=i.tenant_id ORDER BY i.created_at;" -c "SELECT left(p.tenant_id::text,8) tenant, p.amount_cents, p.status, p.reference_number, p.created_by FROM payments p ORDER BY p.created_at;" -c "SELECT left(tenant_id::text,8) tenant, event_type, count(*) FROM audit_events WHERE event_type IN ('payment.recorded','invoice.status_changed') GROUP BY 1,2 ORDER BY 1,2;" 2>&1 | tee -a $T/fix-terminal-run.log
docker rm -f "$CID" >/dev/null
echo "-- tsc (tsconfig.json, this file only):" | tee -a $T/fix-terminal-run.log
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c 'stripe-terminal-doorstep' | sed 's/^/errors in file: /' | tee -a $T/fix-terminal-run.log
npx tsc --project tsconfig.build.json --noEmit && echo "tsc build clean" | tee -a $T/fix-terminal-run.log
cd "$L3"
git add "$F" && git -c user.name=Claude -c user.email=noreply@anthropic.com commit -q -m "fix(test): repair the merge-damaged Stripe stub in stripe-terminal-doorstep.test.ts

The #1100 merge resolution kept three stale \`if (url.includes(…)) {\` lines
from the pre-review stub next to the fail-closed matchers that replaced them,
so the file has not parsed on main since 521b94c33 (\`Declaration or statement
expected\` at 792:2; vitest: Transform failed, no tests). This restores the
lane head's copy (dc1398981) byte-for-byte — no test semantics change.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push -q -u origin fix/terminal-test-merge-repair && echo "pushed $(git rev-parse --short HEAD)" | tee -a $T/fix-terminal-run.log
echo "== end $(date -u +%H:%M:%SZ)" | tee -a $T/fix-terminal-run.log
