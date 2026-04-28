# Multi-Agent Development Runbook

**Audience:** the human (or lead agent) coordinating a sprint of gap-story work.
**Companion docs:**
- `docs/superpowers/contracts/repository-conventions.md`
- `docs/superpowers/contracts/freeze-list.md`
- `docs/superpowers/contracts/p0-dispatch-addendum.md` (one per phase as we go)
- `.claude/skills/dispatch-story/SKILL.md` (the dispatcher itself)

## Mental model

The 36 gap stories don't form a flat list — they form a **dependency graph**. Multi-agent development is fast only when you find the parallel cuts in that graph.

Three things make a wave parallelizable:
1. **Disjoint allowed-files.** Two agents writing to the same file blocks one of them.
2. **Stable contracts.** The interfaces both agents depend on can't change underneath them.
3. **Independent verification.** Each agent's gate runs without depending on another agent's PR being merged first.

If any one of those breaks, you have to serialize.

## How to run a wave

### 1. Pick a wave from the addendum

Each phase's dispatch addendum opens with a wave plan. Example from `p0-dispatch-addendum.md`:

```
1A: P0-019, P0-020, P0-021, P0-022, P0-027, P0-028   (parallel)
1B: P0-026, P0-029, P0-032                            (parallel)
1C: P0-023                                            (single, after 1A)
1D: P0-024, P0-025, P0-030, P0-031                    (parallel, after 1C)
```

Run waves in order: 1A → 1B → 1C → 1D. Within a wave, all stories run concurrently.

### 2. Refresh migration reservations

Before dispatching Wave 1A, open `freeze-list.md` and confirm the migration numbers reserved for each story are still free in `packages/api/src/db/schema.ts`. If main has advanced past them, edit the freeze list and the addendum to bump the numbers. Don't dispatch with stale reservations — two agents picking the same number = unmergeable conflict.

### 3. Confirm Tier 3 freezes have landed

Open `freeze-list.md` § Tier 3. If any item in flux is depended on by a story in this wave, the freeze story has to land first as a single PR before any wave story dispatches.

### 4. Dispatch the wave

For each story ID in the wave, in **separate** Claude sessions or in **parallel** Agent calls in one session:

```
/dispatch-story P0-019
/dispatch-story P0-020
/dispatch-story P0-021
/dispatch-story P0-022
/dispatch-story P0-027
/dispatch-story P0-028
```

Each dispatch:
- Pre-flights (clean tree, fetched main, tsc passes, deps merged, migration free)
- Spawns an agent in a worktree with the assembled prompt
- The agent makes a commit on a story-named branch
- Runs the verification gate
- Reports back: branch, commit SHA, gate result, suggested next step

The dispatcher does **not** push or open a PR. The human reviews diffs and pushes manually.

### 5. Merge in dependency order

