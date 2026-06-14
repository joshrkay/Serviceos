---
name: ce-work
description: "Execute a plan or a bounded piece of work end to end — implement, test, and commit complete features following existing patterns. Use when the user says 'work this', 'execute the plan', 'build this', or 'implement X'. Pairs with ce-plan (pass a docs/plans/ path); blank invocation picks up the latest plan."
argument-hint: "[plan path, or a description of the work. Blank = latest plan in docs/plans/]"
---

# /ce-work — Execute work

Adapted from Every Inc's Compound Engineering plugin (MIT) — see
`.claude/skills/ATTRIBUTION.md`.

Take a plan (or a bare description) and ship it: understand requirements
fast, follow existing patterns, keep quality high, finish the feature.
The goal is a **complete, tested, committed** change — not 80%-done work.

## Input

<input_document> #$ARGUMENTS </input_document>

## Phase 0 — Triage

- **Plan path given** → read it fully (Phase 1).
- **Blank** → glob `docs/plans/*.md`, pick the most recent, confirm it's
  the one to execute.
- **Bare prompt** → assess complexity and route:

  | Complexity | Signals | Action |
  |-----------|---------|--------|
  | **Trivial** | 1-2 files, no behavior change (typo, config, rename) | Implement directly after setup. Still add a test if behavior changes. |
  | **Small/Medium** | Clear scope, <~10 files | Build a task list, proceed. |
  | **Large** | Cross-cutting, architectural decisions, 10+ files, touches auth/payments/migrations/AI gateway | Recommend running `/ce-plan` first to surface edge cases. Honor the user's choice. |

## Phase 1 — Quick start

1. **Read the plan** as a decision artifact (not a script). Mine its
   Implementation Units, Files, Test scenarios, Verification, Scope
   Boundaries, and Open Questions. Note any unit dependencies/ordering.
   If anything is genuinely ambiguous, ask now — better than building the
   wrong thing. **Do not edit the plan body during execution**; progress
   lives in git commits, not the doc.

2. **Confirm the branch.** Per this repo's rules, feature work goes on the
   designated development branch — do **not** push to a different branch
   without explicit permission, and never commit to the default branch
   directly. Check `git branch --show-current`; if you're not on the
   intended feature branch, confirm with the user before switching or
   creating one (create locally if it doesn't exist).

3. **Build a task list** from the plan's units using `TaskCreate`/
   `TaskUpdate`/`TaskList`. Prefix each task with the unit's U-ID
   (e.g. "U3: add catalog-resolver coverage"). Carry each unit's
   "Patterns to follow" and use its "Verification" as the done-signal.
   Skip this for Trivial work.

4. **Choose execution strategy:**

   | Strategy | When |
   |----------|------|
   | **Inline** | 1-2 small tasks, or anything needing mid-flight user input. Default for bare prompts. |
   | **Serial sub-agents** | 3+ dependent tasks with good plan metadata — each `general-purpose` agent gets a fresh context for one unit. |
   | **Parallel sub-agents** | 3+ independent tasks whose `Files:` lists don't intersect. Dispatch with `isolation: "worktree"` so each works in its own tree; merge in dependency order. If file sets overlap and no isolation, downgrade to serial. |

## Phase 2 — Execute

For each task, in dependency order:

1. Mark in-progress. **If the unit's work already exists and satisfies its
   Verification**, it likely shipped earlier — verify, mark done, don't
   reimplement.
2. Read the files it touches and the patterns it should mirror. Grep for
   similar implementations; match naming and conventions exactly.
3. Implement following existing conventions and the repository invariants
   (integer cents; UTC storage; `tenant_id` + RLS on every entity; audit
   events on every mutation; AI calls through the LLM gateway; proposals
   Zod-validated and never auto-executed; AI prices grounded via the
   catalog resolver; voice entity refs through the entity resolver). Use
   the shared billing engine for money math, the async worker pattern
   (P0-009) for background jobs, and the webhook base (P0-014) for webhook
   handlers.
4. **Tests in the same commit** (mandatory — `CLAUDE.md`):
   - New/changed pure logic → unit tests.
   - Voice/AI behavior → handler-level tests with a mocked gateway/repos.
   - DB-touching changes → a Docker-gated integration test in
     `packages/api/test/integration/`. A mocked-DB test is **never the
     only proof a query works** — pin real columns.
   - Mobile/public UI → ≥44px tap targets (`min-h-11`), no horizontal
     overflow at 320px; pin with a jsdom class-contract test + a
     Playwright viewport test.
   - Run the relevant tests after each change, fix failures immediately —
     don't batch testing to the end.
5. **System-wide check** before marking done: what fires when this runs
   (callbacks, middleware, webhook handlers, audit emission)? Do the tests
   exercise the real chain, not just mocks? Can a failure leave orphaned
   state? Are there other interfaces (voice vs. web vs. API) that need
   parity?
6. **Remove dead code** as you go — unused exports, imports, fixtures, and
   any null/stub stand-ins for a module you just wired (re-grep usage
   first). This is part of every change, not a follow-up.
7. Mark complete and evaluate an **incremental commit**: commit when a
   logical unit is complete and tests pass; don't commit WIP or failing
   trees. Stage only that unit's files (not `git add .`). Use a
   conventional message derived from the unit's Goal. Incremental commits
   use clean messages without attribution footers.

Every 2-3 units (or at a phase boundary), pause to **simplify** — the
`/simplify` skill, or review the changed files for duplication and reuse.
Don't simplify after every unit; early patterns may diverge intentionally.

## Phase 3 — Quality gate (mandatory before finishing)

Run, from the repo root unless noted, and fix everything before declaring
done:

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit   # canonical prod build check
npm run lint
npm run test
npm run test:integration   # when DB-touching changes were made (Docker-gated)
```

For UI changes also run the relevant Playwright specs (e.g.
`npm run e2e:smoke`). The default `tsconfig.json` includes test files and
is **not** sufficient — always verify with `tsconfig.build.json`.

Then run a code review: invoke `/code-review` (or the `review` skill) on
the diff and address findings. If `/code-review` returns findings,
fix-then-recheck before finishing.

## Phase 4 — Finish

1. Confirm all tasks are complete — no feature left 80% done.
2. Commit any remaining staged work with a clear conventional message.
3. Push to the designated feature branch:
   `git push -u origin <branch>` (retry on network errors with backoff:
   2s, 4s, 8s, 16s). **Do not open a PR unless the user asks.**
4. Report: what shipped (by U-ID), test/build results (state failures
   plainly if any), and anything deferred. Offer `/ce-compound` to capture
   any non-trivial learning from this work.

## Pitfalls to avoid

- Analysis paralysis — read the plan and execute.
- Testing at the end instead of continuously.
- Mock-only tests for DB queries or cross-layer behavior.
- Re-scoping the plan into human-time "sessions" — execute the units.
- Leaving dead code or stub stand-ins behind.
- Pushing to the wrong branch or opening a PR unprompted.
