# QA Manual Testing Framework

**Effective Date**: 2026-07-30  
**Cadence**: Every 2-3 days (sustainable manual QA)  
**Philosophy**: Brutally honest, detailed, regression-focused

---

## Quick Start

### For Testers: Running QA

```bash
# Set up a new QA run
./scripts/run-qa.sh --tester "Your Name" --env staging

# This will:
# 1. Verify the app is running
# 2. Create a results file: docs/qa-results-YYYY-MM-DD.md
# 3. Show the testing roadmap
# 4. Open testing resources

# Then: Follow the checklist in docs/QA_CHECKLIST.md
# Record your findings in the results file as you test
```

### For Leads: Understanding Results

1. **Open the results file** → `docs/qa-results-YYYY-MM-DD.md`
   - See: Critical failures, high failures, pass rate
   - Look for: Regressions (features that were passing, now failing)
   
2. **Check the master log** → `docs/QA_LOG.md`
   - Summary table: Shows all runs and trends
   - Regression tracking: Which issues appeared recently
   - Health scorecard: Which feature areas are stable vs. concerning
   
3. **Make a release decision**:
   - 🟢 **Approved**: >95% pass rate, no critical issues
   - 🟡 **Conditional**: 80-95% pass rate, critical issues have workarounds
   - 🔴 **Blocked**: <80% pass rate or critical issues with no fix

---

## Documents in This Framework

### 1. **QA_CHECKLIST.md** — The Detailed Testing Blueprint
   - **What**: Comprehensive checklist of 286 tests across 18 feature areas
   - **How**: Check off each test (✅/❌) as you go
   - **Why**: Ensures consistent coverage every run
   - **Sections**: Auth, Dashboard, Appointments, Estimates, Invoices, Customers, Leads, Jobs, Voice, SMS, Dispatch, Reports, Settings, Mobile, Error Handling, Performance, AI Quality, Security
   - **Read**: Before starting a run; follow as your guide

### 2. **qa-results-template.md** — Template for Individual Runs
   - **What**: Markdown template with sections for all finding types
   - **How**: Use `./scripts/run-qa.sh` to auto-create from template
   - **Sections**: Summary, critical failures, high failures, medium/low failures, regressions, improvements, skipped tests, detailed checklist
   - **Read**: After QA run; fill in findings

### 3. **qa-results-[DATE].md** — Your Run's Results
   - **What**: Filled-in results from a specific QA run
   - **How**: Created from template; filled in by tester
   - **Read**: During/after testing to track findings; links from QA_LOG.md

### 4. **QA_LOG.md** — Master Tracking & Comparison Log
   - **What**: Runs-over-time summary, regression tracking, health scorecard
   - **How**: Update after each run (copy your summary into the table)
   - **Why**: Lets us spot trends and regressions across multiple runs
   - **Sections**: 
     - Run summary table (all runs at a glance)
     - Regression tracking (what broke and when)
     - Critical issues board
     - Feature area health scores (by category)
     - Known issues inventory
   - **Read**: To compare this run to prior runs; to understand problem areas

### 5. **QA_PROCESS.md** — How to Execute QA
   - **What**: Step-by-step guide to running QA
   - **How**: Read before your first run; reference during testing
   - **Sections**: The 4 phases, testing roadmap, issue reporting, regression tracking, device testing, performance benchmarks, money testing, security testing, FAQ
   - **Read**: Before starting; reference during testing

### 6. **This File (QA_README.md)** — Overview & Navigation
   - **What**: High-level guide to the framework
   - **How**: Start here to understand the whole system
   - **Read**: First time setup, or when confused about which doc to use

---

## The QA Workflow

```
Every 2-3 Days:

  Day 0 (Tuesday)
  ├─ 9:00 AM: Run ./scripts/run-qa.sh
  ├─ 9:15 AM: Test Critical Path (auth, dashboard, appointments, estimates, invoices, voice, payments)
  ├─ 12:30 PM: Test Core Workflows (SMS, customers, jobs, settings, security)
  ├─ 3:15 PM: Test Polish & Edge Cases (error handling, performance, mobile, reports, AI, leads)
  ├─ 3:45 PM: Triage & Summarize (identify regressions, fix new issues)
  ├─ 4:00 PM: Update QA_LOG.md
  └─ 4:15 PM: Commit results & make release decision

  Release Decision:
  └─ 🟢 Approved / 🟡 Conditional / 🔴 Blocked
```

---

## Key Definitions

### Severity Levels

| Level | Symbol | Meaning | Action |
|-------|--------|---------|--------|
| Critical | 🔴 | Breaks core workflow, data loss, security risk, money bug | Fix immediately, blocks release |
| High | 🟠 | Affects important workflow, data integrity risk, bad UX | Fix this sprint, high priority |
| Medium | 🟡 | Edge case, minor UX issue, non-critical feature broken | Fix next sprint |
| Low | 🟢 | Polish, cosmetic, low-priority improvement | Backlog |

