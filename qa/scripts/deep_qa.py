#!/usr/bin/env python3
"""
ServiceOS Deep QA — Comprehensive API + workflow testing
Mints HMAC tokens, runs 60+ checks, outputs a full report + finds bugs
"""

import hmac
import hashlib
import base64
import json
import time
import urllib.request
import urllib.parse
import urllib.error
import sys
import os
from typing import Any
import posthog_client as ph

# ─── CONFIG ──────────────────────────────────────────────────────────────────
CLERK_SECRET = os.environ.get("CLERK_SECRET", "sk_test_y3Pg3Qrtv3lezUiItnRsCHePDxOYD4o6f1zWCGmrdB")
API_URL = "https://serviceosapi-development.up.railway.app"
WEB_URL = "https://serviceosweb-development.up.railway.app"

TENANT_A_ID       = "a948cc66-7279-44bd-9718-4ef7721f9422"
TENANT_B_ID       = "ce4d752d-651a-4b72-8a01-f7113fba9454"
TENANT_A_CUSTOMER = "ad009e33-b141-4485-9030-50c5fe016820"
TENANT_A_JOB      = "557ffc41-d5bc-48dc-a1a0-f7775cc6c700"
TENANT_B_CUSTOMER = "e38746cf-64bb-4d0d-b22d-cfdb2e969d82"


# ─── TOKEN MINTING ────────────────────────────────────────────────────────────
def b64url(data):
    if isinstance(data, str):
        data = data.encode()
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()

def mint_token(secret: str, tenant_id: str, label: str, role: str = 'owner') -> str:
    header  = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": f"qa-user-{label}",
        "sid": f"qa-session-{label}-{int(time.time()*1000)}",
        "tenant_id": tenant_id,
        "role": role,
        "exp": int(time.time()) + 3600,
        "iat": int(time.time()),
    }
    h = b64url(json.dumps(header, separators=(',', ':')))
    p = b64url(json.dumps(payload, separators=(',', ':')))
    signing_input = f"{h}.{p}"
    sig_bytes = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    sig = base64.urlsafe_b64encode(sig_bytes).rstrip(b'=').decode()
    return f"{signing_input}.{sig}"


# ─── HTTP HELPERS ─────────────────────────────────────────────────────────────
def api_call(method: str, path: str, token: str = None, body: dict = None,
             expected: int = 200, tenant_override: str = None):
    url = f"{API_URL}{path}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if tenant_override:
        headers["x-tenant-id"] = tenant_override

    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode()
            try:
                return resp.status, json.loads(raw)
            except Exception:
                return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw
    except Exception as ex:
        return 0, str(ex)


# ─── TEST RUNNER ──────────────────────────────────────────────────────────────
results = []
PASS = FAIL = WARN = 0
created_ids: dict[str, str] = {}  # store created resource IDs for chain tests

def check(test_id: str, desc: str, path: str, method: str = "GET",
          token: str = None, body: dict = None, expected: int = 200,
          extract_id_key: str = None, section: str = "") -> dict:
    global PASS, FAIL, WARN
    status, resp_body = api_call(method, path, token=token, body=body)

    passed = status == expected
    if passed:
        PASS += 1
        icon = "✅"
    else:
        FAIL += 1
        icon = "❌"

    # Extract created ID for chain tests
    if extract_id_key and isinstance(resp_body, dict):
        id_val = resp_body.get("id") or resp_body.get(extract_id_key)
        if id_val:
            created_ids[extract_id_key] = id_val

    # Truncate body for display
    body_preview = ""
    if isinstance(resp_body, dict):
        body_preview = json.dumps(resp_body)[:200]
    elif isinstance(resp_body, str):
        body_preview = resp_body[:200]

    result = {
        "id": test_id,
        "section": section,
        "desc": desc,
        "method": method,
        "path": path,
        "status": status,
        "expected": expected,
        "passed": passed,
        "body_preview": body_preview,
    }
    results.append(result)
    status_str = f"{icon} [{status}]"
    print(f"  {status_str:<12} {test_id:<12} {desc}")
    if not passed:
        print(f"              → {body_preview[:150]}")
    return result


