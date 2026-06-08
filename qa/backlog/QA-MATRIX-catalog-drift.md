# QA-MATRIX — matrix.ts catalog drift (15 tests can't run, 13 rows can't pass)

**Matrix rows:** EST-04..06, INV-03..07, AST-01..07 (missing) ·
CUS-01/02, BILL-01..03, VOICE-01/02, ISO-02, PORTAL-01/02, LEGACY-ESTINVAST-01, legacy PROV-01/02 (orphaned)
**Live verdict (2026-06-04):** structurally fail
**Target:** every spec test has a catalog row; every catalog row has an implementing spec
**Effort:** S–M (catalog edit + report-builder tweak)

## Problem

Two-way drift between `e2e/qa-matrix/matrix.ts` and the specs:

1. **Specs without rows.** `estimates.spec.ts` (EST-04/05/06),
   `invoices.spec.ts` (INV-03..07), `assistant.spec.ts` (AST-01..07) call
   `matrixTest(id, …)` with ids missing from `MATRIX`. `setupRow` throws
   `Unknown matrix row: <id>` before any evidence is captured, and each
   file's remaining tests are skipped serially. 15 tests — including the
   whole assistant suite and the Stripe webhook row — produce no verdicts.
   Error context: `Error: Unknown matrix row: AST-01` (2026-06-04 run).
2. **Rows without specs.** The 13 legacy catalog rows (CUS/BILL/VOICE/
   PORTAL/ISO-02/LEGACY-…, plus duplicate-id legacy PROV/SCH/SMS/PAY/EST
   entries) have no implementing spec, so the report permanently shows
   `FAIL — no manifest`, inflating the fail count (26 reported fails vs ~6
   real product defects on 2026-06-04).
3. **Id collisions.** Legacy and current catalogs reuse ids (PROV-01,
   SCH-02, SMS-01, PAY-01, ISO-01, EST-01..03), so one manifest feeds two
   report rows with different titles/criteria — e.g. legacy "SCH-02
   Reschedule and assignment integrity" displays the voice-scheduling
   failure of current SCH-02.

## Acceptance criteria

- [ ] Add MATRIX rows for EST-04..06, INV-03..07, AST-01..07 (or delete those tests deliberately).
- [ ] Remove or quarantine the 13 legacy no-spec rows (report them as `n/a — not implemented`, not fail).
- [ ] Make ids unique across the catalog; report-builder warns on orphan manifests instead of dropping them silently.
- [ ] Re-run produces verdicts for all executable tests; summary counts reflect product reality.

## Allowed files

- `e2e/qa-matrix/matrix.ts`
- `e2e/qa-matrix/helpers/report-builder.ts`

## Verify

```bash
QA_MATRIX=1 npx playwright test --project=qa-matrix --list
npm run e2e:qa-matrix
```
