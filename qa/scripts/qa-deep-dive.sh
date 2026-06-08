#!/usr/bin/env bash
# Deep QA script — mints HMAC tokens, runs comprehensive API checks
set -euo pipefail

API_URL="https://serviceosapi-development.up.railway.app"
TENANT_A_ID="a948cc66-7279-44bd-9718-4ef7721f9422"
TENANT_B_ID="ce4d752d-651a-4b72-8a01-f7113fba9454"
TENANT_A_CUSTOMER_ID="ad009e33-b141-4485-9030-50c5fe016820"
TENANT_A_JOB_ID="557ffc41-d5bc-48dc-a1a0-f7775cc6c700"
TENANT_B_CUSTOMER_ID="e38746cf-64bb-4d0d-b22d-cfdb2e969d82"

# Token is passed as env var TOKEN_A / TOKEN_B from parent script
TOKEN_A="${TOKEN_A:-}"
TOKEN_B="${TOKEN_B:-}"

PASS=0; FAIL=0; WARN=0
RESULTS=""

check() {
  local id="$1" desc="$2" url="$3" expected="$4" token="${5:-$TOKEN_A}"
  local resp http_code body
  resp=$(curl -s -w "\n__STATUS__%{http_code}__" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    "$url" 2>&1)
  body=$(echo "$resp" | sed '$d')
  http_code=$(echo "$resp" | tail -1 | sed 's/__STATUS__//g' | tr -d '_')
  
  if [[ "$http_code" == "$expected" ]]; then
    echo "✅ $id [$http_code] $desc"
    PASS=$((PASS+1))
    RESULTS+="| ✅ | $id | $desc | $http_code | pass |\n"
  else
    echo "❌ $id [$http_code expected:$expected] $desc"
    echo "   → $(echo "$body" | head -c 200)"
    FAIL=$((FAIL+1))
    RESULTS+="| ❌ | $id | $desc | $http_code (expected $expected) | fail |\n"
  fi
}

check_post() {
  local id="$1" desc="$2" url="$3" data="$4" expected="$5" token="${6:-$TOKEN_A}"
  local resp http_code body
  resp=$(curl -s -w "\n__STATUS__%{http_code}__" \
    -X POST \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "$data" \
    "$url" 2>&1)
  body=$(echo "$resp" | sed '$d')
  http_code=$(echo "$resp" | tail -1 | sed 's/__STATUS__//g' | tr -d '_')
  
  if [[ "$http_code" == "$expected" ]]; then
    echo "✅ $id [$http_code] $desc"
    PASS=$((PASS+1))
    RESULTS+="| ✅ | $id | $desc | $http_code | pass |\n"
    echo "$body"
  else
    echo "❌ $id [$http_code expected:$expected] $desc"
    echo "   → $(echo "$body" | head -c 300)"
    FAIL=$((FAIL+1))
    RESULTS+="| ❌ | $id | $desc | $http_code (expected $expected) | fail |\n"
    echo "$body"
  fi
}

echo "================================================================"
echo "  ServiceOS Deep QA — $(date)"
echo "  API: $API_URL"
echo "  Tenant A: $TENANT_A_ID"
echo "================================================================"
echo ""

echo "--- INFRA ---"
check "INFRA-01" "Health check" "$API_URL/health" "200" "none"
check "INFRA-02" "Ready probe" "$API_URL/ready" "200" "none"

echo ""
echo "--- AUTH ---"
check "AUTH-01" "/api/me (Tenant A)" "$API_URL/api/me" "200"
check "AUTH-02" "/api/me (Tenant B)" "$API_URL/api/me" "200" "$TOKEN_B"
check "AUTH-03" "No token → 401" "$API_URL/api/me" "401" "none"

echo ""
echo "--- CUSTOMERS ---"
check "CUS-01" "List customers (Tenant A)" "$API_URL/api/customers" "200"
check "CUS-02" "Get specific customer" "$API_URL/api/customers/$TENANT_A_CUSTOMER_ID" "200"
check "CUS-03" "Tenant B can't see Tenant A customer" "$API_URL/api/customers/$TENANT_A_CUSTOMER_ID" "404" "$TOKEN_B"

echo ""
echo "--- ESTIMATES ---"
check "EST-01" "List estimates" "$API_URL/api/estimates" "200"

echo ""
echo "--- INVOICES ---"
check "INV-01" "List invoices" "$API_URL/api/invoices" "200"

echo ""
echo "--- JOBS ---"
check "JOB-01" "List jobs" "$API_URL/api/jobs" "200"
check "JOB-02" "Get specific job" "$API_URL/api/jobs/$TENANT_A_JOB_ID" "200"

echo ""
echo "--- APPOINTMENTS ---"
check "APT-01" "List appointments" "$API_URL/api/appointments" "200"

echo ""
echo "--- PROPOSALS ---"
check "PROP-01" "List proposals" "$API_URL/api/proposals" "200"
check "PROP-02" "Proposal inbox" "$API_URL/api/proposals/inbox" "200"

echo ""
echo "--- REPORTS ---"
check "RPT-01" "Money dashboard" "$API_URL/api/reports/money-dashboard" "200"
check "RPT-02" "Revenue by source" "$API_URL/api/reports/revenue-by-source" "200"
check "RPT-03" "Time given back" "$API_URL/api/reports/time-given-back" "200"

echo ""
echo "--- SETTINGS ---"
check "SET-01" "Get tenant settings" "$API_URL/api/settings" "200"

echo ""
echo "--- CATALOG ---"
check "CAT-01" "List catalog items" "$API_URL/api/catalog" "200"

echo ""
echo "--- LEADS ---"
check "LEAD-01" "List leads" "$API_URL/api/leads" "200"

echo ""
echo "--- CONVERSATIONS ---"
check "CONV-01" "List conversations" "$API_URL/api/conversations" "200"

echo ""
echo "--- AGREEMENTS ---"
check "AGR-01" "List service agreements" "$API_URL/api/agreements" "200"

echo ""
echo "--- TIME ENTRIES ---"
check "TIME-01" "List time entries" "$API_URL/api/time-entries" "200"

echo ""
echo "--- LOCATIONS ---"
check "LOC-01" "List service locations" "$API_URL/api/service-locations" "200"

echo ""
echo "--- NOTES ---"
check "NOTE-01" "List notes for job" "$API_URL/api/jobs/$TENANT_A_JOB_ID/notes" "200"

echo ""
echo "--- VOICE ---"
check "VOI-01" "Voice recordings" "$API_URL/api/voice/recordings" "200"

echo ""
echo "--- ASSISTANT ---"
check "AST-01" "Assistant context" "$API_URL/api/assistant/context" "200"

echo ""
echo "--- ISOLATION TEST ---"
check "ISO-01" "B can't see A's job" "$API_URL/api/jobs/$TENANT_A_JOB_ID" "404" "$TOKEN_B"
check "ISO-02" "B can't see A's customer" "$API_URL/api/customers/$TENANT_A_CUSTOMER_ID" "404" "$TOKEN_B"

echo ""
echo "================================================================"
echo "  RESULTS: ✅ $PASS passed  ❌ $FAIL failed  ⚠️  $WARN warned"
echo "================================================================"
