# Lint Blockers — 2026-07-28 QA Run

## 3 Errors Requiring Fixes

### 1. scripts/data-pipeline/pii-leakage.ts:17
```
Error: no-useless-escape
Message: Unnecessary escape character: \-
Severity: 🟡 Low (script-only, non-production)
```

**Location:** Line 17, column 27 in pii-leakage.ts
**Issue:** Regex pattern has unnecessary backslash before hyphen
**Example (likely):**
```typescript
const pattern = /\-some-pattern/;  // Should be /-some-pattern/ or /\-/ if needed
```

**Fix:** Remove escape or refactor regex
**Time:** 5 minutes
**Blocker:** No — script file, not in production build

---

### 2. scripts/production-retest.mjs:139
```
Error: no-promise-executor-return
Message: Return values from promise executor functions cannot be read
Severity: 🟡 Medium (async anti-pattern, could hide rejection)
```

**Location:** Line 139 in production-retest.mjs
**Issue:** Promise executor returning a value (invalid pattern)
**Example (likely):**
```javascript
new Promise((resolve, reject) => {
  // returning here is invalid
  return someAsyncFn().then(resolve);
});
```

**Fix:** Remove return or move logic outside executor
**Time:** 15 minutes
**Impact:** Could mask promise rejection in test harness
**Blocker:** No — test script, but could hide bugs

---

### 3. scripts/production-retest.mjs:243
```
Error: require-atomic-updates
Message: Possible race condition: `report.probe` might be assigned based on outdated state of `report`
Severity: 🟡 Medium (data race in test harness)
```

**Location:** Line 243 in production-retest.mjs
**Issue:** Async operation reading stale object state
**Example (likely):**
```javascript
const report = await getReport();  // stale
report.probe = await checkProbe(); // race: report state may have changed
```

**Fix:** Restructure to snapshot state before async mutation
**Time:** 20 minutes
**Impact:** Test results could be inconsistent if harness is concurrent
**Blocker:** No — test script, but affects reliability

---

## Summary Table

| File | Error | Line | Type | Risk | Fix Time |
|---|---|---|---|---|---|
| pii-leakage.ts | no-useless-escape | 17 | Regex | Low | 5m |
| production-retest.mjs | no-promise-executor-return | 139 | Async pattern | Med | 15m |
| production-retest.mjs | require-atomic-updates | 243 | Race condition | Med | 20m |

**Total Fix Time:** ~40 minutes
**Priority:** Fix before next merge to main (these are CI scripts)
**Impact on Deploy:** None — scripts not in production code path

---

## Recommended Action Plan

### Immediate (Before Next Merge)
1. Fix pii-leakage.ts:17 (regex)
2. Fix production-retest.mjs:139 (promise executor)
3. Fix production-retest.mjs:243 (atomicity)
4. Run `npm run lint:eslint` to verify 0 errors
5. Merge to fix lint baseline

### Follow-Up (Next Sprint)
- Address 2162 lint warnings (organize by priority)
- Target: reduce to <500 warnings
- Categories to tackle:
  - Unused variables (6+)
  - Unnecessary conditionals (5+)
  - Unused eslint directives (3+)

---

## How to Fix Manually

```bash
# Check exact errors
npm run lint:eslint scripts/data-pipeline/pii-leakage.ts
npm run lint:eslint scripts/production-retest.mjs

# View with context
npm run lint:eslint scripts/data-pipeline/pii-leakage.ts --format=json | jq '.[] | select(.messages | length > 0)'

# After fixing, verify
npm run lint:eslint | grep "error\|problems"
# Should show: 0 errors
```

---

## Context: Why These Matter

These are **CI-only scripts** used for:
- **pii-leakage.ts** — Data pipeline safety check (processes training data)
- **production-retest.mjs** — Production environment verification harness

While not in the shipping product, lint errors here can:
1. **Hide real bugs** — regex escape could cause data loss if pattern mismatches
2. **Mask failures** — promise executor pattern could hide test harness crashes
3. **Introduce races** — atomic updates bug could cause inconsistent test results

**Fix priority:** Before next test-harness update or data-pipeline run.
