# chore: AI hardening execution — take the handoff and run batches U1–U6 to merged PRs

**Created:** 2026-10-18
**Depth:** Standard
**Status:** plan

## Summary

The AI enterprise-readiness audit produced a technical plan with eight units
(`docs/plans/2026-10-18-002-fix-ai-enterprise-hardening-plan.md`, on branch
`docs/ai-enterprise-readiness-audit`, PR #1695). That plan says *what* to fix. This plan says *how this
session executes it*: pre-flight verification, environment, the per-batch protocol, PR lifecycle,
merge-time coordination, and the owner-decision packet that unblocks U7 and U8. Units here are
numbered **E1–E8** so they never collide with the hardening plan's **U1–U8**, which this document
refers to by those IDs throughout.

## Problem Frame

Six independent fix batches (U1–U6, 33 findings) have to land as six reviewable draft PRs, test-first,
each independently reviewed before push, on a 4-CPU cloud container with one shared `node_modules`.
Two more units (U7 erasure, U8 spend cap) wait on owner decisions. The originating session may still
be alive and may push batch A or B at any time, so every batch start has to re-check origin first.

## State verified at planning time (2026-10-18)

| Claim in the handoff | Verified |
|---|---|
| `origin/main` = `20637e004` | Yes, unchanged. |
| No `fix/ai-hardening-*` branch on origin | Yes: `git ls-remote origin 'refs/heads/fix/ai-hardening-*'` returns nothing. |
| PR #1695 open, draft, docs only | Yes. Head `6f29973bd`. Checks green or in progress; nothing failing. |
| Max migration key `313_onboarding_drafts_owner_phone` | Yes. `check-migration-keys` reports 317 keys OK; snapshot row for 313 at `packages/api/test/db/migration-immutability.test.ts:613`. |
| `proposal-linkage.ts`, `createIntentRun`, `dataset-hooks.ts` possibly unimported | All three are unimported on main. `dataset-hooks.ts` is at `packages/api/src/ai/evaluation/dataset-hooks.ts`, not `packages/api/src/ai/`. All three are deletions, not wiring. |
| `gh api` for review threads | **Not usable here**: `gh auth status` fails on `GH_TOKEN`. Use the GitHub MCP tools (`pull_request_read` with `get_review_comments`, `resolve_review_thread`, `add_reply_to_pull_request_comment`). |
| Docker may be unavailable | Docker is up and `pgvector/pgvector:pg16` plus the ryuk reaper are pre-pulled by the session hook. Testcontainers works, but one external DB per batch is still the way to run batches concurrently. |
| Local Postgres | Installed (16.15), stopped. `service postgresql start` before any integration run. |
| CLAUDE.md local Gemma executor at `localhost:1234` | Unreachable in this container. Claude subagents implement (Josh's rule: Sonnet or Opus implements, the orchestrator reviews). |
| PR CI | `pr-checks.yml` `test` job runs `npm test`, `npm run test:integration` (all 376 integration files, RLS runtime role on) and coverage. `e2e.yml` (playwright) and `onboarding-database.yml` run too. `agent-path-smoke.yml` fires on `packages/api/src/ai/**`, so U2, U3, U4, U6 will trigger the live-model smoke; it needs the `OPENAI_API_KEY` secret and is capped at $1. |
| Disk / CPU | 29 GB free, 4 CPUs. `node_modules` is 604 MB at the root plus `packages/{api,shared,web}/node_modules`. |

## Decisions recorded

- 2026-10-18, Josh: owner decisions 1 (PRIV-5 erasure scope) and 2 (money cap on AI spend) are
  settled on the hardening plan's recommended defaults. U7 and U8 may start once U4 and U3 merge.
- 2026-10-25, planning: the U7 and U8 implementation planning, checked against `main` at
  `58383e730`, found sub-choices that those defaults don't cover. The designs name no default for
  them, or they arose after the designs were written. Decisions 1 and 2 accept the designs on
  scope; these sub-choices are still open. They are listed, each with a recommendation, in
  [`docs/plans/2026-10-25-002-u7-u8-owner-decision-packet.md`](2026-10-25-002-u7-u8-owner-decision-packet.md),
  and each design's "Slices and order" names the slices that wait on them.

## Assurance program (rebuilt 2026-10-18 after owner review)

Josh's bar is enterprise production-ready: a large customer's security, reliability and privacy
reviewer signs off, every AI feature works end to end, and no workflow leaves bad state behind.
Landing the 34 audited fixes is necessary, not sufficient. The program therefore has four layers,
each orchestrated as a Workflow with adversarial verification, and the batch protocol in E3 is the
innermost layer only:

1. **Completeness: gap audit of `main`** (runs alongside wave 1). Twelve independent lenses re-audit
   the AI surface: the seven audit dimensions, three enterprise lenses the audit lacked (authn and
   authz on AI surfaces, operability of AI paths, data lifecycle and compliance evidence), and two
   functional lenses (features that do not work end to end on the real app with only the model
   mocked; multi-step workflows that create inconsistent, duplicated or orphaned state). Rounds
   repeat until two consecutive rounds surface nothing new. Every fresh finding faces three
   skeptics (does the path exist, is it real in production configuration, is it already covered by
   the 34 or their planned fixes) and survives only if none refutes it. Survivors are assigned to
   the existing batches or to a new batch G (functional and workflow fixes).
2. **Per-finding implementation and verification**, not per-batch. Each finding gets its own
   implementer working from the wave work package, then three refuters: production-path bypass,
   test validity by reverting the fix and watching the new tests fail, and regression, invariants
   and security. Blocking items go to a fixer, then the finding is re-verified; up to three rounds.
   Wave 1's whole-batch implementers feed the same gauntlet before anything is pushed.
3. **Enterprise panel per PR** before push: a privacy and SOC 2 reviewer, an SRE reviewer and an
   application security reviewer judge the whole diff; blockers loop through the fixer.
4. **Evidence pack per PR** at `docs/quality/ai-hardening-evidence/batch-<K>-U<u>.md`: per finding,
   the production-path trace, commits, tests with proof they fail without the fix, refuter verdicts
   per round, panel verdicts, and the gate output verbatim. The PR body links it.

Definition of done for a batch: every finding PASSes all three refuters, the panel has no open
blocker, the gate is green with counts in the evidence pack, CI and bot reviews are green, and the
evidence pack is on the branch.

## Requirements

- R1. Every batch U1–U6 ends as a draft PR on its named branch, test-first, with an independent
  adversarial review before the first push, and CI plus bot reviews driven to green.
- R2. No batch starts without re-checking origin for its branch and an open PR; a batch is never run
  in two sessions.
- R3. Each push passes the hardening plan's gate locally first: build tsc, api lint, full api unit
  suite, every touched integration file under `RLS_RUNTIME_ROLE=true`, plus web/shared checks when
  those packages change.
- R4. Merge-time rules hold: migrations stay strictly increasing (second merge renumbers and updates
  the immutability snapshot), hot files are merged by `git merge origin/main`, never rebased.
- R5. Owner decisions are put to Josh as one packet and never guessed in code; U7 and U8 start only
  after decisions 1 and 2 land.
- R6. All repository rules apply unchanged (CLAUDE.md; the handoff's §0, including commit trailers,
  PR footer, comment footer, plain owner-facing copy, no force-push, no skipped tests, no merging).

## Key Technical Decisions

- **Execution is delegated; review is independent.** Each batch gets one implementer agent working
  in its own worktree, and a separate reviewer agent that reads `git diff origin/main...HEAD`
  without the implementer's notes. The orchestrator only verifies command output and never states
  a gate as green without it. (Alternative: orchestrator implements. Rejected: Josh's lean-coordinator
  rule, and review independence.)
- **Model per role, chosen by the work.** Implementers and reviewers run on Opus: every batch touches
  security, tenancy, money or live-call behaviour, and the reviewer must be at least as strong as the
  implementer. Sonnet handles bounded lookups (origin checks, file-existence sweeps, CI log reads).
  The orchestrator (Fable) verifies gates, coordinates merges and talks to Josh. Josh's instruction
  2026-10-18: pick whichever model makes more sense per task.
- **Two batches at a time, three waves, ordered by high-severity count.** 4 CPUs minus 2 for the
  orchestrator and Postgres gives two concurrent implementers. Wave 1: U5 (5 high) and U4 (3 high).
  Wave 2: U2 (2 high) and U1 (1 high). Wave 3: U3 (1 high) and U6 (0 high). The originating session
  was working A (U1) and B (U2) at handoff; scheduling them in wave 2 gives it the longest window to
  push before this session takes them, and the pre-start origin check (E3) decides either way.
- **Agent tool, not the Workflow tool, unless Josh opts in.** The handoff mentions a Workflow run,
  but the Workflow tool needs an explicit request from the user. Default to `Agent` with two
  implementers in flight; switch to a Workflow only if Josh says "use a workflow".
- **One Postgres database per batch, shared cluster.** `serviceos_test_<k>` on the local cluster via
  `EXTERNAL_TEST_DB_URL`. Integration files run in a single fork sharing one DB, so two batches on
  one DB would pollute each other (see `docs/solutions/test-failures/shared-db-integration-test-grant-pollution.md`).
  Testcontainers is the fallback if the local cluster misbehaves.
- **Shared `node_modules` by symlink, shared `packages/shared/dist` by build.** Worktrees symlink the
  root and the three package `node_modules` directories from the main checkout; never run
  `npm install` in a worktree (it rewrites the lockfile, see
  `docs/solutions/tooling-decisions/npm-install-rewrites-lockfile-every-session.md`). Rebuild
  `packages/shared` in a worktree only if that batch changes `packages/shared`.
- **Plan-claim verification before each batch, not one big pass up front.** Per
  `docs/solutions/workflow-issues/adversarially-verify-plan-units-before-execution.md`, the hardening
  plan is a set of hypotheses about `20637e004`. Each batch's implementer starts with a read-only
  verification of that unit's file, line and mechanism claims and records corrections in the PR body.
  Corrections are not committed to #1695; that branch belongs to the originating session.
- **Review threads through the GitHub MCP tools.** `gh` is unauthenticated here. Listing threads,
  replying and resolving go through `pull_request_read` (`get_review_comments`),
  `add_reply_to_pull_request_comment` and `resolve_review_thread`.

## Scope Boundaries

**In scope:** E1–E8 below: pre-flight, environment, running U1–U6 to draft PRs and green CI, PR
upkeep, merge-time coordination, the owner-decision packet, U7/U8 once decided, and the close-out.

**Non-goals:**

- Merging anything. Merges are Josh's.
- Re-planning the fixes. The hardening plan's rulings win; the verifier's `corrected_fix` is second;
  the auditor's `fix` third.
- The onboarding slices S3–S6 and D11 (`docs/plans/2026-10-18-001-feat-pick-dont-build-onboarding-plan.md`).
- Externalizing voice session state, a Langfuse DPA, or invented model prices (the hardening plan's
  non-goals).

### Deferred to follow-up work

- The flaky `packages/api/test/settings/voice-approval-pin-route.test.ts:127` (one-line hardening
  candidate; re-run once if it is the only failure).
- D11 (demo phone allowance tied to the `demo_calls` row): fold into the onboarding plan with the
  next commit that touches it.
- `docs/plans/README.md` should list the hardening plan once #1695 merges; do it in E8 if the
  originating session has not.

## Repository invariants touched

This plan writes no product code itself. Each batch honours the invariants as the hardening plan's
"Repository invariants touched" section sets out (RLS and tenant_id in U1/U4; the human-approval gate,
Zod proposals and entity resolver in U2; audit events in U2/U4/U5; the LLM gateway in U3/U4; integer
cents in U3/U8). The reviewer checklist in E3 names each one explicitly so a batch cannot pass review
with a broken invariant.

## High-Level Technical Design

```mermaid
flowchart TD
  E1[E1 pre-flight: origin check, claim verification harness] --> E2[E2 environment: worktrees, DBs, shared build]
  E2 --> W1[Wave 1: U5 voice reliability + U4 privacy]
  W1 --> W2[Wave 2: U2 action safety + U1 tenant DB]
  W2 --> W3[Wave 3: U3 gateway + U6 injection and ops]
  W1 -.-> E4[E4 PR lifecycle: subscribe, bot reviews, CI to green]
  W2 -.-> E4
  W3 -.-> E4
  E4 --> E5[E5 merge-time coordination: migrations, hot files]
  E1 --> E6[E6 owner-decision packet to Josh]
  E6 --> E7[E7 U7 erasure and U8 spend cap, after decisions 1 and 2]
  E5 --> E8[E8 close-out: docs, learnings, plan status]
  E7 --> E8
```

Each wave's batch runs the E3 protocol end to end. A batch leaves its wave slot when its draft PR is
up and its first CI run is green or being worked; E4 continues in the background through PR event
subscriptions while the next wave starts.

## Implementation Units

### E1. Pre-flight and the per-batch verification harness
- **Goal:** record the state this session starts from, tell Josh which batches it is taking, and
  prepare the read-only claim-verification brief each implementer runs before touching code.
- **Requirements:** R2, R5
- **Dependencies:** none
- **Files:**
  - this plan (status notes)
  - no code
- **Approach:**
  - State is already verified (table above). Report to Josh: no batch branches exist, this session
    takes all six in the wave order above, and will re-check origin before each start.
  - Write the verification brief once and reuse it per batch: a numbered checklist of that unit's
    claims from the hardening plan and `findings.json` (files exist, line ranges current, the named
    helper or guard does what the plan says, the named test harness fits, no wrapper or second caller
    a hook would miss). Demand `WRONG / MISSING / RISK / OK` with `file:line` and replacement text.
  - Pre-known corrections to hand to the relevant implementers: `dataset-hooks.ts` path and the three
    confirmed deletions (U2: `proposal-linkage.ts`, `createIntentRun`; U4: `dataset-hooks.ts`).
  - Post the owner-decision packet (E6) now rather than after the waves, so Josh's answers can land
    while batches run.
- **Patterns to follow:** `docs/solutions/workflow-issues/adversarially-verify-plan-units-before-execution.md`
- **Test scenarios:** Test expectation: none, process only. The done signal is the message to Josh
  naming the batches taken and the decisions needed.
- **Verification:** Josh has the batch list and the decision packet; the verification brief exists in
  the scratchpad.

### E2. Environment: worktrees, databases, shared build
- **Goal:** two batches can run concurrently without colliding on files, `node_modules` or a database.
- **Requirements:** R3
- **Dependencies:** E1
- **Files:**
  - worktrees at `../hard-<K>` for K in A–F (outside the repo)
  - no repo changes
- **Approach:**
  - Once: `service postgresql start`; `npm run build --workspace=packages/shared` in the main checkout.
  - Per batch K: `git worktree add -b fix/ai-hardening-<name> ../hard-<K> origin/main`; symlink
    `node_modules` and `packages/{api,shared,web}/node_modules` from the main checkout; symlink or copy
    `packages/shared/dist`; `createdb serviceos_test_<k>`.
  - Integration runs: `cd packages/api && EXTERNAL_TEST_DB_URL=postgres://postgres:postgres@localhost:5432/serviceos_test_<k> RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.mts test/integration/<file>`.
    The connecting role must be a superuser (global-setup applies every migration and provisions the
    RLS runtime role). If the local cluster's `postgres` role has no password, set one or use a
    `trust` entry; record what was done in the scratchpad.
  - Smoke the setup before wave 1 by running one existing integration file (for example
    `test/integration/request-transaction-commit-before-response.test.ts`) in worktree A's DB and
    `npx tsc --project tsconfig.build.json --noEmit` in the worktree.
  - If Postgres stops after a container restart, start it again before any integration or e2e run.
- **Patterns to follow:** `packages/api/test/integration/global-setup.ts` (external DB path);
  `docs/solutions/test-failures/docker-hub-cdn-blocked-in-remote-sessions.md` (fallback);
  `docs/solutions/build-errors/shared-package-dist-stale-after-new-export.md`.
- **Test scenarios:** Test expectation: none, environment. Done when the smoke integration file and
  tsc pass inside a worktree with exact output captured.
- **Verification:** two worktrees run integration files at the same time against different databases
  with no cross-talk.

### E3. Batch protocol (run once per batch: U5, U4, U2, U1, U3, U6)
- **Goal:** one batch goes from plan to a pushed draft PR with an independent review behind it.
- **Requirements:** R1, R2, R3, R6
- **Dependencies:** E2; for each batch the hardening plan's unit section is the spec.
- **Files:** per batch, the hardening plan's "Files" list for that unit; test files next to each
  module plus new `packages/api/test/integration/` files where the unit names them.
- **Wave work packages (the per-batch spec the implementer and reviewer both work from):**
  `docs/plans/ai-hardening-waves/wave-<n>-batch-<K>-U<u>.md`, one per batch. Each restates the
  batch's findings in full (locations, trigger, impact, evidence, verifier reasoning, the fix that
  wins, the audit's test specification), fixes the build order inside the batch, states file
  ownership against the concurrent batch, lists per-finding acceptance criteria, the gate commands,
  the reviewer checklist and the PR body skeleton.
- **Approach:**
  1. **Origin check.** `git ls-remote origin 'refs/heads/fix/ai-hardening-*'` and list open PRs. If
     the batch's branch exists with an open PR, check it out and continue that PR; otherwise start
     from `origin/main`. Record the result.
  2. **Claim verification** (read-only, inside the implementer brief): run the E1 checklist for the
     unit; fold corrections into the implementer's working notes and later the PR body.
  3. **Implement test-first with the `tdd` skill**, one commit per finding or tight group,
     `fix(<area>): <defect in plain words>`, staging only changed files, trailers from the session's
     system reminder. The seams are pre-agreed: the hardening plan's test scenarios for the unit.
     Red before green, one vertical slice at a time, expected values from the finding's trigger,
     never recomputed the way the code does. Grep `docs/solutions/` for the area first. Delete dead
     code the unit names.
  4. **Local gate**, exact counts captured:
     `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`;
     `npm run lint --workspace=packages/api`; `cd packages/api && npx vitest run` (full unit suite);
     every touched or added integration file plus existing ones covering changed code, under
     `RLS_RUNTIME_ROLE=true`; `packages/web` and `packages/shared` tsc and vitest when touched;
     `npm run check:migration-keys --workspace=packages/api` and the migration-immutability test when
     a migration is added.
  5. **Independent review with the `code-review` skill.** A fresh reviewer agent gets the branch,
     the unit's findings as the spec, and the checklist below, not the implementer's conclusions. It
     runs the two-axis review (Standards against CLAUDE.md and the handoff rules; Spec against the
     finding IDs) and then the adversarial pass. Blocking: a fix that does not hold on the
     real production path; a caller regression; a broken invariant (integer cents, UTC, tenant_id and
     RLS, audit event on every mutation, gateway for every AI call, Zod proposal never auto-executed,
     catalog-grounded prices, entity resolver); a test that passes without the fix (reviewer reverts
     the fix hunk and runs the test); a new security hole; jargon or over-promising owner- or
     caller-facing copy; a non-idempotent migration. Fix blocking items test-first, re-run the gate.
  6. **Push** `git push -u origin fix/ai-hardening-<name>` only once the gate is green, then open a
     **draft** PR: findings fixed with IDs; behaviour owners and callers will notice; tests; gate
     output with counts; plan corrections found in step 2; owner actions; the required footer.
  7. **Subscribe** with `subscribe_pr_activity`, then hand the PR to E4.
- **Patterns to follow:** the hardening plan's "How to execute a batch"; the Twilio-adapter ownership
  split (U4 owns `bootstrapCallEstablishment` and `buildTelephonyGreeting`, U5 owns the rest of
  `twilio-adapter.ts`); `docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md`
  (every DB-touching change needs a real-column integration test).
- **Test scenarios:** the hardening plan enumerates them per unit (U1–U6 "Test scenarios"). Two
  cross-cutting checks apply to every batch:
  - Each new test fails on `origin/main` (or with the fix hunk reverted) and passes on the branch.
  - Integration files run under the per-batch external DB with `RLS_RUNTIME_ROLE=true`.
- **Verification:** draft PR open on the named branch, review findings closed, local gate output in
  the PR body, PR subscribed.

### E4. PR lifecycle: CI, bot reviews and threads to green
- **Goal:** every batch PR reaches green CI with every review thread answered or resolved.
- **Requirements:** R1, R6
- **Dependencies:** E3 (per PR)
- **Files:** none beyond the batch branch
- **Approach:**
  - PR events arrive through the subscription; no polling. Keep a safety-net check-in via
    `send_later` while a PR waits only on CI or reviewers (first at about 50 minutes, then about every
    4 hours, stop after three quiet check-ins).
  - CI red: root-cause and push a fix; a failure that is red on `main` too is reported once on the PR
    with the ported fix if one exists. Known flake: re-run `voice-approval-pin-route.test.ts:127`
    once if it is the only failure. Never skip or quarantine a test, never an empty commit.
  - `agent-path-smoke` needs the `OPENAI_API_KEY` secret; if it fails for a missing credential, say so
    on the PR and to Josh. It is not a code failure.
  - Bot reviews: Codex reviews every push and is the main source. Every finding is a claim to verify:
    trace the path, fix when real and proportionate, otherwise reply with the traced path. Optional
    (nit, suggestion, style) findings get a one-line reply and are carried into the next code push.
    Cursor Bugbot and XHawk need Josh (usage limit, credits); CodeRabbit skips drafts.
  - Thread mechanics through the GitHub MCP tools; every comment ends with the attribution footer.
  - Base moves: `git merge origin/main` into the branch, regenerate nothing by hand, re-run the gate,
    push.
- **Patterns to follow:** the session's PR-driving rules; `docs/solutions/workflow-issues/main-merge-damage-on-long-lived-branches.md`
  for the merge-damage checklist (dropped migrations first).
- **Test scenarios:** Test expectation: none, process. CI is the test.
- **Verification:** per PR, all checks green on the current head, no open thread without a reply, and
  Josh told once that it waits only on him.

### E5. Merge-time coordination across the six PRs
- **Goal:** six PRs merging in any order never drop a migration or leave a hot file broken.
- **Requirements:** R4
- **Dependencies:** E4
- **Files:** `packages/api/src/db/schema.ts`, `packages/api/test/db/migration-immutability.test.ts`
  (only when renumbering); the hot files listed in the hardening plan's Risks table.
- **Approach:**
  - Migrations: every batch that adds one takes `314_*` at write time (current max is 313). After
    each merge to `main`, every still-open PR that carries a migration merges `origin/main`, compares
    keys with the `comm` recipe in the merge-damage learning, renumbers to the next free key with the
    same SQL body (hash unchanged) and updates the snapshot row in that same commit. Migrations are
    idempotent (`IF NOT EXISTS`) and additive (`docs/runbooks/migration-discipline.md`).
  - Hot files (`ai/gateway/gateway.ts`, `telephony/twilio-adapter.ts`,
    `voice/transcription-providers.ts`, `shared/config.ts`, `app.ts`): conflicts resolved by merging
    `main` in, keeping both sides' hunks; ask Josh only when both sides changed the same logic.
  - Suggested merge order to minimize renumbering, given Josh merges: U5, U4, U2, U1, U3, U6 (the
    wave order). Say so once in the decision packet; it is a suggestion, not a gate.
- **Patterns to follow:** `docs/solutions/workflow-issues/main-merge-damage-on-long-lived-branches.md`
- **Test scenarios:**
  - After each `main` merge: `check:migration-keys`, `migration-immutability.test.ts`,
    `migration-key-order.test.ts` pass; the full local gate passes again before the push.
- **Verification:** no PR is ever `dirty` for longer than one working round, and no migration key
  is dropped by a merge.

### E6. Owner-decision packet to Josh
- **Goal:** every decision only Josh can make is in front of him as one message, with the
  recommended default and what each unblocks.
- **Requirements:** R5
- **Dependencies:** E1
- **Files:** none (a message; optionally a comment on #1695 with the footer)
- **Approach:** list the hardening plan's nine owner items with the recommended default and the
  dependent unit: (1) PRIV-5 erasure scope → U7; (2) money cap → U8; (3) auto-approve threshold floor;
  (4) AI-disclosure wording, counsel; (5) run the VoiceFallbackUrl backfill after U5 merges; (6) make
  the live eval required and disable Railway auto-deploy after U6 merges; (7) voice scale-out;
  (8) plan → AI tier mapping; (9) raise the Cursor Bugbot limit. Add the two from this session: the
  `OPENAI_API_KEY` secret for the smoke job, and whether to opt in to a Workflow run.
- **Test scenarios:** Test expectation: none.
- **Verification:** Josh's answers to 1 and 2 are recorded in this plan's status notes before U7 or
  U8 starts.

### E7. U7 erasure and U8 spend cap, after decisions
- **Goal:** build the two follow-on units exactly as the hardening plan specifies, once decisions 1
  and 2 land.
- **Requirements:** R1, R3, R5
- **Dependencies:** E6 (decisions 1 and 2); U7 depends on U4 merged (Twilio deleter seam, `ai_runs`
  purge); U8 depends on U3 merged. Both are on `main`. Each design's gates add their own
  dependencies: #1695 merged with the 2026-10-25 corrections, the open PRs each design names, and
  the owner-packet answers its slices wait on.
- **Files:** per each design's "Slices and order"
  ([`2026-10-18-002a-u7-data-subject-erasure-design.md`](2026-10-18-002a-u7-data-subject-erasure-design.md),
  [`2026-10-18-002b-u8-ai-spend-cap-design.md`](2026-10-18-002b-u8-ai-spend-cap-design.md)).
- **Approach** (amended 2026-10-25; it replaced one branch per unit):
  - **Serial PRs off `main`, not one branch.** U7 is 64 slices (U7-00 to U7-50 with their splits) and U8 about 35, too many for
    one reviewable PR, and stacked long-lived branches invite the damage in
    `docs/solutions/workflow-issues/main-merge-damage-on-long-lived-branches.md`. Each PR is cut
    from `main` after the one before it merges, runs the E3 protocol unchanged, quotes the decision
    and any packet answer it builds on, and merges `main` in rather than rebasing. The single
    branches `fix/ai-hardening-erasure` and `fix/ai-hardening-spend-cap` are not used.
  - **The gates.**
    - U7 Gate 0 starts now: the U7-00 inventory
      ([`docs/plans/2026-10-25-001-u7-erasure-inventory.md`](2026-10-25-001-u7-erasure-inventory.md)),
      webhook receipts that keep only what their readers use, and the four raw `audit_events`
      inserts moved onto the repository.
    - U7 Gate 1 waits for #1695 and #1830 to merge and for owner packet items 13, 14 and 16.
      Gates 2 to 4 follow the U7 design's order; the erase flag stays off until Gate 4 is done.
    - U8 starts with PR-0, its design corrections on #1695. No U8 code slice starts until #1695
      has merged, owner packet items 1 and 2 are answered, the owner of the shared primitives is
      agreed, and #1829 to #1833 have landed. U8's PR-1 and PR-2 merge together.
  - **Shared primitives belong to U7.** U7 owns the two-key lock class ids
    (`db/advisory-lock-classes.ts`), the stripe helper and the lock-order flags, the dedicated side
    pool (`db/side-pool.ts`) and the sink registry (`externalSinks`, which carries U8's `spend`
    field). U8 imports them. Whichever unit is ready first builds them in U7's files, under U7's
    names.
  - **Keys.** Migration keys are taken at merge time from `main`'s tail (353 on `58383e730`); the
    PR that merges second renumbers and updates the immutability snapshot in the same commit, as
    E5 already requires. Sweep keys 590048 to 590057 are reserved for U7; U8 starts at 590058.
  - Money in integer cents; the cap check before dispatch including failover and streaming; the
    erasure endpoint owner-only, audited, never a proposal.
- **Test scenarios:** the hardening plan's U7 and U8 scenarios, including the Docker-gated erasure
  integration test (every store scrubbed, amounts kept, suppression kept, audit event, 403 for
  non-owner, other tenant untouched) and the U8 monthly-window integration test.
- **Verification:** every U7 and U8 PR green, with the decision and any owner-packet answer it
  relies on quoted in its PR body.

### E8. Close-out
- **Goal:** the next session can pick up without this one.
- **Requirements:** R6
- **Dependencies:** E5, E7
- **Files:** `docs/plans/README.md`; `docs/solutions/` entries; this plan's status.
- **Approach:** update the hardening plan's status when its units merge (on `main`, after #1695
  merges); add `docs/plans/README.md` rows for both plans; write `ce-compound` entries for anything
  learned the hard way (the `gh` limitation, the worktree symlink recipe, any CI surprise); update
  `docs/audit/HANDOFF-*` only if a further handoff is needed.
- **Test scenarios:** Test expectation: none, docs.
- **Verification:** `docs/plans/README.md` lists both plans with the right status.

## Risks & Dependencies

- **The originating session pushes A or B mid-run.** Mitigated by wave ordering and the origin check
  at every batch start; if a branch appears after this session started the same batch, stop, compare
  diffs, and tell Josh before continuing either.
- **Two implementers plus Postgres on 4 CPUs.** The full unit suite in two worktrees at once will be
  slow; stagger the gate runs rather than widen concurrency.
- **Disk.** Six worktrees share `node_modules` by symlink, so the cost is source trees only (well
  under 1 GB each); still prune a worktree once its PR is merged.
- **`agent-path-smoke` cost and secret.** Four batches trigger a live-model job; it is capped at $1 a
  run and fails explicitly without the secret.
- **Behaviour changes owners will notice** (more drafts held for technicians, an AI-disclosure
  sentence on every call, voicemail instead of a false "connecting you"): each PR body calls them out.

## Open Questions (deferred to implementation)

- Whether the local cluster's `postgres` role needs a password set for the `EXTERNAL_TEST_DB_URL`
  form the handoff gives; E2 records what was needed.
- Whether a tenant plan field exists to drive `tenantTier` (U3); if not, raise the default
  concurrency and leave the mapping to owner decision 8.
- Whether Josh wants the Workflow tool used; until he says so, the Agent tool with two implementers.

## Sources & Research

- `docs/plans/2026-10-18-002-fix-ai-enterprise-hardening-plan.md` and
  `docs/quality/ai-enterprise-readiness-audit-2026-10-18.{md,findings.json}` (branch
  `docs/ai-enterprise-readiness-audit`, PR #1695).
- `docs/audit/HANDOFF-2026-10-18-ai-hardening.md` (same branch; uploaded copy read this session).
- `docs/solutions/workflow-issues/adversarially-verify-plan-units-before-execution.md`,
  `docs/solutions/workflow-issues/main-merge-damage-on-long-lived-branches.md`,
  `docs/solutions/test-failures/shared-db-integration-test-grant-pollution.md`,
  `docs/solutions/test-failures/docker-hub-cdn-blocked-in-remote-sessions.md`,
  `docs/solutions/tooling-decisions/npm-install-rewrites-lockfile-every-session.md`,
  `docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md`,
  `docs/runbooks/migration-discipline.md`.
