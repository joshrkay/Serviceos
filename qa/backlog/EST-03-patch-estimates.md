# EST-03 — Add `PATCH /api/estimates/:id` alias

**Matrix row:** EST-03 (Estimates · partial update)
**Current predicted verdict:** partial (PUT only)
**Target verdict:** pass
**Effort:** S (< 1 hour)

## Problem

The matrix expects `PATCH` for partial updates per REST conventions. The
estimates router only exposes `PUT`, so a PATCH request returns `404`.

## Evidence from code

- `packages/api/src/routes/estimates.ts:75` — only `router.put('/:id', ...)` is registered.
- `packages/api/src/estimates/estimate.ts` — `updateEstimate()` already performs a
  partial merge internally; no data-layer change required.
- Matrix row expectation: `qa/README.md` §"pass/partial/fail" treats either
  method as pass today, but this story closes the documented deviation.

## Acceptance criteria

- [ ] `PATCH /api/estimates/:id` routes to the same `updateEstimate` handler as `PUT`.
- [ ] Both verbs accept identical request body (`UpdateEstimateInput`).
- [ ] Both verbs require the same permission (`estimates:update`).
- [ ] Unit tests cover PATCH with a partial body (only `lineItems` changed).
- [ ] QA matrix `EST-03` flips from partial → pass; artifact shows 200 on PATCH.

## Allowed files

- `packages/api/src/routes/estimates.ts`
- `packages/api/src/routes/__tests__/estimates.test.ts` (add PATCH case)

## Out of scope

- Rewriting `updateEstimate()` semantics.
- Deprecating PUT. Keep both; PUT stays the canonical verb for now.

## Verify

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm run test -w packages/api -- estimates.test
npm run e2e:qa-matrix -- --grep EST-03
```
