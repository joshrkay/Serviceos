# QA Run Log & Regression Tracking

**Master Log**: Tracks all QA runs and allows comparison across 2-3 day cycles.  
**Purpose**: Early detection of regressions, tracking of bug fixes, trend analysis.  
**Last Updated**: 2026-09-06

---

## How to Use This Log

1. **After each QA run** (every 2-3 days), file a new entry in the table below.
2. **Fill in the run date, pass rate, and critical/high counts.**
3. **Compare against the previous run** to spot regressions.
4. **Document what changed** in the "Notes" column.
5. **Cross-reference** back to the detailed results file (`qa-results-[DATE].md`).

---

## Run Summary Table

| Run Date | Tester | Environment | Pass Rate | Passes | Failures | Critical | High | Medium | Low | Status | Notes | Detailed Report |
|----------|--------|-------------|-----------|--------|----------|----------|------|--------|-----|--------|-------|-----------------|
| 2026-07-30 | [TBD] | Staging | [%] | [X] | [X] | [X] | [X] | [X] | [X] | 🟢 HEALTHY | Initial baseline QA run | [qa-results-2026-07-30.md](qa-results-2026-07-30.md) |
| 2026-08-18 | Claude Code | Development | 71% | 60 | 13 | 3 | 2 | 4 | 4 | 🔴 BLOCKED | Pass rate <80% per QA_PROCESS.md; infrastructure blockers prevent full testing; code quality clean; no regressions | [qa-results-2026-08-18.md](qa-results-2026-08-18.md) |
| 2026-09-06 | Fable 5.1 + Sonnet workers | Cloud container (CI-equivalent; Docker + hermetic browser; no provider creds) | 92% (22/24 automated lanes) | 22 | 2 | 0 | 0 | 1 | 5 | 🟡 DEGRADED (automated) | All CI gates green incl. 14 158 API unit, 1 218 integration on real Postgres, 3 057 web/shared/mobile, voice-quality 73/73, Playwright hermetic 19/19; only the two documented non-blocking corpus checks red; 1 pre-existing medium defect (C-1/D-1) re-confirmed at runtime; provider legs remain STAGING | [verification/full-verification-2026-09-06.md](verification/full-verification-2026-09-06.md) |
| [DATE] | [Name] | Prod/Staging | [%] | [X] | [X] | [X] | [X] | [X] | [X] | 🔴/🟠/🟡/🟢 | [Change summary] | [Link] |

---

## Regression Tracking

Track issues that regress (pass → fail) or recover (fail → pass).

### Currently Tracked Regressions

