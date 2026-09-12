# ServiceOS QA Process — Comprehensive Manual Testing Framework

**Updated:** 2026-09-01  
**Cycle:** Every 2-3 days (automated + manual)

---

## Overview

This QA framework ensures **brutally honest, detailed assessment** of the entire application every 2-3 days. The goal is to catch regressions immediately, prove that fixes don't re-break, and maintain a complete audit trail of what works and what doesn't.

### What This Framework Provides

1. **QA-COMPARISON-LOG.md** — Running log of every QA run with metrics
2. **QA-MANUAL-CHECKLIST.md** — Comprehensive feature checklist (12 categories, 100+ test cases)
3. **qa-scheduled-run.ts** — Automated script to collect baseline metrics every run
4. **Deep regression tracking** — Compare runs; identify what broke and what was fixed

---

## Quick Start

### Automated Checks (Every Run, ~15 min)
```bash
npm run typecheck   # TypeScript compilation
npm run lint        # ESLint + code quality
npm test            # Unit tests (runs in background)
```

### Manual Feature Testing (Every 2-3 days, ~2 hours)
1. Open **QA-MANUAL-CHECKLIST.md**
2. Walk through all 12 feature categories
3. Record PASS / PARTIAL / FAIL for each
4. Document any regressions
5. Update QA-COMPARISON-LOG.md with findings

### Full E2E Matrix (If credentials available)
```bash
# Requires Railway dev URLs + Clerk HMAC secret
npm run qa:matrix:run
```

---

## The Framework

### 1. QA-COMPARISON-LOG.md

**Purpose:** Track QA run metrics and compare across 2-3 day cycles

**What It Captures:**
- Date/time of run
- Baseline metrics (typecheck, lint, unit tests)
- Feature status by category
- Regressions from previous run
- Known issues & workarounds
- Test coverage by layer

**How to Update:**
- Run automated checks
- Document baseline metrics
- Note any regressions
- Track what was fixed since last run

**Example Flow:**
```
Run #1 (Sept 1) → 10 tests passing, 0 failing
  ↓ Feature added Thursday
Run #2 (Sept 3) → 10 tests passing, 2 NEW FAILURES (regressions)
  ↓ Fix pushed Friday
Run #3 (Sept 5) → 12 tests passing, 0 failing (regressions fixed)
```

### 2. QA-MANUAL-CHECKLIST.md

**Purpose:** Exhaustive feature-by-feature testing (not aspirational)

**Coverage:**
1. Provisioning & Onboarding
2. Customer Management
3. Estimates & Proposals
4. Scheduling & Appointments
5. Voice (AI Calling)
6. SMS & Communications
7. Payments & Billing ⚠️ CRITICAL
8. Data Isolation & Security ⚠️ CRITICAL
9. Audit & Compliance
10. UI/UX (Mobile-First)
11. Performance
12. Deployment & Infrastructure

**Critical Sections (⚠️):**
- **Estimates & Proposals:** Catalog validation ensures AI-drafted prices are real
- **Scheduling:** Double-booking prevention (DB constraint must be enforced)
- **Voice:** TCPA/DNC compliance (no calls to blocked numbers)
- **Payments:** Webhook idempotency (double-apply prevention)
- **Security:** RLS isolation (tenant data hermetic sealing)

**How to Use:**
- Check each item as you test
- Mark ✅ PASS, ⚠️ PARTIAL, or ❌ FAIL
- If ⚠️ or ❌, describe the issue in the table at bottom
- Use this as sign-off for "safe to deploy"

### 3. qa-scheduled-run.ts

**Purpose:** Automated baseline metrics collection (every run)

**Runs:**
- TypeScript compilation
- ESLint linting
- Unit test count extraction
- Regression detection vs. previous run

**Usage:**
```bash
npx tsx scripts/qa-scheduled-run.ts
```

**Output:**
- Comparison log updated
- Console summary showing what broke/fixed
- Exit code 1 if regressions found (CI can fail)

