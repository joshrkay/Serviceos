# Jobber Feature-Parity Roadmap

**Created:** 2026-06-20
**Status:** in progress (worked iteratively via `/loop create feature parity and quality the same as jobber`)
**Branch:** `claude/lucid-euler-amq2hk`

Gap analysis (canonical `/packages` only) found ServiceOS already at strong
Jobber parity across most pillars: CRM, quotes/estimates (incl. good-better-best
tiers), one-off + recurring jobs (agreements w/ RRULE), dispatch board (realtime
websocket, drag-drop, crews), invoicing (one-off/batch/auto-on-completion +
milestone schedules), card payments + deposits + saved cards + Stripe Connect,
two-way SMS/email with reminders/thank-you/DNC, client hub portal, public online
booking + intake, time tracking, expenses, Google reviews, financial reporting,
3-role RBAC, and pre-built automation sweeps.

## Prioritized backlog (value-to-effort)

| # | Feature | Pillar | Size | Status |
|---|---------|--------|------|--------|
| 1 | Customer source/origin tracking ("How did you hear about us?") | CRM | S | ✅ done |
| 4 | Customer profitability report | Reporting | S | ✅ done |
| 2 | Surcharge / processing-fee pass-through | Payments | S | todo |
| 3 | Technician profitability report | Reporting | S | todo |
| 5 | Tip collection at checkout | Payments | S | todo |
| 6 | Maintenance contracts DB persistence (graduate stub) | Jobs | M | todo |
| 7 | Payment plan / installment support (expose milestone schedules) | Payments | M | todo |
| 8 | Customer groups / segmentation | CRM | M | todo |
| 9 | ACH bank payments | Payments | M | todo |
| 10 | Route optimization / TSP (needs external solver) | Dispatch | M | todo |
| 11 | Multi-platform review aggregation (Yelp/Facebook, needs OAuth) | Reviews | M-L | todo |
| 12 | No-code workflow builder | Automation | L | todo |

Items needing external services/keys (ACH, tips, route solver, review OAuth) are
deferred behind the self-contained ones so each loop iteration ships something
fully testable in CI.

## Log
- Iteration 1: #1 Customer source tracking — shared type + DB migration + API
  create/update/validation + web capture/display + tests.
- Iteration 2: #4 Customer profitability report — getCustomerProfit aggregation
  (reuses getJobProfit) + GET /api/reports/customer-profit/:customerId +
  CustomerProfitCard on the customer detail + unit/route/web tests. No schema
  change (read-only).