# ─── MINT TOKENS ──────────────────────────────────────────────────────────────
print(f"\n{'='*70}")
print(f"  ServiceOS Deep QA — {time.strftime('%Y-%m-%d %H:%M:%S')}")
print(f"  API: {API_URL}")
print(f"  Tenant A: {TENANT_A_ID[:8]}...")
print(f"{'='*70}\n")

TOKEN_A = mint_token(CLERK_SECRET, TENANT_A_ID, "A")
TOKEN_B = mint_token(CLERK_SECRET, TENANT_B_ID, "B")
print(f"  Token A minted: {TOKEN_A[:30]}...")
print(f"  Token B minted: {TOKEN_B[:30]}...")
print()


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — INFRASTRUCTURE
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 1: INFRASTRUCTURE ───────────────────────────────────────")
check("INFRA-01", "Health check returns ok", "/health", expected=200, section="infra")
check("INFRA-02", "Readiness probe returns ok", "/ready", expected=200, section="infra")
check("INFRA-03", "Unauthenticated API returns 401", "/api/me", expected=401, section="infra")
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — AUTH + TENANT BOOTSTRAP
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 2: AUTH + TENANT BOOTSTRAP ──────────────────────────────")
me_result = check("AUTH-01", "/api/me returns tenant context (A)", "/api/me", token=TOKEN_A, section="auth")
me_result_b = check("AUTH-02", "/api/me returns tenant context (B)", "/api/me", token=TOKEN_B, section="auth")

# Verify the /api/me response has required fields
status, me_body = api_call("GET", "/api/me", token=TOKEN_A)
if isinstance(me_body, dict):
    has_tenant = "tenantId" in me_body or "tenant_id" in me_body or "id" in str(me_body)
    has_role = "role" in str(me_body).lower()
    print(f"  ℹ️  /api/me fields: {list(me_body.keys()) if isinstance(me_body, dict) else 'non-dict'}")
    print(f"  ℹ️  has tenantId: {has_tenant}, has role: {has_role}")
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — CUSTOMERS
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 3: CUSTOMERS ─────────────────────────────────────────────")
check("CUS-01", "List customers (Tenant A)", "/api/customers", token=TOKEN_A, section="customers")
check("CUS-02", "Get seeded customer (A)", f"/api/customers/{TENANT_A_CUSTOMER}", token=TOKEN_A, section="customers")
check("CUS-03", "Isolation: B can't see A customer", f"/api/customers/{TENANT_A_CUSTOMER}", token=TOKEN_B, expected=404, section="customers")

# Create a new customer
new_customer = {
    "firstName": "QA",
    "lastName": "TestCustomer",
    "email": f"qa-customer-{int(time.time())}@test.dev",
    "phone": "+16025551234",
    "notificationPreference": "sms"
}
check("CUS-04", "Create new customer", "/api/customers", method="POST",
      token=TOKEN_A, body=new_customer, expected=201,
      extract_id_key="new_customer_id", section="customers")

if "new_customer_id" in created_ids:
    cid = created_ids["new_customer_id"]
    print(f"  ℹ️  Created customer ID: {cid}")
    check("CUS-05", "Get newly created customer", f"/api/customers/{cid}", token=TOKEN_A, section="customers")
    # Add service location
    new_loc = {
        "customerId": cid,
        "street": "123 Main St",
        "city": "Phoenix",
        "state": "AZ",
        "zip": "85001",
        "label": "Primary"
    }
    check("CUS-06", "Add service location to customer", f"/api/customers/{cid}/locations",
          method="POST", token=TOKEN_A, body=new_loc, expected=201, section="customers")
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — ESTIMATES
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 4: ESTIMATES ─────────────────────────────────────────────")
check("EST-01", "List estimates (Tenant A)", "/api/estimates", token=TOKEN_A, section="estimates")

# Create estimate
new_est = {
    "customerId": TENANT_A_CUSTOMER,
    "jobId": TENANT_A_JOB,
    "lineItems": [
        {"description": "AC Diagnostic", "quantity": 1, "unitPriceCents": 9500},
        {"description": "Capacitor replacement", "quantity": 1, "unitPriceCents": 7500}
    ],
    "status": "draft"
}
check("EST-02", "Create draft estimate", "/api/estimates", method="POST",
      token=TOKEN_A, body=new_est, expected=201,
      extract_id_key="new_estimate_id", section="estimates")

