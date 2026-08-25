# QA Regression Comparison — June 4 vs August 25, 2026

**Baseline:** 2026-06-04 Comprehensive QA Report  
**Current:** 2026-08-25 Automated QA Cycle 2  
**Duration:** 82 days, 82 commits analyzed

---

## Test Suite Health Trajectory

### Unit Tests
| Metric | June 4 | Aug 25 | Change | Verdict |
|--------|--------|---------|--------|---------|
| API tests | 5,511 passed | 13,558 passed | **+8,047 (+146%)** | ✅ Excellent growth with zero failures |
| Web tests | 944 passed | (same suite, passed) | Stable | ✅ No regression |
| Test files | ~600 | 1,129 | **+529 (+88%)** | ✅ Comprehensive expansion |
| Failures | 0 | 0 | **No change** | ✅ Zero regressions |

**Interpretation:** Test suite nearly DOUBLED in size with 100% pass rate maintained. Indicates aggressive quality investment alongside feature development.

---

## Known Issues Tracking

### P0 Blockers (Ship-Stoppers)

| Issue | June Status | Aug Status | Fix Status | Risk |
|-------|---------|-----------|---------|------|
| **Blocker 11: TCPA/DNC gate** | 🔴 OPEN | 🔴 **STILL OPEN** | No commits addressing | 🔴 **CRITICAL** — Ship blocker if voice is live |
| **Branding ("Fieldly" vs "ServiceOS")** | 🔴 OPEN | 🔴 **STILL OPEN** | No commits addressing | 🟠 High (customer-visible) |
| **5 HIGH npm vulnerabilities** | Not tracked | 🔴 **NEW FINDING** | Yes, fixable via `npm audit fix` | 🔴 **CRITICAL** — Supply chain risk |

**Regression Alert:** Same two blockers still open from June. Blocker 11 is **ship-critical** if voice product is in use.

---

### P1 Bugs (Beta-Level Fixes)

| Bug | June Status | Aug Status | Verified | Impact |
|-----|---------|-----------|----------|--------|
| **BUG-03: Money float** (.toLocaleString drops cents) | 🔴 OPEN | ❓ **UNVERIFIED** | No test for this | 🟠 Data corruption in UI |
| **BUG-05: UTC bucketing** (money dashboard) | 🔴 OPEN | ❓ **UNVERIFIED** | No test for this | 🟠 Operational confusion |
| **BUG-07: Refund webhook** (not wired) | 🔴 OPEN | ❓ **LIKELY STILL OPEN** | No commits | 🟡 Graceful failure if hit |
| **ReviewResponseHandler** (not wired) | 🔴 OPEN | ❓ **LIKELY STILL OPEN** | Comment found in code | 🟡 May not be a shipping feature |

**Note:** These bugs are not causing test failures (tests pass 100%), which suggests either:
1. The bugs exist but are not tested, OR
2. The features they affect are not yet live, OR
3. Workarounds mask the issues in testing

**Recommendation:** Manually verify BUG-03 (float) and BUG-05 (timezone) before deploying to production.

---

## Code Quality Metrics

### What Improved
- ✅ Voice system: PIN redaction (2 sites closed), standing instructions now speakable
- ✅ PII handling: Fixed quadratic-backtracking regex (performance), email redactor now loops to fixed point
- ✅ Assistant: Complaint/negotiation no longer answer-from-nothing; customer card preserves explanation
- ✅ Chat money: Fixed integer cents handling (was floating point)
- ✅ App architecture: Composition root refactored with overrides seam (D-024 in progress)
- ✅ Proposals: Execution errors now cleared on retry; cause-building stays in failure-soft boundary

### What's Still Open
- 🔴 Blocker 11 (TCPA/DNC)
- 🔴 Branding decision
- ❓ BUG-03, BUG-05 (not regression-tested)

### No Regressions Detected In
- ✅ Database RLS (FORCE RLS on 74 tables still in place)
- ✅ Auth (RS256/JWKS still verified, /metrics now protected)
- ✅ Webhook idempotency (Stripe/Clerk dedup still working)
- ✅ Voice encryption (AES-256-GCM at rest, no changes)
- ✅ Build (tsc validation passing, zero type errors)

