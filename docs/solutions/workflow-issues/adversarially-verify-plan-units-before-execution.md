---
title: "Adversarially verify a plan's file/line/mechanism claims before executing it"
date: 2026-09-05
track: knowledge
problem_type: workflow-issues
module: "docs/plans, packages/api/src/telephony, packages/api/src/ai/gateway, packages/api/src/db/schema.ts"
tags: ["planning", "ce-plan", "ce-work", "verification", "sub-agents", "deepening", "file-line-drift"]
related: ["docs/solutions/workflow-issues/verify-spec-gaps-against-shipped-code.md", "docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md"]
---

## Context

`docs/plans/2026-09-05-001-fix-top-5-production-issues-plan.md` was
written from an audit (issues, CI history, PostHog, a code re-verification
of the deferred-queue defects) and looked implementer-ready: every unit
named files, line numbers, patterns to follow and test scenarios. Before
dispatching implementers, four read-only `Explore` agents were given two
or three units each and a numbered checklist of the plan's specific
claims, and asked for a verdict (WRONG / MISSING / RISK / OK) with
`file:line` evidence plus the exact text the plan should change.

They returned about forty corrections. A sample, every one of which would
have cost an implementer real time or produced a wrong fix:

| Unit | Plan said | Code says |
|---|---|---|
| U8 | persist from `packages/api/src/voice/voice-session-store.ts` | file does not exist; it is `packages/api/src/ai/agents/customer-calling/voice-session-store.ts` |
| U8 | transcripts are lost when the session is *reaped* | `findByCallSid` returns `undefined` for any `ended` session (`voice-session-store.ts:614-620`), so ingestion is dropped on nearly every normally-ended call; `findByCallSidIncludingEnded` already exists and is used for exactly this at `twilio-adapter.ts:3409-3410`. A one-line fix covers most of the requirement. |
| U7 | "remove the surface-detection guard added by #962" | no such guard exists; the #962 condition is an empty-utterance rule that any non-empty utterance satisfies |
| U10 | one hook in `gateway.complete` sees every completion | cache hits bypass it entirely (`CachingGatewayWrapper` wraps the gateway from outside and returns at `cache.ts:136`); and the factory's options-vs-logger discriminator would coerce the new option key into a logger |
| U5 | copy the fake-timer harness in `telephony-realtime-fallback.test.ts` | that file has zero fake timers and never constructs the adapter; `handleClose` takes a bare string and unknown reasons fall through to `'caller_hangup'` |
| U9 | "if the immutability test forbids edits, add a new migration" | the test's documented process *is* in-place edit plus hash regeneration (precedent `0c9bd4c`); the fallback would add 26 permanent `ALTER TABLE`s per boot. Four constraints were also found to be live deploy-brickers today. |
| U2 | reuse the trend script's issue-search helper; test at `.github/scripts/*.test.ts` | the helper is create-only and swallows errors; vitest only discovers `packages/api/test/**` |
| U1 | tag `request_id` from `req.requestId` | no such field; it is `req.safeRequestLog.correlation_id` |

## Guidance

A plan written from an audit is a set of hypotheses about the code. Before
`ce-work`, spend one round of read-only verification on it:

1. **One reviewer per two or three units, in parallel.** Give each a
   numbered checklist of the plan's *specific* claims, not "review this".
   Good questions: does this file exist; are these line numbers current;
   is the named mechanism (timer, guard, helper, index) really what the
   plan says it is; does the named test harness actually do what the plan
   needs (fake timers, real adapter); is there a wrapper, discriminator,
   immutability test, or second caller that a hook at this seam would
   miss; where does a single hook see *everything*.
2. **Demand verdict plus evidence plus replacement text.** Ask for
   `WRONG / MISSING / RISK / OK`, a `file:line`, and a "plan corrections"
   section written as the text the plan should say. That output folds
   straight back in and is checkable by the next reader.
3. **Fold corrections in preserving U-IDs.** Rewrite whole unit sections
   rather than patching phrases when more than a couple of claims changed;
   fix cross-references (invariants sections, dependency lists) that named
   the units.
4. **Treat "reuse X" claims with suspicion.** Three of the eight units
   claimed a helper, harness or guard to reuse that either did not exist or
   did the opposite of what the plan assumed. Ask the reviewer to quote
   the helper's signature and its error posture.
5. **Ask the "hidden second path" question for every hook.** Cache
   wrappers, second webhook deliveries, second session legs for the same
   external id, and options discriminators were the four places a
   straightforward design silently missed cases.

Cost in this instance: four agents, roughly five minutes wall-clock in
parallel, about 100k tokens each. The alternative was four implementers
each discovering the same facts mid-change, or not discovering them.

## Why This Matters

Line numbers and file paths drift within days on an active branch, and a
plan that cites the wrong seam sends an implementer to build the wrong
thing confidently. The most valuable findings were not the drifted line
numbers but the mechanism errors: a fix aimed at the reaped-session case
when the real drop is the ended-session lookup, a tracing hook that would
have reported `cached: false` forever, a migration fallback that would
have made every deploy slower. None of those surface from running tests
on the current tree; they only surface from reading the code the plan
points at with the plan's claim in hand.

## When to Apply

- Any Standard or Deep `ce-plan` output, before `ce-work`.
- Any plan whose units cite line numbers, "reuse X" helpers, or a single
  hook point that must see every call.
- Plans written from an audit or issue text rather than from a fresh read
  of the code, and plans older than a few days on a busy branch.

Skip it for Lightweight plans touching one or two files the author just
read.

## Examples

Reviewer brief shape that worked (excerpt):

```text
Read unit U8 (awk '/^### U8\./,/^### U9\./' <plan>). For each claim,
verdict (WRONG / MISSING / RISK / OK) plus file:line evidence.
1. Confirm the RecordTurnInput shape, the UNIQUE index, whether the FK
   column is NOT NULL, and whether RLS is FORCEd on the table.
2. Is there a migration-immutability test? If so, must this be a NEW
   migration; what is the next number and naming convention?
3. When is the voice_recordings row actually created? If before the
   webhook, the unit's premise is wrong.
4. Does the worker already write these rows? Would incremental rows
   collide with its keys after backfill?
Report as a numbered list, then a 'plan corrections' section with the
exact text the plan should change.
```

The resulting U8 rewrite added a Step 0 one-line fix, a `session_id` in
the key (a restart creates a second session for the same CallSid), a
first-writer-wins attach with renumbering (two `voice_recordings` rows per
call are legal), and made persisted rows authoritative for the ingestion
payload (the worker's loop index drifts from append order).
