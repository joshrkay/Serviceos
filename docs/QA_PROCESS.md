# QA Process Guide — AI Service OS

**Effective**: 2026-07-30  
**Cadence**: Every 2-3 days (Tuesday, Thursday, Saturday recommended)  
**Owner**: QA Lead / Engineering Team  
**Time Budget**: 5-8 hours per run

---

## Overview

This document describes the complete manual QA process for AI Service OS. We run a comprehensive QA cycle every 2-3 days to catch regressions early and maintain quality as features evolve.

**Why this matters**: As the feature set grows, we need to ensure that new features don't break existing functionality. This process gives us an honest, detailed view of application health.

---

## The Process

### Phase 1: Setup (15 minutes)

1. **Choose a tester** (owner of this run)
2. **Choose an environment** (staging recommended, production quarterly)
3. **Run the QA setup script**:
   ```bash
   ./scripts/run-qa.sh --tester "Your Name" --env staging
   ```
4. **Verify the app is running** and accessible
5. **Open the test checklist**: `docs/QA_CHECKLIST.md`

### Phase 2: Systematic Testing (5-8 hours)

1. **Follow the testing roadmap** (checklist order)
2. **Test on multiple devices**:
   - Desktop: 1920px width (Chrome, Firefox, Safari)
   - Tablet: 768px width (if applicable)
   - Mobile: 375px width (Chrome mobile, Safari iOS)
3. **For each feature**:
   - Mark ✅ if it passes
   - Mark ❌ if it fails, document the issue
   - Take screenshots of failures
   - Note the exact steps to reproduce
4. **Be brutally honest** — record every issue, no matter how small
5. **Compare against prior run** — look for regressions
6. **Fill in the results file** as you go: `docs/qa-results-[DATE].md`

### Phase 3: Results & Triage (1-2 hours)

1. **Summarize findings**:
   - Total pass/fail counts
   - Critical issues (must fix)
   - High issues (urgent)
   - Medium issues (should fix)
   - Low issues (nice to fix)
2. **Identify regressions** (features that were passing but now fail)
3. **Identify fixes** (features that were failing but now pass)
4. **Update the master log**: `docs/QA_LOG.md`
   - Add your run to the summary table
   - Document regressions
   - Update health scores
5. **File tickets** for issues (if not already filed)
6. **Commit everything**: 
   ```bash
   git add docs/qa-results-[DATE].md docs/QA_LOG.md
   git commit -m "QA run [DATE]: [pass rate]% pass rate"
   ```

### Phase 4: Release Decision (30 minutes)

1. **Review critical issues** — Do any block release?
2. **Consult with engineering lead** if issues are unclear
3. **Make a go/no-go decision**:
   - 🟢 **APPROVED**: Pass rate >95%, no critical issues
   - 🟡 **CONDITIONAL**: Pass rate 80-95%, critical issues have workarounds
   - 🔴 **BLOCKED**: Pass rate <80% or critical issues with no workaround

---

## Testing Roadmap (by Priority)

### Critical Path (Test First — ~2-3 hours)

These are the core workflows. If any fail, the application is unusable.

1. **Authentication & Sign In** ➜ docs/QA_CHECKLIST.md §1
   - Can users log in?
   - Can users create accounts?
   - Can users reset passwords?

2. **Dashboard** ➜ docs/QA_CHECKLIST.md §2
   - Does the dashboard load?
   - Do all metrics display?
   - Are values up-to-date (<30s)?

3. **Appointments** ➜ docs/QA_CHECKLIST.md §3
   - Can technicians create appointments?
   - Can appointments be viewed and edited?
   - Do SMS confirmations send?

4. **Estimates** ➜ docs/QA_CHECKLIST.md §4
   - Can estimates be created?
   - Can line items be added/edited?
   - Are prices calculated correctly (integer cents)?
   - Can estimates be sent to customers?

5. **Invoices** ➜ docs/QA_CHECKLIST.md §5
   - Can invoices be created?
   - Can payment links be generated?
   - Can customers pay?
   - Are payments recorded correctly?

6. **Voice/Telephony** ➜ docs/QA_CHECKLIST.md §9
   - Do inbound calls get answered by AI?
   - Are calls transcribed accurately?
   - Are appointments created from calls?

7. **Money/Payment Processing** ➜ docs/QA_CHECKLIST.md §5.5, §16-18
   - All monetary values in integer cents (no floats)
   - Payment reconciliation matches Stripe
   - No double-counting of payments

