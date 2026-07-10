# W1-3 — Hermetic: public estimate approval `/e/:id`

**Thread ID:** W1-3  
**Parent:** [Wave 1 index](./README.md) · [umbrella plan](../2026-07-10-001-feat-wave1-prove-money-loop-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `feat/w1-3-public-estimate-approval`  
**PR title:** `test(e2e): public estimate approval hermetic (W1-3)`  
**Estimate:** 0.5–1 day  
**Parallel with:** W1-4 — **recommended first thread** (no auth)

---

## Goal

Prove the customer-facing estimate approval page works and never falls back to mock/fixture data on error (Blocker 8 regression).

## Why this thread exists

Public `/e/:id` is production-critical trust UI. Mobile/public specs exist in places but desktop hermetic happy-path + error-path proof should be always-on in the default Playwright project.

## In scope

- Boot app; hit `/e/:id` (or token URL as implemented) **without Clerk**
- Mock `GET` public estimate payload (Zod-pinned to shared contract)
- Assert customer name, line items, money formatting (`fmtUsd` / `centsToDisplay` — no bare float drop)
- Happy path: approve/sign → success UI + correct POST
- Negative: network failure → error UI (no other customer’s estimate)

## Out of scope

- Authenticated estimate editor
- Tier picker edge cases beyond money formatting smoke
- E-sign provider integrations beyond what the page already does
- Wave 2/3

## Approach

1. Inspect `EstimateApprovalPage` routes + public API paths.
2. Add `e2e/public/estimate-approval.spec.ts`.
3. Use `page.route` for public estimate GET/POST; abort external hosts if needed.
4. Pin fixture with `@ai-service-os/shared` schema parse at fixture build time if schema exists.
5. Ensure spec is **not** gated on `E2E_CLERK_*` or `VITE_CLERK_*` beyond whatever the SPA needs to boot marketing/public shell.

## Expected files

| Path | Action |
|------|--------|
| `e2e/public/estimate-approval.spec.ts` | Create |
| Optional fixture module under `e2e/public/fixtures/` | Create |
| `e2e/README.md` | Document always-on public money specs |

## Done when

- [ ] Spec green in default `npm run e2e` / CI without Clerk secrets
- [ ] Error-path asserts no mock-data leak
- [ ] Money amounts show two decimal places where applicable
- [ ] PR links this thread doc

## Handoff prompt (paste into new agent thread)

```text
Implement W1-3 only: docs/plans/wave1/W1-3-public-estimate-approval.md
Branch: feat/w1-3-public-estimate-approval from main.
Do not implement other Wave 1 threads.
Hermetic public /e/:id approve + error UI; no Clerk required.
```
