# Build queue — shared task routing

Every task lands here first, gets routed to the right tool, and gets tracked.
Rule: judgment → Claude, volume → Codex, hands-on → Cursor, non-code → Kai.

## Columns

| Task | Routed to | Status | Notes |
|---|---|---|---|
| SEND NOW: customer #1 onboarding email via Twilio email | Claude | in_progress | Josh: send from Twilio (already wired — TWILIO_EMAIL_FROM_ADDRESS). NOT Resend (not wired), NOT Josh's Gmail (declined). To: kapokapokepo@gmail.com. Subject: `your Rivet line — let's get it set up`. Body: `hey — josh here, founder of rivet. saw you signed up yesterday — appreciate it.` / blank / `here's how this goes: 20 minutes on the phone, i set the whole thing up for you. your greeting, your services, your calendar — you don't touch anything. then it's live on your real number.` / blank / `what's a good 20 for you tomorrow?` Plain text. Confirm sent. |
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
