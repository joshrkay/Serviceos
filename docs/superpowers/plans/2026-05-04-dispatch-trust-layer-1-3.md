# Dispatch Trust Gap — Layer 1 (Wiring Grep Gate) + Layer 3 (Reviewer Checklist)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Context

A 2026-05-04 codebase assessment surfaced a meta-bug: the dispatch system reports more shipped than is actually wired in production code. Three concrete examples on `origin/main` head:

1. `CreateCustomerExecutionHandler.execute` (`packages/api/src/proposals/execution/handlers.ts:42-52`) returns `{ success: true, resultEntityId: uuidv4() }` with zero database write. Same for `UpdateCustomerExecutionHandler`, `CreateJobExecutionHandler`, `DraftEstimateExecutionHandler`.
2. `IdempotencyGuard` exists (`proposals/execution/idempotency.ts`) and `ProposalExecutor` accepts it as a 3rd constructor arg (`executor.ts:55`), but `app.ts:768` constructs `new ProposalExecutor(...)` without passing it. Grep confirms zero `IdempotencyGuard` references in `app.ts`.
3. F-1 freeze item: API `Proposal` interface has 27 fields (`packages/api/src/proposals/proposal.ts:44`), Web `Proposal` interface has 6 fields (`packages/web/src/types/conversation.ts:64`). 21 fields silently truncated. Identical drift on the assessment branch and `main`.

In every case, the dispatch addendum / runbook believed the work was done because:
- A story-named branch had a passing `tsc` build
- The verification gate ran unit tests against in-memory repos that don't exercise the wiring path
- The addendum status notes were updated based on "branch landed" not "wired in `app.ts` with real deps"

**Goal of this plan:** add two cheap gates to `dispatch-story` that catch this class of bug *before* a story passes verify. Layer 1 (automated grep) catches "handler isn't wired in app.ts." Layer 3 (manual checklist) catches CLAUDE.md invariant violations that can't be detected by single-symbol grep (gateway bypass, webhook base not adopted, type drift, etc.).

These two layers ship together because they're both small and complement each other — automation for the things grep can see, human review for the rest.

Layer 2 (integration smoke gate) is specified separately in `docs/superpowers/plans/2026-05-04-dispatch-trust-layer-2.md` because it requires test-infra work (Postgres harness) and lands after Layer 1+3.

**Architecture:** No new patterns. Extends the existing `dispatch-story` skill: one new required field in the addendum block (`Wiring claim:`), one new awk-extract + grep step in `verify.sh`, one new docs file (`shipped-checklist.md`), one PR-template reference. Nothing in product code changes. Nothing in CI changes.

**Tech stack:** Bash + awk (already used in `verify.sh`), Markdown. No new dependencies.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `docs/superpowers/contracts/shipped-checklist.md` | The Layer 3 manual checklist that human reviewers tick before merging a story PR. |
| `.github/PULL_REQUEST_TEMPLATE.md` | Embeds the shipped-checklist as a PR-body section. (Create only if not already present — verify first.) |

### Modified files

| Path | Change |
|------|--------|
| `.claude/skills/dispatch-story/verify.sh` | Add a "wiring claim" extraction step that greps for the claimed symbol(s) in `packages/api/src/app.ts` (or other named target file). Block the gate if absent. |
| `.claude/skills/dispatch-story/SKILL.md` | Document the new required `Wiring claim:` field. Add a "before-PR" reminder pointing at `shipped-checklist.md`. |
| `docs/superpowers/contracts/repository-conventions.md` | Document the `Wiring claim:` field with an example. Document the shipped-checklist as a hard gate before push. |
| `docs/superpowers/multi-agent-runbook.md` | Add a one-line note in §5 ("Merge in dependency order") pointing at the shipped-checklist as the manual gate. |

### Migration / data changes

None.

### Commit cadence

One commit per task. Tests stay green throughout (most tasks are docs/scripts; one task adds a verify.sh test).

---

## Phase 1: Layer 3 — Shipped checklist (docs only, lowest risk, lands first)

The reviewer checklist is the cheapest piece and the easiest to roll back. It also stress-tests the language we'll use in Layer 1's `Wiring claim:` field — if the checklist is hard to write, the field name will be hard too. So this lands first.

