# Execution Plan: Dispatch and Scheduling

## Plan Goal
Close the currently known delivery gaps in **Dispatch and Scheduling** with measurable execution milestones.

## Gap Register
1. Drag/drop hooks not wired.
2. Missing delay audit/escalation endpoints.
3. Working-hours timezone test failures.

## 30-60-90 Day Execution

### Days 0-30 (Stabilize)
- Wire drag/drop actions to schedule proposal creation.

### Days 31-60 (Implement)
- Implement/mount delay prompt audit + escalation endpoints.

### Days 61-90 (Harden)
- Fix temporal assumptions in dispatch validation tests.

## Owners and Dependencies
- **Primary owner role:** Engineering lead for this domain.
- **Contributors:** API + Web + QA + Product.
- **Dependencies:** Environment config parity, shared contracts, and CI capacity.

## Definition of Done
- All listed gaps are closed or explicitly de-scoped with product sign-off.
- Route/contract/test coverage is updated for every shipped change.
- Operational metrics are visible in dashboard/alerts where applicable.

## Success Metrics
- Dispatch schedule action success rate.
- Dispatch API test pass rate.
