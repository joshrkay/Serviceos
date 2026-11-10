# Linting Fixes — Priority Order

**Generated:** 2026-11-10 04:45 UTC  
**Total Errors:** 1101  
**Total Warnings:** 3012  
**Time to Fix:** 2–4 hours (all priority issues)  
**Blocking:** YES — Cannot ship until fixed

---

## 🔴 Priority 1: Promise/Void Mismatches (14 errors, 30 min)

### Location: `packages/web/src/routes.ts`

**Problem:** Route handlers return promises but are typed as void. This can cause unhandled promise rejections.

**Lines with Issues:**
```
Line 136:  error  Promise-returning function provided to property where a void return was expected
Line 137:  error  Promise-returning function provided to property where a void return was expected
Line 153:  error  Promise-returning function provided to property where a void return was expected
Line 154:  error  Promise-returning function provided to property where a void return was expected
Line 155:  error  Promise-returning function provided to property where a void return was expected
Line 171:  error  Promise-returning function provided to property where a void return was expected
Line 172:  error  Promise-returning function provided to property where a void return was expected
Line 188:  error  Promise-returning function provided to property where a void return was expected
Line 201:  error  Promise-returning function provided to property where a void return was expected
Line 202:  error  Promise-returning function provided to property where a void return was expected
Line 215:  error  Promise-returning function provided to property where a void return was expected
Line 216:  error  Promise-returning function provided to property where a void return was expected
Line 232:  error  Promise-returning function provided to property where a void return was expected
Line 233:  error  Promise-returning function provided to property where a void return was expected
```

**Fix Pattern:**

Before:
```typescript
{
  path: '/route',
  action: async () => doSomething(),  // ❌ Returns Promise<void>, typed as void
}
```

After:
```typescript
{
  path: '/route',
  action: async () => {
    try {
      await doSomething();
    } catch (e) {
      console.error('Route error:', e);
    }
  },
}
```

Or:
```typescript
{
  path: '/route',
  action: () => doSomething().catch(e => console.error('Route error:', e)),
}
```

**Estimated Effort:** 30 minutes  
**Difficulty:** Low  
**Risk:** Low (linting-only fix)

---

## 🟠 Priority 2: Promise Handlers in Settings (3 errors, 15 min)

### Location: `packages/web/src/pages/settings/LanguageSettings.tsx`

**Problem:** Event handlers return promises but are typed as void.

**Lines with Issues:**
```
Line 79:   error  Promise-returning function provided to attribute where a void return was expected
Line 95:   error  Promise-returning function provided to attribute where a void return was expected
Line 117:  error  Promise-returning function provided to attribute where a void return was expected
```

**Fix Pattern:**

Before:
```typescript
onClick={async () => await changeLanguage()}  // ❌ Returns Promise
```

After:
```typescript
onClick={() => {
  changeLanguage().catch(e => console.error('Language change failed:', e));
}}
```

Or wrap with error boundary:
```typescript
onClick={() => changeLanguage().catch(handleError)}
```

**Estimated Effort:** 15 minutes  
**Difficulty:** Low  
**Risk:** Low (UX improvement actually)

---

## 🟠 Priority 3: Promise Executor Returns (3 errors, 15 min)

### Location: `scripts/ai-catalog-sweep/run-sweep.mjs` (1 error, 5 min)

**Problem:** Promise executor should never return a value.

**Line with Issue:**
```
Line 322:  error  Return values from promise executor functions cannot be read
```

**Fix Pattern:**

Before:
```javascript
const promise = new Promise((resolve, reject) => {
  return someAsyncFunction();  // ❌ Invalid — executor should not return
});
```

After:
```javascript
const promise = new Promise((resolve, reject) => {
  someAsyncFunction()
    .then(resolve)
    .catch(reject);
});
```

Or use promisify:
```javascript
const promise = Promise.resolve().then(() => someAsyncFunction());
```

**Estimated Effort:** 5 minutes  
**Difficulty:** Low  
**Risk:** Low

---

### Location: `scripts/release/database-setup.test.mjs` (2 errors, 10 min)

**Lines with Issues:**
```
Line 8:   error  Return values from promise executor functions cannot be read
Line 10:  error  Return values from promise executor functions cannot be read
```

**Fix:** Same pattern as above.

**Estimated Effort:** 10 minutes total  
**Difficulty:** Low  
**Risk:** Low

---

## 🟠 Priority 4: Race Condition (1 error, 15 min)

### Location: `scripts/production-retest.mjs`

**Problem:** `report.probe` might be assigned based on stale state.

**Line with Issue:**
```
Line 281:  error  Possible race condition: `report.probe` might be assigned based on an outdated state of `report`
```

**Fix Pattern:**

Before:
```javascript
// ❌ Race condition — report state might change between reads
if (!report.probe) {
  report.probe = await getProbe();
}
```

After:
```javascript
// ✅ Atomic — capture state once
const reportState = report;
if (!reportState.probe) {
  reportState.probe = await getProbe();
}
```

Or use promise atomicity:
```javascript
// ✅ If this is async loop, extract assignment
const probe = report.probe || await getProbe();
report.probe = probe;
```

**Estimated Effort:** 15 minutes  
**Difficulty:** Medium  
**Risk:** Low (audit/test script)

---

## 🟡 Priority 5: Missing Error Causes (2 errors, 20 min)

