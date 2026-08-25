# QA Cycle Checklist — Every 48 Hours

**Last Run:** 2026-08-25 (automated)  
**Next Scheduled Run:** 2026-08-27 (automated)  
**Cycle Interval:** 48 hours

---

## Pre-QA Checklist (Before Running Tests)

### Environment Setup
- [ ] Verify .env.qa is populated with current credentials
- [ ] Confirm E2E_CLERK_HMAC_SECRET matches deployed value
- [ ] Check E2E_DB_URL_* variables point to dev database
- [ ] Verify CLERK_DEV_HMAC_TOKENS=true is set on Railway dev API

### System Health (Quick Checks)
- [ ] API health endpoint responds: `curl https://serviceosapi-development.up.railway.app/health`
- [ ] Database is reachable from test environment
- [ ] Docker daemon is running (for testcontainers)
- [ ] No active deployments in progress on Railway

---

## Automated Test Execution

### Build Verification
- [ ] Run TypeScript check: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
  - **Expected:** Exit code 0, zero errors
  - **Failure action:** Review error details, fix type issues

### Unit Test Suite
- [ ] Run full test suite: `npm test -- --run`
  - **Expected:** ≥13,558 tests pass, 0 failures
  - **Yellow flag:** Test count drops OR failures appear
  - **Failure action:** Investigate failed test, check recent commits

### Dependency Audit
- [ ] Run npm audit: `npm audit --audit-level=moderate`
  - **Expected:** 0 high/critical vulnerabilities
  - **Current known issues:** 5 HIGH (as of 2026-08-25)
  - **Fix if needed:** `npm audit fix && npm test -- --run`

### QA Matrix (If E2E Env Is Ready)
- [ ] Run full matrix: `npm run qa:matrix:run`
  - **Expected:** Voice-Critical gate: 20/20 pass; Business-Critical gate: ≥27/30 pass
  - **If unavailable:** Note in report; document missing env vars

---

## Known Issues Regression Checks (Manual)

### P0 — Ship-Critical
- [ ] **Blocker 11: TCPA/DNC Gate**
  - **What to test:** Attempt outbound voice call, verify DNC check is enforced
  - **Expected:** Voice call fails if customer on DNC list
  - **If broken:** Flag as CRITICAL blocker

- [ ] **Branding Consistency**
  - **What to test:** Open web app, check logo, page title, welcome message
  - **Expected:** All say same brand (should be "Rivet" or pick one name)
  - **If inconsistent:** Note which pages show wrong branding

- [ ] **npm Vulnerabilities**
  - **What to test:** Run `npm audit`
  - **Expected:** 0 HIGH or CRITICAL vulnerabilities
  - **If found:** Run `npm audit fix`, re-test, commit

### P1 — High Priority
- [ ] **Money Float Rendering (BUG-03)**
  - **What to test:** Create estimate, view on web, open invoice page
  - **Expected:** Money displays as $1,234.50 (with cents), not $1,234.5
  - **If broken:** Investigate InvoicesPage.tsx:288-289, EstimateApprovalPage.tsx:715-716

- [ ] **Money Dashboard Timezone (BUG-05)**
  - **What to test:** Open reports/money dashboard
  - **Expected:** Revenue bucketed by tenant's timezone, not UTC
  - **If wrong:** Check `reports/money-dashboard.ts` for timezone handling

- [ ] **Refund Webhook (BUG-07)**
  - **What to test:** Simulate Stripe webhook for charge.refund.updated
  - **Expected:** Refund status in database updates to 'succeeded'
  - **If silent:** Check webhooks/routes.ts for wiring of refund handler

---

## Comparison Against Baseline

### Test Suite
- **June 4:** 5,511 API tests passing
- **Aug 25:** 13,558 API tests passing
- **This cycle:** Should be ≥13,558 (watch for drops)

### Blockers Still Open
| ID | Issue | Ship-Critical? |
|----|-------|---|
| 11 | TCPA/DNC gate | 🔴 YES if voice is live |
| Branding | "Fieldly" vs "ServiceOS" | 🟠 YES if customer-facing |
| npm-5 | HIGH vulnerabilities | 🔴 YES (supply chain risk) |

---

## If You Find Issues

### Issue Severity Guide

**🔴 CRITICAL (Stop & Escalate)**
- Any P0 blocker found broken
- Test suite regression (fewer passing tests)
- Build fails or type errors appear
- Security vulnerability exploitable

**🟠 HIGH (Fix This Cycle)**
- Money rendering broken (data integrity)
- Auth/RLS failure
- Customer data exposed

**🟡 MEDIUM (Fix Next Cycle)**
- Optional feature broken
- Performance degradation
- Non-customer-facing bug
- Documentation issues

### Logging Issues
When you find a problem:
1. **Document it:** Note exact reproduction steps
2. **Bisect if needed:** Use `git log --oneline` to find which commit broke it
3. **File issue:** Create GitHub issue with:
   - Exact steps to reproduce
   - Expected vs actual
   - Commit that introduced (if bisected)
   - Suggested fix (if obvious)
4. **Flag if critical:** Post in team Slack or escalation channel

---

## Report Template

After each QA cycle, create/update:
1. **QA-REPORT-YYYY-MM-DD.md** — Detailed findings
2. **YYYY-MM-DD-regression-comparison.md** — Before/after vs baseline
3. **Update this checklist** with new known issues

---

## Success Criteria

✅ **This QA cycle passes if:**
- [ ] TypeScript build: PASS (exit 0)
- [ ] Unit tests: PASS (13,558+ tests, 0 failures)
- [ ] npm audit: 0 HIGH vulnerabilities (or all fixed)
- [ ] No regressions in critical systems (RLS, auth, encryption, money)
- [ ] Blocker 11 status: Document whether it's fixed or still open
- [ ] Manual spot-checks: Branding, money rendering, timezone all verified

🔴 **This QA cycle FAILS if:**
- TypeScript build fails
- Unit tests drop OR failures appear
- Security vulnerability found and unfixed
- Regression in existing functionality
- Critical blocker remains unresolved without documented reason

---

**Questions?** See `/qa/README.md` for matrix runbook details.
