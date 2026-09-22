# ServiceOS QA — Quick Reference Card

**Print this and keep it on your desk.** Update it when QA processes change.

---

## TL;DR — Every 2 Days

```bash
# 1. Run automated checks (30 min)
./scripts/qa-comparison.sh --verbose

# 2. Manual testing (2-3 hours)
# Follow: qa/QA-MANUAL-CHECKLIST.md

# 3. Report findings (30 min)
# File GitHub issues + update qa/QA-LOG.md

# 4. Decision
✅ Green → Ready to merge/ship
🟡 Yellow → Address medium/high issues before ship
🔴 Red → Fix critical issues, re-test
```

---

## What Each Status Means

| Status | Meaning | Action |
|---|---|---|
| 🟢 **GREEN** | All checks pass, no regressions | OK to merge/ship |
| 🟡 **YELLOW** | Warnings or minor issues | Fix before ship, OK to merge |
| 🟠 **ORANGE** | Infrastructure blocked (timeout, env var) | Investigate, unblock |
| 🔴 **RED** | Critical failures, regressions | Fix immediately, re-test |

---

## Core Modules (Always Test)

### 1. Auth & Multi-Tenancy (10 min)
- [ ] Login works
- [ ] Tenant A ≠ Tenant B
- [ ] Can't see other tenant data

### 2. Customers (10 min)
- [ ] CRUD works
- [ ] Search works
- [ ] SMS consent tracked

### 3. Estimates (15 min)
- [ ] Create, approve, convert to job
- [ ] Pricing math correct (integer cents)
- [ ] No float errors

### 4. Jobs & Scheduling (10 min)
- [ ] Double-booking prevented
- [ ] Status lifecycle works
- [ ] Technician assignment updates calendar

### 5. Invoices & Payments (15 min)
- [ ] Payment processing (Stripe)
- [ ] Webhook received (not double-charged)
- [ ] Refunds work correctly

### 6. SMS (10 min)
- [ ] SMS sending works
- [ ] Consent checked
- [ ] DNC respected

### 7. Voice (10 min)
- [ ] Calls work
- [ ] Transcripts recorded
- [ ] TCPA quiet hours enforced

### 8. UI/UX (15 min)
- [ ] Mobile: 44px tap targets
- [ ] Mobile: No horizontal scroll at 320px
- [ ] Errors clear & actionable

### 9. Security (15 min)
- [ ] Auth required for private pages
- [ ] Can't access other tenant data
- [ ] PII not logged

### 10. Performance (10 min)
- [ ] Page load <2s
- [ ] Search returns <1s
- [ ] No jank/lag on buttons

---

## Files You'll Use

| File | When | What To Do |
|---|---|---|
| `qa/QA-LOG.md` | Every cycle | Update summary table |
| `qa/QA-MANUAL-CHECKLIST.md` | During manual testing | Check boxes + log issues |
| `qa/QA-FINDINGS-*.md` | After cycle | Read findings + escalate issues |
| `qa/QA-PROCESS-README.md` | When confused | Reference for how-tos |
| `scripts/qa-comparison.sh` | Start of cycle | Run: `./scripts/qa-comparison.sh` |

---

## Issue Severity

### 🔴 CRITICAL (Fix NOW)
- Type errors, compile failures
- Money bug (rounding, float, double-charge)
- Data isolation broken (Tenant A sees B)
- Audit trail missing/tampered
- Security bypass
- **Action:** Stop everything, fix now

### 🟠 HIGH (Fix Before Merge)
- Core feature broken (payment, estimate, SMS)
- New feature buggy
- Regression (was passing, now failing)
- 50%+ performance drop
- **Action:** Assign to engineer, retest after fix

### 🟡 MEDIUM (Fix This Sprint)
- UI breaks on mobile (layout, not tap targets)
- Linting errors
- Timeout issues (infrastructure)
- Missing documentation
- **Action:** File issue, add to backlog

### 🟢 LOW (Nice-to-Have)
- Typos, cosmetic
- Unused code/warnings
- Comment cleanup
- **Action:** Comment on issue (optional to fix)

---

## Comparison (What Changed?)

**Last Run vs This Run:**

