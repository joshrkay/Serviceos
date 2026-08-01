---
title: "Voice-quality graders mis-attribute events on sub-millisecond Date.now() ties"
date: 2026-06-21
track: bug
problem_type: test-failures
module: "packages/api/src/ai/voice-quality/graders"
tags: ["voice-quality", "flaky-test", "timestamp", "date-now", "grader", "escalation", "launch-gate", "determinism"]
related: ["docs/solutions/test-failures/voice-quality-cassette-drift-serves-stale-response.md"]
---

## Problem
The voice-quality launch gate flip-flopped between **57/58 and 58/58** on the
*same commit* with the *same cassettes*. The single flaky script was
`10-adversarial/sql-injection-text`, failing disposition criterion 11
(`rightEscalationBehavior`, `structured=[11]`) on ~30% of runs. The cause was
**not** cassette content (cf. the related cassette-drift doc) — it was the
grader ordering events by `Date.now()` millisecond timestamps, which **tie**
when a script runs sub-millisecond.

## Symptoms
- `dispositionStructuredResult.failedCriteria: [11]`, reason
  `"turn 0: expected escalates=false, got true"`.
- The escalation didn't appear/disappear — it **moved between turns**: on a
  failing run turn 0 was `escalated=true` (wrong) **and** turn 1 was
  `escalated=false` (wrong) simultaneously.
- **Byte-identical stderr between passing and failing runs** — the tell that
  this is timing, not content (no `cassette drift` warning, no log diff).
- Reproduced by stress-running `npm run voice-quality` ~12–20× and watching
  `voice-quality-report.json` alternate 57/58 ↔ 58/58.

## What Didn't Work
- **Assuming it was cassette corruption** (the prior failure on this branch —
  see related doc — was a merge-mangled cassette). A faithful replay of the
  committed cassette graded the script **4/4 deterministically**; re-recording
  would have changed nothing.
- **A single local run.** `-t "sql-injection-text"` in replay passed, masking
  the flake. Only stress-running the *full* suite surfaced the ~30% failure.

## Solution
Order events by their position in the append-only `observation.events` log, not
by `Date.now()`. Extracted a shared helper and applied it to both graders that
ordered by `ts`:

```ts
// packages/api/src/ai/voice-quality/graders/event-order.ts
export function eventLogIndex(
  events: readonly VoiceSessionEvent[],
): (event: VoiceSessionEvent) => number {
  const index = new Map<VoiceSessionEvent, number>();
  events.forEach((e, i) => index.set(e, i));
  return (event) => index.get(event) ?? -1;
}
```

```ts
// disposition-structured.ts — before: tie-prone ms windows
const lowerBound = i === 0 ? -Infinity : intents[i - 1]?.ts ?? -Infinity;
const upperBound = isLastTurn ? Infinity : intentEv?.ts ?? -Infinity;
const actualEscalated = escalations.some(e => e.ts > lowerBound && e.ts <= upperBound);

// after: causal log-index windows (tie-proof)
const logIndexAt = eventLogIndex(observation.events);
const escalationIndices = escalations.map(logIndexAt);
const lowerBound = i === 0 ? -1 : intents[i - 1] ? logIndexAt(intents[i - 1]) : -1;
const upperBound = isLastTurn ? Infinity : intentEv ? logIndexAt(intentEv) : -1;
const actualEscalated = escalationIndices.some(k => k > lowerBound && k <= upperBound);
```

The same helper revived **floor #8** ("no proposal after hangup"), which had
compared `ts` on `proposal_created` events — but those carry **no `ts` field**,
so the check silently never fired. Ordered by log index it now works.

Verified: tsc clean, grader unit tests green (incl. a same-millisecond tie
test), full corpus stays 58/58, **0/12** stress-run flaky.
Commits: `ad4a9f3d` (initial fix), `14990953` (simplify to plain log index),
`13cb905a` (shared `eventLogIndex` + revive floor #8).

## Why This Works
Every `VoiceSessionEvent` is stamped `ts: Date.now()` (ms) and a whole 2-turn
script can execute inside one millisecond, so `intents[0].ts == escalation.ts`.
With ms windows, turn 0's `<=` upper bound grabbed the tie and turn 1's strict
`>` lower bound excluded it — moving the escalation to the wrong turn. The
**append-only event log is the true causal order** (the agent classifies before
it escalates; a post-hangup proposal is logged after the terminating event), and
log index is unique, so ordering by it is deterministic regardless of clock
granularity. Note the log index, not a per-event `seq`, is the right home:
production events live only in the `session.events` EventEmitter stream — the
ordered log is a harness/observation concept, so there is no production "append
point" to stamp a sequence at.

## Prevention
- **Never order voice-session events by `Date.now()` ts.** Use
  `eventLogIndex(observation.events)` — `ts` ties on fast paths, and some events
  (`proposal_created`, `transition`, `ended`) carry no `ts` at all.
- **Flaky-launch-gate triage:** if pass/fail logs are byte-identical and there's
  no `cassette drift` warning, suspect non-determinism in *grader/agent logic*,
  not cassette content. Stress-run the full suite (≥12×); a single or
  `-t`-filtered run hides it.
- A same-millisecond-tie unit test (`event-order.test.ts`, plus the tie case in
  `disposition-structured.test.ts`) pins the behavior so a future `ts`-based
  refactor fails fast.
