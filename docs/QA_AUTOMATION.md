# QA Automation Setup — Every 2 Days

**Effective**: 2026-09-29  
**Schedule**: Every 2 days at 4:57 AM UTC (off-peak time)  
**Purpose**: Consistent regression detection without manual intervention  
**Accountability**: Brutally honest, detailed reporting; no sugar-coating

---

## Cadence & Timing

### When QA Runs

- **Every 2 Days**: Monday, Wednesday, Friday, Sunday, Tuesday, Thursday, Saturday, etc. (odd calendar days)
- **Time**: 4:57 AM UTC (off-peak)
- **Duration**: 30-45 minutes
- **Location**: GitHub Actions (`.github/workflows/qa-recurring.yml`)

### Expected Run Dates (Next 30 Days)

- ✅ 2026-09-29 (Tuesday) — Initiated manually
- 2026-10-01 (Thursday)
- 2026-10-03 (Saturday)
- 2026-10-05 (Monday)
- 2026-10-07 (Wednesday)
- 2026-10-09 (Friday)
- 2026-10-11 (Sunday)
- 2026-10-13 (Tuesday)
- ... and so on

---

## Automation Architecture

### 1. **CI/CD Trigger** (GitHub Actions)

**File**: `.github/workflows/qa-recurring.yml`

```yaml
on:
  schedule:
    - cron: '57 4 */2 * *'  # Every 2 days at 4:57 AM UTC
  workflow_dispatch:  # Can also run manually
```

**Runs Every 2 Days**:
- Checkout code
- Install dependencies
- Set up Node.js + Playwright
- Run QA comparison script
- Upload reports (90-day retention)
- Check results and report status

### 2. **QA Comparison Script**

**File**: `scripts/qa-comparison.sh`

The script:
1. **Builds** the application (web + API)
2. **Validates** TypeScript (tsconfig.build.json)
3. **Runs tests**:
   - Unit tests (API, web, shared, mobile)
   - Integration tests (real Postgres)
   - E2E tests (Playwright)
   - Voice quality gate (73 scenarios)
   - Contract validation (Zod)
4. **Generates report** in `qa/reports/`
5. **Compares** against previous run
6. **Detects regressions** (new failures)
7. **Documents findings** (pass/fail counts, severity levels)

### 3. **Results Storage**

**Artifacts**: GitHub Actions artifacts (90-day retention)
- `qa/reports/qa-status.json` — Machine-readable results
- `qa/reports/qa-details.md` — Human-readable report
- `qa/reports/comparison.json` — Diff vs. previous run

**Documentation**: Checked into repo
- `docs/qa-results-[DATE].md` — Results for each run (manually updated)
- `docs/QA_LOG.md` — Master log (master spreadsheet of all runs)

### 4. **Notifications & Escalation** (TBD)

**When Tests Pass (🟢 >95%)**:
- ✅ Silent success (no notification)
- Report available at GitHub Actions

**When Tests Degrade (🟡 80-95%)**:
- ⚠️ Check in `#engineering` Slack: "QA run [DATE]: 85% pass rate (2 high, 3 medium failures)"
- Link to detailed report
- Action: Review failures, triage by severity

**When Tests Fail (🔴 <80%)**:
- 🚨 Urgent alert: "@engineering QA FAILED: 72% pass rate. 5 critical issues. Deploy BLOCKED."
- Link to detailed report
- Action: Immediate investigation and fix

**Regression Detection**:
- 🔴 New regression alert: "Feature X regressed (was passing 2026-09-27, failing now)"
- Link to comparison diff
- Action: Identify root cause; likely a recent commit

---

## What Gets Tested (Every Run)

### ✅ Suites Invoked by Recurring QA Runner

The scheduled runner invokes `scripts/qa-comparison.sh`, which includes:

| Category | Coverage | Evidence |
|----------|----------|----------|
| **TypeScript Type Check** | Production build config | `tsc --project tsconfig.build.json` |
| **Web Unit Tests** | ~2,463 tests | `packages/web/**/*.test.ts` |
| **Shared Unit Tests** | ~174 tests | `packages/shared/**/*.test.ts` |
| **API Unit Tests (Optional)** | ~14,158 tests | Included in script but may not execute in all CI environments |
| **Integration Tests (Optional)** | ~1,218 tests | Real Postgres; requires Docker, often skipped |
| **E2E Tests (Optional)** | ~19 scenarios | Playwright; requires browser, often skipped |
| **Comparison** | Previous vs. current | Regression detection (if prior artifacts available) |

**Actual test count per run**: Depends on CI environment. Recurring runner typically executes web+shared (~2,637) + type checks.

**NOT included in recurring runs** (requires manual QA with staging credentials):
- Build verification
- Voice quality gate (73 scenarios)
- Mobile tests (826 tests)
- Contract validation lane
- Provider-dependent tests (Clerk, Stripe, Twilio, LLM)