---

## Test Coverage Expansion Analysis

**Since June 4, new tests added for:**
1. Voice improvements (PIN redaction, standing instructions, lookup extraction)
2. Assistant/chat fixes (complaint, negotiation, customer card)
3. App composition refactoring (dependency injection, sibling overrides)
4. Proposal execution (failure handling, error clearing)
5. PII/redaction (email handling, backtracking fixes)

**Tests that still DON'T appear to exist:**
- Money float rendering (toLocaleString → centsToDisplay)
- Timezone bucketing in money dashboard
- Refund webhook handling (charge.refund.updated)
- ReviewResponseHandler wiring
- Double-booking prevention (trigger test from June's Blocker 7)

---

## Deployment Readiness Assessment

### June Baseline
| Component | Status |
|-----------|--------|
| Build | ✅ Green |
| Unit tests | ✅ 5,511 passing |
| Type safety | ✅ Pass |
| Blockers | 🔴 2/12 open (Blocker 11 critical) |
| Known bugs | 🔴 6+ open |
| **Ship Readiness** | 🔴 **BLOCKED** by Blocker 11 |

### August Current
| Component | Status |
|-----------|--------|
| Build | ✅ Green |
| Unit tests | ✅ 13,558 passing (NO REGRESSIONS) |
| Type safety | ✅ Pass |
| Blockers | 🔴 2/12 open (Blocker 11 **still critical**) |
| Known bugs | 🔴 Same 6+ from June, **plus 5 npm vulns** |
| **Ship Readiness** | 🔴 **STILL BLOCKED** by Blocker 11 + npm vulns |

---

## Summary: Progress & Risks

### ✅ What's Improved
- Test suite expanded massively (+8,047 tests) with zero failures
- Voice and PII handling substantially hardened
- Code architecture improving (composition refactor, D-024)
- No regressions in core systems (RLS, auth, encryption, webhooks)

### 🔴 What's Still Broken
- **Blocker 11 (TCPA/DNC gate)** — Still unimplemented, ship-critical if voice is live
- **5 HIGH npm vulnerabilities** — New blocker since June, supply-chain risk
- **Branding decision** — Still unresolved ("Fieldly" vs "ServiceOS")
- **3 P1 bugs** — Unverified since June (money float, timezone bucketing, refund webhook)

### ⚠️  What Needs Verification
- Manual test: Money rendering ($1,234.5 vs $1,234.50 bug)
- Manual test: Money dashboard shows correct tenant timezone
- Manual test: Refund webhook works end-to-end
- Manual test: Branding is consistent across web app

### 📋 Action Items (Ordered by Priority)

1. **URGENT — Fix npm vulnerabilities:** `npm audit fix` + test + deploy
2. **URGENT — Implement Blocker 11:** Wire `dncRepo.isOnDnc()` check in voice outbound path
3. **HIGH — Resolve branding:** Pick "Rivet" / "ServiceOS" / "Fieldly" and apply consistently
4. **HIGH — Verify BUG-03 & BUG-05:** Manual test money rendering and timezone bucketing
5. **MEDIUM — Configure E2E matrix:** Restore automated 74-row matrix QA
6. **MEDIUM — Add regression tests:** BUG-03, BUG-05, refund webhook, ReviewResponseHandler

---

## Conclusion

**Overall Trajectory:** POSITIVE (strong test growth, no regressions) BUT SHIP READINESS UNCHANGED (same blockers).

The system has undergone significant hardening, particularly around voice safety and data handling. However, **Blocker 11 (TCPA/DNC gate) remains the critical ship-stopper**, and is compounded now by supply-chain risk from npm vulnerabilities.

**Next QA cycle (2026-08-27):**
- Verify Blocker 11 fix has been implemented
- Verify npm vulnerabilities patched
- If Blocker 11 is fixed, run full 74-row matrix QA to confirm no regressions
- Spot-check manual tests for BUG-03 and BUG-05

