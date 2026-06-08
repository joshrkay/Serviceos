# PROV-01 — `POST /api/onboarding/configure` does not exist

**Matrix rows:** PROV-01, PROV-02 (vertical provisioning)
**Live verdict (2026-06-04):** fail (PROV-02 blocked behind PROV-01)
**Target verdict:** pass
**Effort:** M — but decide build-vs-rewrite first

## Problem

The matrix provisions each row's vertical via
`POST /api/onboarding/configure { services: ["HVAC"] }`. The deployed dev API
returns the Express default 404 (`Cannot POST /api/onboarding/configure`),
and the route is absent from `packages/api/src` entirely — this is not a
deploy-lag issue. Either the onboarding/configure surface was planned and
never built, or provisioning happens through another endpoint and the
harness (plus pass criteria) must be rewritten to use it.

## Evidence from the live run

- `qa/reports/2026-06-04/artifacts/PROV-01/api/01-configure.json` — 404 HTML body.
- `grep -rn "onboarding/configure" packages/api/src` → no matches (2026-06-04).
- Most matrix rows still pass because `setupRow`'s provisioning failure is
  non-fatal for rows that don't assert vertical context — only PROV-01/02
  assert it.

## Acceptance criteria

- [ ] Decision recorded: build the route vs. point harness at the real provisioning path.
- [ ] PROV-01 (HVAC) and PROV-02 (Plumbing) flip fail → pass.
- [ ] `GET /api/settings` + `/api/verticals` report the configured vertical per tenant.

## Verify

```bash
npm run e2e:qa-matrix -- --grep "PROV-0"
```