### 4. Regression Tracking

**How It Works:**

| Run | Date | TypeCheck | Lint | Tests | Notes |
|---|---|---|---|---|---|
| #1 | Sept 1 | ✅ | ✅ | 5511 pass | Baseline |
| #2 | Sept 3 | ❌ | ✅ | 5509 pass | REGRESSION: TS broke (see note) |
| #3 | Sept 5 | ✅ | ✅ | 5511 pass | FIXED: TS restored |

**Key Rule:** If something broke on Run #2, you MUST prove it's fixed on Run #3. Not silence—proof.

---

## Running Manually

### Every 2-3 Days

1. **Pull latest main branch**
   ```bash
   git fetch origin main
   git checkout main
   git pull
   ```

2. **Run automated checks**
   ```bash
   npm run typecheck && npm run lint
   npm test  # In background (~10-20 min)
   ```

3. **Update comparison log**
   - Edit `docs/qa/QA-COMPARISON-LOG.md`
   - Add new run entry
   - Record baseline metrics
   - Compare against previous run

4. **Manual feature testing**
   - Open `docs/qa/QA-MANUAL-CHECKLIST.md`
   - Walk through each category
   - Test on real app (run `npm start` in web package)
   - Record PASS/FAIL
   - If any FAIL, stop and investigate

5. **Report findings**
   - Update comparison log with feature status
   - Document any new regressions
   - Document any fixes since last run
   - Sign off: "Safe to deploy" or "Blockers: [list]"

---

## Critical Tests (Never Skip)

### Money Bugs (Integer Cents)
**Checklist Item:** Payments & Billing 7.1
```
Verify: Invoice amount stored as 10000 (cents), not 100.00 (float)
Test: Create estimate → approve → invoice → pay → refund
Expected: All values in integer cents; no 99.9 or 100.00
```

### Double-Charging (Webhook Idempotency)
**Checklist Item:** Payments & Billing 7.2
```
Verify: Stripe webhook sent twice → only one payment charged
Test: Simulate idempotency key replay; verify DB has one record
Expected: Reconciliation shows single payment (not double)
```

### Double-Booking Prevention
**Checklist Item:** Scheduling & Appointments 4.2
```
Verify: DB exclusion constraint prevents overlapping assignments
Test: Rapid double-click on "Assign Tech" → only one succeeds
Expected: 403 on second attempt; DB has one record
```

### Tenant Isolation (RLS)
**Checklist Item:** Data Isolation & Security 8.1
```
Verify: Tenant A cannot read Tenant B data
Test: Login as Tenant A; query Tenant B's customers → 403
Expected: RLS policy enforced at DB level (not just app)
```

### TCPA/DNC Compliance
**Checklist Item:** Voice 5.2
```
Verify: No outbound calls to DNC numbers; no calls 9pm–8am
Test: Add number to DNC; attempt call → rejected
Expected: Audit log shows "Call blocked: DNC number"
```

---

## Regression Scenario

**Example:** Tuesday's QA finds 10 bugs.

| Scenario | Action |
|---|---|
| **Tuesday QA** | Tests run; 10 issues logged |
| **Tuesday–Wednesday** | Fixes pushed; bugs supposedly fixed |
| **Thursday QA (this run)** | Re-run same 10 tests; verify they PASS |
| **Test results** | 8/10 PASS, 2/10 still FAIL (regression not fully fixed) |
| **Comparison log** | Update: "PARTIAL: 2 fixes not holding; needs investigation" |
| **Decision** | Do NOT ship; wait for fixes to be re-tested Friday |

This is **brutally honest** reporting. Not "we fixed it" (aspirational) but "we tested it and confirmed it works" (evidence-based).

---

## Test Layers

### Layer 1: Local Static Checks (No DB)
**Command:** `npm run typecheck && npm run lint`  
**Time:** ~1 min  
**What:** TypeScript + ESLint rules  
**Frequency:** Every run