```
Tuesday:   Invoice payment FAIL
Wednesday: Invoice payment PASS ✅ (Fixed by PR #500)
           Estimate creation FAIL ❌ (New regression)

Result: 1 fix, 1 new issue
Risk:   MEDIUM (need to understand regression)
Action: Investigate PR #499 (probably caused it)
```

---

## Troubleshooting

### Tests Timing Out

**Cause:** Slow test setup  
**Fix:** Extend timeout to 300s  
```bash
timeout 300 npm test --workspace=packages/api
```

### Linting Errors Not Failing CI

**Cause:** Lint command exits 0 (warnings only)  
**Fix:** Make `max-warnings=0` in package.json  
```json
"lint": "eslint . --max-warnings=0"
```

### QA Matrix Won't Run

**Cause:** Missing env vars  
**Fix:** Set in Railway + source `.env.qa`  
```bash
source .env.qa
npm run qa:matrix:run
```

### Found Bug That Tests Missed

**Do This:**
1. Add unit test for that case
2. Add E2E test for that flow
3. Update QA-MANUAL-CHECKLIST.md to catch next time
4. File issue with `qa-improvement` label

---

## Key Commands

```bash
# Type checking (fast)
npm run typecheck

# Unit tests
npm test --workspace=packages/shared
timeout 300 npm test --workspace=packages/api
timeout 300 npm test --workspace=packages/web

# Linting
npm run lint:eslint

# Integration tests (Docker required)
npm run test:integration --workspace=packages/api
npm run test:rls

# E2E smoke tests
npm run e2e:smoke

# QA matrix (full setup required)
npm run qa:matrix:run

# Our new QA script
./scripts/qa-comparison.sh --verbose
```

---

## Escalation Path

1. **Found Critical Issue:** 
   - 🚨 Ping team lead + product owner in Slack immediately
   - File GitHub issue, label `critical`
   - Don't ship

2. **Found High Issue:**
   - Create GitHub issue, label `high`
   - Assign to engineer
   - Re-test after fix

3. **Found Medium Issue:**
   - Create GitHub issue, label `medium`
   - Add to backlog
   - Re-test next cycle

4. **Found Low Issue:**
   - Comment on GitHub (optional)
   - Or skip if unimportant

---

## How to Report Findings

### In GitHub Issue

```
Title: [QA] Customer search times out at 10,000 records

Severity: HIGH (performance regression)

Details:
- Searching for "John" in customer list
- Takes 15 seconds (was 2 seconds last week)
- Regression introduced: PR #502

Steps to Reproduce:
1. Create 10,000 customers
2. Search for "John"
3. Observe: Page freezes for 15s

Expected: <2 seconds

Environment:
- Dev: https://serviceosweb-development.up.railway.app
- Tested on: Chrome 130, MacBook Pro 16GB RAM
- Date: 2026-09-24

Related: Previous pass 2026-09-22, now failing
```

### In QA-LOG.md

```
| 2026-09-24 | 🟡 YELLOW | 1 regression (search timeout) | Check PR #502 | medium-priority |
```

---

## Remember

- 🟢 **Be Honest:** No sugarcoating. Every bug matters.
- 🔍 **Be Specific:** "Button broken" → "Invite button doesn't respond when clicked on iPad 375px"
- ✅ **Be Complete:** Test all modules, not just obvious happy path
- 🚀 **Be Fast:** QA every 2 days, catch regressions early
- 📊 **Be Consistent:** Same checklist each cycle, easier to compare
- 📝 **Be Thorough:** Document findings, not just "works" or "broken"

---

## One-Sheet Summary

**Every 2 Days:**

1. ✅ Run `./scripts/qa-comparison.sh` (automated tests)
2. ⏱️ Manual testing (2–3 hours, follow checklist)
3. 📋 File GitHub issues + update QA-LOG.md
4. 🚀 Decision: green/yellow/red for shipping

**Files to Know:**
- `qa/QA-LOG.md` — Comparison across cycles
- `qa/QA-MANUAL-CHECKLIST.md` — What to test
- `qa/QA-FINDINGS-*.md` — Detailed findings

**Golden Rule:** If it passed last time and fails now, it's a regression. Investigate immediately.