### Core Workflows (~2-3 hours)

These are important features that should work but aren't necessarily blocking.

8. **SMS Messaging** ➜ docs/QA_CHECKLIST.md §10
9. **Customer Management** ➜ docs/QA_CHECKLIST.md §6
10. **Jobs & Dispatch** ➜ docs/QA_CHECKLIST.md §8, §11
11. **Settings & Configuration** ➜ docs/QA_CHECKLIST.md §13
12. **Security & RLS** ➜ docs/QA_CHECKLIST.md §15.5, §18

### Polish & Edge Cases (~1-2 hours, if time)

13. **Error Handling** ➜ docs/QA_CHECKLIST.md §15
14. **Performance** ➜ docs/QA_CHECKLIST.md §16
15. **Mobile Responsiveness** ➜ docs/QA_CHECKLIST.md §14
16. **Reports & Analytics** ➜ docs/QA_CHECKLIST.md §12
17. **AI & Proposals** ➜ docs/QA_CHECKLIST.md §17
18. **Leads & Intake** ➜ docs/QA_CHECKLIST.md §7

---

## How to Report Issues

### During Testing (in the results file)

For each failure, document:

1. **Check**: What exactly failed? (e.g., "Dashboard loads but metrics don't update")
2. **Severity**: 🔴 Critical / 🟠 High / 🟡 Medium / 🟢 Low
3. **Steps to Reproduce**:
   ```
   1. Log in as [user]
   2. Navigate to [section]
   3. [Action that fails]
   ```
4. **Expected**: What should happen
5. **Actual**: What actually happened
6. **Evidence**:
   - Screenshot or video
   - Network error (if applicable)
   - Console error (if applicable)
   - Database state (if applicable)

### Severity Guidelines

- **🔴 CRITICAL**: 
  - Breaks core workflow (can't create estimate, can't process payment)
  - Data loss or corruption
  - Security vulnerability
  - Financial impact (money miscalculation)
  - Affects multiple users/tenants
  
- **🟠 HIGH**: 
  - Affects important workflow but has a workaround
  - Data integrity risk (eventual consistency issues)
  - Performance degradation (>2s page load)
  - User experience significantly impacted
  
- **🟡 MEDIUM**: 
  - Edge case affecting some users
  - Minor UX issue (confusing button text, awkward flow)
  - Non-critical feature doesn't work
  - Performance acceptable but not ideal
  
- **🟢 LOW**: 
  - Polish / cosmetic issue
  - Rare edge case
  - Low-priority improvement
  - Doesn't affect workflow

---

## Regression Tracking

After each run, compare against the previous run's results.

### What to Look For

1. **Issues that were passing, now failing** ➜ Regression
   - Usually caused by recent code changes
   - High priority to fix (indicates a bug was introduced)
   
2. **Issues that were failing, now passing** ➜ Fixed
   - Great news! Document which fix/PR resolved it
   
3. **New failures** (not seen before)
   - Either a new feature that's broken, or a new regression
   - Document in QA_LOG.md

### Documenting Regressions

In `QA_LOG.md`, add to the regression table:

| Feature | First Regressed | Status | Impact | Root Cause | Ticket | Fix Date |
|---------|-----------------|--------|--------|-----------|--------|----------|
| [Feature] | 2026-07-30 | 🔴 OPEN | [Impact] | [Hypothesis] | #123 | [TBD] |

**Root Cause Hypothesis**: Make your best guess about what code change caused this.
- Look at commits since the last passing run
- Check if any recent changes touch related code
- Link to the suspected PR

---

## Testing by Device & Browser

### Desktop Testing (1920px)

- [ ] **Chrome** (latest)
  - Open DevTools, set viewport to 1920x1080
  - Test all features
  - Check console for errors
  
- [ ] **Firefox** (latest)
  - Open DevTools, set viewport to 1920x1080
  - Test critical paths (sign in, estimate, payment)
  
- [ ] **Safari** (latest)
  - If on Mac, test critical paths
  - Check for layout issues specific to Safari

### Mobile Testing (375px)

- [ ] **Chrome Mobile** (on Android or DevTools)
  - Set viewport to 375x667 (iPhone 8 / SE size)
  - Test sign in, estimate approval, payment
  - Verify tap targets are ≥44px
  - Check for horizontal scroll (should not exist)
  
- [ ] **Safari iOS** (if available)
  - Test estimate approval, payment flow
  - Check for Safari-specific issues
  - Verify keyboard doesn't obscure inputs

