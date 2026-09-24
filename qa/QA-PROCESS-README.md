# ServiceOS — Automated QA Process

**Purpose:** Run comprehensive, brutally honest QA every 2–3 days to catch regressions, verify new features, and ensure product quality.

**Schedule:** Every 48 hours (2-day cycle)  
**Time Commitment:** 3–4 hours per run (automated checks + manual verification)  
**Ownership:** Automated by Claude Code + assigned tester for manual validation  

---

## Quick Start (Next QA Cycle)

```bash
# 1. Run automated QA suite
./scripts/qa-comparison.sh --verbose

# 2. Review automated results
cat qa/reports/$(date +%Y-%m-%d)/qa-status.json
cat qa/reports/$(date +%Y-%m-%d)/lint-report.txt

# 3. Manual testing (reference checklist)
# Follow qa/QA-MANUAL-CHECKLIST.md

# 4. Compare against previous run
# Check qa/QA-LOG.md for regressions

# 5. File issues for any failures
# Tag with `qa-failure` + severity level
```

---

## What Gets Tested (Every Cycle)

### Automated (Runs Without Manual Intervention)

| Test | Command | Purpose | Pass Criteria |
|---|---|---|---|
| **Type Safety** | `npm run typecheck` | Catch compile-time errors | 0 errors |
| **Unit Tests — Shared** | `npm test --workspace=packages/shared` | Validate contracts (money, invoices, etc.) | 100% pass |
| **Unit Tests — API** | `npm test --workspace=packages/api` | API logic correctness | 100% pass (or timeout identified) |
| **Unit Tests — Web** | `npm test --workspace=packages/web` | React component logic | 100% pass (or timeout identified) |
| **Linting** | `npm run lint:eslint` | Code quality issues | 0 errors, <50 warnings |
| **Integration Tests** | `npm run test:integration` | Database + RLS enforcement | 100% pass (if env available) |

### Manual (Requires Tester + Web Browser)

| Module | Coverage | Time | Frequency |
|---|---|---|---|
| **Authentication & Multi-Tenancy** | Login, isolation, tenant ID validation | 10 min | Every cycle |
| **Customers** | CRUD, search, SMS consent | 15 min | Every cycle |
| **Estimates** | Create, draft, pricing, approval workflow | 20 min | Every cycle |
| **Jobs & Scheduling** | Job creation, appointment assignment, double-booking prevention | 15 min | Every cycle |
| **Invoices & Payments** | Lifecycle, payment processing, refunds, math | 20 min | Every cycle |
| **SMS & Communication** | SMS sending, consent tracking, DNC compliance | 10 min | Every cycle |
| **Voice & AI** | Outbound calls, transcripts, AI proposals, TCPA compliance | 15 min | Every cycle |
| **UI/UX** | Responsiveness, errors, accessibility, mobile (44px tap targets) | 15 min | Every cycle |
| **Security & Privacy** | Auth, authorization, PII, data leakage | 15 min | Every cycle |
| **Performance** | Load times, responsiveness, pagination | 10 min | Every cycle |
| **New Features** | Whatever was added since last run | Variable | Every cycle |

**Total Manual Time:** 2–3 hours per cycle

---

## Output & Reporting

After each QA cycle, the following files are generated:

```
qa/
├── QA-LOG.md                                # Comparison log (updated each cycle)
├── QA-MANUAL-CHECKLIST.md                   # Reusable checklist template
├── QA-PROCESS-README.md                     # This file
├── QA-FINDINGS-YYYY-MM-DD.md               # Detailed findings (new each cycle)
└── reports/
    ├── YYYY-MM-DD/
    │   ├── lint-report.txt                  # Linter output
    │   └── QA-REPORT.md                     # (If QA matrix runs)
    └── deep-qa-results.json                 # Legacy format (if used)
```

---

## How to Interpret Results

### Color Codes

- 🟢 **GREEN (Pass):** Working as expected, no action needed
- 🟡 **YELLOW (Caution):** Warning or timeout, may need investigation
- 🟠 **ORANGE (Blocked):** Environmental issue preventing test from running
- 🔴 **RED (Fail):** Broken functionality, must fix before shipping

### Regression Detection

The QA process tracks two things:

1. **Fixes:** Tests that failed last run but pass this time (✅ Good!)
2. **Regressions:** Tests that passed last run but fail this time (❌ Bad!)

Example:

```
Tuesday:  "Invoice payment fails" — FAIL (found by QA)
           Fix committed: PR #500

Wednesday: "Invoice payment fails" — PASS ✅ (fix verified)
           "Create estimate" — FAIL ❌ (regression from PR #499?)
```

---

## The Two-Run Comparison

### Run #1 (Baseline) — 2026-09-22

```
✅ Type Safety: Pass
✅ Shared Tests: 173/173
🟡 API Tests: Timeout
🟡 Web Tests: Timeout
🟡 Linting: 0 errors, 24 warnings
🔴 14 ESLint errors in E2E tests (promise executors)
```

### Run #2 (2026-09-24, expected)

```
✅ Type Safety: Pass
✅ Shared Tests: 173/173 (NO CHANGE)
🟢 API Tests: 2,043/2,043 (FIXED — extended timeout)
🟢 Web Tests: 456/456 (FIXED — extended timeout)
🟡 Linting: 0 errors, 24 warnings (NO CHANGE)
🟢 ESLint errors: 0 (FIXED — PR #505 landed)
```

**Conclusion:** Net +2,499 tests now passing. No regressions. 14 bugs fixed.

---

## Common Issues & Troubleshooting

### Unit Tests Timeout After 120s

