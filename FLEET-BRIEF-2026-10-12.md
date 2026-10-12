# Fleet briefing — all hands toward $10k MRR by Dec 31, 2026

Date: 2026-10-12. Goal: $10,000/mo recurring revenue by Dec 31 (~87 paying accounts
at ~$115 blended ARPU). Now: 1 paying ($79 MRR). October target: 50 by Oct 31.

Full plan: `~/workspace/goals/10k-mrr-by-end-of-year/files/rivet-10k-mrr-plan.md`
(shared copy — Josh has it).

## Standing orders by member

**Claude (product, Max plan) — product loop owner**
Judgment work: architecture, big refactors, onboarding flow, ambiguous features.
1. Customer #1 lookup — IN PROGRESS (KAI-HANDOFF-2026-10-11-FIRST-CUSTOMER.md):
   signup date (new vs trial-converting), setup completion, billable minutes, call count.
2. Owner usage visibility — the gap behind #1: Josh must be able to see any
   tenant's signup date, setup state, and minutes used without asking.
3. Finish-setup UX + in-app onboarding checklist — activation loop; founder-led
   onboarding breaks ~account 20, productize before November.

**Codex ($100 plan) — overnight build farm**
Volume work, tight specs, parallel runs. Judgment calls go to Claude, not Codex.
1. E2E signup → card → onboarding run — QUEUED, BLOCKED on Josh setting the
   test-account password (joshrkay+8@gmail.com) via secure card. Fire the moment
   it lands; report every break.
2. Next up: activation instrumentation audit — verify every onboarding step
   (signup → setup booked → setup done → first call → day 14) emits a timestamp.

**Cursor ($60) — Josh's hands-on seat**
For Josh directly: quick edits, code reading, diff review at speed.

**Kai — acquisition + activation operator, fleet dispatcher**
Runs 24/7: content drip, inbox sweeps, outreach, onboarding comms, funnel reporting,
feedback debriefs. Routes every task through BUILD-QUEUE.md (this repo).
1. Trace customer #1's acquisition source — the highest-leverage unknown.
2. Repair FB cross-post leg — needs Josh live ~10 min for the approval tap.
3. No paying customer sits in silence — first touch within 2h of signup.

**Josh — founder-led motion only**
DMs from his account, calls, setup visits. Current: customer #1 Stripe timeline
check (10 sec, unblocks onboarding email), six founder-DMs, Phoenix call block.

## Handoff protocol (unchanged, now fleet-wide)

- `KAI-HANDOFF-*.md` / `CLAUDE-HANDOFF-*.md` in this repo. Every handoff: the ask,
  the evidence, the decision needed. No open loop older than 48h.
- BUILD-QUEUE.md is the index: task, routed-to, status. Kai dispatches; members
  pick up.
- Skill rule (standing): before any task, check for a skill first
  (`ce-*` and `mp-*` skill libraries are installed in Kai's workspace).
- Code rules (standing): simplify every PR; continuously remove dead code.
