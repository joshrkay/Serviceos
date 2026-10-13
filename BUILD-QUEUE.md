# Build queue — shared task routing

Every task lands here first, gets routed to the right tool, and gets tracked.
Rule: judgment → Claude, volume → Codex, hands-on → Cursor, non-code → Kai.

## Columns

| Task | Routed to | Status | Notes |
|---|---|---|---|
| Customer #1 onboarding email (HELD — do not send) | Kai | queued | Josh reversed the send 2026-10-12 21:09 MST — focus is the NEXT customer, not onboarding #1. Copy stays approved on file; reactivate only on his word.
| Owner visibility into tenant usage (signup date, setup state, billable minutes per customer) | Claude | in_progress | Handoff filed: KAI-HANDOFF-2026-10-11-FIRST-CUSTOMER.md (pushed to main). Arose from customer #1 — owner couldn't see anything. |
| Finish-setup UX for ACCOUNT_SETUP_INCOMPLETE | Claude | queued | From Sep 28 handoff. User hitting incomplete setup needs to see WHAT is incomplete and HOW to finish. |
| In-app onboarding checklist (productized setup) | Claude | queued | Needed before ~20 accounts — founder-led onboarding won't scale past that. |
| E2E: full signup → card → onboarding flow | Codex | queued | Tight spec: use test account joshrkay+8@gmail.com; report breaks. Blocked on Josh setting the test password via secure card. |
| Activation instrumentation audit (read-only, report only — no code changes) | Codex | queued | For each of the five activation checkpoints — (1) signup completed, (2) setup call booked, (3) setup completed/onboarded, (4) first answered call on the customer's line, (5) day-14 trial conversion/charge — locate where the event or timestamp is recorded (DB table/column, event log, or provider webhook) and report per checkpoint: recorded? (yes/no/partial), exact table+field or code path, and the gap if missing. If a checkpoint's recording path is ambiguous, mark UNKNOWN and move on — no judgment calls, no refactors. Deliverable: a 5-row table. This unblocks Monday loop scoring: without these timestamps the signup→paid funnel can't be measured. |

## Status values

`queued` → `in_progress` → `done`. If a task sits in `queued` > 48h, it gets re-routed or killed.

## Routing cheat sheet

- **Claude (Max):** ambiguous features, big refactors, architecture, onboarding flow — where being wrong is expensive.
- **Codex ($100):** parallel volume — bug batches, E2E runs, migrations, red→green test grinds. Tight specs only.
- **Cursor ($60):** Josh driving in the editor — quick edits, code reading, diff review.
- **Kai:** GTM, content, outreach, onboarding comms, debriefs, orchestration.

## How tasks get here

Josh drops them on Kai (chat). Kai specs them, routes them, and files them here.
Product-side pickups happen via the KAI-HANDOFF-*.md files; this queue is the index.