### Task 1: Write the shipped-checklist

**Files:**
- Create: `docs/superpowers/contracts/shipped-checklist.md`

**Context:** Each item must be (a) verifiable by reading the diff, not running the code, (b) phrased as a yes/no checkbox, (c) tied to a specific CLAUDE.md invariant or a concrete bug we already saw. No "general best practices" — every item has to point at a real failure mode.

- [ ] **Step 1: Write the file with this content.**

```markdown
# Shipped Checklist

> Hard gate before merging a story PR. The reviewer ticks each box in the PR
> body. A box that cannot be ticked = do not merge.
>
> Each item exists because it caught (or would have caught) a real bug. See the
> "why" link on each line.

## Wiring (Layer 1 must pass first; this is the human-eyes follow-up)

- [ ] The new handler / service / provider is wired into `packages/api/src/app.ts`
      with **real production dependencies**, not stubs / Noop / synthetic-id
      fallbacks. (Why: voice creation handlers shipped without DB persistence
      because the registry call in `app.ts` omitted `customerRepo` etc. — see
      `2026-04-23-production-readiness-blockers.md` Phase 1.)

- [ ] If the change adds a constructor argument to a long-lived class
      (executor, router, gateway), every existing instantiation site has been
      updated to pass it. (Why: `IdempotencyGuard` was added to
      `ProposalExecutor`'s constructor signature but never passed in `app.ts`.)

- [ ] No `InMemory*` / `Mock*` / `Noop*` provider is reachable when
      `NODE_ENV === 'production'` without an explicit, documented guard.
      Conditional fallbacks like `pool ? Pg : InMemory` are acceptable only if
      `pool` is itself guaranteed by a NODE_ENV check at boot.
      (Why: `NoopInvoiceDeliveryProvider` was the prod default for
      `send_invoice` because the `sendService` ternary had no NODE_ENV gate.)

## CLAUDE.md invariants (every PR, no exceptions)

- [ ] All money fields are integer cents. No `parseFloat`, no `Number()` on
      money strings, no division producing sub-cent values. Verify with grep
      against the diff. (Why: CLAUDE.md "All money: integer cents.")

- [ ] All authenticated DB queries flow through the per-tenant client (set
      tenant context via `pg-base.ts`). No raw `pool.query` from a request
      handler. (Why: CLAUDE.md "All entities: tenant_id column + RLS"; missing
      RLS context = cross-tenant data leak.)

- [ ] All mutations emit an audit event. Spot-check the diff: every `INSERT`
      / `UPDATE` / `DELETE` path either calls `auditRepo.create(...)` directly
      or routes through a service function that does. (Why: CLAUDE.md "All
      mutations: emit audit events.")

- [ ] All AI calls (chat completion, embedding, TTS, transcription) route
      through `packages/api/src/ai/gateway/`. Direct `fetch('https://api.openai.com/...')`
      or `client.messages.create(...)` outside the gateway is forbidden.
      (Why: CLAUDE.md "All AI calls: route through LLM gateway"; bypass = cost
      leakage + no observability. TTS and Whisper transcription currently
      violate this — flag if a new call follows the same pattern.)

- [ ] All proposal payloads are validated by the Zod schemas in
      `proposals/contracts/`. New proposal types add to `PROPOSAL_TYPE_SCHEMAS`.
      No new proposal type ships with `z.unknown()` or `z.any()` as its
      payload. (Why: CLAUDE.md "All proposals: typed payloads validated by Zod
      contracts.")

- [ ] All proposal execution requires explicit human approval — no
      `auto-execute` shortcuts. The new handler does NOT call itself from a
      worker, scheduler, or webhook without a record-of-approval check.
      (Why: CLAUDE.md "Never auto-execute proposals — all require human
      approval.")

- [ ] All financial calculations use the shared billing engine
      (`packages/api/src/shared/billing-engine.ts`). New code does not
      re-implement subtotal / tax / total math inline. (Why: CLAUDE.md "Use
      the shared billing engine for all financial calculations.")

- [ ] All background jobs use the async worker pattern (P0-009). No
      `setTimeout` / `setInterval` / direct queue pushes outside the registered
      worker harness. (Why: CLAUDE.md "Use the async worker pattern (P0-009)
      for background jobs.")

- [ ] All external webhook handlers extend the webhook base (P0-014). No
      inline signature verification copied between Stripe / Clerk / Twilio.
      (Why: CLAUDE.md "Use the webhook base (P0-014) for all external webhook
      handlers." Currently violated — Stripe / Clerk / Twilio each
      reimplement; a new handler should NOT add a fourth copy.)

## API ↔ Web type contract

- [ ] If the change modifies a type in `packages/api/src/` that is also
      represented in `packages/web/src/types/`, both sides are updated in the
      same PR. If they cannot stay in sync (drift is intentional or staged),
      the drift is documented in `docs/superpowers/contracts/freeze-list.md`.
      (Why: F-1 freeze item — `Proposal` has 27 fields in API, 6 in Web; 21
      fields silently truncated; web cannot render undo state, audit metadata,
      confidence, or rejection reasons.)

## Build + tests

- [ ] `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
      passes from the merged HEAD. (Why: default `tsconfig.json` includes
      tests + vitest types — only `tsconfig.build.json` reflects the Railway
      deploy build.)