### Layer 2: Unit Tests (Local DB via TestContainers)
**Command:** `npm test` (background)  
**Time:** ~10–20 min  
**What:** API logic, scheduling, billing math, AI decision trees  
**Frequency:** Every run (async)

### Layer 3: Integration Tests (Docker DB)
**Command:** `npm run test:integration`  
**Time:** ~5 min  
**What:** DB migrations, queries, RLS policies  
**Frequency:** If credentials available

### Layer 4: E2E Matrix (Full Stack)
**Command:** `npm run qa:matrix:run`  
**Time:** ~30 min  
**What:** All 74 rows (provisioning, calls, payments, proposals, etc.)  
**Frequency:** If Railway dev URLs + CLERK_HMAC available  
**Status:** Requires credentials (blocked in remote environment)

---

## Artifacts & Reports

### Generated Files

```
qa/
├── README.md                              (QA matrix overview)
├── gate-exceptions.json                   (soft-gate waivers)
├── qa-matrix-live-runbook.md             (manual execution guide)
├── reports/
│   ├── 2026-09-01/
│   │   └── QA-REPORT.md                  (if matrix run completed)
│   ├── 2026-08-29/
│   │   └── ai-catalog-scoreboard.html
│   └── ...
└── backlog/                               (failed test tracking)

docs/qa/
├── QA-PROCESS-README.md                  (this file)
├── QA-COMPARISON-LOG.md                  (running log every 2-3 days)
├── QA-MANUAL-CHECKLIST.md                (feature checklist)
└── ...
```

---

## Blocked / Skipped Tests

### Why E2E Matrix Skipped (Remote Environment)

| Requirement | Status | Why |
|---|---|---|
| Node.js v20+ | ✅ Available | |
| npm 10.x | ✅ Available | |
| Docker daemon | ✅ Available | |
| Railway dev URL | ❌ Missing | Credentials not available in remote env |
| DB read/write access | ❌ Missing | No RDS endpoint exposed |
| CLERK_HMAC_SECRET | ❌ Missing | Requires Railway dev API config |

**Workaround:** Manual QA checklist covers the same features; can be run offline.

---

## Next Steps

1. **Run automated checks** (already done today)
   - ✅ TypeScript: PASS
   - ✅ Linting: PASS
   - ⏳ Unit tests: running

2. **Update comparison log** with today's metrics (today)

3. **Schedule next run** for 2026-09-03 (in 2 days)

4. **If new features ship**
   - Add them to QA-MANUAL-CHECKLIST.md
   - Include in next run
   - Document as "NEW: <feature>" in comparison log

5. **If bugs found in QA**
   - Document in "Known Issues" section
   - Provide workaround if available
   - Re-test after fix pushed
   - Mark as FIXED in next run

---

## Command Reference

```bash
# Automated checks
npm run typecheck              # TypeScript compilation
npm run lint                   # ESLint
npm test                       # Unit tests (all packages)

# QA orchestration
npx tsx scripts/qa-scheduled-run.ts   # Automated comparison log update
npm run qa:doctor              # Environment verification
npm run qa:matrix:run          # Full E2E matrix (if creds available)
npm run qa:report              # Generate HTML report

# Individual suites
npm run test:integration       # API integration tests (Docker required)
npm run test:rls               # RLS policy verification tests
npm run e2e:qa-matrix          # Playwright QA matrix only

# Development
npm start --prefix packages/api    # Start API server
npm start --prefix packages/web    # Start web UI
```

---

## Sign-Off & Approval

After completing a QA run:

**Coordinator Name:** _______________  
**Date:** _______________  
**All Tests PASS?** ☐ YES ☐ NO  
**Approved for Deployment?** ☐ YES ☐ NO

If NO on either, list blockers here:
1. _______________
2. _______________
3. _______________

---

**Questions?** See CLAUDE.md > "Code Hygiene & Testing" for standards.
