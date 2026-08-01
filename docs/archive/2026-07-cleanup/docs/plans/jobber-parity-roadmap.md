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
| 3 | Technician profitability report | Reporting | S | ✅ done |
| 2 | Surcharge / processing-fee pass-through (invoice) | Payments | S | ✅ done |
| 5 | Tip collection at checkout | Payments | S | todo |
| 6 | Maintenance contracts DB persistence (graduate stub) | Jobs | M | ✅ done |
| 7 | Payment plan / installment support (expose milestone schedules) | Payments | M | todo |
| 8 | Customer groups / segmentation | CRM | M | ✅ done |
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
- Iteration 3: #3 Technician profitability report — generalized the rollup into
  src/reports/job-profit-rollup.ts (aggregateJobProfits, shared by customer +
  technician), getTechnicianProfit + GET /api/reports/technician-profit/:id +
  shared web ProfitCard (CustomerProfitCard/TechnicianProfitCard wrappers) +
  TechnicianProfitCard on the technician day view (invoices:view-gated). No
  schema change.
- Iteration 4: #2 Invoice processing-fee surcharge — calculateDocumentTotals
  gains an optional processingFeeBps (fee on subtotal−discount+tax, folded into
  totalCents → amountDueCents → the Stripe charge); migration 202 adds the two
  nullable invoice columns; threaded through the invoice model/repo/route +
  createInvoiceSchema; rendered on the invoice detail + public pay page.
  Cents-exact billing tests + integration round-trip + web row tests.
- Iteration 6: #8 Customer groups / segmentation — first-class named segments
  with explicit membership (distinct from free-form tags). Domain + in-memory +
  Pg repo (migration 227: customer_groups + customer_group_members, FORCE RLS,
  case-insensitive partial unique on active names) + /api/customer-groups CRUD +
  membership routes. Wired into marketing campaigns (campaigns can target a
  group via segmentGroupId, migration 228; group takes precedence over tag).
  Web: groups manager (settings), membership panel on the customer detail, and
  a group selector in the campaign composer. Unit + Docker-gated integration
  (incl. archived-name reuse) + web tests; audit events on every mutation.
- Iteration 5: #6 Maintenance contracts persistence — graduated the in-memory
  route stub to a real tenant-scoped table (migration 203) + domain module +
  PgMaintenanceContractRepository (with an InMemory double) + router rewrite +
  app.ts wiring. API shape unchanged (no web change). Route + audit + Docker-
  gated integration round-trip tests.