- [ ] All new behavior has at least one test. Coverage of the persisting path
      (the path that hits a real repo, not the synthetic-id fallback) is
      explicit in the test name.

## Reviewer signature

- [ ] I have ticked every box above based on reading the diff and the
      relevant linked file(s). Boxes I cannot tick are explained inline.
```

- [ ] **Step 2: Commit:** `docs(contracts): add shipped-checklist as Layer 3 of dispatch trust gap fix`

### Task 2: Wire the checklist into the PR template

**Files:**
- Verify whether `.github/PULL_REQUEST_TEMPLATE.md` exists. If yes, modify; if no, create.

**Context:** The checklist needs to render in every PR body so reviewers can't miss it. The template is the only mechanism that guarantees this.

- [ ] **Step 1: Check for an existing template:** `ls -la .github/`
- [ ] **Step 2:** If `.github/PULL_REQUEST_TEMPLATE.md` exists, append a section pointing at the shipped checklist:

```markdown
## Shipped Checklist

This PR cannot merge until every item in
[`docs/superpowers/contracts/shipped-checklist.md`](../docs/superpowers/contracts/shipped-checklist.md)
is ticked or explicitly waived in this PR body. Paste the checklist below and
tick each item.

<!-- Paste docs/superpowers/contracts/shipped-checklist.md here, ticking
boxes you have verified. Boxes you cannot tick must have a one-line reason
inline. -->
```

- [ ] **Step 3:** If no template exists, create one with that section as the sole content.
- [ ] **Step 4: Commit:** `chore(github): require shipped-checklist in PR body`

### Task 3: Cross-link from runbook

**Files:**
- Modify: `docs/superpowers/multi-agent-runbook.md`

**Context:** The runbook's §5 ("Merge in dependency order") tells the human "review each branch's diff." Strengthen that line to point at the new checklist.

- [ ] **Step 1: Locate the §5 block (lines 67-72 currently). Update the bullet that says "Review each branch's diff" to:**

```markdown
- Review each branch's diff against
  [`docs/superpowers/contracts/shipped-checklist.md`](contracts/shipped-checklist.md).
  Tick each box in the PR body. A box that cannot be ticked = do not merge.
```

- [ ] **Step 2: Commit:** `docs(runbook): require shipped-checklist tick before merge`

---

## Phase 2: Layer 1 — Wiring grep gate (verify.sh + addendum schema)

This is the automation half. It catches the simplest, highest-frequency bug shape — "handler exists but isn't wired in app.ts" — without needing a smoke test.

### Task 4: Document the new addendum field

**Files:**
- Modify: `docs/superpowers/contracts/repository-conventions.md`

**Context:** Each dispatch addendum block currently has these fields (per `p0-dispatch-addendum.md`):
- Status correction (optional)
- Wave
- Migration number reserved (optional)
- Forbidden files
- Verification gate
- Pre-flight

Add a new required field: `Wiring claim:` — one or more grep patterns that, when run against `packages/api/src/app.ts` (or another named target file), must each produce at least one match for verify to pass. Format:

```
**Wiring claim:**
- file: packages/api/src/app.ts
- must-match:
  - `customerRepo,` (the registry call passes the repo)
  - `new IdempotencyGuard\(` (the guard is instantiated)