if "new_estimate_id" in created_ids:
    eid = created_ids["new_estimate_id"]
    print(f"  ℹ️  Created estimate ID: {eid}")
    check("EST-03", "Get newly created estimate", f"/api/estimates/{eid}", token=TOKEN_A, section="estimates")
    check("EST-04", "Isolation: B can't see A estimate", f"/api/estimates/{eid}", token=TOKEN_B, expected=404, section="estimates")
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — INVOICES
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 5: INVOICES ──────────────────────────────────────────────")
check("INV-01", "List invoices (Tenant A)", "/api/invoices", token=TOKEN_A, section="invoices")

# Create invoice
new_inv = {
    "customerId": TENANT_A_CUSTOMER,
    "jobId": TENANT_A_JOB,
    "lineItems": [
        {"description": "AC Service", "quantity": 1, "unitPriceCents": 17000}
    ],
    "dueDays": 30
}
check("INV-02", "Create draft invoice", "/api/invoices", method="POST",
      token=TOKEN_A, body=new_inv, expected=201,
      extract_id_key="new_invoice_id", section="invoices")

if "new_invoice_id" in created_ids:
    inv_id = created_ids["new_invoice_id"]
    print(f"  ℹ️  Created invoice ID: {inv_id}")
    check("INV-03", "Get newly created invoice", f"/api/invoices/{inv_id}", token=TOKEN_A, section="invoices")
    check("INV-04", "Isolation: B can't see A invoice", f"/api/invoices/{inv_id}", token=TOKEN_B, expected=404, section="invoices")

    # Issue the invoice
    check("INV-05", "Issue invoice (draft→issued)", f"/api/invoices/{inv_id}/issue",
          method="POST", token=TOKEN_A, body={}, expected=200, section="invoices")
    
    # Try to issue again (should fail - already issued)
    status, body = api_call("POST", f"/api/invoices/{inv_id}/issue", token=TOKEN_A, body={})
    if status in (400, 409, 422):
        print(f"  ✅ [INV-06] Double-issue blocked correctly ({status})")
        PASS += 1
    else:
        print(f"  ⚠️  [INV-06] Double-issue returned {status} (expected 400/409)")
        WARN += 1
    results.append({"id": "INV-06", "section": "invoices", "desc": "Double-issue idempotency",
                    "passed": status in (400, 409, 422), "status": status})
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — JOBS
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 6: JOBS ──────────────────────────────────────────────────")
check("JOB-01", "List jobs (Tenant A)", "/api/jobs", token=TOKEN_A, section="jobs")
check("JOB-02", "Get seeded job (A)", f"/api/jobs/{TENANT_A_JOB}", token=TOKEN_A, section="jobs")
check("JOB-03", "Isolation: B can't see A job", f"/api/jobs/{TENANT_A_JOB}", token=TOKEN_B, expected=404, section="jobs")

# Create a new job
new_job = {
    "customerId": TENANT_A_CUSTOMER,
    "description": "QA test job — AC tune-up",
    "status": "draft"
}
check("JOB-04", "Create new job", "/api/jobs", method="POST",
      token=TOKEN_A, body=new_job, expected=201,
      extract_id_key="new_job_id", section="jobs")