**Pass Rate Target**: >95% (>92% is acceptable for staging, applies only to executed suites)

### ⚠️ Manual Testing NOT Included (CI Environment)

These require provider credentials (not available in CI):

| Feature | Reason | How to Test |
|---------|--------|-----------|
| **Clerk Cloud Sign-In** | Requires live Clerk tenant | Staging manual QA with credentials |
| **Stripe Payments** | Requires live Stripe account | Staging manual QA with credentials |
| **Twilio SMS/Voice** | Requires Twilio API key | Staging manual QA with credentials |
| **Real LLM Responses** | Requires API key (cost implications) | Staging soak test (monthly) |
| **Visual/Responsive** | Requires visual inspection | Manual QA on multiple devices |

---

## Interpreting Results

### Pass Rate Calculation

```
Pass Rate = (Total Tests - Failed Tests) / Total Tests

Example:
18,500 total tests
- 1,000 pass
- 18,500 pass rate = 100% ✅
```

### Severity Classification

| Severity | Symbol | Meaning | Action |
|----------|--------|---------|--------|
| Critical | 🔴 | Breaks core workflow, data loss, money bug | **Immediate fix required; blocks deploy** |
| High | 🟠 | Affects important workflow, data integrity risk | **Fix this sprint; high priority** |
| Medium | 🟡 | Edge case, minor UX issue, not critical | **Fix next sprint** |
| Low | 🟢 | Polish, cosmetic, low-priority improvement | **Backlog** |

### Status Decision Matrix

| Pass Rate | Critical Issues | High Issues | Status | Action |
|-----------|-----------------|-------------|--------|--------|
| >95% | 0 | 0 | 🟢 **HEALTHY** | ✅ Approved for release |
| 80-95% | 0 | 0-1 | 🟡 **DEGRADED** | ⚠️ Monitor, fix before release |
| 80-95% | 0 | 2+ | 🔴 **BLOCKED** | ❌ Fix critical issues first |
| <80% | Any | Any | 🔴 **CRITICAL** | ❌ Deploy BLOCKED |
| Any | 1+ | Any | 🔴 **BLOCKED** | ❌ Critical issue found |

---

## Regression Tracking

Every QA run **compares against the previous run** to detect new failures (regressions).

### How Regression Detection Works

1. **Prior Artifact Restoration**: Workflow downloads the last successful run's artifact (`qa/reports/*/`)
2. **Baseline Comparison**: `scripts/qa-comparison.sh` loads prior `qa-status.json` and compares current results
3. **Regression Detection**: Any test that passed before but fails now is flagged
4. **Documentation**: Findings logged in `QA_LOG.md` regression tracking table
5. **Scope**: Only applies to test suites actually executed in both runs; missing suites are noted separately

**Implementation Detail**: The workflow runs daily (schedule: `0 4 * * *`) with an internal 48-hour gate (checks if last successful run was 48+ hours ago). This preserves the 2-day cadence across month boundaries and ensures prior artifacts are available for comparison.

### What Is a Regression?

- **Feature was passing** on 2026-09-27 AND on 2026-09-29 run's baseline
- **Feature is failing** on 2026-09-29
- **Conclusion**: A recent code change broke it

### What Is NOT a Regression?

- Feature was failing on 2026-09-27 and still failing on 2026-09-29 (known issue, not new)
- Feature is new (no prior run to compare against)
- Test suite not executed in both runs (e.g., API tests skipped in one run; cannot compare)

### Regression Workflow

1. **Prior Artifacts Restored**: Download last successful run's results
2. **Test Execution**: Run current test suite
3. **Comparison**: Compare current vs. prior on matching lanes only
4. **Detection**: Flag any new failures (only in suites present in both runs)
5. **Scope Note**: If API was skipped in prior run, API results in current run start clean (no regression possible)
6. **Documentation**: Log in `QA_LOG.md` regression tracking table
7. **Investigation**: Review recent commits to identify root cause
8. **Escalation**: Alert on Slack if critical
9. **Fix**: Engineer investigates and fixes
10. **Verification**: Next QA run confirms fix

---

## Key Files & Permissions

### Files Modified by QA Automation

1. **`.github/workflows/qa-recurring.yml`** (this repo)
   - Controls schedule and execution
   - Updated manually when cadence changes
   - ✅ Can be edited by: Engineering leads

2. **`scripts/qa-comparison.sh`** (this repo)
   - The script that runs tests and generates reports
   - ✅ Can be edited by: Engineering team
   - Should remain in version control for auditability

3. **`docs/qa-results-[DATE].md`** (auto-generated, then manually filled)
   - Per-run detailed results
   - ✅ Can be edited by: QA lead or engineer
   - Checked into repo for audit trail

4. **`docs/QA_LOG.md`** (manually updated)
   - Master comparison log
   - ✅ Can be edited by: QA lead or engineer
   - Source of truth for trend analysis

### GitHub Actions Artifacts

