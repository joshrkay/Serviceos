# Build queue — shared task routing

Every task lands here first, gets routed to the right tool, and gets tracked.
Rule: judgment → Claude, volume → Codex, hands-on → Cursor, non-code → Kai.

## Columns

| Task | Routed to | Status | Notes |
|---|---|---|---|
| Owner visibility into tenant usage (signup date, setup state, billable minutes per customer) | Claude | in_progress | Handoff filed: KAI-HANDOFF-2026-10-11-FIRST-CUSTOMER.md (pushed to main). Arose from customer #1 — owner couldn't see anything. |
| Finish-setup UX for ACCOUNT_SETUP_INCOMPLETE | Claude | queued | From Sep 28 handoff. User hitting incomplete setup needs to see WHAT is incomplete and HOW to finish. |
| In-app onboarding checklist (productized setup) | Claude | queued | Needed before ~20 accounts — founder-led onboarding won't scale past that. |
| E2E: full signup → card → onboarding flow | Codex | queued | Tight spec: use test account joshrkay+8@gmail.com; report breaks. Blocked on Josh setting the test password via secure card. |

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