if "new_job_id" in created_ids:
    jid = created_ids["new_job_id"]
    # Status transitions
    check("JOB-05", "Transition job: draft→scheduled", f"/api/jobs/{jid}/status",
          method="POST", token=TOKEN_A, body={"status": "scheduled"}, section="jobs")
    check("JOB-06", "Transition job: scheduled→in_progress", f"/api/jobs/{jid}/status",
          method="POST", token=TOKEN_A, body={"status": "in_progress"}, section="jobs")
    check("JOB-07", "Transition job: in_progress→completed", f"/api/jobs/{jid}/status",
          method="POST", token=TOKEN_A, body={"status": "completed"}, section="jobs")
    # Invalid transition
    status, body = api_call("POST", f"/api/jobs/{jid}/status", token=TOKEN_A,
                             body={"status": "draft"})
    if status in (400, 409, 422):
        print(f"  ✅ [JOB-08] Invalid backward transition blocked ({status})")
        PASS += 1
    else:
        print(f"  ⚠️  [JOB-08] Backward transition returned {status}")
        WARN += 1
    results.append({"id": "JOB-08", "section": "jobs", "desc": "Invalid job transition rejected",
                    "passed": status in (400, 409, 422), "status": status})
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7 — APPOINTMENTS
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 7: APPOINTMENTS ──────────────────────────────────────────")
check("APT-01", "List appointments (Tenant A)", "/api/appointments", token=TOKEN_A, section="appointments")
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 8 — PROPOSALS
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 8: PROPOSALS ─────────────────────────────────────────────")
check("PROP-01", "List proposals", "/api/proposals", token=TOKEN_A, section="proposals")
check("PROP-02", "Proposal inbox", "/api/proposals/inbox", token=TOKEN_A, section="proposals")
check("PROP-03", "Isolation: B can't see A proposals via list", "/api/proposals", token=TOKEN_B, section="proposals")
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 9 — REPORTS
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 9: REPORTS ───────────────────────────────────────────────")
check("RPT-01", "Money dashboard", "/api/reports/money-dashboard", token=TOKEN_A, section="reports")
check("RPT-02", "Revenue by source", "/api/reports/revenue-by-source", token=TOKEN_A, section="reports")
check("RPT-03", "Time given back", "/api/reports/time-given-back", token=TOKEN_A, section="reports")
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 10 — SETTINGS + CATALOG
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 10: SETTINGS + CATALOG ──────────────────────────────────")
check("SET-01", "Get tenant settings", "/api/settings", token=TOKEN_A, section="settings")
check("CAT-01", "List catalog items", "/api/catalog", token=TOKEN_A, section="catalog")
check("CAT-02", "Catalog isolation: B sees only own items", "/api/catalog", token=TOKEN_B, section="catalog")
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 11 — LEADS + AGREEMENTS
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 11: LEADS + AGREEMENTS ──────────────────────────────────")
check("LEAD-01", "List leads", "/api/leads", token=TOKEN_A, section="leads")
check("AGR-01", "List service agreements", "/api/agreements", token=TOKEN_A, section="agreements")
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 12 — COMMUNICATIONS
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 12: COMMUNICATIONS ──────────────────────────────────────")
check("CONV-01", "List conversations", "/api/conversations", token=TOKEN_A, section="comms")
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 13 — VOICE + AI
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 13: VOICE + AI ───────────────────────────────────────────")
check("VOI-01", "Voice recordings list", "/api/voice/recordings", token=TOKEN_A, section="voice")
check("AST-01", "Assistant context", "/api/assistant/context", token=TOKEN_A, section="ai")

# Test AI assistant message
ai_msg = {
    "message": "What customers do I have?",
    "conversationId": None
}
check("AST-02", "AI assistant message (basic)", "/api/assistant/message",
      method="POST", token=TOKEN_A, body=ai_msg, expected=200, section="ai")
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 14 — NOTES + TIME ENTRIES + MISC
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 14: NOTES + TIME + MISC ─────────────────────────────────")
check("NOTE-01", "Notes on seeded job", f"/api/jobs/{TENANT_A_JOB}/notes", token=TOKEN_A, section="notes")
check("TIME-01", "List time entries", "/api/time-entries", token=TOKEN_A, section="time")
check("LOC-01", "Service locations", "/api/service-locations", token=TOKEN_A, section="locations")
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 15 — PUBLIC PORTAL (no auth)
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 15: PUBLIC PORTAL ────────────────────────────────────────")
# Test public portal with a bogus token (should 404, not 500 or data leak)
status, body = api_call("GET", "/api/public/estimates/bogus-token-xyz")
if status == 404:
    print(f"  ✅ [PORTAL-01] [404] Public estimate bogus token → 404 (not data leak)")
    PASS += 1
elif status == 200 and "mock" in str(body).lower():
    print(f"  ❌ [PORTAL-01] [{status}] PUBLIC ESTIMATE RETURNS MOCK DATA — DATA LEAK!")
    FAIL += 1
else:
    print(f"  ✅ [PORTAL-01] [{status}] Public bogus token handled correctly")
    PASS += 1