### Location: `scripts/check-dependency-audit.ts`

**Problem:** Caught errors should be attached as `cause` for debugging.

**Line with Issue:**
```
Line 270:  error  There is no `cause` attached to the symptom error being thrown
```

**Fix Pattern:**

Before:
```typescript
try {
  // ...
} catch (e) {
  throw new Error('Dependency audit failed');  // ❌ Lost original error context
}
```

After:
```typescript
try {
  // ...
} catch (e) {
  throw new Error('Dependency audit failed', { cause: e });
}
```

**Estimated Effort:** 10 minutes  
**Difficulty:** Low  
**Risk:** Low (error handling improvement)

---

### Location: `scripts/inapp-50/lib.mjs`

**Problem:** Same as above.

**Line with Issue:**
```
Line 127:  error  There is no `cause` attached to the symptom error being thrown
```

**Fix:** Same pattern.

**Estimated Effort:** 10 minutes  
**Difficulty:** Low  
**Risk:** Low

---

## 🟡 Priority 6: Unused Assignments (4 errors, 20 min)

### Locations: Various scripts

**Problem:** Variables assigned but never used afterward.

**Lines with Issues:**
```
scripts/ai-catalog-sweep/run-sweep.mjs:997     — 'chatFields' assigned but unused
scripts/check-env-coverage.ts:137              — Escape character issues
scripts/doctor.ts:352                          — 'npmVersion' assigned but unused
scripts/production-retest.mjs:67                — 'json' assigned but unused
packages/web/src/utils/api-fetch.ts:198        — 'fresh' assigned but unused
```

**Fix Pattern:**

Before:
```typescript
const unused = await getSomeValue();  // ❌ Never used
```

After:
```typescript
const used = await getSomeValue();
console.log(used);  // Or remove line entirely if not needed
```

**Estimated Effort:** 20 minutes  
**Difficulty:** Low (simple removals)  
**Risk:** Low

---

## 🟢 Priority 7: Test Warnings (40+ warnings, low priority)

**Problem:** Async test mocks declared without await expressions.

**Type:** @typescript-eslint/require-await  
**Impact:** Low — test-only issues  
**Fix:** Remove `async` keyword from test mocks if no await, or add await.

**Estimated Effort:** Not blocking (fix in separate PR)  
**Difficulty:** Very Low  
**Risk:** None

---

## 📋 Summary of Fixes

| Priority | File | Lines | Error Type | Fix Time | Total |
|---|---|---|---|---|---|
| 1 | `packages/web/src/routes.ts` | 14 | Promise/void | 30 min | **30 min** |
| 2 | `packages/web/src/pages/settings/LanguageSettings.tsx` | 3 | Promise/void | 15 min | **15 min** |
| 3 | `scripts/ai-catalog-sweep/run-sweep.mjs` | 1 | Executor return | 5 min | **5 min** |
| 3 | `scripts/release/database-setup.test.mjs` | 2 | Executor return | 10 min | **10 min** |
| 4 | `scripts/production-retest.mjs` | 1 | Race condition | 15 min | **15 min** |
| 5 | `scripts/check-dependency-audit.ts` | 1 | Missing cause | 10 min | **10 min** |
| 5 | `scripts/inapp-50/lib.mjs` | 1 | Missing cause | 10 min | **10 min** |
| 6 | Various | 4 | Unused assignments | 20 min | **20 min** |
| **BLOCKING TOTAL** | — | **27 errors** | — | — | **2 hours 15 min** |
| 7 | Various test files | 40+ | Test warnings | N/A | Not blocking |

---

## 🚀 Recommended Action Plan

### Phase 1: Critical Path (2 hours 15 min)

1. **Fix Promise/Void (45 min)**
   - Priority 1 + 2 = 17 errors total
   - Highest impact on shipping
   - Straightforward fixes

2. **Fix Executors & Race (25 min)**
   - Priority 3 + 4 = 4 errors
   - Low effort, high importance

3. **Fix Error Causes (20 min)**
   - Priority 5 = 2 errors
   - Good practice improvement

4. **Fix Unused Assignments (20 min)**
   - Priority 6 = 4 errors
   - Simple removals

5. **Verify & Commit (10 min)**
   - Run `npm run lint:eslint` locally
   - Confirm 0 errors
   - Commit with message

### Phase 2: Follow-up (separate PR)

- Clean up test warnings (40+ warnings)
- Update linting rules if needed
- Add pre-commit hook to prevent regression

---

## ✅ Verification Checklist

Before declaring done:

- [ ] Run `npm run lint:eslint` locally
- [ ] Confirm 0 errors (warnings OK for now)
- [ ] Run `npm run typecheck` — must be 0 errors
- [ ] Run shared tests — must be 241/241
- [ ] Create PR with fixes
- [ ] CI passes all checks
- [ ] Next QA cycle (2026-11-12) confirms no regressions

---

## 📞 Questions?

If a fix pattern is unclear:
- Check the specific line in your editor
- Look at similar patterns in the codebase
- Ask: "What is the original error trying to prevent?"
- Apply the corresponding fix pattern

---

**Last Updated:** 2026-11-10 04:45 UTC  
**Next QA Run:** 2026-11-12  
**Expected Result:** All 27 blocking errors fixed → Status 🟢 GREEN
