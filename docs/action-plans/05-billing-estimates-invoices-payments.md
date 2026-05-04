# Execution Plan: Billing, Estimates, Invoices, and Payments

## Plan Goal
Close the currently known delivery gaps in **Billing, Estimates, Invoices, and Payments** with measurable execution milestones.

## Gap Register
1. Timezone-sensitive due-date behavior.
2. Missing public payment collect endpoint.
3. Mock-driven public invoice UI.

## 30-60-90 Day Execution

### Days 0-30 (Stabilize)
- Standardize date-only/UTC policy for invoice due-date logic.

### Days 31-60 (Implement)
- Implement `/api/payments/public/collect` with validation + audit events.

### Days 61-90 (Harden)
- Replace invoice payment page mocks with live API contracts.

## Owners and Dependencies
- **Primary owner role:** Engineering lead for this domain.
- **Contributors:** API + Web + QA + Product.
- **Dependencies:** Environment config parity, shared contracts, and CI capacity.

## Definition of Done
- All listed gaps are closed or explicitly de-scoped with product sign-off.
- Route/contract/test coverage is updated for every shipped change.
- Operational metrics are visible in dashboard/alerts where applicable.

## Success Metrics
- Invoice due-date defect count.
- Public payment success rate.