| Feature | First Regressed | Status | Impact | Root Cause | Ticket | Fix Date |
|---------|-----------------|--------|--------|-----------|--------|----------|
| [Feature Name] | 2026-07-30 | 🔴 OPEN | [Impact] | [Cause] | [#123] | [TBD] |

### Recently Fixed Issues (Fail → Pass)

| Feature | First Failed | Fixed Date | Fixer | Notes |
|---------|--------------|-----------|-------|-------|
| [Feature Name] | 2026-07-20 | 2026-07-30 | [Name] | [Brief note] |

---

## Critical Issues Requiring Immediate Attention

**As of 2026-07-30**: [X] critical issues

### Active Critical Blockers

| Issue | First Seen | Severity | Impact | Assigned | ETA | Notes |
|-------|-----------|----------|--------|----------|-----|-------|
| [Issue Name] | 2026-07-30 | 🔴 CRITICAL | [Impact] | [Owner] | [Date] | [Notes] |

---

## Feature Area Health Score (by category)

Updated after each QA run. Shows which areas are stable vs. problematic.

### Health Scorecard

Updated 2026-09-06 from executed automated evidence (see `verification/full-verification-2026-09-06.md` §2 for the per-workflow table). "STAGING" means the code path is wired and proven up to the provider boundary; the provider leg needs credentials.

| Section | Automated evidence executed | Status | Trend | Notes |
|---------|-----------------------------|--------|-------|-------|
| 1. Auth | RBAC/Clerk/RLS unit + 7 RLS integration suites + HTTP cross-tenant 404s + no-401-storm e2e | 🟢 | ↑ | Clerk-cloud sign-in UI is STAGING |
| 2. Dashboard | 8 home component suites, analytics/digest API, portal-dashboard mobile e2e (4/4) | 🟢 | ↑ | — |
| 3. Appointments | 9+14+4 API suites, voice reschedule/cancel/reassign integration, day-window runtime proof | 🟢 | ↑ | SMS delivery leg STAGING |
| 4. Estimates | 29 API suites, public approval e2e (4/4), money-loop e2e, runtime integer-cents proof | 🟢 | ↑ | — |
| 5. Invoices | 35+15+3 API suites, webhook-paid e2e, idempotency/concurrency integration, runtime payment arithmetic | 🟢 | ↑ | Live Stripe STAGING |
| 6. Customers | 12 API suites, 11 web suites, 9 integration suites, runtime CRUD/archive/dup-warning | 🟢 | ↑ | — |
| 7. Leads | 7 API suites, public-intake integration, voice lead-capture 7/7 | 🟡 | ↑ | No web component tests for lead pages (P2-4) |
| 8. Jobs | 13 API suites, 17 web suites, runtime status machine new→completed with timeline | 🟢 | ↑ | — |
| 9. Voice | 35+61+37 API suites, 73/73 voice-quality launch gate, durable-timer integration, runtime signed-webhook + no-key pipeline | 🟢 | ↑ | Real audio/LLM STAGING |
| 10. SMS | 17 API suites, 7 conversation integration suites, MMS-to-quote integration | 🟢 | ↑ | Comms-inbox browser flow STAGING (Clerk) |
| 11. Dispatch | 15 API + 15 web suites, 6 integration suites | 🟡 | ↑ | Feature is implemented (prior "not implemented" note was wrong); no e2e drives the board (P2-3) |
| 12. Reports | 10+7 API suites, digest worker integration, reports e2e in qa-matrix | 🟢 | ↑ | — |
| 13. Settings | 30 web suites, 14 API suites, packs/flags/brand-voice/onboarding integration | 🟢 | ↑ | Onboarding v2 browser journey STAGING |
| 14. Mobile | 116 files / 826 tests, coverage gate met, typecheck green | 🟡 | ↑ | 10 responsive specs skip without Clerk (P1-2); RN jest-expo ungated |
| 15. Errors | Middleware/webhook suites, render-stability e2e, runtime structured 400s | 🟡 | → | D-1: unmatched `/api/*` hits SPA catch-all (P1-1) |
| 16. Performance | Index EXPLAIN integration only | 🟠 | → | Load scripts exist but unwired (P3-3) |
| 17. AI Quality | 271+114 API suites, proposal CAS integration, runtime approve→5s undo→execute gate | 🟢 | ↑ | Real-LLM soak STAGING |
| 18. Security | RLS audit (every table forced), signatures, log-safety, PII guard | 🟡 | → | Dependency advisories open (P2-1) |
| **OVERALL** | **22/24 automated lanes green; 0 product regressions** | 🟡 | **↑** | **Release-ready on automated evidence; provider legs need the staging runbook** |

**Legend**:
- 🟢 **Healthy** (95%+): Area is stable, no action needed.
- 🟡 **Degraded** (80-94%): Some issues, monitor closely, address in next sprint.
- 🟠 **Concerning** (65-79%): Multiple failures, needs prioritization.
- 🔴 **Critical** (<65%): Broken, blocks release, immediate action required.

**Trend Symbols**:
- ↑ Improving — fixes landed, situation better than last run.
- → Stable — consistent pass rate, no major changes.
- ↓ Degrading — regression or new failures, needs investigation.

---

## By-the-Numbers Trends

Track pass rate, failure count, and critical count over time.

```
Pass Rate Over Time:
100% ┤
 95% ├───────────────
 90% ├   🟢 🟢 🟡 🟡 🟡
 85% │           🟠
 80% │
 75% ├
      └──────────────────────
        2026-07-30  →  Future runs

(Chart updates as runs accumulate)
```

| Week | Mon | Tue | Wed | Thu | Fri | Sat | Sun | Avg | Trend |
|------|-----|-----|-----|-----|-----|-----|-----|-----|-------|
| Jul 28-Aug 03 | - | [%] | [%] | [%] | - | [%] | - | [%] | [Trend] |
| Aug 04-10 | - | - | - | - | - | - | - | - | - |

---

## Known Issues Inventory

Persistent bugs that appear across multiple runs. Maintained to track "this is a known issue, not a regression."

### Issue Backlog

| Issue ID | Feature | Severity | Status | First Seen | Last Seen | Days Open | Notes |
|----------|---------|----------|--------|-----------|-----------|-----------|-------|
| QA-001 | [Feature] | 🟡 MEDIUM | OPEN | 2026-07-30 | 2026-07-30 | 0 | [Description] |
| QA-002 | [Feature] | 🟠 HIGH | BLOCKED | 2026-07-30 | 2026-07-30 | 0 | [Description] |
| QA-003 | Unmatched `/api/*` routes fall into SPA catch-all (200 HTML or 500) | 🟡 MEDIUM | OPEN | 2026-07 (C-1) | 2026-09-06 | — | Re-confirmed at runtime; fix = JSON 404 before catch-all (plan P1-1) |

---

## QA Process Health

Track the QA process itself to ensure we're catching issues consistently.

### Coverage Assessment

| Area | Coverage | Automated? | Manual? | Notes |
|------|----------|-----------|---------|-------|
| Authentication | 100% | ✅ | ✅ | Full coverage |
| Dashboard | 90% | ⚠️ Partial | ✅ | Widget metrics need more tests |
| Estimates | 95% | ✅ | ✅ | Good coverage |
| Invoices | 90% | ⚠️ Partial | ✅ | Payment reconciliation untested |
| Voice | 80% | ❌ Limited | ✅ | Transcription hard to test automatically |
| Mobile | 75% | ⚠️ Partial | ✅ | Need more device coverage |

### Test Reliability

| Category | Flaky? | Reliability | Notes |
|----------|--------|-------------|-------|
| API tests | ❌ No | 100% | Stable |
| UI tests | ⚠️ Occasional | 95% | Mobile sometimes slow |
| Integration tests | ✅ Yes | 85% | Database timing issues |
| E2E tests | ⚠️ Occasional | 90% | Network timeouts |

---

## Lessons Learned & Process Improvements

Document what we learn from QA runs to improve future testing.

### Recent Learnings

**2026-07-30**: 
- Setting up the QA process for the first time
- Establishing baseline with comprehensive checklist
- All feature areas are functional; no critical blockers

### Process Improvements Made

1. [Date]: [What we improved]
2. [Date]: [What we improved]

### Recommended Improvements for Next Sprint

- [ ] Add automated tests for payment reconciliation (currently all manual)
- [ ] Improve mobile device coverage (add iPad, Android tablet)
- [ ] Reduce voice transcription testing latency (currently slow to validate)
- [ ] Add performance benchmarking to QA checklist (measure load times)

---

## Release Decision History

Track which QA runs led to releases and what the decision criteria were.

| Run Date | Recommendation | Release Decision | Release Date | Release Notes Link | Post-Release Issues |
|----------|-----------------|-----------------|--------------|-------------------|-------------------|
| 2026-07-30 | [Blocked/Conditional/Approved] | [TBD] | [TBD] | [Link] | [Notes] |

---

## Action Items & Follow-Ups

Open tasks from QA process:

- [ ] **[Critical Issue]** — Fix [Feature], blocking release [Owner] [ETA: DATE]
- [ ] **[High Issue]** — Improve [Feature] performance [Owner] [ETA: DATE]
- [ ] **[Process]** — Add automated tests for [Area] [Owner] [ETA: DATE]
- [ ] **[Automation]** — Record baseline performance metrics [Owner] [ETA: DATE]

---

## Contact & Escalation

**QA Lead**: [Name] ([Email])  
**Engineering Lead**: [Name] ([Email])  
**Product Manager**: [Name] ([Email])  

**Escalation Path**:
1. 🟠 HIGH / 🟡 MEDIUM issues → Engineering Lead
2. 🔴 CRITICAL issues → All hands, immediate action

---

## Template for New Runs

Copy/paste when starting a new QA run:

```markdown
## Run: [YYYY-MM-DD]

**Date**: [YYYY-MM-DD]  
**Tester**: [Name]  
**Environment**: [Prod/Staging]  
**Duration**: [X hours]  

**Summary**:
- **Pass Rate**: [X%]
- **Passed**: [X] ✅
- **Failed**: [X] ❌
- **Skipped**: [X] ⊘
- **Critical**: [X]
- **High**: [X]
- **Medium**: [X]
- **Low**: [X]

**Key Findings**:
1. [Critical issue #1]
2. [Critical issue #2]
3. [High issue #1]

**Regressions** (vs. prior run on [DATE]):
- [Feature] — was passing, now failing

**Fixes** (vs. prior run on [DATE]):
- [Feature] — was failing, now passing ✅

**Detailed Report**: [qa-results-2026-07-30.md](qa-results-2026-07-30.md)

**Next Steps**:
- [ ] File ticket for issue #1
- [ ] File ticket for issue #2
- [ ] Assign fixes to sprint

**Sign-Off**: 🔴 BLOCKED / 🟡 CONDITIONAL / 🟢 APPROVED
```

---

## Appendix: Severity & Status Definitions

### Severity Levels

- **🔴 CRITICAL**: Breaks core functionality, financial impact, security risk, blocks release
- **🟠 HIGH**: Affects important workflow, degrades user experience, data integrity risk
- **🟡 MEDIUM**: Edge case, minor UX issue, low-impact bug
- **🟢 LOW**: Polish, cosmetic, low-priority improvement

### Status Symbols

- **🟢 HEALTHY**: Baseline passing, no issues
- **🟡 DEGRADED**: Some failures, working but not ideal
- **🟠 CONCERNING**: Multiple failures, needs prioritization
- **🔴 CRITICAL**: Broken, blocks release

### Trend Symbols

- **↑** Improving (more fixes than regressions)
- **→** Stable (no major changes)
- **↓** Degrading (more regressions than fixes)

