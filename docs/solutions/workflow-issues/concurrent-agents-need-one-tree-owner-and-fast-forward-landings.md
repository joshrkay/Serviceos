---
title: "Concurrent agents need exactly one working-tree owner; everyone else lands via worktree branches and fast-forwards"
date: 2026-08-01
track: knowledge
problem_type: workflow-issues
module: multi-agent orchestration (repo-wide)
tags: ["worktree", "parallel-agents", "git", "orchestration", "merge-discipline"]
related: ["docs/solutions/workflow-issues/main-merge-damage-on-long-lived-branches.md"]
---

## Context
One day (2026-08-01) produced three distinct collisions from parallel actors sharing git state: (1) a resumed agent `git reset` the orchestrator's gate commit believing a "rogue reviewer" had made it — the commit was legitimate; (2) two actors resolved the same 15-file merge concurrently (web-UI resolution vs verified agent resolution), and the unverified one was admin-merged, turning main red; (3) an "Update branch" click raced the orchestrator's identical local base-sync on a PR branch. Separately, merging a finished worktree branch while another agent was still booting the app from the main tree nearly repeated the damage class.

## Guidance
- **One tree, one writer.** At any moment exactly one actor (agent or orchestrator) commits in a given working tree. Everyone else works in an isolated worktree on its own branch.
- **Tell every agent who owns commits.** Agent briefs must state: which branch, whether it may commit, that it must never push/reset/rebase others' commits. An agent that finds an unexpected commit reports it — never "fixes" history it didn't write.
- **Land finished worktree work as branches, not tree edits.** When a fix must apply to a branch whose tree is busy (or sandbox-blocked), branch off the shared ref at its current tip and commit there; the orchestrator lands it later with `git merge --ff-only` — no conflicts possible, nothing stale.
- **Never mutate a tree hosting a live runtime session** (verifier booting the app, dev server). Queue merges until the session tears down.
- **Competing resolutions of the same conflicts:** keep both in history; supersede the unverified tree with the verified one via a `-s ours` merge (preserves the other commit as a parent, no force-push), and say so in the merge body.
- **Remote moved under you?** Fetch and inspect authorship/content BEFORE choosing between a normal merge (equivalent work, e.g. a GitHub "Update branch" race) and a supersede merge (competing unverified resolution). Never force-push over a human's commit.

## Why This Matters
Every incident above cost a round of re-verification, and one shipped a red main. The discipline costs nothing: worktrees are cheap, `--ff-only` landings are conflict-free by construction, and supersede-merges keep history honest.

## When to Apply
Any session running 2+ agents that touch git, any repo with concurrent human+agent actors (this one), and especially fix rounds targeting a branch another process is using.

## Examples
- Fix-round landing: agent commits `10ffcdf6` on `fix/u9-voicemail-review-findings` branched from the feature tip → orchestrator: `git merge --ff-only fix/u9-voicemail-review-findings`.
- Supersede: `git merge -s ours origin/<branch>` after verifying the remote resolution kept duplicate modules / colliding migrations that the verified tree had consolidated (PR #789 history).
