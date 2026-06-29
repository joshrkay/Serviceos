---
title: "CI red but local green because the branch is behind a main merge that changed the code-under-test"
date: 2026-06-29
track: bug
problem_type: test-failures
module: packages/api/test/webhooks
tags: ["ci", "vitest", "clerk", "svix", "webhook-signature", "merge", "reproduce-locally"]
related:
  - docs/solutions/test-failures/component-test-green-in-isolation-red-in-ci.md
---

## Problem
Five Clerk webhook tests returned `401` (expected `200`) on the CI `test` job
but passed locally — in isolation, in the full api suite, and on CI's exact Node
version. The tests weren't flaky and the production code wasn't wrong *in my
tree*: my local branch was **behind a `main` merge that had rewritten the webhook
route's signature scheme**, and the sibling test files still signed with the old
scheme. CI checks out the post-merge HEAD; my local checkout lagged it.

## Symptoms
- CI: `expected 401 to be 200` in `test/webhooks/{signup-fixtures,
  clerk-user-deleted,durable-idempotency,clerk-welcome-email,
  clerk-invitee-pool-null}.test.ts`; route logged `Clerk webhook signature
  verification failed`.
- Locally **green every way I ran it**: single file, full `vitest run` (0
  failures), and after downloading Node 20 to match CI exactly (still 0).

## What Didn't Work
Every theory below was a dead end because they all assumed my local tree matched
CI's — it didn't:
- **Re-running the failed jobs** (`rerun_failed_jobs`) — failed identically;
  deterministic, not a flake.
- **Node version** — fetched Node 20.18 to match the CI runner; the full suite
  still passed locally.
- **The 300s replay window in `verifyWebhookSignature`** — red herring: the
  `/clerk` route had migrated to an *inline* HMAC and no longer calls that
  helper, so its tolerance was irrelevant.
- **vitest cross-file pollution / sharding** — impossible under the default
  `forks` + `isolate` pool (each file is its own process); and isolated runs
  passed regardless.
- **A CI-global env var / `NODE_ENV`** — the route reads the secret from
  *injected config*, not `process.env`.

Hours went here. The one check that would have ended it in two minutes was not
"what's different about CI?" but "**is my tree the same commit CI is testing?**"

## Solution
Sync local to the exact failing SHA, then reproduce:
```bash
git fetch origin <branch>
git log --oneline HEAD..origin/<branch>   # origin ahead → a 'Merge branch main' commit
git merge --ff-only origin/<branch>
npx vitest run test/webhooks/...          # now FAILS locally, instantly
```
The merge had rewritten `POST /webhooks/clerk` to the Svix scheme:
HMAC-SHA256 keyed by the **raw** base64-decoded secret bytes (not its hex
string), over `` `${svixId}.${svixTimestamp}.${rawBody}` ``, **base64** digest.
The merged `clerk-webhook-integration.test.ts` was updated to match; five
siblings weren't. Mirror the route in each:
```ts
// before (old scheme): hex key, extra `${ts}.` prefix on the content, hex digest
crypto.createHmac('sha256', secretBytes.toString('hex'))
  .update(`${svixTimestamp}.${svixId}.${svixTimestamp}.${rawBody}`).digest('hex');
// after: raw secret bytes, signedContent, base64
crypto.createHmac('sha256', secretBytes)
  .update(`${svixId}.${svixTimestamp}.${rawBody}`).digest('base64');
```

## Why This Works
CI checks out the PR head SHA (post-merge), where the route's signing changed. A
long-lived branch's local checkout can lag that HEAD, so locally the route and
its tests move together (both old) and pass — the mismatch exists **only in CI's
tree**. Once local is at the same commit, the test/route divergence is visible
and fixable. The neighbor doc covers the *other* cause of the same symptom
(test-internal mock-order / clock flakes); this one is source-tree drift.

## Prevention
- **First diagnostic for "CI red, local green": make your tree match the failing
  SHA.** `git fetch origin <branch> && git log HEAD..origin/<branch>` — if origin
  is ahead (especially a `Merge branch 'main'`), `--ff-only` to it and re-run
  *before* theorizing about Node, sharding, or env. Confirm the HeadSHA in the
  webhook/check matches `git rev-parse HEAD`.
- **Keep webhook signers DRY.** Each `test/webhooks/*` file re-implements the
  Svix HMAC; a single shared `signSvix(secret, body, svixId, ts)` helper would
  make a scheme change a one-line edit instead of six. Until then, grep
  `createHmac` across `test/webhooks/` whenever signature code changes.
- A route signature/contract change should land with **all** its test signers
  updated in the same commit.
