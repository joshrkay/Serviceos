---
title: "Phone lookup dispatch had no authorization behind the classifier prompt — an identified customer could hear tenant revenue"
date: 2026-08-26
track: bug
problem_type: logic-errors
module: "packages/api/src/telephony/twilio-adapter.ts, packages/api/src/ai/voice-turn/phone-lookup-surface.ts, packages/api/src/telephony/phone-actor.ts"
tags: ["voice", "telephony", "lookups", "rbac", "defence-in-depth", "prompt-gating", "surface-adapter", "parity", "allowlist"]
related: ["docs/solutions/workflow-issues/adding-a-voice-intent-requires-four-coordinated-updates.md"]
---

## Problem
The live phone carried its own copy of the lookup switch (14 of 20 cases) instead of calling
the shared dispatch the memo and chat surfaces use. Two consequences:

1. Five lookups (`lookup_my_day`, `lookup_materials`, `lookup_job_profit`, `lookup_crew_schedule`,
   `lookup_timesheets`) fell to `default` and answered "let me get a person" — with no metric (#843).
2. The copy's only authorization was the caller-ID boolean, applied to a subset of intents.
   `lookup_revenue` and `lookup_leads` live in the base classifier `SYSTEM_PROMPT` (offered to
   every caller) and the phone's switch had **no** check on them after customer identification.
   The only thing between an identified customer and the tenant's revenue figure was prompt wording.

A third instance surfaced while fixing it: the first fix gated the phone by a *denylist* (the
owner-extended set), and `lookup_materials` — base prompt, no permission entry — read the tenant's
shopping list to any identified caller. Code review caught it before merge.

## Root cause
Prompt gating was treated as authorization. The shared module authorises by the asking
**actor's** DB role and fails closed; the phone had no actor, only `ownerSession`. And a gate
expressed as "refuse these" fails open for the next intent added; only "answer these" fails closed.

## Fix
- Phone becomes the third caller of `executeLookupAnswer` via a thin surface adapter
  (`ai/voice-turn/phone-lookup-surface.ts`); the private switch is deleted.
- Caller-ID resolves to an actor once at session establishment (`telephony/phone-actor.ts`) and is
  stored as `session.actorUserId`. Order: registered mobile → active user (a matched-but-inactive
  user never falls through to the bridge); owner line → sole active owner (bridge, so owners without
  a mobile on their profile don't regress); else none.
- The shared RBAC gate then applies on the phone, plus one phone-only allowlist: with no actor, only
  the caller's own customer-scoped records and `lookup_availability` are answered.
- `PgUserRepository` now maps `status`/`deleted_at` (it never had), so the active check is real.

## How to recognise it next time
- A surface with its own copy of a shared switch. `grep -rn "case 'lookup_"` should hit ONE
  production dispatch (`workers/voice-lookup-answer.ts`) plus two non-dispatch hits: the voice-quality
  text-mode harness (knowingly stale mirror, out of scope) and
  `ai/agents/customer-calling/escalation-summary-builder.ts` (an intent → human-phrase switch, not a
  dispatch).
- "Gated by the prompt" anywhere in a comment. The prompt decides what the model may *say*;
  it must never be the only thing deciding what the system *does*.
- A boolean where the shared module wants an identity.
- An authorization rule written as a denylist. Enumerate every intent against every gate in a
  table-driven test and assert the count, so the next intent cannot slip through.

## Tests that pin it
`test/telephony/lookup-dispatch-characterization.test.ts` (Gather seam, all outcomes, the
20-intent no-actor table), `test/telephony/phone-actor.test.ts`,
`test/telephony/owner-session.test.ts` (actor stamped at establishment, both transports),
`test/users/pg-user.test.ts` (status/deleted_at mapping),
`test/integration/phone-lookups-shared-dispatch.test.ts` (real Postgres + real membership loader).