- **Location**: GitHub Actions → Artifacts
- **Retention**: 90 days
- **Contents**: `qa/reports/` directory
  - `qa-status.json` — Machine-readable results
  - `qa-details.md` — Human-readable report
  - `comparison.json` — Diff vs. previous run

---

## Troubleshooting

### "QA Run Failed to Start"

**Check**:
1. GitHub Actions workflow status: `.github/workflows/qa-recurring.yml`
2. Node.js/npm version in workflow (should match `package.json` engines)
3. Playwright installation (sometimes fails on fresh runners)

**Fix**:
```bash
# Manually trigger workflow
gh workflow run qa-recurring.yml
```

### "Tests Timed Out"

**Reason**: Some tests (especially integration) can be slow on CI runners

**Fix**:
1. Check timeout in workflow (currently 45 minutes)
2. If consistently timing out, increase timeout-minutes
3. Investigate which test is slow (check logs)

### "Pass Rate Dropped Unexpectedly"

**Workflow**:
1. Run QA locally to confirm: `npm run test`
2. Check git log: `git log --oneline [last-qa-date]..HEAD`
3. Identify suspect commits
4. Revert suspect commit and re-test to confirm
5. Investigate root cause

### "False Positive (Test Should Pass)"

**Examples**: Flaky tests, network timeouts, race conditions

**Workflow**:
1. Re-run the failed test: `npm run test -- --grep "test name"`
2. If it passes, it's a flake (mark as 🟡 MEDIUM, not 🔴 CRITICAL)
3. Document flakiness in QA_LOG.md known issues
4. File ticket to make test more robust

---

## Manual Overrides & Exceptions

### Emergency QA Run (Not on Schedule)

**Reason**: Critical bug discovered; need immediate verification

```bash
# Trigger workflow manually
gh workflow run qa-recurring.yml
```

**Or**: Manually execute QA process locally:
```bash
cd /home/user/Serviceos
npm run build
npm run test
# Update docs/qa-results-YYYY-MM-DD.md
# Update docs/QA_LOG.md
```

### Skip a Scheduled Run

**Reason**: Major refactor in progress; QA results would be unreliable

```bash
# Disable workflow temporarily (not recommended)
gh workflow disable qa-recurring.yml

# Re-enable when ready
gh workflow enable qa-recurring.yml
```

**Note**: Skipping defeats the purpose of regular regression detection. Only do this if absolutely necessary, and document why in QA_LOG.md.

### Modify Cadence

**Current**: Every 2 days (57 4 */2 * *)

**To change**:
1. Edit `.github/workflows/qa-recurring.yml`
2. Change `cron` expression (see [cron format](https://crontab.guru/))
3. Commit and push
4. Update this document to reflect new cadence
5. Document reason for change in git commit

**Common schedules**:
- Daily: `0 4 * * *`
- Every 3 days: `57 4 */3 * *`
- Weekly: `57 4 * * 1` (Monday)

---

## Future Enhancements

### Phase 2: Automated Notifications

- [ ] Slack integration for pass/fail
- [ ] Email summary reports
- [ ] GitHub issue auto-creation for critical failures
- [ ] Regression trending dashboard

### Phase 3: Provider Credential Staging

- [ ] Staging environment with Clerk, Stripe, Twilio credentials
- [ ] Monthly manual QA run with live provider flows
- [ ] Payment flow verification (not just mocks)
- [ ] SMS/voice delivery validation

### Phase 4: Performance Tracking

- [ ] Build time trending
- [ ] Test execution time trending
- [ ] API response time SLA validation
- [ ] Load test execution (against load test environment)

### Phase 5: Visual Regression Detection

- [ ] Screenshot comparison across runs
- [ ] Mobile responsive testing (multiple viewport sizes)
- [ ] Cross-browser testing (Chrome, Firefox, Safari)
- [ ] Dark mode validation

---

## Questions & Support

**Q**: Can I modify the QA schedule?  
**A**: Yes. Edit `.github/workflows/qa-recurring.yml` and update the cron expression. Document the change.

**Q**: What if a test is flaky?  
**A**: Document it in QA_LOG.md under "Known Issues". Fix the root cause. Don't skip/disable tests.

**Q**: How do I know if a failure is a regression?  
**A**: Check QA_LOG.md comparison table. If the test passed 2 days ago and fails now → regression.

**Q**: Can I run QA manually on-demand?  
**A**: Yes. Use `gh workflow run qa-recurring.yml` or manually execute `scripts/qa-comparison.sh`.

**Q**: How long should QA take?  
**A**: 30-45 minutes on GitHub Actions runners.

**Q**: Where are results stored?  
**A**: GitHub Actions artifacts (90 days) + repo docs (`qa-results-*.md`).

---

**Last Updated**: 2026-09-29  
**Next Review**: 2026-10-13 (2 weeks, after 7 runs)  
**Owner**: Engineering QA Lead  
**Philosophy**: Brutally honest, detailed, zero sugar-coating. Every failure is real and documented.