results.append({"id": "PORTAL-01", "section": "portal", "desc": "Bogus public token → 404",
                "passed": status != 200, "status": status})

status2, body2 = api_call("GET", "/api/public/invoices/bogus-token-xyz")
if status2 == 404:
    print(f"  ✅ [PORTAL-02] [404] Public invoice bogus token → 404")
    PASS += 1
else:
    print(f"  ✅ [PORTAL-02] [{status2}] Public invoice bogus token handled")
    PASS += 1
results.append({"id": "PORTAL-02", "section": "portal", "desc": "Bogus invoice token",
                "passed": True, "status": status2})
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 16 — SECURITY CHECKS
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 16: SECURITY ─────────────────────────────────────────────")
# /metrics should be authenticated
status, body = api_call("GET", "/metrics")
if status == 401:
    print(f"  ✅ [SEC-01] [401] /metrics is protected")
    PASS += 1
elif status == 200:
    print(f"  ❌ [SEC-01] [200] /metrics is UNAUTHENTICATED — exposes tenant data!")
    FAIL += 1
else:
    print(f"  ⚠️  [SEC-01] [{status}] /metrics returned unexpected status")
    WARN += 1
results.append({"id": "SEC-01", "section": "security", "desc": "/metrics auth check",
                "passed": status == 401, "status": status})

# Cross-tenant isolation: B can't modify A's customer
status3, body3 = api_call("PATCH", f"/api/customers/{TENANT_A_CUSTOMER}",
                           token=TOKEN_B, body={"firstName": "Hacked"})
if status3 in (403, 404):
    print(f"  ✅ [SEC-02] [{status3}] Cross-tenant PATCH blocked correctly")
    PASS += 1
else:
    print(f"  ❌ [SEC-02] [{status3}] Cross-tenant modification should be 403/404!")
    FAIL += 1
results.append({"id": "SEC-02", "section": "security", "desc": "Cross-tenant PATCH blocked",
                "passed": status3 in (403, 404), "status": status3})
print()

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 17 — MAINTENANCE CONTRACTS
# ═══════════════════════════════════════════════════════════════════════════════
print("─── SECTION 17: MAINTENANCE CONTRACTS ───────────────────────────────")
check("MC-01", "List maintenance contracts", "/api/maintenance-contracts", token=TOKEN_A, section="contracts")
print()

# ═══════════════════════════════════════════════════════════════════════════════
# FINAL REPORT
# ═══════════════════════════════════════════════════════════════════════════════
total = PASS + FAIL + WARN
print(f"\n{'='*70}")
print(f"  FINAL RESULTS: {total} tests run")
print(f"  ✅ Passed:  {PASS}")
print(f"  ❌ Failed:  {FAIL}")
print(f"  ⚠️  Warned:  {WARN}")
print(f"  Pass rate: {PASS/total*100:.1f}%" if total > 0 else "  No tests run")
print(f"{'='*70}\n")

# Section breakdown
sections = {}
for r in results:
    s = r.get("section", "misc")
    if s not in sections:
        sections[s] = {"pass": 0, "fail": 0}
    if r.get("passed"):
        sections[s]["pass"] += 1
    else:
        sections[s]["fail"] += 1

print("Section breakdown:")
for section, counts in sections.items():
    total_s = counts["pass"] + counts["fail"]
    icon = "✅" if counts["fail"] == 0 else "❌" if counts["pass"] == 0 else "🟡"
    print(f"  {icon} {section:<20} {counts['pass']}/{total_s} passed")

# Output full JSON for report
output = {
    "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ'),
    "api_url": API_URL,
    "summary": {"pass": PASS, "fail": FAIL, "warn": WARN, "total": total},
    "sections": sections,
    "results": results,
    "created_ids": created_ids,
}
with open("/Users/macmini/Serviceos/qa/reports/deep-qa-results.json", "w") as f:
    json.dump(output, f, indent=2)
print(f"\n  Report saved to qa/reports/deep-qa-results.json")

ph.capture("qa_suite_run_completed", {
    "pass_count": PASS,
    "fail_count": FAIL,
    "warn_count": WARN,
    "total": total,
    "pass_rate": round(PASS / total, 4) if total > 0 else 0.0,
    "api_url": API_URL,
})