### Tablet Testing (768px, optional)

- Test dashboard and list views
- Verify layout scales correctly
- Check touch interactions

---

## Performance Testing

### Page Load Benchmarks

Use Chrome DevTools Network tab to measure:

| Page | Target | Mobile 4G | Desktop Cable | Measured |
|------|--------|-----------|---------------|----------|
| Dashboard | <2s | <3s | <2s | [Actual] |
| Customer List | <2s | <3s | <2s | [Actual] |
| Estimate View | <1s | <2s | <1s | [Actual] |
| Appointment Create | <1s | <2s | <1s | [Actual] |

**How to measure**:
1. Open Chrome DevTools (F12)
2. Go to Network tab
3. Disable cache (checkmark "Disable cache" in DevTools)
4. Hard refresh (Ctrl+Shift+R)
5. Look at the load time (bottom left of Network tab)
6. Record the time

---

## Money/Payment Testing (CRITICAL)

All monetary values must be integer cents. This is non-negotiable.

### Test Scenarios

1. **Create estimate with line items**:
   - Add line item for $100.00
   - Add line item for $50.50
   - Verify subtotal = $150.50 (in cents: 15050)
   - Add 10% tax = $15.05 (in cents: 1505)
   - Verify total = $165.55 (in cents: 16555)

2. **Apply discount**:
   - $10 discount → total = $155.55 (15555 cents)
   - 5% discount → total = $157.27 (15727 cents)

3. **Payment processing**:
   - Process payment for $165.55
   - Verify Stripe charge is 16555 cents
   - Verify database records 16555 cents (never 165.55)

4. **Partial payment**:
   - Invoice for $1000.00 (100000 cents)
   - Pay $500.00 (50000 cents)
   - Verify remaining balance = $500.00 (50000 cents)

5. **Reconciliation**:
   - Compare database totals to Stripe balance
   - Check for orphaned/missing cents
   - Verify no floating-point errors

---

## Security & Data Isolation Testing

### RLS (Row-Level Security)

1. **Create two test tenants**: Tenant A and Tenant B
2. **Log in as Tenant A user**
3. **Try to access Tenant B data**:
   - Via URL: `?tenant_id=B` (should fail)
   - Via API: `GET /api/customers?tenant_id=B` (should fail)
   - Via database query (should return empty)
4. **Verify**: Tenant A can only see Tenant A's data

### Authentication

1. **Steal session token** (copy from browser dev tools)
2. **Try to use in different browser** (should work = tokens are portable)
3. **Wait for session timeout** (usually 1-2 hours)
4. **Try to use expired token** (should fail with 401 Unauthorized)

---

## AI & Proposal Quality

### AI Call Handling

Test a live inbound call:

1. **Call the business number** from an external phone
2. **Listen for**:
   - [ ] Professional greeting
   - [ ] Clear audio (not robotic)
   - [ ] Correct business name
3. **Go through appointment booking flow**:
   - [ ] AI asks for service type
   - [ ] AI asks for appointment date/time
   - [ ] AI asks for address
   - [ ] AI asks for callback number
   - [ ] AI confirms details
4. **Verify**:
   - [ ] Appointment created
   - [ ] Confirmation SMS sent
   - [ ] Call transcript logged
   - [ ] Lead/customer record created

### AI Estimate Generation

1. **Create a new estimate** via voice or web
2. **Let AI draft line items** (if auto-drafting enabled)
3. **Check**:
   - [ ] All items in catalog (or flagged as uncertain)
   - [ ] Prices are reasonable
   - [ ] Quantities correct
   - [ ] Total makes sense
4. **Review confidence scores** (low confidence = needs approval)

---

## Known Issues & Waivers

As of 2026-07-30, there are no known waived issues. If an issue is consistently failing across runs and there's no plan to fix it, document it here to distinguish "known problem" from "regression."

Template for known issue:

```markdown
### Known Issue: [Title]

**First Seen**: 2026-07-30  
**Severity**: 🟡 MEDIUM  
**Impact**: [What breaks]  
**Workaround**: [If any]  
**Status**: 🟠 OPEN / ✅ FIXED / ❌ WONT FIX  
**Notes**: [Context]  
```

---

## Communication & Escalation

### During Testing

