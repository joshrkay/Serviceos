---
name: dispatch-story
description: Dispatch a single gap story (e.g. P0-019) to an isolated agent that builds, tests, and commits the work in a worktree. Use when the user types `/dispatch-story <id>` or asks to "run", "dispatch", or "execute" a story by ID. Aborts if pre-flight checks fail.
---

# /dispatch-story — Single-story agent dispatch

Use this skill when the user asks you to dispatch a specific gap story (e.g. P0-019, P3-017) to an autonomous agent.

## Inputs

The user gives you a story ID like `P0-019`. From it:
- `phase` = `0` (the digit after `P`)
- `<id>` = `P0-019`

## Steps

1. **Locate inputs** (do not assume they exist — verify with Read).
   - `docs/stories/phase-<phase>-gap-stories.md` — locate the section starting with `### <id> —`. Capture from that heading down to (but not including) the next `### ` heading. This is the **story body**.
   - `docs/superpowers/contracts/p<phase>-dispatch-addendum.md` — locate the `## <id> —` section. Capture to the next `## ` heading. This is the **dispatch block**.
   - `docs/superpowers/contracts/repository-conventions.md` — read in full.
   - `docs/superpowers/contracts/freeze-list.md` — read in full.

   If any of these files is missing, abort and tell the user which file to create.

2. **Run pre-flight checks** by invoking the harness:

   ```bash
   bash .claude/skills/dispatch-story/preflight.sh <id>
   ```

   The script exits non-zero on failure. If it fails, do NOT launch the agent — surface the failure to the user and stop.

   Pre-flight verifies:
   - Working tree is clean
   - `origin/main` is fetched and reachable
   - `npx tsc --project packages/api/tsconfig.build.json --noEmit` passes
   - All `Pre-flight:` dependency stories listed in the dispatch block have merged commits on `origin/main`

3. **Read the verification gate** out of the dispatch block. It's the bash code under the "Verification gate" heading. Capture it verbatim — you'll pass it to the agent and run it again after the agent finishes.

4. **Launch the agent** with `Agent` tool, `isolation: "worktree"`, `subagent_type: "general-purpose"`. Include in the prompt, in this order:

   a. A short framing paragraph: "You are implementing story `<id>` for ServiceOS. Work in this worktree. Make a commit when done. Do not push — the dispatcher pushes after verification."

   b. The story body (verbatim from step 1).

   c. The dispatch block (verbatim from step 1).

   d. The repository-conventions.md content.

   e. The freeze-list.md content.

   f. **Hard rules** (verbatim, every dispatch):
      ```
      HARD RULES
      - Modify only files matching the "Allowed files" line in the story body
        AND not listed in the "Forbidden files" list in the dispatch block.
      - Do not modify any file under packages/shared/ unless the story explicitly allows it.
      - Do not modify packages/api/src/db/pg-base.ts.
      - Do not push. Commit with message "<id>: <one-line summary>".
      - Before committing, run the verification gate command from the dispatch block.
        If it fails, fix and retry. Do not commit a failing build.
      - Output, as your final message, the verification gate's last 30 lines of output.
      ```

   g. The verification gate command in a fenced block, labeled "Run this exact command before committing".

5. **After agent completes**, run the verification gate again from the parent shell against the agent's worktree (the `Agent` result includes the worktree path). If the agent reported success but the gate fails when you run it, surface the discrepancy.

6. **Report to user**:
   - Story ID
   - Worktree path and branch
   - Verification gate result (PASS / FAIL with last lines)
   - Agent's commit SHA
   - Suggested next step: review the diff (`git diff main...<branch>`), then push + open PR.

7. **Do not auto-push or auto-merge.** The user reviews, decides, and pushes manually (or via a separate skill).

## When NOT to use this skill

- For stories not in `docs/stories/phase-*-gap-stories.md` (e.g. ad-hoc tasks). Use a regular Agent call.
- When the user wants to research or plan, not implement.
- For multi-story batches — those go through `/dispatch-wave` (separate skill, future work).

## Failure modes

- **Pre-flight fails:** abort. Tell the user the specific check that failed and how to fix.
- **Agent's verification gate fails:** abort. Do not commit. Tell the user which gate failed and where to look.
- **Allowed-files violation:** abort. Run `git diff --name-only main...<branch>` against the worktree, list violations, do not commit.
- **Story or addendum missing:** abort. Suggest creating the addendum block.
