# W2-3 — Estimate tier cents display

**Thread ID:** W2-3  
**Parent:** [Wave 2 index](./README.md) · [umbrella](../2026-07-10-002-feat-wave2-trust-and-field-gaps-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `feat/w2-3-estimate-tier-cents-display`  
**PR title:** `fix(web): use fmtUsd on estimate approval tier lines (W2-3)`  
**Estimate:** ~0.25 day  
**Parallel with:** everything

---

## Goal

Public estimate approval tier/add-on line prices always show **two decimal places** (e.g. `$50.00` not `$50`).

## Why this thread exists

`EstimateApprovalPage` has `fmtUsd()` but tier picker lines still use bare `(totalCents / 100).toLocaleString()` (~lines 1002, 1031), which drops cents.

## In scope

- Replace bare `.toLocaleString()` money renders with `fmtUsd()` / `centsToDisplay`
- Unit or component test asserting `$50.00` (or locale-stable two-fraction digits)
- Grep the page for other cents→float footguns

## Out of scope

- Full public estimate E2E (Wave 1 W1-3)
- Billing engine changes
- InvoicesPage (already fixed)

## Key files

| Path | Role |
|------|------|
| `packages/web/src/components/customer/EstimateApprovalPage.tsx` | Fix |
| Existing page tests | Extend |

## Done when

- [ ] No bare `totalCents / 100` + `toLocaleString()` on that page for money
- [ ] Test locks two-decimal display
- [ ] PR links this thread

## Handoff prompt

```text
Implement W2-3 only: docs/plans/wave2/W2-3-estimate-tier-cents-display.md
Branch: feat/w2-3-estimate-tier-cents-display from main.
Replace tier-line toLocaleString with fmtUsd; add test.
Do not implement other threads.
```