- forbidden-match:
  - `// TODO: wire customerRepo`
```

Stories that don't add wiring (pure refactors, docs-only, test-only) use `**Wiring claim:** none (rationale: <one-line>)`.

- [ ] **Step 1: Add a section to `repository-conventions.md` under "Story metadata" (or create that section if it doesn't exist) titled "Wiring claims" with the spec above + 2-3 examples drawn from existing stories that *should* have used it (e.g., what P5-005 / `CreateInvoiceExecutionHandler` would have looked like).**

- [ ] **Step 2: Commit:** `docs(conventions): document Wiring claim field for dispatch addendums`

### Task 5: Extend verify.sh to enforce wiring claims

**Files:**
- Modify: `.claude/skills/dispatch-story/verify.sh`

**Context:** verify.sh today extracts a single bash block under `**Verification gate**` and runs it. Add a parallel extraction for `**Wiring claim:**` and a per-claim grep step. Failure = exit 1 with a clear message naming the claim that didn't match.

- [ ] **Step 1: Add the wiring-claim extraction + check after the existing gate-cmd extraction (around line 37). The full new block:**

```bash
# Extract the **Wiring claim:** block for this story. Format is a small
# YAML-ish list under the heading; we parse it line-by-line rather than
# requiring a real YAML lib.
#
# Edge case: stories may declare the claim inline on the heading line
# itself, e.g. `**Wiring claim:** none (rationale: docs-only)`. The
# parser captures any content after `**Wiring claim:**` on the heading
# line BEFORE entering block-collection mode so the inline `none` form
# isn't silently dropped.
WIRING_BLOCK=$(awk -v id="$STORY_ID" '
  /^## / { in_block = ($0 ~ "^## " id " "); next }
  in_block && /\*\*Wiring claim/ {
    inline = $0
    sub(/^.*\*\*Wiring claim:\*\*[[:space:]]*/, "", inline)
    if (inline != "") print inline
    in_wiring = 1
    next
  }
  in_wiring && /^\*\*/ { exit }
  in_wiring { print }
' "$ADDENDUM_PATH")

if [[ -z "$WIRING_BLOCK" ]]; then
  echo "verify: no Wiring claim found for ${STORY_ID}" >&2
  echo "verify: add a 'Wiring claim:' block to the addendum." >&2
  echo "verify: pure-refactor stories use 'Wiring claim: none (rationale: ...)'" >&2
  exit 1
fi

# Allow explicit "none (rationale: ...)" to skip the grep.
if echo "$WIRING_BLOCK" | grep -qE '^\s*-?\s*none\b'; then
  echo "verify: wiring claim explicitly 'none' for ${STORY_ID}, skipping grep step"
else
  WIRING_FILE=$(echo "$WIRING_BLOCK" | grep -E '^\s*-\s*file:' | head -1 | sed -E 's/^\s*-\s*file:\s*//; s/[[:space:]]+$//')
  if [[ -z "$WIRING_FILE" ]]; then
    echo "verify: Wiring claim missing 'file:' line for ${STORY_ID}" >&2
    exit 1
  fi
  if [[ ! -f "$WORKTREE/$WIRING_FILE" ]]; then
    echo "verify: Wiring claim file not found: $WIRING_FILE" >&2
    exit 1
  fi
  # must-match patterns: each backtick-quoted entry under "must-match:"
  MUST_MATCH=$(echo "$WIRING_BLOCK" | awk '/must-match:/{f=1;next} /forbidden-match:/{f=0} f && /`/ { match($0, /`[^`]+`/); if (RSTART) print substr($0, RSTART+1, RLENGTH-2) }')
  while IFS= read -r pattern; do
    [[ -z "$pattern" ]] && continue
    if ! grep -qE "$pattern" "$WORKTREE/$WIRING_FILE"; then
      echo "verify: Wiring claim FAIL — pattern '$pattern' not found in $WIRING_FILE" >&2
      exit 1
    fi
    echo "verify: wiring match OK: $pattern"
  done <<< "$MUST_MATCH"
  # forbidden-match patterns: same shape but failure on match
  FORBIDDEN_MATCH=$(echo "$WIRING_BLOCK" | awk '/forbidden-match:/{f=1;next} f && /`/ { match($0, /`[^`]+`/); if (RSTART) print substr($0, RSTART+1, RLENGTH-2) }')
  while IFS= read -r pattern; do
    [[ -z "$pattern" ]] && continue
    if grep -qE "$pattern" "$WORKTREE/$WIRING_FILE"; then
      echo "verify: Wiring claim FAIL — forbidden pattern '$pattern' found in $WIRING_FILE" >&2
      exit 1
    fi
    echo "verify: forbidden-match clean: $pattern"
  done <<< "$FORBIDDEN_MATCH"
fi
```

Insert this block AFTER the gate command extraction (after line 47) and BEFORE the `cd "$WORKTREE"` line.

- [ ] **Step 2: Add a self-test at the bottom of `.claude/skills/dispatch-story/` named `verify.test.sh` (new file). It creates a temp directory, writes a fake addendum with both passing and failing wiring claims, and calls verify.sh against each. Asserts exit 0 for the passing one, exit 1 for each failing one. Run with `bash .claude/skills/dispatch-story/verify.test.sh`.**

```bash
#!/usr/bin/env bash
# Self-test for verify.sh wiring-claim extraction.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

# Set up a fake addendum + target file
mkdir -p "$TMP/docs/superpowers/contracts"
mkdir -p "$TMP/packages/api/src"
cat > "$TMP/packages/api/src/app.ts" <<EOF
import { CustomerRepo } from './customer';
const customerRepo = new CustomerRepo();
const executionHandlers = createExecutionHandlerRegistry({ customerRepo });
EOF

cat > "$TMP/docs/superpowers/contracts/p99-dispatch-addendum.md" <<EOF
## P99-001 — fake passing
**Wiring claim:**
- file: packages/api/src/app.ts
- must-match:
  - \`customerRepo,\`

**Verification gate:**
\`\`\`bash
echo "fake gate"
\`\`\`

## P99-002 — fake failing
**Wiring claim:**
- file: packages/api/src/app.ts
- must-match:
  - \`jobRepo,\`

**Verification gate:**
\`\`\`bash
echo "fake gate"
\`\`\`

## P99-003 — fake forbidden hit
**Wiring claim:**
- file: packages/api/src/app.ts
- must-match:
  - \`customerRepo,\`
- forbidden-match:
  - \`new CustomerRepo\\(\`

**Verification gate:**
\`\`\`bash
echo "fake gate"
\`\`\`

## P99-004 — pure refactor explicit none
**Wiring claim:** none (rationale: docs-only)
**Verification gate:**
\`\`\`bash
echo "fake gate"
\`\`\`
EOF

cd "$TMP"
PASS=0; FAIL=0
bash "$SCRIPT_DIR/verify.sh" P99-001 . > /dev/null 2>&1 && { echo "P99-001 PASS (expected pass)"; ((PASS++)); } || { echo "P99-001 FAIL (expected pass)"; ((FAIL++)); }
bash "$SCRIPT_DIR/verify.sh" P99-002 . > /dev/null 2>&1 && { echo "P99-002 unexpected pass"; ((FAIL++)); } || { echo "P99-002 PASS (expected fail)"; ((PASS++)); }
bash "$SCRIPT_DIR/verify.sh" P99-003 . > /dev/null 2>&1 && { echo "P99-003 unexpected pass"; ((FAIL++)); } || { echo "P99-003 PASS (expected fail on forbidden-match)"; ((PASS++)); }
bash "$SCRIPT_DIR/verify.sh" P99-004 . > /dev/null 2>&1 && { echo "P99-004 PASS (expected pass — none allowed)"; ((PASS++)); } || { echo "P99-004 FAIL (expected pass — none allowed)"; ((FAIL++)); }

echo "Total: $PASS passed, $FAIL failed"
exit $FAIL
```

- [ ] **Step 3: Run `bash .claude/skills/dispatch-story/verify.test.sh` — confirm 4 passes, 0 failures.**

- [ ] **Step 4: Commit:** `feat(dispatch): Layer 1 wiring-grep gate in verify.sh`

### Task 6: Update SKILL.md to require Wiring claim

**Files:**
- Modify: `.claude/skills/dispatch-story/SKILL.md`

**Context:** The skill body currently lists the addendum fields it expects. Add the new field.

- [ ] **Step 1: In §1 ("Locate inputs"), add a sub-bullet to the addendum-block requirement:**

```markdown
The dispatch block must contain a `**Wiring claim:**` field. If the field
is absent, abort with: "addendum missing Wiring claim field — see
docs/superpowers/contracts/repository-conventions.md § Wiring claims".
```

- [ ] **Step 2: In §6 ("Report to user"), add a final line:**

```markdown
- Reminder to the human: tick every box in
  `docs/superpowers/contracts/shipped-checklist.md` in the PR body before
  merging.
```

- [ ] **Step 3: Commit:** `feat(dispatch): SKILL.md requires Wiring claim and shipped-checklist`

### Task 7: Backfill the in-flight stories with Wiring claims

**Files:**
- Modify: each `docs/superpowers/contracts/p*-dispatch-addendum.md` that has a story currently in-flight.

**Context:** Strict enforcement starts only on stories dispatched AFTER this lands. But the in-flight ones (the three production-readiness-blockers tasks, plus any open PR like P18-001) deserve a backfilled Wiring claim so the next time they're verified, they pass under the new gate. Lazy mode is acceptable for closed/historical stories — pick the line "Wiring claim: not backfilled (story predates Layer 1 gate)" and move on.

- [ ] **Step 1: For each story in `2026-04-23-production-readiness-blockers.md` Phase 1 (Tasks 1-5), draft a Wiring claim. Example for Task 1 (`CreateCustomerExecutionHandler`):**

```markdown
**Wiring claim:**
- file: packages/api/src/app.ts
- must-match:
  - `customerRepo,?\s*$`
  - `createExecutionHandlerRegistry\(\{`
- forbidden-match:
  - `// TODO: wire customerRepo`
```

- [ ] **Step 2: Add the Wiring claim entries to whichever existing addendum is the right home (or create a new `p-readiness-dispatch-addendum.md` if no addendum exists for these readiness tasks yet).**

- [ ] **Step 3: Commit:** `docs(addendums): backfill Wiring claims for production-readiness Phase 1`

---

## Phase 3: Verification

### Task 8: End-to-end smoke

- [ ] **Step 1: Pick one closed story (e.g., P5-017 `MockPaymentLinkProvider` guard) and add a Wiring claim retroactively. Run `bash .claude/skills/dispatch-story/verify.sh P5-017 .` — confirm it passes (the wiring is real on main).**

- [ ] **Step 2: Pick the in-flight `CreateCustomerExecutionHandler` work. Without applying the fix, add the Wiring claim that says `customerRepo,` must appear in the registry call. Run verify — confirm it FAILS (the wiring isn't there yet on main). This is the proof Layer 1 catches the bug we're trying to prevent.**

- [ ] **Step 3: Apply the production-readiness Phase 1 Task 5 fix (`fix(app): wire customerRepo/jobRepo into proposal execution registry`) on a branch. Re-run verify — confirm it now PASSES.**

- [ ] **Step 4: Open one PR with the verify.sh + checklist + repository-conventions changes. Tick the shipped-checklist on that PR's own body as the dogfood test. If anything in the checklist doesn't apply or is unclear, refine before merge.**

---

## Out of scope

- **Layer 2 (integration smoke gate).** Specified separately in `docs/superpowers/plans/2026-05-04-dispatch-trust-layer-2.md`. Lands after this plan.
- **Web-app frontend tsc gate in preflight.** Flagged by the delivery-altitude assessment as a coverage gap. Not addressed here because Layer 1's wiring-grep is enough for the bugs we currently see; frontend tsc gate is a separate Phase 6+ improvement.
- **Auto-tagging stale PRs as "needs Wiring claim before merge."** A GitHub Action could do this; out of scope for the manual-process fix.
- **Retroactive shipped-checklist on already-merged PRs.** Forward-only.
