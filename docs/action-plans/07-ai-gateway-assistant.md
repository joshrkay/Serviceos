# Execution Plan: AI Gateway and Assistant

## Plan Goal
Close the currently known delivery gaps in **AI Gateway and Assistant** with measurable execution milestones.

## Gap Register
1. Limited domain intent coverage.
2. Inconsistent authenticated fetch usage.
3. Fallback behavior not formalized.

## 30-60-90 Day Execution

### Days 0-30 (Stabilize)
- Prioritize top 10 intents and map each to typed proposal payloads.

### Days 31-60 (Implement)
- Replace plain fetch usage with authenticated api client.

### Days 61-90 (Harden)
- Define degraded behavior when AI provider key/model is unavailable.

## Owners and Dependencies
- **Primary owner role:** Engineering lead for this domain.
- **Contributors:** API + Web + QA + Product.
- **Dependencies:** Environment config parity, shared contracts, and CI capacity.

## Definition of Done
- All listed gaps are closed or explicitly de-scoped with product sign-off.
- Route/contract/test coverage is updated for every shipped change.
- Operational metrics are visible in dashboard/alerts where applicable.

## Success Metrics
- Intent-to-proposal conversion rate.
- Assistant auth failure rate.