### Regression vs. Bug

- **Regression**: A feature that was passing in a prior run but is now failing. Indicates recent code broke something.
- **Bug**: A feature that's been failing for multiple runs. Part of the known issues list.
- **Fix**: A feature that was failing but is now passing. Great news!

### Pass Rate

```
Pass Rate = (Total Checks - Failed Checks) / Total Checks

Example:
- 286 total checks
- 26 failures
- Pass Rate = (286 - 26) / 286 = 90%
```

### Release Decision

| Rate | Status | Can Release? |
|------|--------|--------------|
| >95% | 🟢 HEALTHY | ✅ Yes, approved for release |
| 80-95% | 🟡 DEGRADED | ⚠️ Conditional — depends on what failed |
| 65-80% | 🟠 CONCERNING | ❌ No, but close |
| <65% | 🔴 CRITICAL | ❌ Absolutely not, major issues |

---

## Running Your First QA (Start Here)

### 1. Environment Setup (5 minutes)

```bash
# Ensure you're in the repo root
cd /home/user/Serviceos

# Verify the QA files exist
ls docs/QA_CHECKLIST.md
ls docs/QA_PROCESS.md
ls scripts/run-qa.sh
```

### 2. Start a QA Run (15 minutes)

```bash
# Kick off the interactive setup
./scripts/run-qa.sh --tester "Your Name" --env staging

# This creates:
# - docs/qa-results-2026-07-30.md (or today's date)
# - Opens the testing checklist
```

### 3. Test According to Roadmap (5-8 hours)

Follow the order in **QA_PROCESS.md**:

1. **Critical Path First** (2-3 hours)
   - Auth, Dashboard, Appointments, Estimates, Invoices, Voice, Payments
   
2. **Core Workflows** (2-3 hours)
   - SMS, Customers, Jobs, Settings, Security
   
3. **Polish & Edge Cases** (1-2 hours, if time)
   - Error Handling, Performance, Mobile, Reports, AI, Leads

**For each test**: Mark ✅ (pass) or ❌ (fail) in the results file.  
**For failures**: Document steps, expected vs. actual, screenshot.

### 4. Wrap Up & Triage (1-2 hours)

1. **Count results**: Summarize pass/fail in results file
2. **Find regressions**: Compare against prior run in QA_LOG.md
3. **Update the log**: Add your run to the summary table
4. **File tickets**: Create GitHub issues for failures

### 5. Commit & Release Decision (30 minutes)

```bash
git add docs/qa-results-2026-07-30.md docs/QA_LOG.md
git commit -m "QA run 2026-07-30: [pass rate]% pass rate

- [Issue count]: Critical [X], High [X], Medium [X], Low [X]
- Regressions: [X] new failures vs. prior run
- Fixes: [X] issues resolved since last run
- Recommendation: [BLOCKED/CONDITIONAL/APPROVED]"

git push
```

---

## Understanding the Results

### After a QA Run, Where Do I Look?

**Question**: What's the overall health?  
**Answer**: `docs/qa-results-[DATE].md` → Top section → **Status** (🟢/🟡/🟠/🔴)

**Question**: What failed?  
**Answer**: Same file → **Critical Failures**, **High Severity Failures**

**Question**: Is this a regression?  
**Answer**: `docs/QA_LOG.md` → **Regression Tracking** section

**Question**: How does this compare to last time?  
**Answer**: `docs/QA_LOG.md` → **Run Summary Table** (scroll down, compare rows)

**Question**: Which feature area is most broken?  
**Answer**: `docs/QA_LOG.md` → **Feature Area Health Score** (bottom has ↑/→/↓ trends)

**Question**: Can we release?  
**Answer**: `docs/qa-results-[DATE].md` → Bottom → **Release Decision** (🔴/🟡/🟢)

---

## Maintaining the Framework

### After Each Run (Required)

1. ✅ Fill in `docs/qa-results-[DATE].md` completely
2. ✅ Update `docs/QA_LOG.md`:
   - Add row to summary table
   - Document regressions
   - Update health scores
3. ✅ Commit both files
4. ✅ File tickets for issues

### Weekly (Recommended)

- Review `QA_LOG.md` trends
- Identify feature areas needing focus
- Update action items in the log

### Monthly (Quarterly)

- Review this framework — is it still working?
- Update severity criteria if needed
- Run a production QA (not just staging)
- Retrospective on what we learned

---

## Common Scenarios

### Scenario 1: You Find a Critical Issue

**You**: 🚨 Payment processing is broken!

