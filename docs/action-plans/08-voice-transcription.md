# Execution Plan: Voice and Transcription

## Plan Goal
Close the currently known delivery gaps in **Voice and Transcription** with measurable execution milestones.

## Gap Register
1. Onboarding endpoint mismatch with recording API.
2. No-op provider can hide production readiness issues.
3. Limited job-failure observability.

## 30-60-90 Day Execution

### Days 0-30 (Stabilize)
- Align onboarding to recording-based ingestion contract.

### Days 31-60 (Implement)
- Add provider readiness checks in deploy smoke tests.

### Days 61-90 (Harden)
- Instrument transcription queue retries and dead-letter handling.

## Owners and Dependencies
- **Primary owner role:** Engineering lead for this domain.
- **Contributors:** API + Web + QA + Product.
- **Dependencies:** Environment config parity, shared contracts, and CI capacity.

## Definition of Done
- All listed gaps are closed or explicitly de-scoped with product sign-off.
- Route/contract/test coverage is updated for every shipped change.
- Operational metrics are visible in dashboard/alerts where applicable.

## Success Metrics
- Transcription completion rate.
- Median transcript turnaround time.
