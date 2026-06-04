# ISO-01 — Agent C needs a non-superuser probe role for the RLS check

**Matrix row:** ISO-01 (cross-tenant isolation + RLS)
**Live verdict (2026-06-04):** fail — but the product posture verified healthy
**Target verdict:** pass
**Effort:** S

## Problem

ISO-01's DB leg asserts that with no `app.current_tenant_id` GUC set, a
query sees **0 rows**. Per the runbook (Appendix C quick fix), Agent C
connects with Railway's default `postgres` user — a superuser with
`rolbypassrls=true`. Superusers bypass RLS unconditionally, so the check
sees 1 row and the whole row fails, masking the (passing) API-side checks.

## Verified product posture (manual probe, 2026-06-04)

- RLS is **enabled and FORCED** on customers, jobs, estimates, invoices, notes.
- A non-superuser role with no GUC **fails closed**: the policy's
  `current_setting('app.current_tenant_id')` errors
  (`unrecognized configuration parameter`) — no rows leak.
- With the GUC set, scoping is correct (tenant A saw 13 customers, B saw 3).
- API-side: tenant B token reading A's customer/job/estimate/invoice → 404;
  cross-tenant note write → 404 (all in
  `qa/reports/2026-06-04/artifacts/ISO-01/api/`).

## Acceptance criteria

- [ ] Create a `qa_readonly` Postgres role on dev (NOLOGIN→LOGIN as needed,
      SELECT on the verified tables, **no** BYPASSRLS) and point
      `E2E_DB_URL_READONLY` at it.
- [ ] db-verifier treats "policy errors on missing GUC" as suppressed
      (equivalent to 0 rows), since the one-arg `current_setting` fails closed.
- [ ] Runbook §2.2 + Appendix C updated: the quick fix (READONLY=READWRITE)
      invalidates ISO-01 and must note it.
- [ ] ISO-01 flips fail → pass.

## Allowed files

- `e2e/qa-matrix/helpers/db-verifier.ts`, runbook doc

## Verify

```bash
npm run e2e:qa-matrix -- --grep ISO-01
```