- If you find a critical issue, **slack the engineering lead immediately** (don't wait until end of run)
- If you're blocked (app won't start, can't log in), escalate to on-call engineer

### After Testing

1. **File tickets** for all issues (use issue template if available)
2. **Link to QA results** in the ticket
3. **Tag tickets** with QA labels
4. **Assign to** engineering lead or product owner

### Escalation Path

- 🟢 **Low issues**: Add to backlog, no urgent action
- 🟡 **Medium issues**: File ticket, discuss in next standup
- 🟠 **High issues**: File ticket, assign to sprint, mention in Slack
- 🔴 **Critical issues**: Page on-call engineer, all-hands if needed

---

## Tools & Resources

### Required Tools

- Web browser(s): Chrome, Firefox, Safari
- Browser DevTools for inspecting network, console, timeline
- Screenshot tool (built-in or Snagit)
- Markdown editor (VS Code, Sublime, etc.)
- Git/GitHub access to file issues

### Optional Tools

- Video recording (Loom, OBS) for complex failures
- Performance profiler (Chrome DevTools, Lighthouse)
- Mobile device or emulator for mobile testing
- Network throttler to simulate slow connections

### Files

- **Testing Checklist**: `docs/QA_CHECKLIST.md` (detailed steps)
- **Results Template**: `docs/qa-results-template.md` (template for new run)
- **Results File**: `docs/qa-results-[DATE].md` (this run's results)
- **Master Log**: `docs/QA_LOG.md` (track all runs)
- **This Guide**: `docs/QA_PROCESS.md` (you are here)

---

## Example QA Run (Timeline)

```
Tuesday 9:00 AM — Setup
  • Run: ./scripts/run-qa.sh --tester "Alice" --env staging
  • Verify app is running
  • Open checklist and results file

Tuesday 9:15 AM — Critical Path Testing (2-3 hours)
  • Test Auth (15 min)
  • Test Dashboard (20 min)
  • Test Appointments (30 min)
  • Test Estimates (40 min)
  • Test Invoices (40 min)
  • Test Voice (20 min)
  • Test Payments (15 min)
  • Found 3 issues: 1 critical, 2 high

Tuesday 12:30 PM — Core Workflows Testing (2-3 hours)
  • Test SMS (30 min)
  • Test Customers (20 min)
  • Test Jobs (30 min)
  • Test Settings (20 min)
  • Test Security (20 min)
  • Test Error Handling (20 min)
  • Found 5 more issues: 0 critical, 3 high, 2 medium

Tuesday 3:15 PM — Wrap-up & Triage (1-2 hours)
  • Summarize findings: 92% pass rate
  • Identify regressions: 1 (Invoice payment reconciliation)
  • Identify fixes: 2 (Password reset, Mobile view)
  • Update QA_LOG.md with summary
  • File 8 tickets in GitHub
  • Commit results

Tuesday 4:00 PM — Release Decision
  • Review with engineering lead: 🟡 CONDITIONAL
  • Can release if the 1 critical issue (payment reconciliation) is fixed
  • Assign to sprint with high priority
```

---

## FAQ

### Q: How long does a QA run take?
**A**: 5-8 hours typically. Critical path (2-3 hrs) + core workflows (2-3 hrs) + polish (1-2 hrs).

### Q: What if I find an issue but don't know how to fix it?
**A**: That's fine! Your job is to find and document issues, not fix them. File a ticket with clear reproduction steps, and engineering will handle it.

### Q: Should I test production or staging?
**A**: Staging is recommended for regular runs (faster iteration). Do a production run monthly or before major releases.

### Q: What if the app crashes during testing?
**A**: That's a critical issue! Document it, restart the app, and continue. This shows us the app is unstable.

### Q: How do I know if something is a regression vs. a known issue?
**A**: Check `QA_LOG.md`. If the feature was passing in the prior run, it's a regression. If it's in the "Known Issues" section, it's not new.

### Q: What if I run out of time?
**A**: Prioritize: critical path first, then core workflows. Document how far you got and why you stopped. Next run can pick up where you left off.

### Q: Can I test multiple times on the same day?
**A**: Yes, but file separate results files (e.g., `qa-results-2026-07-30-morning.md`). Only update the master log once per day.

### Q: Who reviews the QA results?
**A**: The engineering lead and product manager review results to prioritize fixes.

---

## Feedback & Improvements

This QA process is living documentation. If you have suggestions to improve it:

1. Document the suggestion in QA_LOG.md "Process Improvements" section
2. Propose changes to CLAUDE.md or this guide
3. Discuss in retro

Remember: The goal is to catch bugs early and build confidence in the product. Your honest, thorough testing is valuable.

---

**Last Updated**: 2026-07-30  
**Next Review**: 2026-08-13