After all wave-1A agents finish:
- Review each branch's diff
- Push each branch and open a PR
- Merge to main (1A stories are independent — order within 1A doesn't matter)
- Run `git fetch origin main` locally before starting the next wave

### 6. Wave completion gate

Before starting the next wave, run from the parent shell:

```bash
git fetch origin main
git checkout main && git pull
npx tsc --project packages/api/tsconfig.build.json --noEmit
npm test --workspaces -- --run
```

If anything fails on `main` after the merges, the next wave does not start. Fix on main first.

## Sprint-level plan

Each sprint = a sequence of waves. Stop the sprint when its exit criterion is met or a wave fails repeatedly.

### Sprint 1 — Database & Auth (BLOCKERS)

**Exit criterion:** Real auth works end-to-end. Data persists across server restarts. No `'dev-secret-key'` literal in production code. RLS context is set on every authenticated request.

| Wave | Stories | Wall-clock estimate |
|---|---|---|
| 1A | P0-019, P0-020, P0-021, P0-022, P0-027, P0-028 | ~1 day (6 agents × ~half-day) |
| 1B | P0-026, P0-029, P0-032 | ~half-day |
| 1C | P0-023 | ~2-3 hours (single agent + integration test pass) |
| 1D | P0-024, P0-025, P0-030, P0-031 | ~half-day |

Sprint 1 fits in 2–3 wall-clock days with multi-agent. Without it, the sequential path is 11+ days.

### Sprint 2 — AI & Voice Connection

Mirrors the original audit's Sprint 2: P3-016, P3-017, P3-018, P2-032. Run a similar wave plan once `phase-3-dispatch-addendum.md` and `phase-2-dispatch-addendum.md` are written.

### Sprints 3–5

Same pattern. Each sprint needs its own dispatch addendum before stories can be dispatched.

## What to do when a story fails

### Pre-flight fail

Don't dispatch. Fix the underlying issue (dirty tree, failing tsc on main, missing dependency). The dispatcher refusing to launch is the system working correctly.

### Verification gate fail

Two paths:
- **Agent's gate failed but commit looks reasonable:** re-dispatch with the story body + a "previous attempt failed at <gate-line>; here is its diff" note. Often a one-fix retry succeeds.
- **Agent committed despite a failed gate:** the agent violated a hard rule. Reset that branch, re-dispatch, and (if it happens repeatedly) tighten the agent prompt's "do not commit a failing build" line.

### Allowed-files violation

Reset the branch. Do not re-dispatch the same story without first editing the story's "Allowed files" line — the violation usually means the scope was too narrow for the actual work.

### Two agents collide on a "shared" file

Indicates a wave-planning bug. The fix is either:
- Move one of the stories to a later wave, OR
- Carve the shared file into two interfaces and dispatch a freeze story that does the carve first.

## What this runbook deliberately does not do

- **Auto-push, auto-merge, auto-rebase.** Push is human-driven. Multi-agent makes mistakes; humans are the safety net.
- **Cross-branch coordination during a wave.** Agents work on isolated worktrees. They do not see each other's WIP.
- **Replace `/ultrareview`.** After a wave merges, run `/ultrareview` on the integrated branch before promoting to staging. Multi-agent is fast at producing diffs; review is slow on purpose.

## Adding a new phase

When you reach a phase that doesn't have a dispatch addendum:

1. Read the `phase-N-gap-stories.md` for that phase.
2. For each story, write a `## <id>` block in `docs/superpowers/contracts/p<N>-dispatch-addendum.md` containing:
   - Status correction (if the story body is stale relative to current code)
   - Wave assignment
   - Migration number reserved (if applicable)
   - Forbidden files
   - Verification gate (single bash block)
   - Pre-flight dependency list
3. At the top of the addendum, write a wave plan table.
4. Update `freeze-list.md` if any of the stories in the phase need a Tier 3 freeze first.

That's all the dispatcher needs.

## File map (so a fresh agent can pick this up cold)

```
docs/
  stories/
    phase-0-gap-stories.md ...       # Canonical story bodies (existing)
  superpowers/
    multi-agent-runbook.md            # This file — operating manual
    contracts/
      repository-conventions.md       # Method shapes, RLS pattern, locked seams
      freeze-list.md                  # Tier 1/2/3 contracts, migration reservations
      p0-dispatch-addendum.md         # Wave plan + per-story dispatch metadata
      p1-dispatch-addendum.md         # (TBD when Sprint 2 begins)
      ...
.claude/
  skills/
    dispatch-story/
      SKILL.md                        # /dispatch-story instructions
      preflight.sh                    # Pre-flight checks
      verify.sh                       # Verification gate runner
```

## One-line sprint start

After the addendum and freeze-list are current, starting a sprint is:

```
git checkout main && git pull
/dispatch-story P0-019
/dispatch-story P0-020
/dispatch-story P0-021
/dispatch-story P0-022
/dispatch-story P0-027
/dispatch-story P0-028
```

— in one Claude session, dispatched in a single message so they run in parallel. The dispatcher takes it from there.
