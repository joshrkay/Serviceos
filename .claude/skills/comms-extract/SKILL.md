---
name: comms-extract
description: Read-only discovery pass across the Rivet comms subsystem — data model/resolution reality, channel/threading integration, consent/retention/deletion, and test infra conventions. Dispatches four parallel tracks, synthesizes one findings doc. Precedes both the §8 migration and any goal-prompt rewrite; does not fix anything it finds.
allowed-tools: Read, Grep, Glob
argument-hint: [track-name|all]
---

# /comms-extract — Read-only Rivet comms discovery pass

This is an **extraction pass**, not a `/goal` loop. There are no gates, no
iteration, and no HALT. One read-only inventory pass, same shape as the
ServiceOS six-track discovery work: strict read-only, no code execution
beyond read commands, no per-finding fixes mid-sweep.

The output is a findings doc — `RIVET_COMMS_EXTRACTION_FINDINGS.md` — that
three downstream artifacts consume: the §8 migration plan, the harness
spec, and `RIVET_GOAL_COMMS.md`. This replaces guesswork in all three, not
just the goal prompt. Do **not** rewrite the goal prompt or start the
migration from this skill — those come after the findings doc lands.

## Boundary (read-only, hard)

`allowed-tools` is `Read, Grep, Glob` only. There is deliberately **no
Bash** — this track needs zero execution, not even read-only shell
commands, to stay honest about the read-only boundary. Report state; never
fix. Every finding is `EXISTS` / `PARTIAL` / `ABSENT` with a `file:line`
reference, never a proposed change.

## Arguments

`$ARGUMENTS` is a track name or `all` (default when empty):

- `track1` / `data-model` → Track 1 only
- `track2` / `channel-threading` → Track 2 only
- `track3` / `consent-retention` → Track 3 only
- `track4` / `test-infra` → Track 4 only
- `all` (or empty) → dispatch all four in parallel, then synthesize

## Dispatch

Dispatch the four track subagents **in parallel** (single message, four
`Agent` tool calls) so they run concurrently. Each track reports state only
— `EXISTS` / `PARTIAL` / `ABSENT` per item, with `file:line` references,
never a fix.

| Track | Subagent | Model | Load |
|-------|----------|-------|------|
| 1 — Data model & resolution | `track1-data-model` | opus | architectural tracing (silent drift lives here) |
| 2 — Channel & threading | `track2-channel-threading` | sonnet | enumeration |
| 3 — Consent, retention, deletion | `track3-consent-retention` | opus | architectural tracing (legal exposure) |
| 4 — Test infra | `track4-test-infra` | sonnet | enumeration |

Tracks 1 and 3 carry the heavy judgment load (the same as the goal loop's
isolation-sweep) and run on `opus`; tracks 2 and 4 are enumeration and run
on `sonnet`. Each subagent's charter lives in its own file under
`.claude/agents/`.

## Synthesis (Fable does this — orchestration/review, not re-tracing)

After all dispatched tracks report, synthesize their findings into
`RIVET_COMMS_EXTRACTION_FINDINGS.md` using the fixed output contract below.
Do **not** re-trace the tracks yourself — synthesize what they reported.

**P0 rule (unconditional):** Any RLS or entitlement gap found in Track 1,
and any partial-deletion path found in Track 3, is an automatic **P0**. It
is flagged first in the `## P0` section regardless of what else is found.

### Output contract — `RIVET_COMMS_EXTRACTION_FINDINGS.md`

```
# Comms Extraction Findings

## P0 — silent gaps (surfaced first, unconditionally)
[RLS/entitlement gaps from Track 1, partial-deletion paths from Track 3]

## Track 1 — Data model & resolution
State: EXISTS / PARTIAL / ABSENT per (Account, Contact, Location, entitlement layer)
Drift from spec: [specific deltas]
Migration impact: [which §8 line items are already partially done vs greenfield]

## Track 2 — Channel & threading
State: EXISTS / PARTIAL / ABSENT per (provider integration, channel resolution, threading)
Goal-prompt impact: [does C3/C7's assumed behavior match what's there]

## Track 3 — Consent, retention, deletion
State: EXISTS / PARTIAL / ABSENT per (pre-capture disclosure, 4-class storage, deletion reach)
Legal-exposure flags: [anything touching the 2-party-consent-state exposure or PCI-adjacent storage]

## Track 4 — Test infra
Package manager: ___  Test framework: ___  Existing convention: ___
Harness-spec correction needed: [yes/no, what changes in RIVET_GOAL_COMMS.md]

## Open decisions (D14–D19) — which ones the code already answers
[e.g., if a merge feature already exists, D16 may be partially settled by precedent rather than open]
```

## What happens after this runs (not part of this skill)

The findings doc feeds three things, not one:

1. The **§8 migration plan** gets scoped to actual deltas instead of a
   blind rewrite.
2. The **harness spec** in `RIVET_GOAL_COMMS.md` gets corrected to match
   the real package manager / test convention (Track 4).
3. Any gate whose assumed behavior (**C3, C7** especially) doesn't match
   what Track 2 finds gets re-worded before the loop ever runs.

Hold off rewriting the goal prompt until this comes back — rewriting twice
is cheaper than running a 6-iteration loop against gates that were wrong
from the start.