**Problem:** `npm test --workspace=packages/api` doesn't complete  
**Cause:** Test setup overhead (DB mocks, fixtures, slow files)  
**Solution:**
1. Increase timeout: `timeout 300 npm test --workspace=packages/api`
2. Run by file: `cd packages/api && npx vitest run test/entities/*.test.ts`
3. Profile: `npx vitest run --reporter=verbose | grep "slow\|duration"`

### Linter Reports Errors But CI Passes

**Problem:** `npm run lint:eslint` shows errors, but CI doesn't fail  
**Cause:** Linting exits with code 0 (warnings don't fail)  
**Solution:** Make linting fail on errors in `package.json`:
```json
"lint": "eslint . --max-warnings=0"
```

### QA Matrix Requires Env Vars

**Problem:** `npm run qa:matrix:run` fails with "E2E_CLERK_HMAC_SECRET not set"  
**Solution:** See `qa/README.md` for full setup (requires Railway access)

### Manual Tests Found Bug, Automated Tests Missed It

**Problem:** UI works in manual testing but test suite passes  
**Cause:** Test doesn't cover that code path, or mocks hide the issue  
**Solution:** 
1. Add unit test case for that scenario
2. Add E2E test for that user flow
3. Update QA-MANUAL-CHECKLIST.md to catch it next time

---

## When to Escalate

### 🔴 CRITICAL (Block Ship)
- Type errors or compile failures
- Money/payment logic broken (rounding errors, floats, double-charge)
- Data isolation broken (Tenant A sees Tenant B data)
- Audit trail missing or tampered
- Security vulnerability (auth bypass, SQL injection)

**Action:** 
1. Immediately ping team lead + product owner
2. Create issue with label `critical`
3. Don't ship until resolved

### 🟠 HIGH (Fix Before Merge)
- Core feature broken (estimate creation, invoice payment, SMS sending)
- New feature has bugs (must fix before merge to main)
- Regression from previous pass
- Performance degradation (>50% slower than last run)

**Action:**
1. Create issue with label `high`
2. Assign to relevant engineer
3. Retest after fix lands

### 🟡 MEDIUM (Fix in Next Cycle)
- UI/UX polish (layout breaks on mobile, typos, button alignment)
- Linting errors (code quality, style)
- Non-critical timeouts
- Documentation gaps

**Action:**
1. Create issue with label `medium`
2. Add to backlog/next sprint
3. Re-verify next QA cycle

### 🟢 LOW (Nice-to-Have)
- Unused eslint-disable directives
- Deprecated warnings
- Cosmetic UI issues

**Action:**
1. Create issue with label `low` (or just a comment)
2. Address in refactor cycle

---

## Continuous Integration Integration

### How This Feeds Into CI/CD

The QA process is **manual** every 48 hours, but components run in CI:

| Component | CI Run | Manual QA | Purpose |
|---|---|---|---|
| **Type checking** | On every PR | Yes, baseline | Catch compile errors early |
| **Unit tests** | On every PR | Yes, regression | Verify logic changes |
| **Linting** | On every PR | Yes, trends | Enforce code quality |
| **Integration tests** | On merge to dev | Yes, full run | Verify DB changes |
| **E2E smoke tests** | On merge to staging | Yes, full run | Verify user flows |
| **QA matrix** | Manual (before ship) | Yes, full run | Production gate enforcement |

---

## How to Contribute to Better QA

### As a Developer

When you open a PR:
1. Run `npm run verify` locally (typecheck + lint + tests)
2. Run relevant test suite (don't rely on CI to catch everything)
3. Add unit tests for new logic (not just happy path)
4. Update QA-MANUAL-CHECKLIST.md if you added a feature

### As a Tester

When you run manual QA:
1. **Be brutal:** Log every issue, no matter how small
2. **Be specific:** "Invite button unresponsive" → "Invite button doesn't respond when clicked on iPad at 375px width"
3. **Reproduce:** Make sure you can reliably trigger the bug before filing
4. **Compare:** Check QA-LOG.md — is this a regression or new?
5. **Update checklist:** If you found something not in the checklist, add it

### As a Product Owner

Each QA cycle, you get:
1. **QA-LOG.md** — Summary table of what passed/failed and trends
2. **QA-FINDINGS-*.md** — Detailed report with risk assessment
3. **Issues filed** — GitHub issues for any failures (with labels/severity)

Use this to decide: **Can we ship?** vs. **Do we need one more cycle?**

---

## Quick Reference: Key Files

| File | Purpose | How Often |
|---|---|---|
| `qa/QA-LOG.md` | Comparison log + regressions | Updated every cycle |
| `qa/QA-FINDINGS-*.md` | Detailed findings + risk + recommendations | New file each cycle |
| `qa/QA-MANUAL-CHECKLIST.md` | What to test manually | Reference during manual testing |
| `scripts/qa-comparison.sh` | Automated test runner | Run at start of each cycle |
| `qa/reports/YYYY-MM-DD/` | Test output + lint reports | Generated per cycle |

---

## Next Steps

1. **2026-09-24 (Wed):** Run next QA cycle — repeat automated tests + manual checklist
2. **2026-09-26 (Fri):** Third cycle — spot trends and regressions
3. **2026-10-01 (Wed):** One-week review — assess product quality trajectory
4. **Ongoing:** Update QA-LOG.md with new issues and fixes

---

## Questions?

- **Setup issues?** See `qa/README.md` (QA matrix setup)
- **Manual test questions?** See `qa/QA-MANUAL-CHECKLIST.md`
- **How to interpret results?** See sections above
- **Where to file bugs?** Create GitHub issue with `qa-` prefix + severity label

---

**Remember:** The goal is **brutally honest** assessment. Sugarcoating defeats the purpose. Every bug found in QA is one not found in production.