**Do this**:
1. Stop testing and focus on this issue
2. Document exact reproduction steps
3. Take screenshots/video
4. Slack the engineering lead immediately (don't wait for end of run)
5. Mark as 🔴 CRITICAL in results file
6. Continue testing other features

**Result**: Engineering will jump on it, QA run is flagged as 🔴 BLOCKED.

---

### Scenario 2: You Find a Regression

**You**: Mobile sign-in works on 2026-07-28 run, broken on today's run.

**Do this**:
1. Check what code changed between runs: `git log --oneline [date1]..HEAD`
2. Make a hypothesis about which commit broke it
3. Document in results: "Likely caused by PR #123 (mobile sign-in refactor)"
4. Add to `QA_LOG.md` regression tracking table
5. File ticket linking to both the QA run and the suspected PR

**Result**: Engineering knows it's a regression and can prioritize accordingly.

---

### Scenario 3: You're Out of Time

**You**: I've tested critical path and core workflows (4 hours), but haven't done polish/edge cases yet.

**Do this**:
1. Mark remaining tests as ⊘ (Skipped) with reason "Time budget exhausted"
2. Note in results file: "Tested critical path and core workflows only"
3. Summarize findings based on what you did test
4. Next run can start with the polish/edge cases

**Result**: We still get valuable data on the critical path; polish is secondary.

---

### Scenario 4: You Think Something Might Be a Bug, But You're Not Sure

**You**: The invoice total looks wrong, but I'm not 100% sure if I calculated it right.

**Do this**:
1. Document what you observed (not what you think is true)
2. Mark as 🟡 MEDIUM (not 🔴 CRITICAL — you're not sure)
3. Include your calculation/reasoning in the report
4. Add note: "Needs verification by engineer"
5. File ticket so engineering can investigate

**Result**: You've flagged it without over-claiming it's broken. Engineer will verify.

---

## FAQ

### Q: What if I'm not a "QA person"?
**A**: No special skills needed. You know the product. Read the checklist, test the workflows, document what you find. That's all.

### Q: How do I know if a failure is my fault (misconfiguration) or the app's fault?
**A**: Assume it's the app's fault unless you have a clear reason to think otherwise. Better to report false positives than miss real bugs.

### Q: Can I test from home?
**A**: Yes, as long as you can access staging. If testing production, you need secure access (VPN, etc.).

### Q: What if I break something during testing (e.g., delete a customer)?
**A**: That's fine. Testing data is separate from production data (when using staging). If using production, just document what you changed in the results file.

### Q: How do I run QA on weekends / evenings?
**A**: You can! But don't wait for live users to find bugs. Run QA when you can (even if off-hours), then immediately report critical findings.

### Q: Can multiple people test in parallel?
**A**: Yes. Use different results files (`qa-results-2026-07-30-morning.md` and `qa-results-2026-07-30-afternoon.md`). Merge findings into `QA_LOG.md` once.

### Q: What if the app is completely down?
**A**: That's a 🔴 CRITICAL issue. Document it, mark all tests as failed (app unavailable), and escalate immediately.

### Q: How many checks should I expect to run?
**A**: ~286 checks across all feature areas. On critical path only? ~80 checks. Takes 2-3 hours for critical path.

### Q: Should I test the same thing multiple times?
**A**: Only if you're testing different scenarios (e.g., create estimate with 1 line item vs. 5 line items vs. discount). Don't repeat the exact same test.

### Q: Can I automate this?
**A**: Some tests can be automated (unit tests, integration tests). But full end-to-end QA with real user workflows still requires manual testing. This framework guides manual testing to catch issues automation can't.

---

## Support & Questions

**Need help?**
1. Read **QA_PROCESS.md** (detailed how-to guide)
2. Check **QA_CHECKLIST.md** (specific test instructions)
3. Look at prior results in **docs/qa-results-*.md** (examples)
4. Ask engineering lead or QA owner

**Found an issue with this framework?**
1. Note it in QA_LOG.md "Recommended Improvements" section
2. Propose changes in the next retro
3. This framework evolves based on real experience

---

## Schedule (Recommended)

```
Week 1:
  Tuesday — Run QA (Alice)
  Thursday — Run QA (Bob)
  Saturday — Run QA (Charlie)

Week 2:
  Tuesday — Run QA (Alice)
  Thursday — Run QA (Bob)
  Saturday — Run QA (Charlie)

(Rotate testers to get diverse perspectives)
```

**Next QA Runs**:
- [ ] 2026-07-31 (Thursday) — [Tester TBD]
- [ ] 2026-08-02 (Saturday) — [Tester TBD]
- [ ] 2026-08-05 (Tuesday) — [Tester TBD]

---

## Philosophy

This QA framework is built on three principles:

1. **Brutally Honest** — Every issue is documented, no matter how small. No sugar-coating.
2. **Systematic & Repeatable** — Same checklist every time, so we can spot regressions.
3. **Production-Like** — Test real workflows with real data, not isolated unit tests.

The goal is not to be exhaustive (that's what automated testing does), but to catch **human-discovery bugs** that only show up when someone actually uses the product.

---

**Last Updated**: 2026-07-30  
**Next Review**: 2026-08-13  
**Questions?** Ask the QA lead or engineering team.

